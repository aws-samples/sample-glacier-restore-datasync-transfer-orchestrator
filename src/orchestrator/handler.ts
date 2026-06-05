/**
 * Durable Function handler for the Glacier Restore Orchestrator.
 *
 * Coordinates the end-to-end workflow:
 * 1. Persist initial request to DynamoDB
 * 2. Detect storage classes for all requested objects
 * 3. Initiate restores (individual or batch) for non-Instant Retrieval objects
 * 4. Monitor restore completion with exponential backoff polling
 * 5. Start DataSync transfer
 * 6. Monitor DataSync execution until terminal state
 * 7. Mark request complete
 *
 * Uses Lambda Durable Functions to suspend execution during long waits
 * (Glacier restores can take up to 48+ hours) without incurring compute charges.
 */

import {
  withDurableExecution,
  DurableContext,
  createWaitStrategy,
} from "@aws/durable-execution-sdk-js";
import type {
  RestoreRequest,
  StorageClassInfo,
  RestoreRequestRecord,
} from "../shared/types";
import {
  MAX_CONCURRENCY,
  BATCH_THRESHOLD,
  RESTORE_POLL_INITIAL_MS,
  RESTORE_POLL_MULTIPLIER,
  RESTORE_POLL_MAX_MS,
  RESTORE_TIMEOUT_MS,
  DATASYNC_POLL_INTERVAL_MS,
  DATASYNC_TIMEOUT_MS,
  MAX_CONSECUTIVE_POLL_FAILURES,
} from "../shared/constants";
import { detectStorageClass } from "./steps/detect-storage-class";
import {
  initiateRestores,
  initiateRestore,
} from "./steps/initiate-restore";
import {
  checkRestoreStatus,
  checkBatchJobStatus,
} from "./steps/monitor-restore";
import { startDataSyncTransfer } from "./steps/start-datasync";
import type { StartDataSyncParams } from "./steps/start-datasync";
import { checkDataSyncStatus } from "./steps/monitor-datasync";
import {
  createRequestRecord,
  updateRequestStatus,
  markComplete,
} from "./utils/status";

/** Environment variable accessors */
const getDataSyncTaskArn = () => process.env.DATASYNC_TASK_ARN ?? "";
const getStagingBucket = () => process.env.STAGING_BUCKET ?? "";
const getAccountId = () => process.env.ACCOUNT_ID ?? "";
const getBatchRoleArn = () => process.env.BATCH_ROLE_ARN ?? "";
const getDataSyncS3RoleArn = () => process.env.DATASYNC_S3_ROLE_ARN ?? "";

/** State tracked during restore polling */
interface RestorePollState {
  pendingFiles: string[];
  completedFiles: string[];
  failedFiles: string[];
  timedOut: boolean;
  startTime: number;
}

/** State tracked during batch job polling */
interface BatchPollState {
  jobId: string;
  status: string;
  completedCount: number;
  failedCount: number;
  totalCount: number;
  timedOut: boolean;
  startTime: number;
}

/** State tracked during DataSync polling */
interface DataSyncPollState {
  taskExecutionArn: string;
  status: string;
  consecutiveFailures: number;
  timedOut: boolean;
  startTime: number;
  failureReason?: string;
}

/**
 * Determines if an object needs a Glacier restore based on its storage class
 * and current restore status. Objects that are already restored or have a
 * restore in progress do not need a new restore initiated.
 */
function needsRestore(info: StorageClassInfo): boolean {
  if (!info.exists) return false;
  if (info.storageClass !== "GLACIER" && info.storageClass !== "DEEP_ARCHIVE") return false;
  // Already restored — no action needed
  if (info.restoreStatus === "completed") return false;
  return true;
}

/**
 * Determines if an object needs a new restore to be initiated.
 * Objects with a restore already in progress should be monitored, not re-initiated.
 */
function needsRestoreInitiation(info: StorageClassInfo): boolean {
  return needsRestore(info) && info.restoreStatus !== "in_progress";
}

/**
 * Determines if an object has a restore in progress that should be monitored.
 */
function hasRestoreInProgress(info: StorageClassInfo): boolean {
  return info.exists
    && (info.storageClass === "GLACIER" || info.storageClass === "DEEP_ARCHIVE")
    && info.restoreStatus === "in_progress";
}

/**
 * The durable function handler for the Glacier Restore Orchestrator.
 *
 * Receives a RestoreRequest event and orchestrates the full lifecycle
 * using durable execution primitives for state persistence and long waits.
 */
