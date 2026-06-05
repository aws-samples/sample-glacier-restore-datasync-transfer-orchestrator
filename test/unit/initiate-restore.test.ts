import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  RestoreObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  S3ControlClient,
  CreateJobCommand,
} from "@aws-sdk/client-s3-control";
import {
  initiateRestore,
  createBatchRestoreJob,
  initiateRestores,
  generateManifestCsv,
} from "../../src/orchestrator/steps/initiate-restore";

const s3Mock = mockClient(S3Client);
const s3ControlMock = mockClient(S3ControlClient);

describe("initiate-restore", () => {
  beforeEach(() => {
    s3Mock.reset();
    s3ControlMock.reset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("generateManifestCsv", () => {
    it("generates CSV with bucket and key columns", () => {
      const csv = generateManifestCsv("my-bucket", [
        "path/to/file1.dat",
        "path/to/file2.dat",
      ]);
      expect(csv).toBe(
        "my-bucket,path/to/file1.dat\nmy-bucket,path/to/file2.dat"
      );
    });

    it("handles a single file path", () => {
      const csv = generateManifestCsv("bucket", ["single-file.txt"]);
      expect(csv).toBe("bucket,single-file.txt");
    });

    it("handles file paths with special characters", () => {
      const csv = generateManifestCsv("bucket", [
        "path/with spaces/file.txt",
        "path/with,comma/file.txt",
      ]);
      expect(csv).toBe(
        "bucket,path/with spaces/file.txt\nbucket,path/with,comma/file.txt"
      );
    });
  });

  describe("initiateRestore", () => {
    it("issues RestoreObject with correct parameters", async () => {
      s3Mock.on(RestoreObjectCommand).resolves({});

      await initiateRestore("my-bucket", "path/to/file.dat", "Standard");

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        Bucket: "my-bucket",
        Key: "path/to/file.dat",
        RestoreRequest: {
          Days: 7,
          GlacierJobParameters: {
            Tier: "Standard",
          },
        },
      });
    });

    it("applies Expedited retrieval tier", async () => {
      s3Mock.on(RestoreObjectCommand).resolves({});

      await initiateRestore("my-bucket", "file.dat", "Expedited");

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls[0].args[0].input.RestoreRequest?.GlacierJobParameters?.Tier).toBe(
        "Expedited"
      );
    });

    it("applies Bulk retrieval tier", async () => {
      s3Mock.on(RestoreObjectCommand).resolves({});

      await initiateRestore("my-bucket", "file.dat", "Bulk");

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls[0].args[0].input.RestoreRequest?.GlacierJobParameters?.Tier).toBe(
        "Bulk"
      );
    });

    it("sets restore duration to 7 days", async () => {
      s3Mock.on(RestoreObjectCommand).resolves({});

      await initiateRestore("my-bucket", "file.dat", "Standard");

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls[0].args[0].input.RestoreRequest?.Days).toBe(7);
    });

    it("uses custom restore days when provided", async () => {
      s3Mock.on(RestoreObjectCommand).resolves({});

      await initiateRestore("my-bucket", "file.dat", "Standard", 14);

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls[0].args[0].input.RestoreRequest?.Days).toBe(14);
    });

    it("retries on throttling errors", async () => {
      s3Mock
        .on(RestoreObjectCommand)
        .rejectsOnce({ name: "SlowDown" })
        .resolves({});

      const promise = initiateRestore("my-bucket", "file.dat", "Standard");
      await jest.advanceTimersByTimeAsync(1000);
      await promise;

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls).toHaveLength(2);
    });

    it("throws immediately on non-retryable errors", async () => {
      s3Mock.on(RestoreObjectCommand).rejects({ name: "NoSuchKey" });

      await expect(
        initiateRestore("my-bucket", "missing.dat", "Standard")
      ).rejects.toThrow();

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls).toHaveLength(1);
    });
  });

  describe("createBatchRestoreJob", () => {
    const filePaths = Array.from({ length: 60 }, (_, i) => `file-${i}.dat`);

    beforeEach(() => {
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
      s3ControlMock.on(CreateJobCommand).resolves({ JobId: "job-12345" });
    });

    it("uploads manifest CSV to staging bucket", async () => {
      await createBatchRestoreJob(
        "source-bucket",
        filePaths,
        "Standard",
        "staging-bucket",
        "123456789012",
        "arn:aws:iam::123456789012:role/BatchRole"
      );

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Bucket).toBe("staging-bucket");
      expect(putCalls[0].args[0].input.ContentType).toBe("text/csv");
      expect(putCalls[0].args[0].input.Key).toMatch(/^manifests\/restore-\d+\.csv$/);
    });

    it("creates batch job with correct parameters", async () => {
      await createBatchRestoreJob(
        "source-bucket",
        filePaths,
        "Standard",
        "staging-bucket",
        "123456789012",
        "arn:aws:iam::123456789012:role/BatchRole"
      );

      const createCalls = s3ControlMock.commandCalls(CreateJobCommand);
      expect(createCalls).toHaveLength(1);
      const input = createCalls[0].args[0].input;
      expect(input.AccountId).toBe("123456789012");
      expect(input.RoleArn).toBe("arn:aws:iam::123456789012:role/BatchRole");
      expect(input.ConfirmationRequired).toBe(false);
      expect(input.Operation?.S3InitiateRestoreObject?.ExpirationInDays).toBe(7);
    });

    it("uses custom restore days for batch job", async () => {
      await createBatchRestoreJob(
        "source-bucket",
        filePaths,
        "Standard",
        "staging-bucket",
        "123456789012",
        "arn:aws:iam::123456789012:role/BatchRole",
        21
      );

      const createCalls = s3ControlMock.commandCalls(CreateJobCommand);
      const input = createCalls[0].args[0].input;
      expect(input.Operation?.S3InitiateRestoreObject?.ExpirationInDays).toBe(21);
    });

    it("maps Standard tier to STANDARD for batch job", async () => {
      await createBatchRestoreJob(
        "bucket",
        filePaths,
        "Standard",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      const input = s3ControlMock.commandCalls(CreateJobCommand)[0].args[0].input;
      expect(input.Operation?.S3InitiateRestoreObject?.GlacierJobTier).toBe(
        "STANDARD"
      );
    });

    it("maps Bulk tier to BULK for batch job", async () => {
      await createBatchRestoreJob(
        "bucket",
        filePaths,
        "Bulk",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      const input = s3ControlMock.commandCalls(CreateJobCommand)[0].args[0].input;
      expect(input.Operation?.S3InitiateRestoreObject?.GlacierJobTier).toBe(
        "BULK"
      );
    });

    it("returns the job ID", async () => {
      const jobId = await createBatchRestoreJob(
        "bucket",
        filePaths,
        "Standard",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      expect(jobId).toBe("job-12345");
    });

    it("throws if CreateJob does not return a JobId", async () => {
      s3ControlMock.on(CreateJobCommand).resolves({});

      await expect(
        createBatchRestoreJob(
          "bucket",
          filePaths,
          "Standard",
          "staging",
          "123456789012",
          "arn:aws:iam::123456789012:role/Role"
        )
      ).rejects.toThrow("did not return a JobId");
    });

    it("throws if PutObject does not return an ETag", async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      await expect(
        createBatchRestoreJob(
          "bucket",
          filePaths,
          "Standard",
          "staging",
          "123456789012",
          "arn:aws:iam::123456789012:role/Role"
        )
      ).rejects.toThrow("did not return an ETag");
    });
  });

  describe("initiateRestores (routing function)", () => {
    beforeEach(() => {
      s3Mock.on(RestoreObjectCommand).resolves({});
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag"' });
      s3ControlMock.on(CreateJobCommand).resolves({ JobId: "batch-job-1" });
    });

    it("uses individual mode for ≤50 objects", async () => {
      const filePaths = Array.from({ length: 50 }, (_, i) => `file-${i}.dat`);

      const result = await initiateRestores(
        "bucket",
        filePaths,
        "Standard",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      expect(result.mode).toBe("individual");
      expect(result.jobId).toBeUndefined();
      expect(s3Mock.commandCalls(RestoreObjectCommand)).toHaveLength(50);
    });

    it("uses batch mode for >50 objects", async () => {
      const filePaths = Array.from({ length: 51 }, (_, i) => `file-${i}.dat`);

      const result = await initiateRestores(
        "bucket",
        filePaths,
        "Standard",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      expect(result.mode).toBe("batch");
      expect(result.jobId).toBe("batch-job-1");
      expect(s3Mock.commandCalls(RestoreObjectCommand)).toHaveLength(0);
    });

    it("uses individual mode for a single object", async () => {
      const result = await initiateRestores(
        "bucket",
        ["single-file.dat"],
        "Expedited",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      expect(result.mode).toBe("individual");
      expect(result.jobId).toBeUndefined();
      expect(s3Mock.commandCalls(RestoreObjectCommand)).toHaveLength(1);
    });

    it("uses batch mode for exactly 51 objects (boundary)", async () => {
      const filePaths = Array.from({ length: 51 }, (_, i) => `obj-${i}.dat`);

      const result = await initiateRestores(
        "bucket",
        filePaths,
        "Bulk",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      expect(result.mode).toBe("batch");
      expect(result.jobId).toBe("batch-job-1");
    });

    it("passes retrieval tier to individual RestoreObject calls", async () => {
      await initiateRestores(
        "bucket",
        ["file.dat"],
        "Expedited",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role"
      );

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(
        calls[0].args[0].input.RestoreRequest?.GlacierJobParameters?.Tier
      ).toBe("Expedited");
    });

    it("passes custom restoreDays to individual RestoreObject calls", async () => {
      await initiateRestores(
        "bucket",
        ["file.dat"],
        "Standard",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role",
        21
      );

      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls[0].args[0].input.RestoreRequest?.Days).toBe(21);
    });

    it("passes custom restoreDays to batch job", async () => {
      const filePaths = Array.from({ length: 51 }, (_, i) => `file-${i}.dat`);

      await initiateRestores(
        "bucket",
        filePaths,
        "Standard",
        "staging",
        "123456789012",
        "arn:aws:iam::123456789012:role/Role",
        14
      );

      const createCalls = s3ControlMock.commandCalls(CreateJobCommand);
      expect(createCalls[0].args[0].input.Operation?.S3InitiateRestoreObject?.ExpirationInDays).toBe(14);
    });
  });
});
