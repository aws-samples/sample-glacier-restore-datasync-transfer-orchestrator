import { mockClient } from "aws-sdk-client-mock";
import {
  DataSyncClient,
  DescribeTaskExecutionCommand,
} from "@aws-sdk/client-datasync";
import {
  checkDataSyncStatus,
  monitorDataSyncExecution,
} from "../../src/orchestrator/steps/monitor-datasync";

const dataSyncMock = mockClient(DataSyncClient);

describe("monitor-datasync", () => {
  beforeEach(() => {
    dataSyncMock.reset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const taskExecutionArn =
    "arn:aws:datasync:us-east-1:123456789012:task/task-abc123/execution/exec-xyz789";

  describe("checkDataSyncStatus", () => {
    it("returns status and transfer metrics on success", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "TRANSFERRING",
        BytesTransferred: 1024000,
        FilesTransferred: 5,
      });

      const result = await checkDataSyncStatus(taskExecutionArn);

      expect(result).toEqual({
        status: "TRANSFERRING",
        bytesTransferred: 1024000,
        filesTransferred: 5,
      });
    });

    it("returns SUCCESS status when task completes", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "SUCCESS",
        BytesTransferred: 5000000,
        FilesTransferred: 10,
      });

      const result = await checkDataSyncStatus(taskExecutionArn);

      expect(result.status).toBe("SUCCESS");
      expect(result.bytesTransferred).toBe(5000000);
      expect(result.filesTransferred).toBe(10);
    });

    it("returns ERROR status when task fails", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "ERROR",
        BytesTransferred: 0,
        FilesTransferred: 0,
      });

      const result = await checkDataSyncStatus(taskExecutionArn);

      expect(result.status).toBe("ERROR");
    });

    it("defaults to UNKNOWN when Status is undefined", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({});

      const result = await checkDataSyncStatus(taskExecutionArn);

      expect(result.status).toBe("UNKNOWN");
      expect(result.bytesTransferred).toBeUndefined();
      expect(result.filesTransferred).toBeUndefined();
    });

    it("sends DescribeTaskExecution with correct ARN", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "TRANSFERRING",
      });

      await checkDataSyncStatus(taskExecutionArn);

      const calls = dataSyncMock.commandCalls(DescribeTaskExecutionCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        TaskExecutionArn: taskExecutionArn,
      });
    });

    it("propagates errors from DescribeTaskExecution", async () => {
      dataSyncMock
        .on(DescribeTaskExecutionCommand)
        .rejects(new Error("Network timeout"));

      await expect(checkDataSyncStatus(taskExecutionArn)).rejects.toThrow(
        "Network timeout"
      );
    });

    it("handles undefined BytesTransferred and FilesTransferred", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "LAUNCHING",
      });

      const result = await checkDataSyncStatus(taskExecutionArn);

      expect(result.status).toBe("LAUNCHING");
      expect(result.bytesTransferred).toBeUndefined();
      expect(result.filesTransferred).toBeUndefined();
    });
  });

  describe("monitorDataSyncExecution", () => {
    it("returns 'Transfer Complete' when task succeeds immediately", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "SUCCESS",
        BytesTransferred: 1000,
        FilesTransferred: 1,
      });

      const result = await monitorDataSyncExecution(taskExecutionArn);

      expect(result).toEqual({ finalStatus: "Transfer Complete" });
    });

    it("returns 'DataSync Failed' when task reports ERROR", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "ERROR",
        BytesTransferred: 0,
        FilesTransferred: 0,
      });

      const result = await monitorDataSyncExecution(taskExecutionArn);

      expect(result.finalStatus).toBe("DataSync Failed");
      expect(result.failureReason).toContain("failed with status ERROR");
      expect(result.failureReason).toContain(taskExecutionArn);
    });

    it("polls at 60-second intervals until success", async () => {
      dataSyncMock
        .on(DescribeTaskExecutionCommand)
        .resolvesOnce({ Status: "TRANSFERRING", BytesTransferred: 500 })
        .resolvesOnce({ Status: "TRANSFERRING", BytesTransferred: 1000 })
        .resolvesOnce({ Status: "SUCCESS", BytesTransferred: 1500 });

      const promise = monitorDataSyncExecution(taskExecutionArn);

      // Advance past first poll interval (60s)
      await jest.advanceTimersByTimeAsync(60 * 1000);
      // Advance past second poll interval (60s)
      await jest.advanceTimersByTimeAsync(60 * 1000);

      const result = await promise;

      expect(result).toEqual({ finalStatus: "Transfer Complete" });
      expect(
        dataSyncMock.commandCalls(DescribeTaskExecutionCommand)
      ).toHaveLength(3);
    });

    it("returns 'Transfer Timed Out' after 60 minutes", async () => {
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "TRANSFERRING",
        BytesTransferred: 500,
      });

      const promise = monitorDataSyncExecution(taskExecutionArn);

      // Advance past the 60-minute timeout
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

      const result = await promise;

      expect(result).toEqual({ finalStatus: "Transfer Timed Out" });
    });

    it("returns 'Transfer Status Unknown' after 3 consecutive transient failures", async () => {
      dataSyncMock
        .on(DescribeTaskExecutionCommand)
        .rejects(new Error("Service unavailable"));

      const promise = monitorDataSyncExecution(taskExecutionArn);

      // Advance past first poll interval (after first failure)
      await jest.advanceTimersByTimeAsync(60 * 1000);
      // Advance past second poll interval (after second failure)
      await jest.advanceTimersByTimeAsync(60 * 1000);

      const result = await promise;

      expect(result.finalStatus).toBe("Transfer Status Unknown");
      expect(result.failureReason).toContain("3 consecutive polling failures");
      expect(result.failureReason).toContain("Service unavailable");
    });

    it("resets consecutive failure counter on successful poll", async () => {
      dataSyncMock
        .on(DescribeTaskExecutionCommand)
        // First poll: transient failure
        .rejectsOnce(new Error("Timeout"))
        // Second poll: transient failure
        .rejectsOnce(new Error("Timeout"))
        // Third poll: success (resets counter)
        .resolvesOnce({ Status: "TRANSFERRING", BytesTransferred: 100 })
        // Fourth poll: transient failure (counter restarted at 1)
        .rejectsOnce(new Error("Timeout"))
        // Fifth poll: success
        .resolvesOnce({ Status: "SUCCESS", BytesTransferred: 200 });

      const promise = monitorDataSyncExecution(taskExecutionArn);

      // Advance through poll intervals
      await jest.advanceTimersByTimeAsync(60 * 1000); // after 1st failure
      await jest.advanceTimersByTimeAsync(60 * 1000); // after 2nd failure
      await jest.advanceTimersByTimeAsync(60 * 1000); // after success (reset)
      await jest.advanceTimersByTimeAsync(60 * 1000); // after 3rd failure (counter=1)

      const result = await promise;

      expect(result).toEqual({ finalStatus: "Transfer Complete" });
    });

    it("does not return unknown if fewer than 3 consecutive failures occur", async () => {
      dataSyncMock
        .on(DescribeTaskExecutionCommand)
        // Two failures then success
        .rejectsOnce(new Error("Timeout"))
        .rejectsOnce(new Error("Timeout"))
        .resolvesOnce({ Status: "SUCCESS", BytesTransferred: 100 });

      const promise = monitorDataSyncExecution(taskExecutionArn);

      // Advance through poll intervals
      await jest.advanceTimersByTimeAsync(60 * 1000); // after 1st failure
      await jest.advanceTimersByTimeAsync(60 * 1000); // after 2nd failure

      const result = await promise;

      expect(result).toEqual({ finalStatus: "Transfer Complete" });
    });

    it("handles ERROR status with failure reason", async () => {
      dataSyncMock
        .on(DescribeTaskExecutionCommand)
        .resolvesOnce({ Status: "TRANSFERRING" })
        .resolvesOnce({ Status: "ERROR" });

      const promise = monitorDataSyncExecution(taskExecutionArn);

      // Advance past first poll interval
      await jest.advanceTimersByTimeAsync(60 * 1000);

      const result = await promise;

      expect(result.finalStatus).toBe("DataSync Failed");
      expect(result.failureReason).toBeDefined();
    });

    it("checks timeout before each poll", async () => {
      // Simulate a scenario where the task is still transferring
      // but we hit the 60-minute timeout
      dataSyncMock.on(DescribeTaskExecutionCommand).resolves({
        Status: "TRANSFERRING",
      });

      const promise = monitorDataSyncExecution(taskExecutionArn);

      // Advance to just before timeout (59 polls at 60s each = 59 minutes)
      for (let i = 0; i < 59; i++) {
        await jest.advanceTimersByTimeAsync(60 * 1000);
      }

      // One more interval pushes us past 60 minutes
      await jest.advanceTimersByTimeAsync(60 * 1000);

      const result = await promise;

      expect(result).toEqual({ finalStatus: "Transfer Timed Out" });
    });
  });
});
