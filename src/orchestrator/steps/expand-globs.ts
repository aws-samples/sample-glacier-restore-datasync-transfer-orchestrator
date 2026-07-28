/**
 * Glob expansion step for the Glacier Restore Orchestrator.
 *
 * Expands wildcard patterns (e.g., "prefix/path/*.exr") into concrete S3 object keys
 * by listing objects in the bucket and filtering with glob matching.
 *
 * Supports single-level `*` glob only (no recursive `**`).
 */

import {
  S3Client,
  ListObjectsV2Command,
  type _Object,
} from "@aws-sdk/client-s3";

const s3Client = new S3Client({});

/**
 * Checks if a file path contains a glob pattern character.
 */
export function isGlobPattern(filePath: string): boolean {
  return filePath.includes("*");
}

/**
 * Validates that a glob pattern contains only safe characters.
 *
 * Allows alphanumeric, `/`, `.`, `-`, `_`, `*`, `[`, `]`, `(`, `)`,
 * and spaces. Rejects patterns that could be used to construct
 * malicious regexes (e.g., nested quantifiers or backreferences).
 *
 * @param pattern - The glob pattern to validate
 * @throws Error if the pattern contains disallowed characters
 */
function validateGlobPattern(pattern: string): void {
  const allowedChars = /^[a-zA-Z0-9\-_./\* \[\]()]+$/;
  if (!allowedChars.test(pattern)) {
    throw new Error(
      `Invalid glob pattern: contains disallowed characters. Only alphanumeric, -, _, ., /, *, [], (), and space are permitted.`
    );
  }
  if (pattern.length > 1024) {
    throw new Error(
      `Invalid glob pattern: exceeds maximum length of 1024 characters.`
    );
  }
}

/**
 * Pre-compiled regex patterns used by globToRegex for character escaping
 * and wildcard replacement. Using literals avoids constructing regex from
 * dynamic input and satisfies static analysis tooling.
 */
const GLOB_ESCAPE_PATTERN = /[.+^${}()|[\]\\]/g;
const GLOB_STAR_PATTERN = /\*/g;

/**
 * Converts a glob pattern into a regex for matching S3 keys.
 *
 * Supports `*` which matches any sequence of characters EXCEPT `/`.
 * Does not support `**` (recursive), `?`, or bracket expressions.
 *
 * Input is validated against an allowlist of safe characters before
 * regex construction to prevent ReDoS attacks.
 *
 * @param pattern - The glob pattern (e.g., "project/renders/*.exr")
 * @returns A RegExp that matches against full S3 object keys
 * @throws Error if the pattern contains disallowed characters
 */
export function globToRegex(pattern: string): RegExp {
  validateGlobPattern(pattern);
  // Escape regex special chars except `*`
  const escaped = pattern.replace(GLOB_ESCAPE_PATTERN, "\\$&");
  // Replace `*` with regex for "anything except /"
  const regexStr = "^" + escaped.replace(GLOB_STAR_PATTERN, "[^/]*") + "$";
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  // Safe: input is validated by validateGlobPattern() which restricts characters to an allowlist
  // (alphanumeric, -, _, ., /, *, [], (), space) and enforces a max length. The only dynamic
  // segments in the resulting regex are literal characters and `[^/]*`, which cannot cause ReDoS.
  return new RegExp(regexStr);
}

/**
 * Extracts the prefix portion of a glob pattern for use with ListObjectsV2.
 *
 * Returns everything before the first `*` character. If the pattern is
 * "project/renders/*.exr", the prefix is "project/renders/".
 *
 * @param pattern - The glob pattern
 * @returns The S3 prefix to use for listing
 */
export function extractPrefix(pattern: string): string {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return pattern;
  // Find the last `/` before the first `*`
  const prefixEnd = pattern.lastIndexOf("/", starIndex);
  return prefixEnd >= 0 ? pattern.substring(0, prefixEnd + 1) : "";
}

/**
 * Expands a single glob pattern into matching S3 object keys.
 *
 * Uses ListObjectsV2 with the prefix portion of the pattern, then
 * filters results against the full glob regex.
 *
 * @param bucket - S3 bucket to list
 * @param pattern - Glob pattern to expand
 * @returns Array of matching S3 object keys
 */
export async function expandGlob(
  bucket: string,
  pattern: string
): Promise<string[]> {
  const prefix = extractPrefix(pattern);
  const regex = globToRegex(pattern);
  const matchingKeys: string[] = [];

  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && regex.test(obj.Key)) {
          matchingKeys.push(obj.Key);
        }
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return matchingKeys;
}

/**
 * Expands all file paths, resolving any glob patterns into concrete keys.
 *
 * Literal paths are passed through unchanged. Glob patterns are expanded
 * via S3 listing. Results are deduplicated.
 *
 * @param bucket - S3 bucket name
 * @param filePaths - Array of file paths (may include glob patterns)
 * @returns Deduplicated array of concrete S3 object keys
 */
export async function expandAllGlobs(
  bucket: string,
  filePaths: string[]
): Promise<string[]> {
  const allKeys: string[] = [];

  for (const path of filePaths) {
    if (isGlobPattern(path)) {
      const expanded = await expandGlob(bucket, path);
      allKeys.push(...expanded);
    } else {
      allKeys.push(path);
    }
  }

  // Deduplicate
  return [...new Set(allKeys)];
}
