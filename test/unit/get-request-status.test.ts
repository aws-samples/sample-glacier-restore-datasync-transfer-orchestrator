import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler } from "../../src/api/get-request-status";
import type { RestoreRequestRecord } from "../../src/shared/types";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("GET /requests/{requestId} handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.TABLE_NAME = "test-restore-requests";
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
  });

  function makeEvent(requestId?: string): APIGatewayProxyEvent {
    return {
      pathParameters: requestId ? { requestId } : null,
      body: null,
      headers: {},
      multiValueHeaders: {},
      httpMethod: "GET",
      isBase64Encoded: false,
      path: `/requests/${requestId ?? ""}`,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
    };
  }

  it("returns 200 with the full request record when found", async () => {
    const mockRecord: RestoreRequestRecord = {
      requestId: "01HTEST000000000000000001",
      bucket: "my-glacier-bucket",
      filePaths: ["data/file1.dat", "data/file2.dat"],
      retrievalTier: "Standard",
      restoreDays: 7,
      status: "Restore In Progress",
      submittedAt: "2024-01-15T10:00:00.000Z",
      objectCount: 2,
      restoredCount: 1,
      ttl: 1234567890,
    };

    ddbMock.on(QueryCommand).resolves({ Items: [mockRecord] });

    const result = await handler(makeEvent("01HTEST000000000000000001"));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(mockRecord);
    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("returns 200 with error details when present", async () => {
    const mockRecord: RestoreRequestRecord = {
      requestId: "01HTEST000000000000000002",
      bucket: "my-bucket",
      filePaths: ["data/missing.dat"],
      retrievalTier: "Bulk",
      restoreDays: 7,
      status: "Error",
      submittedAt: "2024-01-15T09:00:00.000Z",
      objectCount: 1,
      restoredCount: 0,
      ttl: 1234567890,
      errorDetails: [
        {
          filePath: "data/missing.dat",
          step: "detect-storage-class",
          reason: "Object not found",
          timestamp: "2024-01-15T09:01:00.000Z",
        },
      ],
    };

    ddbMock.on(QueryCommand).resolves({ Items: [mockRecord] });

    const result = await handler(makeEvent("01HTEST000000000000000002"));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.errorDetails).toHaveLength(1);
    expect(body.errorDetails[0].reason).toBe("Object not found");
  });

  it("returns 200 with restoreExpiresAt when restore has completed", async () => {
    const mockRecord: RestoreRequestRecord = {
      requestId: "01HTEST000000000000000005",
      bucket: "my-glacier-bucket",
      filePaths: ["data/file1.dat"],
      retrievalTier: "Standard",
      restoreDays: 14,
      status: "Transfer Complete",
      submittedAt: "2024-01-15T10:00:00.000Z",
      completedAt: "2024-01-15T12:00:00.000Z",
      restoreExpiresAt: "2024-01-29T11:30:00.000Z",
      objectCount: 1,
      restoredCount: 1,
      ttl: 1234567890,
    };

    ddbMock.on(QueryCommand).resolves({ Items: [mockRecord] });

    const result = await handler(makeEvent("01HTEST000000000000000005"));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.restoreExpiresAt).toBe("2024-01-29T11:30:00.000Z");
    expect(body.restoreDays).toBe(14);
  });

  it("returns 404 when request is not found", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent("nonexistent-id"));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: "Request not found" });
    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("returns 400 when requestId path parameter is missing", async () => {
    const event = makeEvent(undefined);
    event.pathParameters = null;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: "Missing requestId path parameter",
    });
    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("returns 500 when DynamoDB query fails", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("DynamoDB service unavailable"));

    const result = await handler(makeEvent("01HTEST000000000000000003"));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: "DynamoDB service unavailable",
    });
    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("returns 500 with the error message from the exception", async () => {
    ddbMock.on(QueryCommand).rejects("something went wrong");

    const result = await handler(makeEvent("01HTEST000000000000000004"));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toHaveProperty("error");
  });

  it("includes CORS headers on all responses", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent("any-id"));

    expect(result.headers).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    });
  });
});
