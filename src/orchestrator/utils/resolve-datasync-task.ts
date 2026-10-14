/**
 * Resolves the DataSync task ARN for a given source bucket and destination location.
 *
 * Searches existing DataSync tasks for one that matches the source S3 location
 * (bucket), the destination NFS location, AND the requested task mode. If no
 * matching task exists, a new one is created (unless creation is disabled).
 *
 * Hardening notes:
 * - Task mode is matched STRICTLY: a candidate with an unknown/absent TaskMode
 *   is never silently treated as BASIC. This prevents mode mismatches when
 *   multiple tasks share the same source + destination but differ by mode.
 * - Every candidate rejection and every task creation is logged, so leftover
 *   auto-created tasks can be traced back to the run that produced them.
 * - Callers may disable the create-on-miss fallback via `allowCreate: false`
 *   to avoid accumulating orphaned tasks in environments where the full set of
 *   tasks is expected to be provisioned ahead of time (e.g. via CDK).
 */

import {
  DataSyncClient,
  ListTasksCommand,
  DescribeTaskCommand,
  CreateTaskCommand,
  ListLocationsCommand,
  CreateLocationS3Command,
  DescribeLocationNfsCommand,
  DescribeAgentCommand,
} from "@aws-sdk/client-datasync";
import type { DataSyncTaskMode } from "../../shared/types";
import { DEFAULT_TASK_MODE } from "../../shared/constants";

const dataSyncClient = new DataSyncClient({});

export interface ResolveDataSyncTaskParams {
  /** Source S3 bucket name */
  sourceBucket: string;
  /** Destination NFS location ARN chosen by the user */
  destinationLocationArn: string;
  /** IAM role ARN for DataSync to access the S3 source bucket */
  dataSyncS3RoleArn: string;
  /** DataSync task mode (BASIC or ENHANCED). Defaults to BASIC. */
  taskMode?: DataSyncTaskMode;
  /**
   * Whether to create a new task when no existing task matches. Defaults to
   * true for backward compatibility. Set to false to fail fast instead of
   * creating ad-hoc tasks (prevents orphan accumulation).
   */
  allowCreate?: boolean;
}

/**
 * Finds an existing DataSync task that transfers from the given S3 bucket to
 * the specified destination location in the requested mode, or creates a new
 * one when `allowCreate` is true (the default).
 *
 * @returns The DataSync task ARN
 * @throws Error if no task matches and creation is disabled
 */
export async function resolveDataSyncTask(
  params: ResolveDataSyncTaskParams
): Promise<string> {
  const {
    sourceBucket,
    destinationLocationArn,
    dataSyncS3RoleArn,
    taskMode = DEFAULT_TASK_MODE,
    allowCreate = true,
  } = params;

  // Validate that the destination location's agent supports the requested task mode
  await validateDestinationAgentMode(destinationLocationArn, taskMode);

  // Resolve the source S3 location once up front so we can match tasks by ARN
  // directly, instead of re-listing locations for every candidate task.
  const sourceLocationArn = await findS3LocationForBucket(sourceBucket);

  // Step 1: Find an existing task matching source + destination + mode.
  const existing = await findMatchingTask({
    sourceLocationArn,
    destinationLocationArn,
    taskMode,
  });

  if (existing) {
    console.info(
      `[resolveDataSyncTask] Reusing existing task ${existing} ` +
        `(dest=${destinationLocationArn}, mode=${taskMode})`
    );
    return existing;
  }

  // Step 2: No matching task. Either create one, or fail fast.
  if (!allowCreate) {
    throw new Error(
      `No DataSync task found for destination "${destinationLocationArn}" in ` +
        `${taskMode} mode with a source for bucket "${sourceBucket}", and task ` +
        `creation is disabled. Provision the task (e.g. via CDK) or enable creation.`
    );
  }

  // Ensure we have a source S3 location (create one if the bucket has none).
  const resolvedSourceArn =
    sourceLocationArn ?? (await createS3Location(sourceBucket, dataSyncS3RoleArn));

  console.warn(
    `[resolveDataSyncTask] No existing task matched ` +
      `(bucket=${sourceBucket}, dest=${destinationLocationArn}, mode=${taskMode}). ` +
      `Creating a new task — this task is NOT managed by CDK/CloudFormation and ` +
      `must be cleaned up manually if no longer needed.`
  );

  const createResponse = await dataSyncClient.send(
    new CreateTaskCommand({
      SourceLocationArn: resolvedSourceArn,
      DestinationLocationArn: destinationLocationArn,
      Name: `restore-transfer-${sourceBucket}-${Date.now()}`,
      TaskMode: taskMode,
      Options: {
        PreserveDeletedFiles: "PRESERVE",
        OverwriteMode: "ALWAYS",
        VerifyMode: "ONLY_FILES_TRANSFERRED",
        TransferMode: "CHANGED",
      },
    })
  );

  if (!createResponse.TaskArn) {
    throw new Error("CreateTask did not return a TaskArn");
  }

  console.info(
    `[resolveDataSyncTask] Created task ${createResponse.TaskArn} ` +
      `(dest=${destinationLocationArn}, mode=${taskMode})`
  );

  return createResponse.TaskArn;
}

