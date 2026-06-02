/**
 * Restore initiation step for the Glacier Restore Orchestrator.
 *
 * Routes restore requests based on object count:
 * - ≤50 objects: individual RestoreObject calls
 * - >50 objects: S3 Batch Operations job
 *
 * Applies the selected retrieval tier and a 7-day restore duration.
 */

import {
  S3Client,
  RestoreObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  S3ControlClient,
  CreateJobCommand,
  JobReportScope,
  JobReportFormat,
  JobManifestFormat,
  JobManifestFieldName,
} from "@aws-sdk/client-s3-control";
import { retryWithBackoff } from "../utils/retry";
import {
  BATCH_THRESHOLD,
  RESTORE_DURATION_DAYS,
  RESTORE_OBJECT_RETRY,
} from "../../shared/constants";
import type { RetrievalTier } from "../../shared/types";

const s3Client = new S3Client({});
const s3ControlClient = new S3ControlClient({});

/**
 * Initiates a Glacier restore for a single object.
 *
 * Issues a RestoreObject API call with the selected retrieval tier
 * and a restore duration of 7 days. Retries on throttling errors
 * using the RESTORE_OBJECT_RETRY configuration.
 *
 * @param bucket - S3 bucket name
 * @param filePath - S3 object key
 * @param retrievalTier - Glacier retrieval tier (Expedited, Standard, or Bulk)
 */
export async function initiateRestore(
  bucket: string,
  filePath: string,
  retrievalTier: RetrievalTier
): Promise<void> {
  await retryWithBackoff(
    async () => {
      await s3Client.send(
        new RestoreObjectCommand({
          Bucket: bucket,
          Key: filePath,
          RestoreRequest: {
            Days: RESTORE_DURATION_DAYS,
            GlacierJobParameters: {
              Tier: retrievalTier,
            },
          },
        })
      );
    },
    RESTORE_OBJECT_RETRY,
    `RestoreObject(${bucket}/${filePath})`
  );
}

/**
 * Generates a CSV manifest for S3 Batch Operations.
 *
 * The manifest format is a simple CSV with bucket and key columns,
 * as required by S3 Batch Operations for S3InitiateRestoreObject.
 *
 * @param bucket - S3 bucket name
 * @param filePaths - Array of S3 object keys
 * @returns CSV string with bucket,key rows
 */
export function generateManifestCsv(
  bucket: string,
  filePaths: string[]
): string {
  return filePaths.map((key) => `${bucket},${key}`).join("\n");
}

/**
 * Creates an S3 Batch Operations job to restore multiple objects.
 *
 * For large batches (>50 objects), this is more efficient than individual
 * RestoreObject calls. The function:
 * 1. Generates a CSV manifest with bucket and key columns
 * 2. Uploads the manifest to the staging bucket
 * 3. Creates an S3 Batch Operations job with S3InitiateRestoreObject operation
 *
 * @param bucket - S3 bucket containing the objects to restore
 * @param filePaths - Array of S3 object keys to restore
 * @param retrievalTier - Glacier retrieval tier
 * @param stagingBucket - S3 bucket for storing the manifest CSV
 * @param accountId - AWS account ID for the batch job
 * @param roleArn - IAM role ARN for the batch job to assume
 * @returns The batch job ID for status tracking
 */
