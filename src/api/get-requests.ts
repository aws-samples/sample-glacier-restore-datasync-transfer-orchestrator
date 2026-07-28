/**
 * GET /requests API handler.
 *
 * Returns the 50 most recent restore requests ordered by submittedAt descending.
 * Supports optional status filter via query parameter (comma-separated list).
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { queryRecentRequests } from "../orchestrator/utils/status";
import type { RequestStatus } from "../shared/types";
import { REQUEST_STATUSES } from "../shared/constants";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    // Parse optional status filter from query parameters
    const statusParam = event.queryStringParameters?.status;
    let statusFilter: RequestStatus[] | undefined;

    if (statusParam) {
      const statuses = statusParam.split(",").map((s) => s.trim());

      // Validate each status value
      const invalidStatuses = statuses.filter(
        (s) => !REQUEST_STATUSES.includes(s as RequestStatus)
      );

      if (invalidStatuses.length > 0) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            message: `Invalid status filter values: ${invalidStatuses.join(", ")}`,
          }),
        };
      }

      statusFilter = statuses as RequestStatus[];
    }

    const requests = await queryRecentRequests(50, statusFilter);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ requests }),
    };
  } catch (error) {
    console.error("Failed to query requests:", error);

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Failed to retrieve requests. Please try again later.",
      }),
    };
  }
}
