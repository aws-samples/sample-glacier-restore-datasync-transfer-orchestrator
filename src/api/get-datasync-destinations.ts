/**
 * GET /datasync-destinations handler.
 *
 * Lists available DataSync destination locations (NFS) that users can choose
 * as the transfer target for their restore requests.
 *
 * Each destination is annotated with the task mode its backing agent supports
 * (BASIC vs ENHANCED). Two locations can share the same NFS URI but be backed
 * by different agents (one Basic, one Enhanced); both are returned as distinct
 * entries so clients can pair the correct destination with the requested mode.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DataSyncClient,
  ListLocationsCommand,
  DescribeLocationNfsCommand,
  DescribeAgentCommand,
} from "@aws-sdk/client-datasync";
import type { DataSyncDestination, DataSyncTaskMode } from "../shared/types";

const dataSyncClient = new DataSyncClient({});

/** Standard CORS headers applied to all responses */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

/**
 * Determines the task mode supported by an NFS location based on its agent's
 * platform version.
 *
 * DataSync agents report a platform version: Enhanced-mode agents report "3",
 * Basic-mode agents report "2". The mode is inferred from the first agent on
 * the location (agents on a single location share the same mode).
 *
 * @param locationArn - The NFS location ARN to inspect
 * @returns The derived task mode and backing agent ARN. Mode is "UNKNOWN" when
 *          the location has no agent or the describe calls fail.
 */
async function resolveLocationMode(
  locationArn: string
): Promise<{ taskMode: DataSyncTaskMode | "UNKNOWN"; agentArn?: string }> {
  try {
    const location = await dataSyncClient.send(
      new DescribeLocationNfsCommand({ LocationArn: locationArn })
    );

    const agentArn = location.OnPremConfig?.AgentArns?.[0];
    if (!agentArn) {
      return { taskMode: "UNKNOWN" };
    }

    const agent = await dataSyncClient.send(
      new DescribeAgentCommand({ AgentArn: agentArn })
    );

    const version = agent.Platform?.Version;
    if (!version) {
      return { taskMode: "UNKNOWN", agentArn };
    }

    // Enhanced-mode agents report platform version "3"; Basic-mode report "2".
    const taskMode: DataSyncTaskMode = version.startsWith("3")
      ? "ENHANCED"
      : "BASIC";

    return { taskMode, agentArn };
  } catch {
    // Non-NFS location, missing permissions, or transient failure — surface as
    // UNKNOWN rather than failing the whole listing.
    return { taskMode: "UNKNOWN" };
  }
}

/**
 * Lambda handler for GET /datasync-destinations.
 *
 * Lists all NFS destination locations configured in DataSync that can be
 * used as transfer targets, each annotated with its supported task mode.
 * Deduplicates by location ARN so distinct locations that share an NFS URI
 * are both returned.
 */
export async function handler(
  _event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const seenArns = new Set<string>();
    const locationArns: { locationArn: string; locationUri: string }[] = [];
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
          if (loc.LocationArn && loc.LocationUri && !seenArns.has(loc.LocationArn)) {
            seenArns.add(loc.LocationArn);
            locationArns.push({
              locationArn: loc.LocationArn,
              locationUri: loc.LocationUri,
            });
          }
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    // Resolve each location's agent mode in parallel.
    const destinations: DataSyncDestination[] = await Promise.all(
      locationArns.map(async ({ locationArn, locationUri }) => {
        const { taskMode, agentArn } = await resolveLocationMode(locationArn);
        return { locationArn, locationUri, taskMode, agentArn };
      })
    );

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
