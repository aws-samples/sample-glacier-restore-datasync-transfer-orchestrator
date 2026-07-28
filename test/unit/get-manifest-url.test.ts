import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler } from "../../src/api/get-manifest-url";
import type { RestoreRequestRecord } from "../../src/shared/types";

// Mock the presigner
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://s3.amazonaws.com/presigned-url"),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("GET /requests/{requestId}/manifest handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.TABLE_NAME = "test-restore-requests";
    process.env.STAGING_BUCKET = "test-staging-bucket";
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.STAGING_BUCKET;
  });

  function makeEvent(requestId?: string): APIGatewayProxyEvent {
    return {
      pathParameters: requestId ? { requestId } : null,
      body: null,
      headers: {},
      multiValueHeaders: {},
      httpMethod: "GET",
      isBase64Encoded: false,
      path: `/requests/${requestId ?? ""}/manifest`,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
    };
  }

  it("returns 200 with pre-signed URL when manifest exists", async () => {
    const mockRecord: RestoreRequestRecord = {
      requestId: "req-001",
      bucket: "source-bucket",
      filePaths: Array.from({ length: 60 }, (_, i) => `file-${i}.dat`),
      retrievalTier: "Standard",
      restoreDays: 7,
      status: "Restore In Progress",
      submittedAt: "2024-01-15T10:00:00.000Z",
      objectCount: 60,
      restoredCount: 0,
      ttl: 1234567890,
      manifestKey: "manifests/restore-1234567890.csv",
    };

    ddbMock.on(QueryCommand).resolves({ Items: [mockRecord] });

    const result = await handler(makeEvent("req-001"));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.url).toBe("https://s3.amazonaws.com/presigned-url");
    expect(body.manifestKey).toBe("manifests/restore-1234567890.csv");
    expect(body.expiresInSeconds).toBe(900);
  });

  it("returns 404 when request has no manifest", async () => {
    const mockRecord: RestoreRequestRecord = {
      requestId: "req-002",
      bucket: "source-bucket",
      filePaths: ["file.dat"],
      retrievalTier: "Standard",
      restoreDays: 7,
      status: "Transfer Complete",
      submittedAt: "2024-01-15T10:00:00.000Z",
      objectCount: 1,
      restoredCount: 1,
      ttl: 1234567890,
    };

    ddbMock.on(QueryCommand).resolves({ Items: [mockRecord] });

    const result = await handler(makeEvent("req-002"));

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body);
    expect(body.error).toContain("No manifest available");
  });

  it("returns 404 when request is not found", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent("nonexistent"));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe("Request not found");
  });

  it("returns 400 when requestId is missing", async () => {
    const event = makeEvent(undefined);
    event.pathParameters = null;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it("returns 500 when STAGING_BUCKET is not set", async () => {
    delete process.env.STAGING_BUCKET;

    const result = await handler(makeEvent("req-001"));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toContain("Staging bucket not configured");
  });

  it("includes CORS headers on all responses", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent("any-id"));

    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
    });
  });
});
