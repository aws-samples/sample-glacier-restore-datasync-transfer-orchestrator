/**
 * DataSync monitoring step for the Glacier Restore Orchestrator.
 *
 * Polls DataSync task execution status at fixed 60-second intervals.
 * Implements:
 * - 60-second fixed interval polling via DescribeTaskExecutionCommand
 * - 60-minute timeout detection
 * - Consecutive transient failure tracking (3 consecutive → "Transfer Status Unknown")
 * - Terminal state handling: SUCCESS → "Transfer Complete", ERROR → "DataSync Failed"
 */

import {
  DataSyncClient,
  DescribeTaskExecutionCommand,
} from "@aws-sdk/client-datasync";
import {
  DATASYNC_POLL_INTERVAL_MS,
  DATASYNC_TIMEOUT_MS,
  MAX_CONSECUTIVE_POLL_FAILURES,
} from "../../shared/constants";

/** S3 DataSync client instance (shared across invocations for connection reuse) */
const dataSyncClient = new DataSyncClient({});

/** Result of the DataSync monitoring process */
export interface DataSyncResult {
  finalStatus:
    | "Transfer Complete"
    | "DataSync Failed"
    | "Transfer Timed Out"
    | "Transfer Status Unknown";
  failureReason?: string;
}

/** Status of a single DataSync execution check */
export interface DataSyncExecutionStatus {
  status: string;
  bytesTransferred?: number;
  filesTransferred?: number;
}

/**
 * Checks the current status of a DataSync task execution.
 *
 * Issues a DescribeTaskExecutionCommand and returns the execution status
 * along with transfer metrics.
 *
 * @param taskExecutionArn - The DataSync task execution ARN to check
 * @param client - Optional DataSync client (for testing)
 * @returns The current execution status and transfer metrics
 * @throws Error if the DescribeTaskExecution call fails
 */
export async function checkDataSyncStatus(
  taskExecutionArn: string,
  client: DataSyncClient = dataSyncClient
): Promise<DataSyncExecutionStatus> {
  const response = await client.send(
    new DescribeTaskExecutionCommand({
      TaskExecutionArn: taskExecutionArn,
    })
  );

  return {
    status: response.Status ?? "UNKNOWN",
    bytesTransferred: response.BytesTransferred != null
      ? Number(response.BytesTransferred)
      : undefined,
    filesTransferred: response.FilesTransferred != null
      ? Number(response.FilesTransferred)
      : undefined,
  };
}

/**
 * Monitors a DataSync task execution until it reaches a terminal state,
 * times out, or encounters too many consecutive transient failures.
 *
 * Polling behavior:
 * - Polls at fixed 60-second intervals (DATASYNC_POLL_INTERVAL_MS)
 * - Times out after 60 minutes (DATASYNC_TIMEOUT_MS)
 * - Tracks consecutive transient failures: 3 consecutive → "Transfer Status Unknown"
 * - A successful poll resets the consecutive failure counter
 *
 * Terminal states:
 * - "SUCCESS" → returns { finalStatus: "Transfer Complete" }
 * - "ERROR" → returns { finalStatus: "DataSync Failed", failureReason: ... }
 *
 * @param taskExecutionArn - The DataSync task execution ARN to monitor
 * @param client - Optional DataSync client (for testing)
 * @returns The final result of the DataSync transfer
 */
export async function monitorDataSyncExecution(
  taskExecutionArn: string,
  client: DataSyncClient = dataSyncClient
): Promise<DataSyncResult> {
  const startTime = Date.now();
  let consecutiveFailures = 0;

  while (true) {
    // Check for timeout before polling
    const elapsed = Date.now() - startTime;
    if (elapsed >= DATASYNC_TIMEOUT_MS) {
      return { finalStatus: "Transfer Timed Out" };
    }

    try {
      const executionStatus = await checkDataSyncStatus(taskExecutionArn, client);
      // Successful poll resets the consecutive failure counter
      consecutiveFailures = 0;

      // Check for terminal states
      if (executionStatus.status === "SUCCESS") {
        return { finalStatus: "Transfer Complete" };
      }

      if (executionStatus.status === "ERROR") {
        return {
          finalStatus: "DataSync Failed",
          failureReason: `DataSync task execution ${taskExecutionArn} failed with status ERROR`,
        };
      }
    } catch (error: unknown) {
      // Transient failure — increment consecutive failure counter
      consecutiveFailures++;

      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          finalStatus: "Transfer Status Unknown",
          failureReason: `${MAX_CONSECUTIVE_POLL_FAILURES} consecutive polling failures: ${errorMessage}`,
        };
      }
    }

    // Wait before next poll (fixed 60-second interval)
    await sleep(DATASYNC_POLL_INTERVAL_MS);
  }
}

// --- Internal helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
