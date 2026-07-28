/**
 * GET /requests/{requestId} API handler.
 *
 * Returns the full request record including status, object counts, and error details.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getRequestRecord } from "../orchestrator/utils/status";

/** Standard CORS headers for all responses */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const requestId = event.pathParameters?.requestId;

  if (!requestId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Missing requestId path parameter" }),
    };
  }

  try {
    const record = await getRequestRecord(requestId);

    if (!record) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Request not found" }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(record),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: message }),
    };
  }
}
