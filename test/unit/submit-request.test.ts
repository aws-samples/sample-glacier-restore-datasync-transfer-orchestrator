import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler } from "../../src/api/submit-request";

// Mock AWS SDK clients
const lambdaMock = mockClient(LambdaClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// Mock ulid for predictable request IDs
jest.mock("ulid", () => ({
  ulid: () => "01HTEST000000000000000001",
}));

/** Helper to create a minimal APIGatewayProxyEvent */
function makeEvent(body: unknown): APIGatewayProxyEvent {
  return {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: "POST",
    isBase64Encoded: false,
    path: "/requests",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as never,
    resource: "",
  };
}

describe("POST /requests handler", () => {
  beforeEach(() => {
    lambdaMock.reset();
    ddbMock.reset();
    process.env.TABLE_NAME = "test-restore-requests";
    process.env.ORCHESTRATOR_FUNCTION_NAME = "restore-orchestrator";
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TABLE_NAME;
    delete process.env.ORCHESTRATOR_FUNCTION_NAME;
  });

  describe("successful submission", () => {
    it("returns 202 with requestId and status on valid input", async () => {
      ddbMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({});

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["path/to/file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const body = JSON.parse(result.body);
      expect(body.requestId).toBe("01HTEST000000000000000001");
      expect(body.status).toBe("Submitted");
    });

    it("includes CORS headers in the response", async () => {
      ddbMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({});

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Bulk",
        restoreDays: 14,
      });

      const result = await handler(event);

      expect(result.headers).toMatchObject({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      });
    });

    it("invokes the orchestrator asynchronously with correct payload", async () => {
      ddbMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({});

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["data/file1.dat", "data/file2.dat"],
        retrievalTier: "Expedited",
        restoreDays: 3,
      });

      await handler(event);

      const calls = lambdaMock.commandCalls(InvokeCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.FunctionName).toBe("restore-orchestrator:$LATEST");
      expect(input.InvocationType).toBe("Event");

      const payload = JSON.parse(
        Buffer.from(input.Payload as Uint8Array).toString("utf-8")
      );
      expect(payload.requestId).toBe("01HTEST000000000000000001");
      expect(payload.bucket).toBe("my-bucket");
      expect(payload.filePaths).toEqual(["data/file1.dat", "data/file2.dat"]);
      expect(payload.retrievalTier).toBe("Expedited");
      expect(payload.restoreDays).toBe(3);
    });

    it("creates a request record in DynamoDB before invoking orchestrator", async () => {
      ddbMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({});

      const event = makeEvent({
        bucket: "test-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      });

      await handler(event);

      const ddbCalls = ddbMock.commandCalls(PutCommand);
      expect(ddbCalls).toHaveLength(1);
      expect(ddbCalls[0].args[0].input.Item).toMatchObject({
        requestId: "01HTEST000000000000000001",
        bucket: "test-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
        status: "Submitted",
      });
    });

    it("deduplicates file paths before processing", async () => {
      ddbMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({});

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat", "file.dat", "other.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      });

      await handler(event);

      const ddbCalls = ddbMock.commandCalls(PutCommand);
      const item = ddbCalls[0].args[0].input.Item!;
      expect(item.filePaths).toEqual(["file.dat", "other.dat"]);
      expect(item.objectCount).toBe(2);
    });

    it("defaults restoreDays to 7 when not provided", async () => {
      ddbMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({});

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
      });

      await handler(event);

      const ddbCalls = ddbMock.commandCalls(PutCommand);
      expect(ddbCalls[0].args[0].input.Item!.restoreDays).toBe(7);

      const lambdaCalls = lambdaMock.commandCalls(InvokeCommand);
      const payload = JSON.parse(
        Buffer.from(lambdaCalls[0].args[0].input.Payload as Uint8Array).toString("utf-8")
      );
      expect(payload.restoreDays).toBe(7);
    });
  });

  describe("validation errors", () => {
    it("returns 400 when bucket is missing", async () => {
      const event = makeEvent({
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors).toBeDefined();
      expect(body.errors.some((e: { field: string }) => e.field === "bucket")).toBe(true);
    });

    it("returns 400 when bucket is too short", async () => {
      const event = makeEvent({
        bucket: "ab",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors.some((e: { field: string }) => e.field === "bucket")).toBe(true);
    });

    it("returns 400 when filePaths is empty", async () => {
      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: [],
        retrievalTier: "Standard",
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors.some((e: { field: string }) => e.field === "filePaths")).toBe(true);
    });

    it("returns 400 when retrievalTier is invalid", async () => {
      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "SuperFast",
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors.some((e: { field: string }) => e.field === "retrievalTier")).toBe(true);
    });

    it("returns 400 when restoreDays is out of range", async () => {
      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 0,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors.some((e: { field: string }) => e.field === "restoreDays")).toBe(true);
    });

    it("returns 400 when restoreDays exceeds maximum", async () => {
      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 31,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors.some((e: { field: string }) => e.field === "restoreDays")).toBe(true);
    });

    it("returns 400 with multiple errors when multiple fields are invalid", async () => {
      const event = makeEvent({
        bucket: "",
        filePaths: "not-an-array",
        retrievalTier: "Invalid",
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("returns 400 when body is invalid JSON", async () => {
      const event = makeEvent("not valid json {{{");

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors[0].field).toBe("body");
      expect(body.errors[0].message).toContain("Invalid JSON");
    });

    it("includes CORS headers on validation error responses", async () => {
      const event = makeEvent({});

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(result.headers).toMatchObject({
        "Access-Control-Allow-Origin": "*",
      });
    });
  });

  describe("error handling", () => {
    it("returns 500 when DynamoDB record creation fails", async () => {
      ddbMock.on(PutCommand).rejects(new Error("DynamoDB error"));

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("Failed to create request record");
    });

    it("returns 500 when orchestrator invocation fails", async () => {
      ddbMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).rejects(new Error("Lambda invocation error"));

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("Failed to invoke the restore orchestrator");
    });

    it("returns 500 when ORCHESTRATOR_FUNCTION_NAME is not set", async () => {
      delete process.env.ORCHESTRATOR_FUNCTION_NAME;
      ddbMock.on(PutCommand).resolves({});

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("Orchestrator function not configured");
    });

    it("includes CORS headers on error responses", async () => {
      ddbMock.on(PutCommand).rejects(new Error("DynamoDB error"));

      const event = makeEvent({
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      });

      const result = await handler(event);

      expect(result.headers).toMatchObject({
        "Access-Control-Allow-Origin": "*",
      });
    });
  });
});