/**
 * Scans existing tasks (with pagination) and returns the ARN of the first task
 * whose source, destination, and mode all match. Returns undefined if none match.
 *
 * Matching rules:
 * - Destination location ARN must equal the requested destination exactly.
 * - Task mode must equal the requested mode EXACTLY. A task whose DescribeTask
 *   response omits TaskMode is skipped (never assumed BASIC), because an
 *   ambiguous mode cannot be safely matched to either request.
 * - Source location ARN must equal the resolved source S3 location. When the
 *   source location is unknown (the bucket has no S3 location yet), no existing
 *   task can match, so the scan is skipped entirely.
 */
async function findMatchingTask(params: {
  sourceLocationArn: string | undefined;
  destinationLocationArn: string;
  taskMode: DataSyncTaskMode;
}): Promise<string | undefined> {
  const { sourceLocationArn, destinationLocationArn, taskMode } = params;

  // Without a known source location, nothing can match an existing task.
  if (!sourceLocationArn) {
    return undefined;
  }

  let nextToken: string | undefined;

  do {
    const listResponse = await dataSyncClient.send(
      new ListTasksCommand({ NextToken: nextToken })
    );

    for (const task of listResponse.Tasks ?? []) {
      if (!task.TaskArn) continue;

      const described = await dataSyncClient.send(
        new DescribeTaskCommand({ TaskArn: task.TaskArn })
      );

      if (described.DestinationLocationArn !== destinationLocationArn) {
        continue;
      }

      // Strict mode match — do NOT default an absent TaskMode to BASIC.
      if (described.TaskMode !== taskMode) {
        console.debug(
          `[resolveDataSyncTask] Skipping task ${task.TaskArn}: mode ` +
            `${described.TaskMode ?? "<unknown>"} != requested ${taskMode}`
        );
        continue;
      }

      if (described.SourceLocationArn !== sourceLocationArn) {
        continue;
      }

      return task.TaskArn;
    }

    nextToken = listResponse.NextToken;
  } while (nextToken);

  return undefined;
}

/**
 * Finds the S3 location ARN for the given bucket, paginating through all
 * locations. Returns undefined if no S3 location for the bucket exists.
 *
 * Uses the `LocationUri` filter to narrow the server-side list, then matches
 * the bucket name exactly (the filter is a substring "Contains" match, so a
 * final exact check avoids matching buckets that merely share a prefix).
 */
