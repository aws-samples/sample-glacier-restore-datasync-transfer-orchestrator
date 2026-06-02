import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { detectStorageClass } from "../../src/orchestrator/steps/detect-storage-class";

const s3Mock = mockClient(S3Client);

describe("detectStorageClass", () => {
  beforeEach(() => {
    s3Mock.reset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const bucket = "test-bucket";
  const filePath = "path/to/object.dat";

  describe("successful detection", () => {
    it("detects GLACIER storage class", async () => {
      s3Mock.on(HeadObjectCommand).resolves({ StorageClass: "GLACIER" });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result).toEqual({
        filePath,
        storageClass: "GLACIER",
        exists: true,
        restoreStatus: "not_started",
      });
    });

    it("detects DEEP_ARCHIVE storage class", async () => {
      s3Mock.on(HeadObjectCommand).resolves({ StorageClass: "DEEP_ARCHIVE" });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result).toEqual({
        filePath,
        storageClass: "DEEP_ARCHIVE",
        exists: true,
        restoreStatus: "not_started",
      });
    });

    it("detects GLACIER_IR storage class", async () => {
      s3Mock.on(HeadObjectCommand).resolves({ StorageClass: "GLACIER_IR" });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result).toEqual({
        filePath,
        storageClass: "GLACIER_IR",
        exists: true,
      });
    });

    it("maps STANDARD (undefined) storage class to GLACIER_IR", async () => {
      s3Mock.on(HeadObjectCommand).resolves({ StorageClass: undefined });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result).toEqual({
        filePath,
        storageClass: "GLACIER_IR",
        exists: true,
      });
    });

    it("maps explicit STANDARD storage class to GLACIER_IR", async () => {
      s3Mock.on(HeadObjectCommand).resolves({ StorageClass: "STANDARD" });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result).toEqual({
        filePath,
        storageClass: "GLACIER_IR",
        exists: true,
      });
    });
  });

  describe("error handling - 404 Not Found", () => {
    it("returns exists: false with error on 404 status", async () => {
      s3Mock.on(HeadObjectCommand).rejects({
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result.filePath).toBe(filePath);
      expect(result.exists).toBe(false);
      expect(result.error).toBe("Object not found");
    });

    it("returns exists: false with error on NoSuchKey", async () => {
      s3Mock.on(HeadObjectCommand).rejects({
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result.filePath).toBe(filePath);
      expect(result.exists).toBe(false);
      expect(result.error).toBe("Object not found");
    });
  });

  describe("error handling - 403 Access Denied", () => {
    it("returns exists: false with error on 403 status", async () => {
      s3Mock.on(HeadObjectCommand).rejects({
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result.filePath).toBe(filePath);
      expect(result.exists).toBe(false);
      expect(result.error).toBe("Access denied");
    });

    it("returns exists: false with error on Forbidden", async () => {
      s3Mock.on(HeadObjectCommand).rejects({
        name: "Forbidden",
        $metadata: { httpStatusCode: 403 },
      });

      const result = await detectStorageClass(bucket, filePath, new S3Client({}));

      expect(result.filePath).toBe(filePath);
      expect(result.exists).toBe(false);
      expect(result.error).toBe("Access denied");
    });
  });

  describe("error handling - transient errors with retry", () => {
    it("retries on transient errors and succeeds", async () => {
      s3Mock
        .on(HeadObjectCommand)
        .rejectsOnce({
          name: "ServiceUnavailable",
          $metadata: { httpStatusCode: 503 },
        })
        .resolves({ StorageClass: "GLACIER" });

      const promise = detectStorageClass(bucket, filePath, new S3Client({}));
      await jest.advanceTimersByTimeAsync(1000); // first retry delay

      const result = await promise;

      expect(result).toEqual({
        filePath,
        storageClass: "GLACIER",
        exists: true,
        restoreStatus: "not_started",
      });
    });

    it("returns error after exhausting all retry attempts", async () => {
      s3Mock.on(HeadObjectCommand).rejects({
        name: "InternalError",
        $metadata: { httpStatusCode: 500 },
      });

      const promise = detectStorageClass(bucket, filePath, new S3Client({}));
      // Advance through retry delays: 1000ms + 2000ms
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result.filePath).toBe(filePath);
      expect(result.exists).toBe(false);
      expect(result.error).toContain("HeadObject");
      expect(result.error).toContain("3 attempts");
    });

    it("retries on HTTP 500 and succeeds on second attempt", async () => {
      s3Mock
        .on(HeadObjectCommand)
        .rejectsOnce({
          name: "UnknownError",
          $metadata: { httpStatusCode: 500 },
        })
        .resolves({ StorageClass: "DEEP_ARCHIVE" });

      const promise = detectStorageClass(bucket, filePath, new S3Client({}));
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;

      expect(result).toEqual({
        filePath,
        storageClass: "DEEP_ARCHIVE",
        exists: true,
        restoreStatus: "not_started",
      });
    });
  });

  describe("HeadObject command parameters", () => {
    it("sends correct bucket and key to HeadObject", async () => {
      s3Mock.on(HeadObjectCommand).resolves({ StorageClass: "GLACIER" });

      await detectStorageClass("my-bucket", "my/key.txt", new S3Client({}));

      const calls = s3Mock.commandCalls(HeadObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        Bucket: "my-bucket",
        Key: "my/key.txt",
      });
    });
  });
});
