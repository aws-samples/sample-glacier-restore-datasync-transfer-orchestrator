import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler } from "../../src/api/get-requests";
import type { RestoreRequestRecord } from "../../src/shared/types";

// Mock the DynamoDB Document Client used by status.ts
const ddbMock = mockClient(DynamoDBDocumentClient);

describe("GET /requests handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.TABLE_NAME = "test-restore-requests";
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
  });

  function makeEvent(queryStringParameters?: Record<string, string> | null): APIGatewayProxyEvent {
    return {
      queryStringParameters: queryStringParameters ?? null,
      body: null,
      headers: {},
      multiValueHeaders: {},
      httpMethod: "GET",
      isBase64Encoded: false,
      path: "/requests",
      pathParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
    };
  }

  it("returns 200 with empty requests array when no records exist", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.requests).toEqual([]);
  });

  it("returns 200 with requests ordered by submittedAt descending", async () => {
    const items: Partial<RestoreRequestRecord>[] = [
      { requestId: "a", submittedAt: "2024-01-15T08:00:00.000Z", status: "Submitted" },
      { requestId: "b", submittedAt: "2024-01-15T10:00:00.000Z", status: "Transfer Complete" },
      { requestId: "c", submittedAt: "2024-01-15T09:00:00.000Z", status: "Error" },
    ];

    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.requests).toHaveLength(3);
    expect(body.requests[0].requestId).toBe("b");
    expect(body.requests[1].requestId).toBe("c");
    expect(body.requests[2].requestId).toBe("a");
  });

  it("filters by a single status query parameter", async () => {
    const submittedItems: Partial<RestoreRequestRecord>[] = [
      { requestId: "a", submittedAt: "2024-01-15T10:00:00.000Z", status: "Submitted" },
    ];

    ddbMock.on(QueryCommand).resolves({ Items: submittedItems });

    const result = await handler(makeEvent({ status: "Submitted" }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].status).toBe("Submitted");

    // Verify it used the StatusIndex GSI
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0].args[0].input.IndexName).toBe("StatusIndex");
  });

  it("filters by multiple comma-separated status values", async () => {
    const submittedItems: Partial<RestoreRequestRecord>[] = [
      { requestId: "a", submittedAt: "2024-01-15T10:00:00.000Z", status: "Submitted" },
    ];
    const errorItems: Partial<RestoreRequestRecord>[] = [
      { requestId: "b", submittedAt: "2024-01-15T09:00:00.000Z", status: "Error" },
    ];

    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "Submitted" } })
      .resolves({ Items: submittedItems })
      .on(QueryCommand, { ExpressionAttributeValues: { ":status": "Error" } })
      .resolves({ Items: errorItems });

    const result = await handler(makeEvent({ status: "Submitted,Error" }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.requests).toHaveLength(2);
    // Newest first
    expect(body.requests[0].requestId).toBe("a");
    expect(body.requests[1].requestId).toBe("b");
  });

  it("returns 400 for invalid status filter values", async () => {
    const result = await handler(makeEvent({ status: "InvalidStatus" }));

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.message).toContain("Invalid status filter values");
    expect(body.message).toContain("InvalidStatus");
  });

  it("returns 400 when one of multiple status values is invalid", async () => {
    const result = await handler(makeEvent({ status: "Submitted,BadValue" }));

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.message).toContain("BadValue");
  });

  it("returns 500 when DynamoDB query fails", async () => {
    ddbMock.on(ScanCommand).rejects(new Error("DynamoDB service unavailable"));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.message).toContain("Failed to retrieve requests");
  });

  it("includes CORS headers on success response", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await handler(makeEvent());

    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    });
  });

  it("includes CORS headers on error response", async () => {
    ddbMock.on(ScanCommand).rejects(new Error("fail"));

    const result = await handler(makeEvent());

    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    });
  });

  it("handles status filter with whitespace around values", async () => {
    const items: Partial<RestoreRequestRecord>[] = [
      { requestId: "a", submittedAt: "2024-01-15T10:00:00.000Z", status: "Submitted" },
    ];

    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await handler(makeEvent({ status: " Submitted , Error " }));

    // "Error" is valid, " Submitted " trimmed is valid
    expect(result.statusCode).toBe(200);
  });

  it("returns at most 50 requests without filter", async () => {
    const items: Partial<RestoreRequestRecord>[] = Array.from({ length: 60 }, (_, i) => ({
      requestId: `req-${i}`,
      submittedAt: `2024-01-15T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
      status: "Submitted" as const,
    }));

    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.requests).toHaveLength(50);
  });
});
