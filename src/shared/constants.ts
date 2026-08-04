/**
 * Shared constants for the Glacier Restore DataSync system.
 */

import type { RetrievalTier, RequestStatus, DataSyncTaskMode } from "./types";

/** Batch operations threshold: use S3 Batch Operations when object count exceeds this */
export const BATCH_THRESHOLD = 50;

/** Maximum concurrent file processing via context.map */
export const MAX_CONCURRENCY = 50;

/** Default restore duration in days for RestoreObject calls */
export const RESTORE_DURATION_DAYS = 7;

/** Minimum allowed restore duration in days */
export const MIN_RESTORE_DAYS = 1;

/** Maximum allowed restore duration in days (no hard upper bound; set high for safety) */
export const MAX_RESTORE_DAYS = Infinity;

/** DynamoDB TTL: 30 days after completion (in seconds) */
export const TTL_DAYS = 30;
export const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

/** Maximum number of recent requests returned by the API */
export const MAX_RECENT_REQUESTS = 50;

// --- Timeout Configuration ---

/** Maximum restore wait duration per retrieval tier (in milliseconds) */
export const RESTORE_TIMEOUT_MS: Record<RetrievalTier, number> = {
  Expedited: 12 * 60 * 60 * 1000,  // 12 hours
  Standard: 48 * 60 * 60 * 1000,   // 48 hours
  Bulk: 72 * 60 * 60 * 1000,       // 72 hours
};

/** DataSync transfer timeout (in milliseconds) */
export const DATASYNC_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// --- Polling Intervals ---

/** Restore polling: initial interval (in milliseconds) */
export const RESTORE_POLL_INITIAL_MS = 5 * 60 * 1000; // 5 minutes

/** Restore polling: backoff multiplier */
export const RESTORE_POLL_MULTIPLIER = 2;

/** Restore polling: maximum interval cap (in milliseconds) */
export const RESTORE_POLL_MAX_MS = 30 * 60 * 1000; // 30 minutes

/** DataSync polling: fixed interval (in milliseconds) */
export const DATASYNC_POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

/** Batch job polling: fixed interval (in milliseconds) */
export const BATCH_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Retry Configuration ---

/** HeadObject transient error retry */
export const HEAD_OBJECT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 4000,
};

/** RestoreObject throttling retry */
export const RESTORE_OBJECT_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 16000,
};

/** DataSync start retry */
export const DATASYNC_START_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  multiplier: 2,
  maxDelayMs: 8000,
};

/** DynamoDB write retry */
export const DYNAMODB_WRITE_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 4000,
};

/** Consecutive transient polling failures before marking status unknown */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

// --- Validation Constraints ---

/** Bucket name minimum length */
export const BUCKET_MIN_LENGTH = 3;

/** Bucket name maximum length */
export const BUCKET_MAX_LENGTH = 63;

/** File path minimum length */
export const FILE_PATH_MIN_LENGTH = 1;

/** File path maximum length */
export const FILE_PATH_MAX_LENGTH = 1024;

/** Minimum unique file paths for batch requests */
export const MIN_FILE_PATHS = 1;

/** Maximum unique file paths per request */
export const MAX_FILE_PATHS = 1000;

/** Minimum unique file paths for batch operations */
export const MIN_BATCH_FILE_PATHS = 2;

// --- Retrieval Tier Constraints ---

/** Valid retrieval tiers */
export const VALID_RETRIEVAL_TIERS: readonly RetrievalTier[] = [
  "Expedited",
  "Standard",
  "Bulk",
] as const;

/** Valid DataSync task modes */
export const VALID_TASK_MODES: readonly DataSyncTaskMode[] = [
  "BASIC",
  "ENHANCED",
] as const;

/** Default DataSync task mode when not specified */
export const DEFAULT_TASK_MODE: DataSyncTaskMode = "BASIC";

/** Tiers NOT available for Deep Archive */
export const DEEP_ARCHIVE_UNAVAILABLE_TIERS: readonly RetrievalTier[] = [
  "Expedited",
] as const;

// --- Status Values ---

/** All valid request status values */
export const REQUEST_STATUSES: readonly RequestStatus[] = [
  "Submitted",
  "Resolving Paths",
  "Detecting Storage Class",
  "Initiating Restore",
  "Restore In Progress",
  "Restore Complete",
  "Starting DataSync",
  "DataSync In Progress",
  "Transfer Complete",
  "Restore Timed Out",
  "DataSync Failed",
  "Transfer Timed Out",
  "Transfer Status Unknown",
  "Error",
] as const;

/** Terminal status values (no further transitions) */
export const TERMINAL_STATUSES: readonly RequestStatus[] = [
  "Transfer Complete",
  "Restore Timed Out",
  "DataSync Failed",
  "Transfer Timed Out",
  "Transfer Status Unknown",
  "Error",
] as const;
