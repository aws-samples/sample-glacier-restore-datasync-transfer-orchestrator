import { mockClient } from "aws-sdk-client-mock";
import {
  DataSyncClient,
  StartTaskExecutionCommand,
} from "@aws-sdk/client-datasync";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { startDataSyncTransfer, generateDataSyncManifest } from "../../src/orchestrator/steps/start-datasync";
import type { StartDataSyncParams } from "../../src/orchestrator/steps/start-datasync";

const dataSyncMock = mockClient(DataSyncClient);
const s3Mock = mockClient(S3Client);

describe("start-datasync", () => {
  beforeEach(() => {
    dataSyncMock.reset();
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolves({});
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const baseParams: StartDataSyncParams = {
    taskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-abc123",
    stagingBucket: "my-staging-bucket",
    filePaths: ["project/file1.exr", "project/file2.exr"],
    manifestAccessRoleArn: "arn:aws:iam::123456789012:role/DataSyncS3Role",
  };

  const taskExecutionArn =
    "arn:aws:datasync:us-east-1:123456789012:task/task-abc123/execution/exec-xyz789";

  describe("generateDataSyncManifest", () => {
    it("generates a CSV with one file path per line", () => {
      const manifest = generateDataSyncManifest(["file1.txt", "dir/file2.txt", "file3.txt"]);
      expect(manifest).toBe("file1.txt\ndir/file2.txt\nfile3.txt");
    });

    it("handles a single file", () => {
      const manifest = generateDataSyncManifest(["only-file.dat"]);
      expect(manifest).toBe("only-file.dat");
    });
  });

  describe("startDataSyncTransfer", () => {
    it("uploads a manifest and starts a task execution with ManifestConfig", async () => {
      dataSyncMock.on(StartTaskExecutionCommand).resolves({
        TaskExecutionArn: taskExecutionArn,
      });

      const result = await startDataSyncTransfer(baseParams);

      expect(result).toBe(taskExecutionArn);

      // Verify manifest was uploaded
      const s3Calls = s3Mock.commandCalls(PutObjectCommand);
      expect(s3Calls).toHaveLength(1);
      expect(s3Calls[0].args[0].input.Bucket).toBe("my-staging-bucket");
      expect(s3Calls[0].args[0].input.Body).toBe("project/file1.exr\nproject/file2.exr");

      // Verify StartTaskExecution was called with ManifestConfig
      const dsCalls = dataSyncMock.commandCalls(StartTaskExecutionCommand);
      expect(dsCalls).toHaveLength(1);
      const input = dsCalls[0].args[0].input;
      expect(input.TaskArn).toBe(baseParams.taskArn);
      expect(input.ManifestConfig).toBeDefined();
      expect(input.ManifestConfig!.Action).toBe("TRANSFER");
      expect(input.ManifestConfig!.Format).toBe("CSV");
      expect(input.ManifestConfig!.Source!.S3!.BucketAccessRoleArn).toBe(baseParams.manifestAccessRoleArn);
      expect(input.ManifestConfig!.Source!.S3!.S3BucketArn).toBe("arn:aws:s3:::my-staging-bucket");
    });

    it("throws a descriptive error if TaskExecutionArn is not returned", async () => {
      dataSyncMock.on(StartTaskExecutionCommand).resolves({});

      await expect(startDataSyncTransfer(baseParams)).rejects.toThrow(
        `StartTaskExecution for task "${baseParams.taskArn}" did not return a TaskExecutionArn`
      );
    });

    it("retries on transient errors up to 3 attempts", async () => {
      dataSyncMock
        .on(StartTaskExecutionCommand)
        .rejectsOnce({ name: "InternalError" })
        .rejectsOnce({ name: "ServiceUnavailable" })
        .resolves({ TaskExecutionArn: taskExecutionArn });

      const promise = startDataSyncTransfer(baseParams);

      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);

      const result = await promise;
      expect(result).toBe(taskExecutionArn);

      const calls = dataSyncMock.commandCalls(StartTaskExecutionCommand);
      expect(calls).toHaveLength(3);
    });

    it("throws immediately on non-retryable errors without retrying", async () => {
      dataSyncMock
        .on(StartTaskExecutionCommand)
        .rejects({ name: "InvalidRequest" });

      await expect(startDataSyncTransfer(baseParams)).rejects.toThrow();

      const calls = dataSyncMock.commandCalls(StartTaskExecutionCommand);
      expect(calls).toHaveLength(1);
    });
  });
});
