/**
 * DataSync start step for the Glacier Restore Orchestrator.
 *
 * Starts a DataSync task execution using a manifest to transfer only
 * the specific restored objects (not the entire bucket). Uploads a CSV
 * manifest to the staging bucket, then passes ManifestConfig to
 * StartTaskExecution.
 *
 * Retries up to 3 times with exponential backoff on transient/throttling failures.
 */

import {
  DataSyncClient,
  StartTaskExecutionCommand,
} from "@aws-sdk/client-datasync";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { retryWithBackoff } from "../utils/retry";
import { DATASYNC_START_RETRY } from "../../shared/constants";

const dataSyncClient = new DataSyncClient({});
const s3Client = new S3Client({});

/**
 * Parameters for starting a DataSync transfer with a manifest.
 */
export interface StartDataSyncParams {
  /** The DataSync task ARN */
  taskArn: string;
  /** S3 bucket where the manifest will be uploaded */
  stagingBucket: string;
  /** File paths (object keys) to include in the transfer */
  filePaths: string[];
  /** IAM role ARN that DataSync uses to access the manifest in S3 */
  manifestAccessRoleArn: string;
}

/**
 * Generates a CSV manifest for DataSync.
 *
 * Each line is a relative object key path. DataSync expects paths
 * relative to the source location's configured prefix/mount.
 *
 * @param filePaths - Array of S3 object keys to transfer
 * @returns CSV string with one path per line
 */
export function generateDataSyncManifest(filePaths: string[]): string {
  return filePaths.join("\n");
}

/**
 * Uploads the manifest CSV to the staging bucket and returns the object path.
 *
 * @param stagingBucket - S3 bucket for manifest storage
 * @param manifestCsv - CSV content (one file path per line)
 * @returns The S3 object key of the uploaded manifest
 */
async function uploadDataSyncManifest(
  stagingBucket: string,
  manifestCsv: string
): Promise<string> {
  const manifestKey = `datasync-manifests/transfer-${Date.now()}.csv`;

  await retryWithBackoff(
    async () => {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: stagingBucket,
          Key: manifestKey,
          Body: manifestCsv,
          ContentType: "text/csv",
        })
      );
    },
    DATASYNC_START_RETRY,
    `UploadDataSyncManifest(${stagingBucket}/${manifestKey})`
  );

  return manifestKey;
}

/**
 * Starts a DataSync task execution with a manifest specifying exactly
 * which files to transfer.
 *
 * 1. Generates a CSV manifest from the provided file paths
 * 2. Uploads the manifest to the staging bucket
 * 3. Calls StartTaskExecution with ManifestConfig pointing to the manifest
 *
 * @param params - Configuration including task ARN, staging bucket, file paths, and role ARN
 * @returns The task execution ARN for status tracking
 * @throws Error if StartTaskExecution does not return a TaskExecutionArn
 * @throws RetryError if all retry attempts are exhausted or a non-retryable error occurs
 */
export async function startDataSyncTransfer(params: StartDataSyncParams): Promise<string> {
  const { taskArn, stagingBucket, filePaths, manifestAccessRoleArn } = params;

  // Step 1: Generate and upload the manifest
  const manifestCsv = generateDataSyncManifest(filePaths);
  const manifestKey = await uploadDataSyncManifest(stagingBucket, manifestCsv);

  // Step 2: Start the task execution with the manifest
  const response = await retryWithBackoff(
    async () => {
      return await dataSyncClient.send(
        new StartTaskExecutionCommand({
          TaskArn: taskArn,
          ManifestConfig: {
            Action: "TRANSFER",
            Format: "CSV",
            Source: {
              S3: {
                ManifestObjectPath: manifestKey,
                BucketAccessRoleArn: manifestAccessRoleArn,
                S3BucketArn: `arn:aws:s3:::${stagingBucket}`,
              },
            },
          },
          OverrideOptions: {
            // Don't delete files at destination that aren't in the manifest
            PreserveDeletedFiles: "PRESERVE",
            OverwriteMode: "ALWAYS",
            VerifyMode: "ONLY_FILES_TRANSFERRED",
          },
        })
      );
    },
    DATASYNC_START_RETRY,
    `StartTaskExecution(${taskArn})`
  );

  if (!response.TaskExecutionArn) {
    throw new Error(
      `StartTaskExecution for task "${taskArn}" did not return a TaskExecutionArn`
    );
  }

  return response.TaskExecutionArn;
}
