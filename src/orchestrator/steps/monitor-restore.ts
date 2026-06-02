/**
 * Restore monitoring step for the Glacier Restore Orchestrator.
 *
 * Provides polling logic for both individual object restores (via HeadObject)
 * and batch job restores (via DescribeJob). Implements:
 * - Exponential backoff polling (5 min initial, 2x multiplier, 30 min cap)
 * - Tier-specific timeout detection (12h Expedited, 48h Standard, 72h Bulk)
 * - Batch job polling at fixed 5-minute intervals
 * - Partial failure handling: continues processing remaining files when individual restores fail
 */

import {
  S3Client,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  S3ControlClient,
  DescribeJobCommand,
} from "@aws-sdk/client-s3-control";
import {
  RESTORE_POLL_INITIAL_MS,
  RESTORE_POLL_MULTIPLIER,
  RESTORE_POLL_MAX_MS,
  RESTORE_TIMEOUT_MS,
} from "../../shared/constants";
import type { RetrievalTier } from "../../shared/types";

/** S3 client instance (shared across invocations for connection reuse) */
const s3Client = new S3Client({});

/** S3 Control client instance for batch job operations */
const s3ControlClient = new S3ControlClient({});

/** Possible restore status values for an individual object */
export type RestoreStatus = "in_progress" | "completed" | "not_started";

/** Batch job status result */
export interface BatchJobStatus {
  status: string;
  completedCount: number;
  failedCount: number;
  totalCount: number;
}

/** Per-file restore result for partial failure tracking */
export interface FileRestoreResult {
  filePath: string;
  status: RestoreStatus | "failed" | "timed_out";
  error?: string;
}

/**
 * Calculates the polling delay for a given attempt using exponential backoff.
 *
 * Formula: min(RESTORE_POLL_INITIAL_MS * RESTORE_POLL_MULTIPLIER^attempt, RESTORE_POLL_MAX_MS)
 *
 * @param attempt - Zero-based attempt index (0 = first poll delay)
 * @returns Delay in milliseconds, capped at RESTORE_POLL_MAX_MS (30 minutes)
 */
export function calculatePollDelay(attempt: number): number {
  const delay = RESTORE_POLL_INITIAL_MS * Math.pow(RESTORE_POLL_MULTIPLIER, attempt);
  return Math.min(delay, RESTORE_POLL_MAX_MS);
}

/**
 * Checks if a single object's restore is complete by inspecting the Restore header
 * from a HeadObject response.
 *
 * The S3 Restore header indicates:
 * - `ongoing-request="true"` → restore is in progress
 * - `ongoing-request="false", expiry-date="..."` → restore is completed
 * - No Restore header → restore has not been initiated
 *
 * @param bucket - S3 bucket name
 * @param filePath - S3 object key
 * @param client - Optional S3 client (for testing)
 * @returns The restore status: 'in_progress', 'completed', or 'not_started'
 */
export async function checkRestoreStatus(
  bucket: string,
  filePath: string,
  client: S3Client = s3Client
): Promise<RestoreStatus> {
  const response = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: filePath })
  );

  const restore = response.Restore;

  if (!restore) {
    return "not_started";
  }

  if (restore.includes('ongoing-request="true"')) {
    return "in_progress";
  }

  if (restore.includes('ongoing-request="false"')) {
    return "completed";
  }

  // Fallback: if Restore header exists but doesn't match known patterns
  return "in_progress";
}

/**
 * Checks the status of an S3 Batch Operations job via DescribeJob.
 *
 * @param accountId - AWS account ID
 * @param jobId - The batch job ID to check
 * @param client - Optional S3 Control client (for testing)
 * @returns Batch job status including completion and failure counts
 */
export async function checkBatchJobStatus(
  accountId: string,
  jobId: string,
  client: S3ControlClient = s3ControlClient
): Promise<BatchJobStatus> {
  const response = await client.send(
    new DescribeJobCommand({
      AccountId: accountId,
      JobId: jobId,
    })
  );

  const job = response.Job;

  if (!job) {
    throw new Error(`DescribeJob returned no job details for jobId: ${jobId}`);
  }

  const progressSummary = job.ProgressSummary;

  return {
    status: job.Status ?? "Unknown",
    completedCount: Number(progressSummary?.NumberOfTasksSucceeded ?? 0),
    failedCount: Number(progressSummary?.NumberOfTasksFailed ?? 0),
    totalCount: Number(progressSummary?.TotalNumberOfTasks ?? 0),
  };
}

