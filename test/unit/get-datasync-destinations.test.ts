import { mockClient } from "aws-sdk-client-mock";
import {
  DataSyncClient,
  ListLocationsCommand,
} from "@aws-sdk/client-datasync";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler } from "../../src/api/get-datasync-destinations";

const dataSyncMock = mockClient(DataSyncClient);

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

  it("returns NFS locations with locationArn and locationUri", async () => {
    dataSyncMock.on(ListLocationsCommand).resolves({
      Locations: [
        {
          LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-aaa111",
          LocationUri: "nfs://10.0.0.5/data/destination-1",
        },
        {
          LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-bbb222",
          LocationUri: "nfs://10.0.0.5/data/destination-2",
        },
      ],
    });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.destinations).toHaveLength(2);
    expect(body.destinations[0]).toEqual({
      locationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-aaa111",
      locationUri: "nfs://10.0.0.5/data/destination-1",
    });
    expect(body.destinations[1]).toEqual({
      locationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-bbb222",
      locationUri: "nfs://10.0.0.5/data/destination-2",
    });
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
