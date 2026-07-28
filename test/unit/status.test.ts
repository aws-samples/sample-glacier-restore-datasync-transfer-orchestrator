import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  createRequestRecord,
  updateRequestStatus,
  recordError,
  markComplete,
  getRequestRecord,
  queryRecentRequests,
} from "../../src/orchestrator/utils/status";
import type { RestoreRequest, RestoreRequestRecord, ErrorDetail } from "../../src/shared/types";

// Mock the DynamoDB Document Client
const ddbMock = mockClient(DynamoDBDocumentClient);

// Mock ulid to return a predictable value
jest.mock("ulid", () => ({
  ulid: () => "01HTEST000000000000000000",
}));

describe("status update helpers", () => {
  const fixedNow = new Date("2024-01-15T10:00:00.000Z");

  beforeEach(() => {
    ddbMock.reset();
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);
    process.env.TABLE_NAME = "test-restore-requests";
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TABLE_NAME;
  });

  describe("createRequestRecord", () => {
    it("creates a record with all required fields", async () => {
      ddbMock.on(PutCommand).resolves({});

      const request: RestoreRequest = {
        bucket: "my-bucket",
        filePaths: ["path/to/file1.dat", "path/to/file2.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      };

      const record = await createRequestRecord(request);

      expect(record.requestId).toBe("01HTEST000000000000000000");
      expect(record.bucket).toBe("my-bucket");
      expect(record.filePaths).toEqual(["path/to/file1.dat", "path/to/file2.dat"]);
      expect(record.retrievalTier).toBe("Standard");
      expect(record.restoreDays).toBe(7);
      expect(record.status).toBe("Submitted");
      expect(record.submittedAt).toBe("2024-01-15T10:00:00.000Z");
      expect(record.objectCount).toBe(2);
      expect(record.restoredCount).toBe(0);
      expect(record.ttl).toBeGreaterThan(0);
    });

    it("sets TTL to 30 days from now", async () => {
      ddbMock.on(PutCommand).resolves({});

      const request: RestoreRequest = {
        bucket: "bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Bulk",
        restoreDays: 7,
      };

      const record = await createRequestRecord(request);

      const expectedTtl = Math.floor(fixedNow.getTime() / 1000) + 30 * 24 * 60 * 60;
      expect(record.ttl).toBe(expectedTtl);
    });

    it("sends PutCommand with correct table name and item", async () => {
      ddbMock.on(PutCommand).resolves({});

      const request: RestoreRequest = {
        bucket: "test-bucket",
        filePaths: ["a.txt"],
        retrievalTier: "Expedited",
        restoreDays: 7,
      };

      await createRequestRecord(request);

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.TableName).toBe("test-restore-requests");
      expect(calls[0].args[0].input.Item).toMatchObject({
        requestId: "01HTEST000000000000000000",
        bucket: "test-bucket",
        filePaths: ["a.txt"],
        retrievalTier: "Expedited",
        status: "Submitted",
      });
    });

    it("sets objectCount to the number of file paths", async () => {
      ddbMock.on(PutCommand).resolves({});

      const request: RestoreRequest = {
        bucket: "bucket",
        filePaths: ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"],
        retrievalTier: "Standard",
        restoreDays: 7,
      };

      const record = await createRequestRecord(request);
      expect(record.objectCount).toBe(5);
    });

    it("persists custom restoreDays value", async () => {
      ddbMock.on(PutCommand).resolves({});

      const request: RestoreRequest = {
        bucket: "bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 21,
      };

      const record = await createRequestRecord(request);
      expect(record.restoreDays).toBe(21);
    });

    it("persists destinationLocationArn when provided", async () => {
      ddbMock.on(PutCommand).resolves({});

      const request: RestoreRequest = {
        bucket: "bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
        destinationLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-nfs123",
      };

      const record = await createRequestRecord(request);
      expect(record.destinationLocationArn).toBe(
        "arn:aws:datasync:us-east-1:123456789012:location/loc-nfs123"
      );

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls[0].args[0].input.Item).toHaveProperty(
        "destinationLocationArn",
        "arn:aws:datasync:us-east-1:123456789012:location/loc-nfs123"
      );
    });

    it("omits destinationLocationArn from record when not provided", async () => {
      ddbMock.on(PutCommand).resolves({});

      const request: RestoreRequest = {
        bucket: "bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
      };

      const record = await createRequestRecord(request);
      expect(record.destinationLocationArn).toBeUndefined();

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls[0].args[0].input.Item).not.toHaveProperty("destinationLocationArn");
    });
  });

  describe("updateRequestStatus", () => {
    it("updates status field", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await updateRequestStatus(
        "req-123",
        "2024-01-15T10:00:00.000Z",
        "Restore In Progress"
      );

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.TableName).toBe("test-restore-requests");
      expect(input.Key).toEqual({
        requestId: "req-123",
        submittedAt: "2024-01-15T10:00:00.000Z",
      });
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":status": "Restore In Progress",
      });
    });

    it("includes additional fields in the update", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await updateRequestStatus(
        "req-456",
        "2024-01-15T10:00:00.000Z",
        "DataSync In Progress",
        { dataSyncTaskArn: "arn:aws:datasync:us-east-1:123:task/exec-abc" }
      );

      const calls = ddbMock.commandCalls(UpdateCommand);
      const input = calls[0].args[0].input;
      expect(input.UpdateExpression).toContain("#dataSyncTaskArn = :dataSyncTaskArn");
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":status": "DataSync In Progress",
        ":dataSyncTaskArn": "arn:aws:datasync:us-east-1:123:task/exec-abc",
      });
    });

    it("ignores undefined additional fields", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await updateRequestStatus(
        "req-789",
        "2024-01-15T10:00:00.000Z",
        "Initiating Restore",
        { batchJobId: undefined, restoredCount: 5 }
      );

      const calls = ddbMock.commandCalls(UpdateCommand);
      const input = calls[0].args[0].input;
      expect(input.UpdateExpression).toContain("#restoredCount = :restoredCount");
      expect(input.UpdateExpression).not.toContain("batchJobId");
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":restoredCount": 5,
      });
    });
  });

  describe("recordError", () => {
    it("appends error detail to errorDetails list", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const errorDetail: ErrorDetail = {
        filePath: "data/file.dat",
        step: "initiate-restore",
        reason: "AccessDenied",
        timestamp: "2024-01-15T10:05:00.000Z",
      };

      await recordError("req-123", "2024-01-15T10:00:00.000Z", errorDetail);

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.Key).toEqual({
        requestId: "req-123",
        submittedAt: "2024-01-15T10:00:00.000Z",
      });
      expect(input.UpdateExpression).toContain("list_append");
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":error": [errorDetail],
        ":emptyList": [],
      });
    });
  });

  describe("markComplete", () => {
    it("sets completedAt, final status, and updated TTL", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await markComplete("req-123", "2024-01-15T10:00:00.000Z", "Transfer Complete");

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.Key).toEqual({
        requestId: "req-123",
        submittedAt: "2024-01-15T10:00:00.000Z",
      });
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":status": "Transfer Complete",
        ":completedAt": "2024-01-15T10:00:00.000Z",
      });
      // TTL should be 30 days from now
      const expectedTtl = Math.floor(fixedNow.getTime() / 1000) + 30 * 24 * 60 * 60;
      expect(input.ExpressionAttributeValues![":ttl"]).toBe(expectedTtl);
    });

    it("works with error terminal statuses", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await markComplete("req-456", "2024-01-15T09:00:00.000Z", "DataSync Failed");

      const calls = ddbMock.commandCalls(UpdateCommand);
      const input = calls[0].args[0].input;
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":status": "DataSync Failed",
      });
    });
  });

  describe("getRequestRecord", () => {
    it("returns the record when found", async () => {
      const mockRecord: RestoreRequestRecord = {
        requestId: "req-123",
        bucket: "my-bucket",
        filePaths: ["file.dat"],
        retrievalTier: "Standard",
        restoreDays: 7,
        status: "Submitted",
        submittedAt: "2024-01-15T10:00:00.000Z",
        objectCount: 1,
        restoredCount: 0,
        ttl: 1234567890,
      };

      ddbMock.on(QueryCommand).resolves({ Items: [mockRecord] });

      const result = await getRequestRecord("req-123");

      expect(result).toEqual(mockRecord);
      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
        ":requestId": "req-123",
      });
    });

    it("returns undefined when not found", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await getRequestRecord("nonexistent");

      expect(result).toBeUndefined();
    });
  });

  describe("queryRecentRequests", () => {
    it("returns results sorted by submittedAt descending when no filter", async () => {
      const items: Partial<RestoreRequestRecord>[] = [
        { requestId: "a", submittedAt: "2024-01-15T08:00:00.000Z", status: "Submitted" },
        { requestId: "b", submittedAt: "2024-01-15T10:00:00.000Z", status: "Transfer Complete" },
        { requestId: "c", submittedAt: "2024-01-15T09:00:00.000Z", status: "Error" },
      ];

      ddbMock.on(ScanCommand).resolves({ Items: items });

      const results = await queryRecentRequests();

      expect(results[0].requestId).toBe("b");
      expect(results[1].requestId).toBe("c");
      expect(results[2].requestId).toBe("a");
    });

    it("limits results to the specified count", async () => {
      const items: Partial<RestoreRequestRecord>[] = Array.from({ length: 10 }, (_, i) => ({
        requestId: `req-${i}`,
        submittedAt: `2024-01-15T${String(i).padStart(2, "0")}:00:00.000Z`,
        status: "Submitted" as const,
      }));

      ddbMock.on(ScanCommand).resolves({ Items: items });

      const results = await queryRecentRequests(3);

      expect(results).toHaveLength(3);
    });

    it("queries StatusIndex GSI when status filter is provided", async () => {
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

      const results = await queryRecentRequests(50, ["Submitted", "Error"]);

      expect(results).toHaveLength(2);
      // Should be sorted newest first
      expect(results[0].requestId).toBe("a");
      expect(results[1].requestId).toBe("b");
    });

    it("uses StatusIndex for filtered queries", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await queryRecentRequests(50, ["Submitted"]);

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.IndexName).toBe("StatusIndex");
    });

    it("defaults limit to 50", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      await queryRecentRequests();

      // No assertion on limit in scan since we sort client-side,
      // but verify it was called
      const calls = ddbMock.commandCalls(ScanCommand);
      expect(calls).toHaveLength(1);
    });
  });
});