/**
 * Checks if a restore operation has exceeded the tier-specific timeout.
 *
 * Timeout durations:
 * - Expedited: 12 hours
 * - Standard: 48 hours
 * - Bulk: 72 hours
 *
 * @param startTime - The timestamp (ms since epoch) when the restore was initiated
 * @param retrievalTier - The retrieval tier used for the restore
 * @returns true if the restore has exceeded the maximum allowed duration
 */
export function isRestoreTimedOut(
  startTime: number,
  retrievalTier: RetrievalTier
): boolean {
  const elapsed = Date.now() - startTime;
  const timeout = RESTORE_TIMEOUT_MS[retrievalTier];
  return elapsed >= timeout;
}

/**
 * Monitors individual object restores with exponential backoff polling.
 * Implements partial failure handling: continues monitoring remaining files
 * when individual restores fail or time out.
 *
 * @param bucket - S3 bucket name
 * @param filePaths - Array of S3 object keys being restored
 * @param retrievalTier - The retrieval tier used for the restore
 * @param startTime - The timestamp (ms since epoch) when the restore was initiated
 * @param client - Optional S3 client (for testing)
 * @returns Array of per-file restore results
 */
export async function monitorIndividualRestores(
  bucket: string,
  filePaths: string[],
  retrievalTier: RetrievalTier,
  startTime: number,
  client: S3Client = s3Client
): Promise<FileRestoreResult[]> {
  const results: Map<string, FileRestoreResult> = new Map();
  let pendingFiles = [...filePaths];
  let attempt = 0;

  while (pendingFiles.length > 0) {
    // Check for timeout before polling
    if (isRestoreTimedOut(startTime, retrievalTier)) {
      for (const filePath of pendingFiles) {
        results.set(filePath, {
          filePath,
          status: "timed_out",
          error: `Restore timed out after ${RESTORE_TIMEOUT_MS[retrievalTier] / (60 * 60 * 1000)} hours`,
        });
      }
      break;
    }

    // Poll each pending file
    const stillPending: string[] = [];

    for (const filePath of pendingFiles) {
      try {
        const status = await checkRestoreStatus(bucket, filePath, client);

        if (status === "completed") {
          results.set(filePath, { filePath, status: "completed" });
        } else if (status === "not_started") {
          // Restore was not initiated — mark as failed
          results.set(filePath, {
            filePath,
            status: "failed",
            error: "Restore not initiated for this object",
          });
        } else {
          // Still in progress — keep polling
          stillPending.push(filePath);
        }
      } catch (error: unknown) {
        // Individual file failure — continue with remaining files (partial failure handling)
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        results.set(filePath, {
          filePath,
          status: "failed",
          error: errorMessage,
        });
      }
    }

    pendingFiles = stillPending;

    // Wait before next poll (if there are still pending files)
    if (pendingFiles.length > 0) {
      const delay = calculatePollDelay(attempt);
      await sleep(delay);
      attempt++;
    }
  }

  // Return results for all files in original order
  return filePaths.map(
    (filePath) =>
      results.get(filePath) ?? { filePath, status: "failed", error: "Unknown state" }
  );
}

/**
 * Monitors a batch job at fixed 5-minute intervals until completion or timeout.
 *
 * @param accountId - AWS account ID
 * @param jobId - The batch job ID to monitor
 * @param retrievalTier - The retrieval tier (used for timeout calculation)
 * @param startTime - The timestamp (ms since epoch) when the restore was initiated
 * @param client - Optional S3 Control client (for testing)
 * @returns Final batch job status
 */
export async function monitorBatchJob(
  accountId: string,
  jobId: string,
  retrievalTier: RetrievalTier,
  startTime: number,
  client: S3ControlClient = s3ControlClient
): Promise<BatchJobStatus> {
  const TERMINAL_STATUSES = new Set([
    "Complete",
    "Failed",
    "Cancelled",
  ]);

  while (true) {
    // Check for timeout
    if (isRestoreTimedOut(startTime, retrievalTier)) {
      return {
        status: "TimedOut",
        completedCount: 0,
        failedCount: 0,
        totalCount: 0,
      };
    }

    const jobStatus = await checkBatchJobStatus(accountId, jobId, client);

    if (TERMINAL_STATUSES.has(jobStatus.status)) {
      return jobStatus;
    }

    // Wait 5 minutes before next poll (fixed interval for batch jobs)
    await sleep(RESTORE_POLL_INITIAL_MS);
  }
}

// --- Internal helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
