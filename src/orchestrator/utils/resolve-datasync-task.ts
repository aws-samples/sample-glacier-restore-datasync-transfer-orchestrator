/**
 * Resolves the DataSync task ARN for a given source bucket and destination location.
 *
 * Searches existing DataSync tasks for one that matches both the source S3 location
 * (bucket) and the specified NFS destination location. If no matching task exists,
 * creates a new one.
 */

import {
  DataSyncClient,
  ListTasksCommand,
  DescribeTaskCommand,
  CreateTaskCommand,
  ListLocationsCommand,
  CreateLocationS3Command,
} from "@aws-sdk/client-datasync";

const dataSyncClient = new DataSyncClient({});

export interface ResolveDataSyncTaskParams {
  /** Source S3 bucket name */
  sourceBucket: string;
  /** Destination NFS location ARN chosen by the user */
  destinationLocationArn: string;
  /** IAM role ARN for DataSync to access the S3 source bucket */
  dataSyncS3RoleArn: string;
}

/**
 * Finds an existing DataSync task that transfers from the given S3 bucket
 * to the specified destination location, or creates a new one.
 *
 * @returns The DataSync task ARN
 */
export async function resolveDataSyncTask(
  params: ResolveDataSyncTaskParams
): Promise<string> {
  const { sourceBucket, destinationLocationArn, dataSyncS3RoleArn } = params;

  // Step 1: List all tasks and find one matching our source + destination
  let nextToken: string | undefined;

  do {
    const listResponse = await dataSyncClient.send(
      new ListTasksCommand({ NextToken: nextToken })
    );

    if (listResponse.Tasks) {
      for (const task of listResponse.Tasks) {
        if (!task.TaskArn) continue;

        const described = await dataSyncClient.send(
          new DescribeTaskCommand({ TaskArn: task.TaskArn })
        );

        // Check if destination matches
        if (described.DestinationLocationArn !== destinationLocationArn) continue;

        // Check if source location is an S3 location for our bucket
        if (described.SourceLocationArn) {
          const isMatchingSource = await isS3LocationForBucket(
            described.SourceLocationArn,
            sourceBucket
          );
          if (isMatchingSource) {
            return task.TaskArn;
          }
        }
      }
    }

    nextToken = listResponse.NextToken;
  } while (nextToken);

  // Step 2: No matching task found — create one
  // First, find or create the S3 source location
  const sourceLocationArn = await findOrCreateS3Location(sourceBucket, dataSyncS3RoleArn);

  const createResponse = await dataSyncClient.send(
    new CreateTaskCommand({
      SourceLocationArn: sourceLocationArn,
      DestinationLocationArn: destinationLocationArn,
      Name: `restore-transfer-${sourceBucket}-${Date.now()}`,
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

  return createResponse.TaskArn;
}

/**
 * Checks if a DataSync location ARN is an S3 location pointing to the given bucket.
 */
async function isS3LocationForBucket(
  locationArn: string,
  bucket: string
): Promise<boolean> {
  try {
    // ListLocations with filter doesn't provide URI per-location easily,
    // so we check if the location URI contains the bucket name
    const listResponse = await dataSyncClient.send(
      new ListLocationsCommand({
        Filters: [
          { Name: "LocationUri", Values: [`s3://${bucket}`], Operator: "Contains" },
        ],
      })
    );

    return (
      listResponse.Locations?.some((loc) => loc.LocationArn === locationArn) ?? false
    );
  } catch {
    return false;
  }
}

/**
 * Finds an existing S3 location for the bucket or creates a new one.
 */
async function findOrCreateS3Location(
  bucket: string,
  roleArn: string
): Promise<string> {
  // Search for existing S3 location
  const listResponse = await dataSyncClient.send(
    new ListLocationsCommand({
      Filters: [
        { Name: "LocationUri", Values: [`s3://${bucket}`], Operator: "Contains" },
      ],
    })
  );

  if (listResponse.Locations && listResponse.Locations.length > 0) {
    const existing = listResponse.Locations[0];
    if (existing.LocationArn) {
      return existing.LocationArn;
    }
  }

  // Create a new S3 location
  const createResponse = await dataSyncClient.send(
    new CreateLocationS3Command({
      S3BucketArn: `arn:aws:s3:::${bucket}`,
      S3Config: {
        BucketAccessRoleArn: roleArn,
      },
    })
  );

  if (!createResponse.LocationArn) {
    throw new Error(`CreateLocationS3 for bucket "${bucket}" did not return a LocationArn`);
  }

  return createResponse.LocationArn;
}
