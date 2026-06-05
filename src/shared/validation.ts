/**
 * Input validation functions for restore requests.
 */

import type { RetrievalTier, ValidationError, ValidationResult } from "./types";
import {
  BUCKET_MIN_LENGTH,
  BUCKET_MAX_LENGTH,
  FILE_PATH_MIN_LENGTH,
  FILE_PATH_MAX_LENGTH,
  MIN_FILE_PATHS,
  MAX_FILE_PATHS,
  VALID_RETRIEVAL_TIERS,
  MIN_RESTORE_DAYS,
  MAX_RESTORE_DAYS,
  RESTORE_DURATION_DAYS,
} from "./constants";

/**
 * Validates a bucket name.
 * Must be a non-empty string between 3 and 63 characters.
 */
export function validateBucket(bucket: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof bucket !== "string" || bucket.length === 0) {
    errors.push({
      field: "bucket",
      message: `Bucket name must be a non-empty string between ${BUCKET_MIN_LENGTH} and ${BUCKET_MAX_LENGTH} characters`,
    });
    return errors;
  }

  if (bucket.length < BUCKET_MIN_LENGTH || bucket.length > BUCKET_MAX_LENGTH) {
    errors.push({
      field: "bucket",
      message: `Bucket name must be between ${BUCKET_MIN_LENGTH} and ${BUCKET_MAX_LENGTH} characters, got ${bucket.length}`,
    });
  }

  return errors;
}

/**
 * Validates a single file path.
 * Must be a non-empty string of at most 1024 characters.
 */
export function validateFilePath(filePath: unknown, index?: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldName = index !== undefined ? `filePaths[${index}]` : "filePath";

  if (typeof filePath !== "string" || filePath.length === 0) {
    errors.push({
      field: fieldName,
      message: `File path must be a non-empty string of at most ${FILE_PATH_MAX_LENGTH} characters`,
    });
    return errors;
  }

  if (filePath.length < FILE_PATH_MIN_LENGTH || filePath.length > FILE_PATH_MAX_LENGTH) {
    errors.push({
      field: fieldName,
      message: `File path must be between ${FILE_PATH_MIN_LENGTH} and ${FILE_PATH_MAX_LENGTH} characters, got ${filePath.length}`,
    });
  }

  return errors;
}

/**
 * Validates the restore days value.
 * Must be an integer between MIN_RESTORE_DAYS and MAX_RESTORE_DAYS.
 * Returns default value if undefined/null.
 */
export function validateRestoreDays(days: unknown): { value: number; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  // If not provided, use the default
  if (days === undefined || days === null) {
    return { value: RESTORE_DURATION_DAYS, errors: [] };
  }

  const numDays = typeof days === "string" ? parseInt(days, 10) : Number(days);

  if (!Number.isInteger(numDays) || numDays < MIN_RESTORE_DAYS || numDays > MAX_RESTORE_DAYS) {
    errors.push({
      field: "restoreDays",
      message: `Restore days must be an integer between ${MIN_RESTORE_DAYS} and ${MAX_RESTORE_DAYS}`,
    });
    return { value: RESTORE_DURATION_DAYS, errors };
  }

  return { value: numDays, errors: [] };
}

/**
 * Validates the retrieval tier.
 * Must be one of "Expedited", "Standard", or "Bulk".
 */
export function validateRetrievalTier(tier: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof tier !== "string" || !VALID_RETRIEVAL_TIERS.includes(tier as RetrievalTier)) {
    errors.push({
      field: "retrievalTier",
      message: `Retrieval tier must be one of: ${VALID_RETRIEVAL_TIERS.join(", ")}`,
    });
  }

  return errors;
}

/**
 * Validates and deduplicates an array of file paths.
 * Removes duplicates and validates the unique count is between minPaths and MAX_FILE_PATHS.
 *
 * @param filePaths - Array of file paths to validate
 * @param minPaths - Minimum number of unique paths required (default: 1 for single requests)
 * @returns Object with deduplicated paths and any validation errors
 */
