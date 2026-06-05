/**
 * POST /requests handler.
 *
 * Validates the incoming restore request, persists an initial record to DynamoDB,
 * invokes the Restore Orchestrator Lambda asynchronously, and returns the
 * request ID with initial status to the caller.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { validateRestoreRequest } from "../shared/validation";
import { createRequestRecord } from "../orchestrator/utils/status";

const lambdaClient = new LambdaClient({});

/** Standard CORS headers applied to all responses */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

/**
 * Lambda handler for POST /requests.
 *
 * 1. Parses the JSON body
 * 2. Validates input using shared validation logic
 * 3. Creates a request record in DynamoDB (status: Submitted)
 * 4. Invokes the orchestrator Lambda asynchronously
 * 5. Returns 202 Accepted with requestId and status
 */
export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  // Parse request body
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        errors: [{ field: "body", message: "Invalid JSON in request body" }],
      }),
    };
  }

  const input = body as Record<string, unknown>;

  // Validate input
  const validationResult = validateRestoreRequest({
    bucket: input.bucket,
    filePaths: input.filePaths,
    retrievalTier: input.retrievalTier,
    restoreDays: input.restoreDays,
  });

  if (!validationResult.valid) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ errors: validationResult.errors }),
    };
  }

  // Build the validated restore request using deduplicated paths
  const restoreRequest = {
    bucket: input.bucket as string,
    filePaths: validationResult.deduplicatedPaths!,
    retrievalTier: input.retrievalTier as string,
    restoreDays: validationResult.restoreDays!,
  };

  // Create the request record in DynamoDB
  let record;
  try {
    record = await createRequestRecord({
      bucket: restoreRequest.bucket,
      filePaths: restoreRequest.filePaths,
      retrievalTier: restoreRequest.retrievalTier as "Expedited" | "Standard" | "Bulk",
      restoreDays: restoreRequest.restoreDays,
    });
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Failed to create request record. Please retry.",
      }),
    };
  }

  // Invoke the orchestrator Lambda asynchronously
  const orchestratorFunctionName = process.env.ORCHESTRATOR_FUNCTION_NAME;
  if (!orchestratorFunctionName) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Orchestrator function not configured. Please contact support.",
      }),
    };
  }

  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: `${orchestratorFunctionName}:$LATEST`,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            requestId: record.requestId,
            submittedAt: record.submittedAt,
            bucket: record.bucket,
            filePaths: record.filePaths,
            retrievalTier: record.retrievalTier,
            restoreDays: record.restoreDays,
          })
        ),
      })
    );
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message:
          "Failed to invoke the restore orchestrator. The request was saved and can be retried.",
      }),
    };
  }

  // Return 202 Accepted with request ID and initial status
  return {
    statusCode: 202,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      requestId: record.requestId,
      status: record.status,
    }),
  };
}
