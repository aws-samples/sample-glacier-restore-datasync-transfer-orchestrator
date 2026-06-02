/**
 * Storage class detection step.
 *
 * Uses S3 HeadObject to determine the storage class of an object.
 * Handles 404 (not found), 403 (access denied), and transient errors with retry.
 */

import {
  S3Client,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { retryWithBackoff, RetryError } from "../utils/retry";
import { HEAD_OBJECT_RETRY } from "../../shared/constants";
import type { StorageClass, StorageClassInfo } from "../../shared/types";

/** S3 client instance (shared across invocations for connection reuse) */
const s3Client = new S3Client({});

/**
 * Maps the S3 StorageClass string from HeadObject to our internal StorageClass type.
 *
 * S3 returns storage class as "GLACIER", "DEEP_ARCHIVE", "GLACIER_IR",
 * or undefined for STANDARD class objects.
 * STANDARD and undefined are treated as directly accessible (mapped to GLACIER_IR).
 */
function mapStorageClass(s3StorageClass: string | undefined): StorageClass {
  switch (s3StorageClass) {
    case "GLACIER":
      return "GLACIER";
    case "DEEP_ARCHIVE":
      return "DEEP_ARCHIVE";
    case "GLACIER_IR":
      return "GLACIER_IR";
    default:
      // STANDARD or undefined — directly accessible, treat like Instant Retrieval
      return "GLACIER_IR";
  }
}

/**
 * Detects the storage class of an S3 object using HeadObject.
 * Also checks the Restore header to determine if a restore is already
 * in progress or completed (for GLACIER/DEEP_ARCHIVE objects).
 *
 * @param bucket - The S3 bucket name
 * @param filePath - The S3 object key
 * @param client - Optional S3 client (for testing)
 * @returns StorageClassInfo with the detected storage class, restore status, existence flag, and any error
 */
export async function detectStorageClass(
  bucket: string,
  filePath: string,
  client: S3Client = s3Client
): Promise<StorageClassInfo> {
  try {
    const response: HeadObjectCommandOutput = await retryWithBackoff(
      () =>
        client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: filePath })
        ),
      HEAD_OBJECT_RETRY,
      `HeadObject(${bucket}/${filePath})`
    );

    const storageClass = mapStorageClass(response.StorageClass);

    // Parse restore status from the Restore header (only relevant for cold tiers)
    let restoreStatus: "not_started" | "in_progress" | "completed" | undefined;
    if (storageClass === "GLACIER" || storageClass === "DEEP_ARCHIVE") {
      restoreStatus = parseRestoreHeader(response.Restore);
    }

    return {
      filePath,
      storageClass,
      exists: true,
      restoreStatus,
    };
  } catch (error: unknown) {
    // Handle RetryError wrapping non-retryable errors
    const underlying = error instanceof RetryError ? error.cause : error;

    // Check for 404 - Object not found
    if (isHttpStatusError(underlying, 404) || isErrorName(underlying, "NotFound") || isErrorName(underlying, "NoSuchKey")) {
      return {
        filePath,
        storageClass: undefined as unknown as StorageClass,
        exists: false,
        error: "Object not found",
      };
    }

    // Check for 403 - Access denied
    if (isHttpStatusError(underlying, 403) || isErrorName(underlying, "AccessDenied") || isErrorName(underlying, "Forbidden")) {
      return {
        filePath,
        storageClass: undefined as unknown as StorageClass,
        exists: false,
        error: "Access denied",
      };
    }

    // All other errors (transient errors exhausted retries, etc.)
    const errorMessage =
      error instanceof RetryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error";

    return {
      filePath,
      storageClass: undefined as unknown as StorageClass,
      exists: false,
      error: errorMessage,
    };
  }
}

// --- Internal helpers ---

/**
 * Parses the S3 Restore header to determine restore status.
 *
 * The Restore header values:
 * - undefined/null → restore has not been initiated
 * - `ongoing-request="true"` → restore is in progress
 * - `ongoing-request="false", expiry-date="..."` → restore is completed and accessible
 */
function parseRestoreHeader(
  restore: string | undefined
): "not_started" | "in_progress" | "completed" {
  if (!restore) {
    return "not_started";
  }

  if (restore.includes('ongoing-request="false"')) {
    return "completed";
  }

  if (restore.includes('ongoing-request="true"')) {
    return "in_progress";
  }

  // Fallback: header exists but doesn't match known patterns
  return "in_progress";
}

/**
 * Checks if an error has a specific HTTP status code.
 */
function isHttpStatusError(error: unknown, statusCode: number): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as Record<string, unknown>;

  // AWS SDK v3 puts HTTP status in $metadata
  const metadata = err.$metadata as { httpStatusCode?: number } | undefined;
  if (metadata?.httpStatusCode === statusCode) return true;

  // Some errors expose statusCode directly
  if (err.statusCode === statusCode) return true;

  // Check $fault or httpStatusCode at top level
  if (err.httpStatusCode === statusCode) return true;

  return false;
}

/**
 * Checks if an error has a specific name/code.
 */
function isErrorName(error: unknown, name: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as Record<string, unknown>;
  return err.name === name || err.code === name || err.Code === name;
}
