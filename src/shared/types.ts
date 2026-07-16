/**
 * Shared TypeScript interfaces for the Glacier Restore DataSync system.
 */

/** Retrieval tier options for Glacier restores */
export type RetrievalTier = "Expedited" | "Standard" | "Bulk";

/** S3 Glacier storage classes handled by the system */
export type StorageClass = "GLACIER" | "DEEP_ARCHIVE" | "GLACIER_IR";

/** All possible request status values */
export type RequestStatus =
  | "Submitted"
  | "Resolving Paths"
  | "Detecting Storage Class"
  | "Initiating Restore"
  | "Restore In Progress"
  | "Restore Complete"
  | "Starting DataSync"
  | "DataSync In Progress"
  | "Transfer Complete"
  | "Restore Timed Out"
  | "DataSync Failed"
  | "Transfer Timed Out"
  | "Transfer Status Unknown"
  | "Error";

/** API input for submitting a restore request */
export interface RestoreRequest {
  /** S3 bucket name (3-63 characters) */
  bucket: string;
  /** Array of S3 object keys (1-1000 items, each ≤1024 characters) */
  filePaths: string[];
  /** Speed tier for Glacier retrieval */
  retrievalTier: RetrievalTier;
  /** Number of days the restored object remains in S3 Standard (1-30, default 7) */
  restoreDays: number;
  /** NFS destination location ARN for DataSync transfer */
  destinationLocationArn?: string;
}

/** Represents a DataSync destination available for transfer */
export interface DataSyncDestination {
  /** DataSync location ARN */
  locationArn: string;
  /** URI of the NFS/location (e.g., nfs://server/path) */
  locationUri: string;
}

/** A single entry in the status change timeline */
export interface StatusHistoryEntry {
  status: RequestStatus;
  /** ISO 8601 timestamp when this status was set */
  timestamp: string;
}

/** Persisted request record stored in DynamoDB */
export interface RestoreRequestRecord {
  /** Partition key (ULID for time-ordered uniqueness) */
  requestId: string;
  bucket: string;
  filePaths: string[];
  retrievalTier: RetrievalTier;
  /** Number of days the restored object remains in S3 Standard */
  restoreDays: number;
  status: RequestStatus;
  /** ISO 8601 timestamp */
  submittedAt: string;
  /** ISO 8601 timestamp (set on completion) */
  completedAt?: string;
  /** ISO 8601 timestamp when the restored objects expire back to Glacier */
  restoreExpiresAt?: string;
  /** S3 Batch Operations job ID (if batch) */
  batchJobId?: string;
  /** S3 key of the batch restore manifest in the staging bucket (for ≥50 objects) */
  manifestKey?: string;
  /** DataSync task execution ARN */
  dataSyncTaskArn?: string;
  /** NFS destination location ARN chosen by the user */
  destinationLocationArn?: string;
  /** Total objects in request */
  objectCount: number;
  /** Objects successfully restored */
  restoredCount: number;
  /** High-level error reason (displayed in UI for terminal error states) */
  errorReason?: string;
  /** Per-file error details */
  errorDetails?: ErrorDetail[];
  /** Timeline of status transitions */
  statusHistory?: StatusHistoryEntry[];
  /** DynamoDB TTL (30 days after completion) */
  ttl: number;
}

/** Storage class detection result for a single object */
export interface StorageClassInfo {
  filePath: string;
  storageClass: StorageClass;
  exists: boolean;
  /** Current restore status (only relevant for GLACIER/DEEP_ARCHIVE objects) */
  restoreStatus?: "not_started" | "in_progress" | "completed";
  error?: string;
}

/** Error detail for a specific file in the workflow */
export interface ErrorDetail {
  filePath: string;
  step: string;
  reason: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Validation error for a specific field */
export interface ValidationError {
  field: string;
  message: string;
}

/** Result of input validation */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** Deduplicated file paths (only present when valid) */
  deduplicatedPaths?: string[];
  /** Validated restore days (only present when valid) */
  restoreDays?: number;
}
