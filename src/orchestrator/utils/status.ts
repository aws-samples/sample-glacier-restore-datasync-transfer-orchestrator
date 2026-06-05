/**
 * Status update helpers for persisting restore request state to DynamoDB.
 *
 * Uses the DynamoDB Document Client from @aws-sdk/lib-dynamodb for
 * simplified attribute marshalling.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import type {
  RestoreRequest,
  RestoreRequestRecord,
  RequestStatus,
  ErrorDetail,
  StatusHistoryEntry,
} from "../../shared/types";
import { TTL_SECONDS, MAX_RECENT_REQUESTS } from "../../shared/constants";

/** Gets the DynamoDB table name from environment */
function getTableName(): string {
  return process.env.TABLE_NAME ?? "";
}

/** Shared DynamoDB Document Client instance */
const ddbClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Creates an initial request record in DynamoDB with status "Submitted".
 *
 * Generates a ULID for the requestId (time-ordered uniqueness) and sets
 * the submittedAt timestamp, objectCount, restoredCount, and TTL.
 *
 * @param request - The incoming restore request (bucket, filePaths, retrievalTier)
 * @returns The persisted RestoreRequestRecord
 */
export async function createRequestRecord(
  request: RestoreRequest
): Promise<RestoreRequestRecord> {
  const now = new Date().toISOString();
  // If any paths contain wildcards, objectCount is unknown until glob expansion
  const hasGlobs = request.filePaths.some((p) => p.includes("*"));
  const record: RestoreRequestRecord = {
    requestId: ulid(),
    bucket: request.bucket,
    filePaths: request.filePaths,
    retrievalTier: request.retrievalTier,
    restoreDays: request.restoreDays,
    status: "Submitted",
    submittedAt: now,
    objectCount: hasGlobs ? 0 : request.filePaths.length,
    restoredCount: 0,
    statusHistory: [{ status: "Submitted", timestamp: now }],
    ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };

  await docClient.send(
    new PutCommand({
      TableName: getTableName(),
      Item: record,
    })
  );

  return record;
}

/**
 * Updates the status of an existing request record.
 *
 * Optionally merges additional fields (e.g., batchJobId, dataSyncTaskArn).
 * Also appends the new status to the statusHistory timeline.
 *
 * @param requestId - The request's partition key
 * @param submittedAt - The request's sort key (ISO 8601 timestamp)
 * @param status - The new status value
 * @param additionalFields - Optional additional fields to update
 */
export async function updateRequestStatus(
  requestId: string,
  submittedAt: string,
  status: RequestStatus,
  additionalFields?: Partial<RestoreRequestRecord>
): Promise<void> {
  let updateExpression = "SET #status = :status, #statusHistory = list_append(if_not_exists(#statusHistory, :emptyList), :historyEntry)";
  const expressionAttributeNames: Record<string, string> = {
    "#status": "status",
    "#statusHistory": "statusHistory",
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ":status": status,
    ":historyEntry": [{ status, timestamp: new Date().toISOString() }],
    ":emptyList": [],
  };

  if (additionalFields) {
    const { requestId: _id, submittedAt: _at, status: _s, ...fields } =
      additionalFields as Record<string, unknown>;

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        const attrPlaceholder = `#${key}`;
        const valuePlaceholder = `:${key}`;
        updateExpression += `, ${attrPlaceholder} = ${valuePlaceholder}`;
        expressionAttributeNames[attrPlaceholder] = key;
        expressionAttributeValues[valuePlaceholder] = value;
      }
    }
  }

  await docClient.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: { requestId, submittedAt },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
}

/**
 * Appends an error detail to the request's errorDetails list.
 *
 * Uses a list_append expression to add the error without overwriting
 * existing entries. Initializes the list if it doesn't exist.
 *
 * @param requestId - The request's partition key
 * @param submittedAt - The request's sort key
 * @param errorDetail - The error detail to append
 */
export async function recordError(
  requestId: string,
  submittedAt: string,
  errorDetail: ErrorDetail
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: { requestId, submittedAt },
      UpdateExpression:
        "SET #errorDetails = list_append(if_not_exists(#errorDetails, :emptyList), :error)",
      ExpressionAttributeNames: {
        "#errorDetails": "errorDetails",
      },
      ExpressionAttributeValues: {
        ":error": [errorDetail],
        ":emptyList": [],
      },
    })
  );
}

/**
 * Marks a request as complete by setting the final status, completedAt
 * timestamp, and updating the TTL to 30 days from now.
 *
 * @param requestId - The request's partition key
 * @param submittedAt - The request's sort key
 * @param finalStatus - The terminal status to set
 */
export async function markComplete(
  requestId: string,
  submittedAt: string,
  finalStatus: RequestStatus
): Promise<void> {
  const now = new Date().toISOString();
  const newTtl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  await docClient.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: { requestId, submittedAt },
      UpdateExpression:
        "SET #status = :status, #completedAt = :completedAt, #ttl = :ttl",
      ExpressionAttributeNames: {
        "#status": "status",
        "#completedAt": "completedAt",
        "#ttl": "ttl",
      },
      ExpressionAttributeValues: {
        ":status": finalStatus,
        ":completedAt": now,
        ":ttl": newTtl,
      },
    })
  );
}

/**
 * Retrieves a single request record by its requestId.
 *
 * Since the table uses requestId as partition key and submittedAt as sort key,
 * this performs a Query to find the record (there should be exactly one per requestId).
 *
 * @param requestId - The request's partition key
 * @returns The request record, or undefined if not found
 */
export async function getRequestRecord(
  requestId: string
): Promise<RestoreRequestRecord | undefined> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: getTableName(),
      KeyConditionExpression: "#requestId = :requestId",
      ExpressionAttributeNames: {
        "#requestId": "requestId",
      },
      ExpressionAttributeValues: {
        ":requestId": requestId,
      },
      Limit: 1,
    })
  );

  return result.Items?.[0] as RestoreRequestRecord | undefined;
}

/**
 * Queries recent requests, optionally filtered by status.
 *
 * When no status filter is provided, performs a Scan ordered by submittedAt descending.
 * When status filters are provided, queries the StatusIndex GSI for each status
 * and merges results sorted by submittedAt descending.
 *
 * @param limit - Maximum number of results (defaults to MAX_RECENT_REQUESTS = 50)
 * @param statusFilter - Optional array of status values to filter by
 * @returns Array of request records ordered by submittedAt descending
 */
export async function queryRecentRequests(
  limit: number = MAX_RECENT_REQUESTS,
  statusFilter?: RequestStatus[]
): Promise<RestoreRequestRecord[]> {
  if (statusFilter && statusFilter.length > 0) {
    // Query the StatusIndex GSI for each status and merge results
    const allResults: RestoreRequestRecord[] = [];

    for (const status of statusFilter) {
      const result = await docClient.send(
        new QueryCommand({
          TableName: getTableName(),
          IndexName: "StatusIndex",
          KeyConditionExpression: "#status = :status",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":status": status,
          },
          ScanIndexForward: false, // newest first
          Limit: limit,
        })
      );

      if (result.Items) {
        allResults.push(...(result.Items as RestoreRequestRecord[]));
      }
    }

    // Sort merged results by submittedAt descending and limit
    allResults.sort(
      (a, b) => b.submittedAt.localeCompare(a.submittedAt)
    );

    return allResults.slice(0, limit);
  }

  // No filter: scan the table and sort by submittedAt descending
  const scanResult = await docClient.send(
    new ScanCommand({
      TableName: getTableName(),
    })
  );

  const items = (scanResult.Items ?? []) as RestoreRequestRecord[];
  items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  return items.slice(0, limit);
}