export async function createBatchRestoreJob(
  bucket: string,
  filePaths: string[],
  retrievalTier: RetrievalTier,
  stagingBucket: string,
  accountId: string,
  roleArn: string
): Promise<string> {
  // Step 1: Generate the CSV manifest
  const manifestCsv = generateManifestCsv(bucket, filePaths);
  const manifestKey = `manifests/restore-${Date.now()}.csv`;
  const manifestETag = await uploadManifest(
    stagingBucket,
    manifestKey,
    manifestCsv
  );

  // Step 2: Create the S3 Batch Operations job
  const response = await retryWithBackoff(
    async () => {
      return await s3ControlClient.send(
        new CreateJobCommand({
          AccountId: accountId,
          ConfirmationRequired: false,
          Operation: {
            S3InitiateRestoreObject: {
              ExpirationInDays: RESTORE_DURATION_DAYS,
              GlacierJobTier: mapRetrievalTierToJobTier(retrievalTier),
            },
          },
          Manifest: {
            Spec: {
              Format: JobManifestFormat.S3BatchOperations_CSV_20180820,
              Fields: [
                JobManifestFieldName.Bucket,
                JobManifestFieldName.Key,
              ],
            },
            Location: {
              ObjectArn: `arn:aws:s3:::${stagingBucket}/${manifestKey}`,
              ETag: manifestETag,
            },
          },
          Report: {
            Enabled: true,
            Bucket: `arn:aws:s3:::${stagingBucket}`,
            Prefix: "reports/",
            Format: JobReportFormat.Report_CSV_20180820,
            ReportScope: JobReportScope.AllTasks,
          },
          Priority: 10,
          RoleArn: roleArn,
          Description: `Glacier restore: ${filePaths.length} objects from ${bucket} (${retrievalTier})`,
        })
      );
    },
    RESTORE_OBJECT_RETRY,
    `CreateBatchJob(${bucket}, ${filePaths.length} objects)`
  );

  if (!response.JobId) {
    throw new Error("S3 Batch Operations CreateJob did not return a JobId");
  }

  return response.JobId;
}

/**
 * Maps the application's RetrievalTier to the S3 Batch Operations GlacierJobTier value.
 *
 * S3 Batch Operations supports BULK and STANDARD tiers for restore jobs.
 * Expedited maps to STANDARD in batch context (batch operations don't support Expedited).
 */
function mapRetrievalTierToJobTier(
  tier: RetrievalTier
): "BULK" | "STANDARD" {
  switch (tier) {
    case "Bulk":
      return "BULK";
    case "Standard":
    case "Expedited":
      return "STANDARD";
  }
}

/**
 * Uploads a manifest CSV to the staging bucket and returns the ETag.
 *
 * @param stagingBucket - S3 bucket for manifest storage
 * @param key - S3 object key for the manifest
 * @param body - CSV content
 * @returns The ETag of the uploaded manifest (required for Batch Operations)
 */
async function uploadManifest(
  stagingBucket: string,
  key: string,
  body: string
): Promise<string> {
  const response = await retryWithBackoff(
    async () => {
      return await s3Client.send(
        new PutObjectCommand({
          Bucket: stagingBucket,
          Key: key,
          Body: body,
          ContentType: "text/csv",
        })
      );
    },
    RESTORE_OBJECT_RETRY,
    `UploadManifest(${stagingBucket}/${key})`
  );

  if (!response.ETag) {
    throw new Error("PutObject did not return an ETag for the manifest");
  }

  return response.ETag;
}

/**
 * Routes restore requests based on object count.
 *
 * - ≤50 objects: issues individual RestoreObject calls
 * - >50 objects: creates an S3 Batch Operations job
 *
 * @param bucket - S3 bucket containing the objects
 * @param filePaths - Array of S3 object keys to restore
 * @param retrievalTier - Glacier retrieval tier
 * @param stagingBucket - S3 bucket for batch manifest storage
 * @param accountId - AWS account ID (used for batch operations)
 * @param roleArn - IAM role ARN (used for batch operations)
 * @returns Mode used ('individual' or 'batch') and optional job ID
 */
export async function initiateRestores(
  bucket: string,
  filePaths: string[],
  retrievalTier: RetrievalTier,
  stagingBucket: string,
  accountId: string,
  roleArn: string
): Promise<{ mode: "individual" | "batch"; jobId?: string }> {
  if (filePaths.length > BATCH_THRESHOLD) {
    const jobId = await createBatchRestoreJob(
      bucket,
      filePaths,
      retrievalTier,
      stagingBucket,
      accountId,
      roleArn
    );
    return { mode: "batch", jobId };
  }

  // Individual restores for ≤50 objects
  await Promise.all(
    filePaths.map((filePath) => initiateRestore(bucket, filePath, retrievalTier))
  );

  return { mode: "individual" };
}
