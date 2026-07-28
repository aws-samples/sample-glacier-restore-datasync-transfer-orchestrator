import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  S3ControlClient,
  DescribeJobCommand,
} from "@aws-sdk/client-s3-control";
import {
  calculatePollDelay,
  checkRestoreStatus,
  checkBatchJobStatus,
  isRestoreTimedOut,
  monitorIndividualRestores,
  monitorBatchJob,
} from "../../src/orchestrator/steps/monitor-restore";

const s3Mock = mockClient(S3Client);
const s3ControlMock = mockClient(S3ControlClient);

describe("monitor-restore", () => {
  beforeEach(() => {
    s3Mock.reset();
    s3ControlMock.reset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("calculatePollDelay", () => {
    it("returns 5 minutes for attempt 0", () => {
      expect(calculatePollDelay(0)).toBe(5 * 60 * 1000);
    });

    it("returns 10 minutes for attempt 1", () => {
      expect(calculatePollDelay(1)).toBe(10 * 60 * 1000);
    });

    it("returns 20 minutes for attempt 2", () => {
      expect(calculatePollDelay(2)).toBe(20 * 60 * 1000);
    });

    it("caps at 30 minutes for attempt 3", () => {
      expect(calculatePollDelay(3)).toBe(30 * 60 * 1000);
    });

    it("caps at 30 minutes for attempt 10", () => {
      expect(calculatePollDelay(10)).toBe(30 * 60 * 1000);
    });

    it("follows formula min(5min * 2^attempt, 30min)", () => {
      const fiveMin = 5 * 60 * 1000;
      const thirtyMin = 30 * 60 * 1000;

      for (let attempt = 0; attempt < 20; attempt++) {
        const expected = Math.min(fiveMin * Math.pow(2, attempt), thirtyMin);
        expect(calculatePollDelay(attempt)).toBe(expected);
      }
    });
  });

  describe("checkRestoreStatus", () => {
    it("returns 'completed' when ongoing-request is false", async () => {
      s3Mock.on(HeadObjectCommand).resolves({
        Restore: 'ongoing-request="false", expiry-date="Fri, 23 Dec 2023 00:00:00 GMT"',
      });

      const status = await checkRestoreStatus("bucket", "file.dat");
      expect(status).toBe("completed");
    });

    it("returns 'in_progress' when ongoing-request is true", async () => {
      s3Mock.on(HeadObjectCommand).resolves({
        Restore: 'ongoing-request="true"',
      });

      const status = await checkRestoreStatus("bucket", "file.dat");
      expect(status).toBe("in_progress");
    });

    it("returns 'not_started' when no Restore header", async () => {
      s3Mock.on(HeadObjectCommand).resolves({
        Restore: undefined,
      });

      const status = await checkRestoreStatus("bucket", "file.dat");
      expect(status).toBe("not_started");
    });

    it("sends HeadObject with correct bucket and key", async () => {
      s3Mock.on(HeadObjectCommand).resolves({
        Restore: 'ongoing-request="true"',
      });

      await checkRestoreStatus("my-bucket", "path/to/file.dat");

      const calls = s3Mock.commandCalls(HeadObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        Bucket: "my-bucket",
        Key: "path/to/file.dat",
      });
    });

    it("propagates errors from HeadObject", async () => {
      s3Mock.on(HeadObjectCommand).rejects(new Error("Access denied"));

      await expect(
        checkRestoreStatus("bucket", "file.dat")
      ).rejects.toThrow("Access denied");
    });
  });

  describe("checkBatchJobStatus", () => {
    it("returns job status with progress counts", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "Active",
          ProgressSummary: {
            TotalNumberOfTasks: 100,
            NumberOfTasksSucceeded: 45,
            NumberOfTasksFailed: 5,
          },
        },
      });

      const result = await checkBatchJobStatus("123456789012", "job-123");

      expect(result).toEqual({
        status: "Active",
        completedCount: 45,
        failedCount: 5,
        totalCount: 100,
      });
    });

    it("returns Complete status when job is done", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "Complete",
          ProgressSummary: {
            TotalNumberOfTasks: 60,
            NumberOfTasksSucceeded: 58,
            NumberOfTasksFailed: 2,
          },
        },
      });

      const result = await checkBatchJobStatus("123456789012", "job-456");

      expect(result.status).toBe("Complete");
      expect(result.completedCount).toBe(58);
      expect(result.failedCount).toBe(2);
      expect(result.totalCount).toBe(60);
    });

    it("sends DescribeJob with correct account and job ID", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "Active",
          ProgressSummary: {
            TotalNumberOfTasks: 10,
            NumberOfTasksSucceeded: 0,
            NumberOfTasksFailed: 0,
          },
        },
      });

      await checkBatchJobStatus("111222333444", "job-abc");

      const calls = s3ControlMock.commandCalls(DescribeJobCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        AccountId: "111222333444",
        JobId: "job-abc",
      });
    });

    it("throws when DescribeJob returns no job details", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({});

      await expect(
        checkBatchJobStatus("123456789012", "missing-job")
      ).rejects.toThrow("DescribeJob returned no job details");
    });

    it("handles zero progress counts gracefully", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "New",
          ProgressSummary: {
            TotalNumberOfTasks: 0,
            NumberOfTasksSucceeded: 0,
            NumberOfTasksFailed: 0,
          },
        },
      });

      const result = await checkBatchJobStatus("123456789012", "job-new");

      expect(result).toEqual({
        status: "New",
        completedCount: 0,
        failedCount: 0,
        totalCount: 0,
      });
    });

    it("defaults to 'Unknown' when status is undefined", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          ProgressSummary: {
            TotalNumberOfTasks: 5,
            NumberOfTasksSucceeded: 0,
            NumberOfTasksFailed: 0,
          },
        },
      });

      const result = await checkBatchJobStatus("123456789012", "job-no-status");
      expect(result.status).toBe("Unknown");
    });
  });

  describe("isRestoreTimedOut", () => {
    it("returns false when within Expedited timeout (12h)", () => {
      const startTime = Date.now() - 11 * 60 * 60 * 1000; // 11 hours ago
      expect(isRestoreTimedOut(startTime, "Expedited")).toBe(false);
    });

    it("returns true when Expedited timeout exceeded (12h)", () => {
      const startTime = Date.now() - 13 * 60 * 60 * 1000; // 13 hours ago
      expect(isRestoreTimedOut(startTime, "Expedited")).toBe(true);
    });

    it("returns true at exactly the Expedited timeout boundary", () => {
      const startTime = Date.now() - 12 * 60 * 60 * 1000; // exactly 12 hours
      expect(isRestoreTimedOut(startTime, "Expedited")).toBe(true);
    });

    it("returns false when within Standard timeout (48h)", () => {
      const startTime = Date.now() - 47 * 60 * 60 * 1000; // 47 hours ago
      expect(isRestoreTimedOut(startTime, "Standard")).toBe(false);
    });

    it("returns true when Standard timeout exceeded (48h)", () => {
      const startTime = Date.now() - 49 * 60 * 60 * 1000; // 49 hours ago
      expect(isRestoreTimedOut(startTime, "Standard")).toBe(true);
    });

    it("returns false when within Bulk timeout (72h)", () => {
      const startTime = Date.now() - 71 * 60 * 60 * 1000; // 71 hours ago
      expect(isRestoreTimedOut(startTime, "Bulk")).toBe(false);
    });

    it("returns true when Bulk timeout exceeded (72h)", () => {
      const startTime = Date.now() - 73 * 60 * 60 * 1000; // 73 hours ago
      expect(isRestoreTimedOut(startTime, "Bulk")).toBe(true);
    });

    it("returns false when restore just started", () => {
      const startTime = Date.now();
      expect(isRestoreTimedOut(startTime, "Bulk")).toBe(false);
    });
  });

  describe("monitorIndividualRestores", () => {
    it("returns completed for all files when restores finish immediately", async () => {
      s3Mock.on(HeadObjectCommand).resolves({
        Restore: 'ongoing-request="false", expiry-date="Fri, 23 Dec 2023 00:00:00 GMT"',
      });

      const results = await monitorIndividualRestores(
        "bucket",
        ["file1.dat", "file2.dat"],
        "Standard",
        Date.now()
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ filePath: "file1.dat", status: "completed" });
      expect(results[1]).toEqual({ filePath: "file2.dat", status: "completed" });
    });

    it("marks files as failed when HeadObject throws", async () => {
      s3Mock.on(HeadObjectCommand).rejects(new Error("Access denied"));

      const results = await monitorIndividualRestores(
        "bucket",
        ["file1.dat"],
        "Standard",
        Date.now()
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("failed");
      expect(results[0].error).toBe("Access denied");
    });

    it("continues monitoring remaining files when one fails (partial failure)", async () => {
      s3Mock
        .on(HeadObjectCommand, { Bucket: "bucket", Key: "good.dat" })
        .resolves({
          Restore: 'ongoing-request="false", expiry-date="Fri, 23 Dec 2023 00:00:00 GMT"',
        });
      s3Mock
        .on(HeadObjectCommand, { Bucket: "bucket", Key: "bad.dat" })
        .rejects(new Error("Not found"));

      const results = await monitorIndividualRestores(
        "bucket",
        ["good.dat", "bad.dat"],
        "Standard",
        Date.now()
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ filePath: "good.dat", status: "completed" });
      expect(results[1].status).toBe("failed");
      expect(results[1].error).toBe("Not found");
    });

    it("marks pending files as timed_out when timeout is exceeded", async () => {
      // Start time is already past the Expedited timeout
      const startTime = Date.now() - 13 * 60 * 60 * 1000;

      const results = await monitorIndividualRestores(
        "bucket",
        ["file1.dat", "file2.dat"],
        "Expedited",
        startTime
      );

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe("timed_out");
      expect(results[1].status).toBe("timed_out");
      expect(results[0].error).toContain("timed out");
    });

    it("marks files as failed when restore is not_started", async () => {
      s3Mock.on(HeadObjectCommand).resolves({
        Restore: undefined,
      });

      const results = await monitorIndividualRestores(
        "bucket",
        ["file.dat"],
        "Standard",
        Date.now()
      );

      expect(results[0].status).toBe("failed");
      expect(results[0].error).toContain("not initiated");
    });

    it("polls with exponential backoff when restore is in progress", async () => {
      // First call: in progress, second call: completed
      s3Mock
        .on(HeadObjectCommand)
        .resolvesOnce({ Restore: 'ongoing-request="true"' })
        .resolvesOnce({ Restore: 'ongoing-request="false", expiry-date="Fri, 23 Dec 2023 00:00:00 GMT"' });

      const promise = monitorIndividualRestores(
        "bucket",
        ["file.dat"],
        "Standard",
        Date.now()
      );

      // Advance past the first poll delay (5 minutes)
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

      const results = await promise;

      expect(results[0].status).toBe("completed");
      expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(2);
    });
  });

  describe("monitorBatchJob", () => {
    it("returns immediately when job is already Complete", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "Complete",
          ProgressSummary: {
            TotalNumberOfTasks: 100,
            NumberOfTasksSucceeded: 95,
            NumberOfTasksFailed: 5,
          },
        },
      });

      const result = await monitorBatchJob(
        "123456789012",
        "job-123",
        "Standard",
        Date.now()
      );

      expect(result.status).toBe("Complete");
      expect(result.completedCount).toBe(95);
      expect(result.failedCount).toBe(5);
      expect(result.totalCount).toBe(100);
    });

    it("returns immediately when job is Failed", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "Failed",
          ProgressSummary: {
            TotalNumberOfTasks: 50,
            NumberOfTasksSucceeded: 0,
            NumberOfTasksFailed: 50,
          },
        },
      });

      const result = await monitorBatchJob(
        "123456789012",
        "job-456",
        "Standard",
        Date.now()
      );

      expect(result.status).toBe("Failed");
    });

    it("returns TimedOut when timeout is exceeded", async () => {
      // Start time is already past the Standard timeout
      const startTime = Date.now() - 49 * 60 * 60 * 1000;

      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "Active",
          ProgressSummary: {
            TotalNumberOfTasks: 100,
            NumberOfTasksSucceeded: 50,
            NumberOfTasksFailed: 0,
          },
        },
      });

      const result = await monitorBatchJob(
        "123456789012",
        "job-789",
        "Standard",
        startTime
      );

      expect(result.status).toBe("TimedOut");
    });

    it("polls at 5-minute intervals until job completes", async () => {
      s3ControlMock
        .on(DescribeJobCommand)
        .resolvesOnce({
          Job: {
            Status: "Active",
            ProgressSummary: {
              TotalNumberOfTasks: 100,
              NumberOfTasksSucceeded: 30,
              NumberOfTasksFailed: 0,
            },
          },
        })
        .resolvesOnce({
          Job: {
            Status: "Complete",
            ProgressSummary: {
              TotalNumberOfTasks: 100,
              NumberOfTasksSucceeded: 100,
              NumberOfTasksFailed: 0,
            },
          },
        });

      const promise = monitorBatchJob(
        "123456789012",
        "job-poll",
        "Standard",
        Date.now()
      );

      // Advance past the 5-minute poll interval
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

      const result = await promise;

      expect(result.status).toBe("Complete");
      expect(result.completedCount).toBe(100);
      expect(s3ControlMock.commandCalls(DescribeJobCommand)).toHaveLength(2);
    });

    it("returns immediately when job is Cancelled", async () => {
      s3ControlMock.on(DescribeJobCommand).resolves({
        Job: {
          Status: "Cancelled",
          ProgressSummary: {
            TotalNumberOfTasks: 100,
            NumberOfTasksSucceeded: 10,
            NumberOfTasksFailed: 0,
          },
        },
      });

      const result = await monitorBatchJob(
        "123456789012",
        "job-cancel",
        "Standard",
        Date.now()
      );

      expect(result.status).toBe("Cancelled");
    });
  });
});
