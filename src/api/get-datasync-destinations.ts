/**
 * GET /datasync-destinations handler.
 *
 * Lists available DataSync destination locations (NFS) that users can choose
 * as the transfer target for their restore requests.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DataSyncClient,
  ListLocationsCommand,
} from "@aws-sdk/client-datasync";
import type { DataSyncDestination } from "../shared/types";

const dataSyncClient = new DataSyncClient({});

/** Standard CORS headers applied to all responses */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

/**
 * Lambda handler for GET /datasync-destinations.
 *
 * Lists all NFS destination locations configured in DataSync that can be
 * used as transfer targets. Filters to only NFS-type locations.
 */
export async function handler(
  _event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const destinations: DataSyncDestination[] = [];
    const seenUris = new Set<string>();
    let nextToken: string | undefined;

    do {
      const response = await dataSyncClient.send(
        new ListLocationsCommand({
          NextToken: nextToken,
          Filters: [
            {
              Name: "LocationType",
              Values: ["NFS"],
              Operator: "Equals",
            },
          ],
        })
      );

      if (response.Locations) {
        for (const loc of response.Locations) {
          if (loc.LocationArn && loc.LocationUri && !seenUris.has(loc.LocationUri)) {
            seenUris.add(loc.LocationUri);
            destinations.push({
              locationArn: loc.LocationArn,
              locationUri: loc.LocationUri,
            });
          }
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ destinations }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: `Failed to list DataSync destinations: ${message}`,
      }),
    };
  }
}