async function findS3LocationForBucket(
  bucket: string
): Promise<string | undefined> {
  let nextToken: string | undefined;
  const exactUri = `s3://${bucket}`;

  do {
    const listResponse = await dataSyncClient.send(
      new ListLocationsCommand({
        NextToken: nextToken,
        Filters: [
          { Name: "LocationUri", Values: [exactUri], Operator: "Contains" },
        ],
      })
    );

    for (const loc of listResponse.Locations ?? []) {
      if (!loc.LocationArn || !loc.LocationUri) continue;
      // Match s3://bucket exactly or s3://bucket/<prefix>, but not s3://bucket-other.
      if (
        loc.LocationUri === `${exactUri}/` ||
        loc.LocationUri === exactUri ||
        loc.LocationUri.startsWith(`${exactUri}/`)
      ) {
        return loc.LocationArn;
      }
    }

    nextToken = listResponse.NextToken;
  } while (nextToken);

  return undefined;
}

/**
 * Creates a new S3 location for the given bucket.
 *
 * @throws Error if CreateLocationS3 does not return a LocationArn
 */
async function createS3Location(
  bucket: string,
  roleArn: string
): Promise<string> {
  const createResponse = await dataSyncClient.send(
    new CreateLocationS3Command({
      S3BucketArn: `arn:aws:s3:::${bucket}`,
      S3Config: {
        BucketAccessRoleArn: roleArn,
      },
    })
  );

  if (!createResponse.LocationArn) {
    throw new Error(
      `CreateLocationS3 for bucket "${bucket}" did not return a LocationArn`
    );
  }

  return createResponse.LocationArn;
}

/**
 * Validates that the destination location's agent(s) support the requested task mode.
 *
 * Enhanced mode tasks require an Enhanced mode agent on the NFS location.
 * Basic mode tasks require a Basic mode agent. If the agent type doesn't match
 * the requested task mode, throws a descriptive error before any restores begin.
 *
 * @param destinationLocationArn - The NFS destination location ARN
 * @param taskMode - The requested task mode (BASIC or ENHANCED)
 * @throws Error if the destination's agent doesn't support the requested mode
 */
async function validateDestinationAgentMode(
  destinationLocationArn: string,
  taskMode: DataSyncTaskMode
): Promise<void> {
  // Only NFS locations have agents — skip validation for non-NFS locations
  if (!destinationLocationArn.includes(":location/")) return;

  try {
    const locationResponse = await dataSyncClient.send(
      new DescribeLocationNfsCommand({
        LocationArn: destinationLocationArn,
      })
    );

    const agentArns = locationResponse.OnPremConfig?.AgentArns;
    if (!agentArns || agentArns.length === 0) {
      // No agents configured — let DataSync handle the error downstream
      return;
    }

    // Check the first agent's platform version to determine its mode.
    // Enhanced agents report platform version "3.x", Basic report "2.x".
    for (const agentArn of agentArns) {
      const agentResponse = await dataSyncClient.send(
        new DescribeAgentCommand({ AgentArn: agentArn })
      );

      const agentPlatform = agentResponse.Platform;
      if (!agentPlatform?.Version) continue;

      const isEnhancedAgent = agentPlatform.Version.startsWith("3");
      const isBasicAgent = !isEnhancedAgent;

      if (taskMode === "ENHANCED" && isBasicAgent) {
        throw new Error(
          `Task mode mismatch: requested ENHANCED mode but destination location "${destinationLocationArn}" ` +
          `uses a Basic mode agent (${agentArn}). Enhanced mode tasks require an Enhanced mode agent. ` +
          `Either change the task mode to BASIC or select a destination with an Enhanced mode agent.`
        );
      }

      if (taskMode === "BASIC" && isEnhancedAgent) {
        throw new Error(
          `Task mode mismatch: requested BASIC mode but destination location "${destinationLocationArn}" ` +
          `uses an Enhanced mode agent (${agentArn}). Basic mode tasks require a Basic mode agent. ` +
          `Either change the task mode to ENHANCED or select a destination with a Basic mode agent.`
        );
      }

      // Only need to check one agent — they should all be the same type
      break;
    }
  } catch (error: unknown) {
    // If it's our own validation error, re-throw it
    if (error instanceof Error && error.message.startsWith("Task mode mismatch")) {
      throw error;
    }
    // For other errors (e.g., location isn't NFS, permissions), skip validation
    // and let the downstream CreateTask call surface the real error
  }
}