export function validateAndDeduplicateFilePaths(
  filePaths: unknown,
  minPaths: number = MIN_FILE_PATHS
): { deduplicatedPaths: string[]; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!Array.isArray(filePaths)) {
    errors.push({
      field: "filePaths",
      message: "filePaths must be an array",
    });
    return { deduplicatedPaths: [], errors };
  }

  if (filePaths.length === 0) {
    errors.push({
      field: "filePaths",
      message: `filePaths must contain at least ${minPaths} file path(s)`,
    });
    return { deduplicatedPaths: [], errors };
  }

  // Validate individual paths
  for (let i = 0; i < filePaths.length; i++) {
    const pathErrors = validateFilePath(filePaths[i], i);
    errors.push(...pathErrors);
  }

  // If individual path validation failed, return early
  if (errors.length > 0) {
    return { deduplicatedPaths: [], errors };
  }

  // Deduplicate paths
  const uniquePaths = [...new Set(filePaths as string[])];

  // Validate unique count
  if (uniquePaths.length < minPaths) {
    errors.push({
      field: "filePaths",
      message: `filePaths must contain at least ${minPaths} unique file path(s), got ${uniquePaths.length} after deduplication`,
    });
  }

  if (uniquePaths.length > MAX_FILE_PATHS) {
    errors.push({
      field: "filePaths",
      message: `filePaths must contain at most ${MAX_FILE_PATHS} unique file paths, got ${uniquePaths.length} after deduplication`,
    });
  }

  return { deduplicatedPaths: uniquePaths, errors };
}

/**
 * Validates a complete restore request.
 * Returns field-specific errors indicating which field failed and why.
 *
 * For batch requests (multiple paths), requires 2-1000 unique paths.
 * For single file requests, requires exactly 1 path.
 */
export function validateRestoreRequest(input: {
  bucket?: unknown;
  filePaths?: unknown;
  retrievalTier?: unknown;
  restoreDays?: unknown;
}): ValidationResult {
  const allErrors: ValidationError[] = [];

  // Validate bucket
  allErrors.push(...validateBucket(input.bucket));

  // Validate retrieval tier
  allErrors.push(...validateRetrievalTier(input.retrievalTier));

  // Validate restore days
  const { value: restoreDays, errors: daysErrors } = validateRestoreDays(input.restoreDays);
  allErrors.push(...daysErrors);

  // Validate and deduplicate file paths (minimum 1 for any request)
  const { deduplicatedPaths, errors: pathErrors } = validateAndDeduplicateFilePaths(
    input.filePaths,
    MIN_FILE_PATHS
  );
  allErrors.push(...pathErrors);

  if (allErrors.length > 0) {
    return { valid: false, errors: allErrors };
  }

  return {
    valid: true,
    errors: [],
    deduplicatedPaths,
    restoreDays,
  };
}

/**
 * Validates a batch restore request.
 * Requires 2-1000 unique paths after deduplication (per Requirement 9.1).
 */
export function validateBatchRestoreRequest(input: {
  bucket?: unknown;
  filePaths?: unknown;
  retrievalTier?: unknown;
}): ValidationResult {
  const allErrors: ValidationError[] = [];

  // Validate bucket
  allErrors.push(...validateBucket(input.bucket));

  // Validate retrieval tier
  allErrors.push(...validateRetrievalTier(input.retrievalTier));

  // Validate and deduplicate file paths (minimum 2 for batch)
  const { deduplicatedPaths, errors: pathErrors } = validateAndDeduplicateFilePaths(
    input.filePaths,
    2
  );
  allErrors.push(...pathErrors);

  if (allErrors.length > 0) {
    return { valid: false, errors: allErrors };
  }

  return {
    valid: true,
    errors: [],
    deduplicatedPaths,
  };
}