const durableHandler = async (event: RestoreRequest & { requestId?: string; submittedAt?: string }, context: DurableContext) => {
  // Step 1: Use existing record if invoked from submit-request, otherwise create one
  let requestId: string;
  let submittedAt: string;

  if (event.requestId && event.submittedAt) {
    // Invoked from submit-request handler — record already exists
    requestId = event.requestId;
    submittedAt = event.submittedAt;
  } else {
    // Direct invocation — create a new record
    const record = await context.step("persist-request", async () => {
      return await createRequestRecord(event);
    });
    requestId = record.requestId;
    submittedAt = record.submittedAt;
  }

  // Step 2: Update status and detect storage classes for all objects
  await context.step("update-status-detecting", async () => {
    await updateRequestStatus(requestId, submittedAt, "Detecting Storage Class");
  });

  const classResults = await context.map(
    "detect-storage-classes",
    event.filePaths,
    async (ctx, filePath) => {
      return await ctx.step(`head-object-${filePath}`, async () => {
        return await detectStorageClass(event.bucket, filePath);
      });
    },
    { maxConcurrency: MAX_CONCURRENCY }
  );

  // Separate objects by restore requirement
  const storageClassInfos = classResults.getResults();
  const objectsToRestore = storageClassInfos.filter(needsRestore);
  const restoreFilePaths = objectsToRestore.map((info) => info.filePath);

  // Further separate: objects needing initiation vs already in progress
  const objectsNeedingInitiation = storageClassInfos.filter(needsRestoreInitiation);
  const initiationFilePaths = objectsNeedingInitiation.map((info) => info.filePath);
  const objectsAlreadyInProgress = storageClassInfos.filter(hasRestoreInProgress);
  const inProgressFilePaths = objectsAlreadyInProgress.map((info) => info.filePath);

  // Step 3: Initiate restores if needed (skip for already-restored and Instant Retrieval objects)
  if (restoreFilePaths.length > 0) {
    await context.step("update-status-initiating-restore", async () => {
      await updateRequestStatus(requestId, submittedAt, "Initiating Restore");
    });

    // Only initiate restores for objects that don't already have one in progress/completed
    if (initiationFilePaths.length > 0) {
      if (initiationFilePaths.length > BATCH_THRESHOLD) {
        // Use S3 Batch Operations for large batches
        const batchResult = await context.step("create-batch-job", async () => {
          return await initiateRestores(
            event.bucket,
            initiationFilePaths,
            event.retrievalTier,
            getStagingBucket(),
            getAccountId(),
            getBatchRoleArn(),
            event.restoreDays
          );
        });

        await context.step("update-status-restore-in-progress", async () => {
          await updateRequestStatus(requestId, submittedAt, "Restore In Progress", {
            batchJobId: batchResult.jobId,
          });
        });

        // Monitor batch job completion with waitForCondition
        const batchFinalState = await context.waitForCondition(
          "wait-batch-restore-complete",
          async (state) => {
            const jobStatus = await checkBatchJobStatus(
              getAccountId(),
              state.jobId
            );
            const elapsed = Date.now() - state.startTime;
            const timeout = RESTORE_TIMEOUT_MS[event.retrievalTier];

            return {
              ...state,
              status: jobStatus.status,
              completedCount: jobStatus.completedCount,
              failedCount: jobStatus.failedCount,
              totalCount: jobStatus.totalCount,
              timedOut: elapsed >= timeout,
            };
          },
          {
            initialState: {
              jobId: batchResult.jobId!,
              status: "Active",
              completedCount: 0,
              failedCount: 0,
              totalCount: initiationFilePaths.length,
              timedOut: false,
              startTime: Date.now(),
            } as BatchPollState,
            waitStrategy: createWaitStrategy<BatchPollState>({
              initialDelay: { minutes: 5 },
              maxDelay: { minutes: 5 },
              backoffRate: 1,
              shouldContinuePolling: (state) => {
                if (state.timedOut) return false;
                const terminalStatuses = new Set(["Complete", "Failed", "Cancelled"]);
                return !terminalStatuses.has(state.status);
              },
            }),
          }
        );

        // Handle batch timeout
        if (batchFinalState.timedOut) {
          await markComplete(requestId, submittedAt, "Restore Timed Out");
          return { requestId, status: "Restore Timed Out" };
        }
      } else {
        // Individual restores for ≤50 objects
        await context.map(
          "initiate-individual-restores",
          initiationFilePaths,
          async (ctx, filePath) => {
            return await ctx.step(`restore-${filePath}`, async () => {
              await initiateRestore(event.bucket, filePath, event.retrievalTier, event.restoreDays);
            });
          },
          { maxConcurrency: MAX_CONCURRENCY }
        );
      }
    }

    await context.step("update-status-restore-in-progress-individual", async () => {
      await updateRequestStatus(requestId, submittedAt, "Restore In Progress");
    });

    // Monitor ALL objects that need restoring (both newly initiated and already in progress)
    const allPendingFiles = restoreFilePaths;
    const restoreFinalState = await context.waitForCondition(
      "wait-individual-restore-complete",
      async (state) => {
        const stillPending: string[] = [];
        const newCompleted = [...state.completedFiles];
        const newFailed = [...state.failedFiles];

        for (const filePath of state.pendingFiles) {
          try {
            const status = await checkRestoreStatus(event.bucket, filePath);
            if (status === "completed") {
              newCompleted.push(filePath);
            } else {
              stillPending.push(filePath);
            }
          } catch {
            newFailed.push(filePath);
          }
        }

        const elapsed = Date.now() - state.startTime;
        const timeout = RESTORE_TIMEOUT_MS[event.retrievalTier];

        return {
          ...state,
          pendingFiles: stillPending,
          completedFiles: newCompleted,
          failedFiles: newFailed,
          timedOut: elapsed >= timeout,
        };
      },
      {
        initialState: {
          pendingFiles: allPendingFiles,
          completedFiles: [],
          failedFiles: [],
          timedOut: false,
          startTime: Date.now(),
        } as RestorePollState,
        waitStrategy: createWaitStrategy<RestorePollState>({
          initialDelay: { minutes: 5 },
          maxDelay: { minutes: 30 },
          backoffRate: RESTORE_POLL_MULTIPLIER,
          shouldContinuePolling: (state) => {
            if (state.timedOut) return false;
            return state.pendingFiles.length > 0;
          },
        }),
      }
    );

    // Handle restore timeout
    if (restoreFinalState.timedOut && restoreFinalState.pendingFiles.length > 0) {
      await markComplete(requestId, submittedAt, "Restore Timed Out");
      return { requestId, status: "Restore Timed Out" };
    }

    // Update status to Restore Complete
    await context.step("update-status-restore-complete", async () => {
      const expiresAt = new Date(Date.now() + event.restoreDays * 24 * 60 * 60 * 1000).toISOString();
      await updateRequestStatus(requestId, submittedAt, "Restore Complete", {
        restoreExpiresAt: expiresAt,
        restoredCount: restoreFinalState.completedFiles.length + (event.filePaths.length - restoreFilePaths.length),
      });
    });
  } else {
    // All objects are already accessible (Instant Retrieval or already restored)
    await context.step("update-restored-count-all-accessible", async () => {
      await updateRequestStatus(requestId, submittedAt, "Restore Complete", {
        restoredCount: event.filePaths.length,
      });
    });
  }

  // Step 4: Start DataSync transfer
  await context.step("update-status-starting-datasync", async () => {
    await updateRequestStatus(requestId, submittedAt, "Starting DataSync");
  });

  const taskExecutionArn = await context.step("start-datasync", async () => {
    return await startDataSyncTransfer({
      taskArn: getDataSyncTaskArn(),
      stagingBucket: getStagingBucket(),
      filePaths: event.filePaths,
      manifestAccessRoleArn: getDataSyncS3RoleArn(),
    });
  });

  await context.step("update-status-datasync-in-progress", async () => {
    await updateRequestStatus(requestId, submittedAt, "DataSync In Progress", {
      dataSyncTaskArn: taskExecutionArn,
    });
  });

  // Step 5: Monitor DataSync execution with fixed 60-second polling
  const dataSyncFinalState = await context.waitForCondition(
    "wait-datasync-complete",
    async (state) => {
      try {
        const executionStatus = await checkDataSyncStatus(state.taskExecutionArn);
        return {
          ...state,
          status: executionStatus.status,
          consecutiveFailures: 0,
          timedOut: Date.now() - state.startTime >= DATASYNC_TIMEOUT_MS,
        };
      } catch (error: unknown) {
        const newConsecutiveFailures = state.consecutiveFailures + 1;
        const failureReason = error instanceof Error ? error.message : "Unknown error";
        return {
          ...state,
          consecutiveFailures: newConsecutiveFailures,
          timedOut: Date.now() - state.startTime >= DATASYNC_TIMEOUT_MS,
          failureReason:
            newConsecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES
              ? `${MAX_CONSECUTIVE_POLL_FAILURES} consecutive polling failures: ${failureReason}`
              : state.failureReason,
        };
      }
    },
    {
      initialState: {
        taskExecutionArn,
        status: "LAUNCHING",
        consecutiveFailures: 0,
        timedOut: false,
        startTime: Date.now(),
      } as DataSyncPollState,
      waitStrategy: createWaitStrategy<DataSyncPollState>({
        initialDelay: { seconds: 60 },
        maxDelay: { seconds: 60 },
        backoffRate: 1,
        shouldContinuePolling: (state) => {
          if (state.timedOut) return false;
          if (state.consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) return false;
          const terminalStatuses = new Set(["SUCCESS", "ERROR"]);
          return !terminalStatuses.has(state.status);
        },
      }),
    }
  );

  // Step 6: Mark complete based on DataSync outcome
  let finalStatus: "Transfer Complete" | "DataSync Failed" | "Transfer Timed Out" | "Transfer Status Unknown";

  if (dataSyncFinalState.status === "SUCCESS") {
    finalStatus = "Transfer Complete";
  } else if (dataSyncFinalState.status === "ERROR") {
    finalStatus = "DataSync Failed";
  } else if (dataSyncFinalState.timedOut) {
    finalStatus = "Transfer Timed Out";
  } else if (dataSyncFinalState.consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
    finalStatus = "Transfer Status Unknown";
  } else {
    finalStatus = "Transfer Timed Out";
  }

  await context.step("mark-complete", async () => {
    await markComplete(requestId, submittedAt, finalStatus);
  });

  return { requestId, status: finalStatus };
};

/**
 * Lambda handler wrapped with durable execution for automatic state
 * persistence, checkpointing, and replay across long-running waits.
 */
export const handler = withDurableExecution(durableHandler);
