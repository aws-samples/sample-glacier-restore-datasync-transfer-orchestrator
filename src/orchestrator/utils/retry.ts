/**
 * Exponential backoff retry utility with error classification.
 *
 * Supports configurable max attempts, base delay, multiplier, and max delay.
 * Classifies AWS SDK errors into throttling (retryable), transient (retryable),
 * and non-retryable categories.
 */

/** Configuration for the retry function */
export interface RetryConfig {
  /** Maximum number of attempts (including the initial attempt) */
  maxAttempts: number;
  /** Base delay in milliseconds before the first retry */
  baseDelayMs: number;
  /** Multiplier applied to the delay on each subsequent retry */
  multiplier: number;
  /** Maximum delay cap in milliseconds */
  maxDelayMs: number;
}

/** Error classification result */
export type ErrorCategory = "throttling" | "transient" | "non-retryable";

/** AWS SDK error codes that indicate throttling (retryable) */
const THROTTLING_ERROR_CODES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "Throttling",
  "SlowDown",
]);

/** AWS SDK error codes/names that indicate transient errors (retryable) */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "InternalError",
  "ServiceUnavailable",
  "RequestTimeout",
  "NetworkingError",
]);

/** HTTP status codes that indicate transient errors */
const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([500, 503]);

/** AWS SDK error codes that are non-retryable */
const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "NoSuchKey",
  "InvalidRequest",
  "NoSuchBucket",
  "InvalidObjectState",
]);

/**
 * Classifies an error into one of three categories:
 * - "throttling": retryable, caused by rate limiting
 * - "transient": retryable, caused by temporary service issues
 * - "non-retryable": permanent errors that should not be retried
 */
export function classifyError(error: unknown): ErrorCategory {
  if (!isErrorLike(error)) {
    return "non-retryable";
  }

  const code = getErrorCode(error);
  const statusCode = getStatusCode(error);

  // Check non-retryable first (most specific)
  if (code && NON_RETRYABLE_ERROR_CODES.has(code)) {
    return "non-retryable";
  }

  // Check throttling errors
  if (code && THROTTLING_ERROR_CODES.has(code)) {
    return "throttling";
  }

  // Check transient errors by code
  if (code && TRANSIENT_ERROR_CODES.has(code)) {
    return "transient";
  }

  // Check transient errors by HTTP status code
  if (statusCode !== undefined && TRANSIENT_STATUS_CODES.has(statusCode)) {
    return "transient";
  }

  // Default: non-retryable (unknown errors are not retried)
  return "non-retryable";
}

/**
 * Calculates the delay for a given attempt using exponential backoff.
 *
 * @param attempt - Zero-based attempt index (0 = first retry)
 * @param config - Retry configuration
 * @returns Delay in milliseconds, capped at maxDelayMs
 */
export function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelayMs * Math.pow(config.multiplier, attempt);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Retries an async operation with exponential backoff.
 *
 * Only retries on throttling and transient errors. Non-retryable errors
 * are thrown immediately without consuming retry attempts.
 *
 * @param operation - The async function to retry
 * @param config - Retry configuration (maxAttempts, baseDelayMs, multiplier, maxDelayMs)
 * @param operationName - Descriptive name for error context
 * @returns The result of the operation on success
 * @throws The last error encountered after all attempts are exhausted, or immediately for non-retryable errors
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  operationName: string
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      const category = classifyError(error);

      // Non-retryable errors are thrown immediately
      if (category === "non-retryable") {
        throw new RetryError(
          `Operation "${operationName}" failed with non-retryable error`,
          error,
          attempt + 1,
          config.maxAttempts
        );
      }

      // If this was the last attempt, don't wait — fall through to throw
      if (attempt < config.maxAttempts - 1) {
        const delay = calculateDelay(attempt, config);
        await sleep(delay);
      }
    }
  }

  // All attempts exhausted
  throw new RetryError(
    `Operation "${operationName}" failed after ${config.maxAttempts} attempts`,
    lastError,
    config.maxAttempts,
    config.maxAttempts
  );
}

/**
 * Error thrown when retry attempts are exhausted or a non-retryable error is encountered.
 */
export class RetryError extends Error {
  /** The underlying error that caused the failure */
  public readonly cause: unknown;
  /** Number of attempts made before failure */
  public readonly attempts: number;
  /** Maximum attempts configured */
  public readonly maxAttempts: number;

  constructor(
    message: string,
    cause: unknown,
    attempts: number,
    maxAttempts: number
  ) {
    super(message);
    this.name = "RetryError";
    this.cause = cause;
    this.attempts = attempts;
    this.maxAttempts = maxAttempts;
  }
}

// --- Internal helpers ---

interface ErrorLike {
  name?: string;
  code?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
  statusCode?: number;
}

function isErrorLike(error: unknown): error is ErrorLike {
  return typeof error === "object" && error !== null;
}

function getErrorCode(error: ErrorLike): string | undefined {
  // AWS SDK v3 uses `name` for the error code
  // Some errors use `code` or `Code`
  return error.name || error.code || error.Code;
}

function getStatusCode(error: ErrorLike): number | undefined {
  // AWS SDK v3 puts HTTP status in $metadata
  return error.$metadata?.httpStatusCode ?? error.statusCode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
