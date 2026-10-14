import { mockClient } from "aws-sdk-client-mock";
import {
  DataSyncClient,
  ListLocationsCommand,
  DescribeLocationNfsCommand,
  DescribeAgentCommand,
} from "@aws-sdk/client-datasync";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler } from "../../src/api/get-datasync-destinations";

const dataSyncMock = mockClient(DataSyncClient);

/** Agent ARNs used to represent Basic (v2) and Enhanced (v3) agents in tests. */
const BASIC_AGENT = "arn:aws:datasync:us-east-1:123456789012:agent/agent-basic";
const ENHANCED_AGENT = "arn:aws:datasync:us-east-1:123456789012:agent/agent-enhanced";

/**
 * Stubs DescribeLocationNfs + DescribeAgent so each NFS location resolves to an
 * agent, and each agent reports a platform version. Keyed by location ARN.
 */
function stubAgents(
  locationToAgent: Record<string, string>,
  agentToVersion: Record<string, string>
): void {
  dataSyncMock.on(DescribeLocationNfsCommand).callsFake((input) => {
    const agentArn = locationToAgent[input.LocationArn as string];
    return { OnPremConfig: agentArn ? { AgentArns: [agentArn] } : undefined };
  });
  dataSyncMock.on(DescribeAgentCommand).callsFake((input) => {
    const version = agentToVersion[input.AgentArn as string];
    return { Platform: version ? { Version: version } : undefined };
  });
}

/** Helper to create a minimal APIGatewayProxyEvent */
function makeEvent(): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "GET",
    isBase64Encoded: false,
    path: "/datasync-destinations",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as never,
    resource: "",
  };
}

describe("GET /datasync-destinations handler", () => {
  beforeEach(() => {
    dataSyncMock.reset();
    // Default: locations resolve to no agent (UNKNOWN) unless a test overrides.
    dataSyncMock.on(DescribeLocationNfsCommand).resolves({});
    dataSyncMock.on(DescribeAgentCommand).resolves({});
  });

  it("returns an empty destinations array when no NFS locations exist", async () => {
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [],
    });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.destinations).toEqual([]);
  });

  it("returns NFS locations annotated with their agent task mode", async () => {
    const basicArn = "arn:aws:datasync:us-east-1:123456789012:location/loc-aaa111";
    const enhancedArn = "arn:aws:datasync:us-east-1:123456789012:location/loc-bbb222";
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [
        { LocationArn: basicArn, LocationUri: "nfs://10.0.0.5/data/destination-1" },
        { LocationArn: enhancedArn, LocationUri: "nfs://10.0.0.5/data/destination-2" },
      ],
    });
    stubAgents(
      { [basicArn]: BASIC_AGENT, [enhancedArn]: ENHANCED_AGENT },
      { [BASIC_AGENT]: "2", [ENHANCED_AGENT]: "3" }
    );

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.destinations).toHaveLength(2);
    expect(body.destinations[0]).toEqual({
      locationArn: basicArn,
      locationUri: "nfs://10.0.0.5/data/destination-1",
      taskMode: "BASIC",
      agentArn: BASIC_AGENT,
    });
    expect(body.destinations[1]).toEqual({
      locationArn: enhancedArn,
      locationUri: "nfs://10.0.0.5/data/destination-2",
      taskMode: "ENHANCED",
      agentArn: ENHANCED_AGENT,
    });
  });

  it("returns two distinct locations that share the same NFS URI", async () => {
    // The real-world bug: a Basic and an Enhanced location point at the same
    // NFS path. Both must be returned (deduped by ARN, not URI) so the user
    // can pick the one matching their requested mode.
    const basicArn = "arn:aws:datasync:us-east-1:123456789012:location/loc-basic";
    const enhancedArn = "arn:aws:datasync:us-east-1:123456789012:location/loc-enh";
    const sharedUri = "nfs://10.0.0.202/data/datasync-destination/";
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [
        { LocationArn: basicArn, LocationUri: sharedUri },
        { LocationArn: enhancedArn, LocationUri: sharedUri },
      ],
    });
    stubAgents(
      { [basicArn]: BASIC_AGENT, [enhancedArn]: ENHANCED_AGENT },
      { [BASIC_AGENT]: "2", [ENHANCED_AGENT]: "3" }
    );

    const result = await handler(makeEvent());

    const body = JSON.parse(result.body);
    expect(body.destinations).toHaveLength(2);
    const modes = body.destinations.map((d: { taskMode: string }) => d.taskMode).sort();
    expect(modes).toEqual(["BASIC", "ENHANCED"]);
  });

  it("reports UNKNOWN mode when a location has no agent", async () => {
    const arn = "arn:aws:datasync:us-east-1:123456789012:location/loc-noagent";
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [{ LocationArn: arn, LocationUri: "nfs://10.0.0.5/data/x" }],
    });
    stubAgents({}, {}); // no agent mapping → OnPremConfig undefined

    const result = await handler(makeEvent());

    const body = JSON.parse(result.body);
    expect(body.destinations[0].taskMode).toBe("UNKNOWN");
    expect(body.destinations[0].agentArn).toBeUndefined();
  });

  it("reports UNKNOWN mode when describing the location fails", async () => {
    const arn = "arn:aws:datasync:us-east-1:123456789012:location/loc-err";
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [{ LocationArn: arn, LocationUri: "nfs://10.0.0.5/data/x" }],
    });
    dataSyncMock.on(DescribeLocationNfsCommand).rejects(new Error("boom"));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.destinations[0].taskMode).toBe("UNKNOWN");
  });

  it("paginates through multiple pages of results", async () => {
    dataSyncMock
      .on(ListLocationsCommand)
      .resolvesOnce({
        Locations: [
          {
            LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-page1",
            LocationUri: "nfs://10.0.0.5/data/page1",
          },
        ],
        NextToken: "token-abc",
      })
      .resolvesOnce({
        Locations: [
          {
            LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-page2",
            LocationUri: "nfs://10.0.0.5/data/page2",
          },
        ],
      });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.destinations).toHaveLength(2);

    // Verify pagination was used
    const calls = dataSyncMock.commandCalls(ListLocationsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.NextToken).toBe("token-abc");
  });

  it("filters locations using LocationType NFS filter", async () => {
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [],
    });

    await handler(makeEvent());

    const calls = dataSyncMock.commandCalls(ListLocationsCommand);
    expect(calls[0].args[0].input.Filters).toEqual([
      {
        Name: "LocationType",
        Values: ["NFS"],
        Operator: "Equals",
      },
    ]);
  });

  it("skips locations missing LocationArn or LocationUri", async () => {
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [
        {
          LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-valid",
          LocationUri: "nfs://10.0.0.5/data/valid",
        },
        {
          LocationArn: undefined,
          LocationUri: "nfs://10.0.0.5/data/missing-arn",
        },
        {
          LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-no-uri",
          LocationUri: undefined,
        },
      ],
    });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.destinations).toHaveLength(1);
    expect(body.destinations[0].locationArn).toContain("loc-valid");
  });

  it("returns 500 with error message when DataSync API fails", async () => {
    dataSyncMock.on(ListLocationsCommand).rejects(new Error("Service unavailable"));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.message).toContain("Failed to list DataSync destinations");
    expect(body.message).toContain("Service unavailable");
  });

  it("includes CORS headers on all responses", async () => {
    dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });

    const result = await handler(makeEvent());

    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    });
  });

  it("includes CORS headers on error responses", async () => {
    dataSyncMock.on(ListLocationsCommand).rejects(new Error("fail"));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
    });
  });
});
