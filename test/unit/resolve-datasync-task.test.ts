import { mockClient } from "aws-sdk-client-mock";
import {
  DataSyncClient,
  ListTasksCommand,
  DescribeTaskCommand,
  CreateTaskCommand,
  ListLocationsCommand,
  CreateLocationS3Command,
  DescribeLocationNfsCommand,
  DescribeAgentCommand,
} from "@aws-sdk/client-datasync";
import { resolveDataSyncTask } from "../../src/orchestrator/utils/resolve-datasync-task";
import type { ResolveDataSyncTaskParams } from "../../src/orchestrator/utils/resolve-datasync-task";

const dataSyncMock = mockClient(DataSyncClient);

describe("resolveDataSyncTask", () => {
  const baseParams: ResolveDataSyncTaskParams = {
    sourceBucket: "my-source-bucket",
    destinationLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-nfs-dest",
    dataSyncS3RoleArn: "arn:aws:iam::123456789012:role/DataSyncS3Role",
  };

  beforeEach(() => {
    dataSyncMock.reset();
  });

  describe("finding existing tasks", () => {
    it("returns existing task ARN when source bucket and destination match", async () => {
      const existingTaskArn = "arn:aws:datasync:us-east-1:123456789012:task/task-existing";

      dataSyncMock.on(ListTasksCommand).resolves({
        Tasks: [{ TaskArn: existingTaskArn }],
      });

      dataSyncMock.on(DescribeTaskCommand).resolves({
        SourceLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-s3-src",
        DestinationLocationArn: baseParams.destinationLocationArn,
      });

      // The source location matches our bucket
      dataSyncMock.on(ListLocationsCommand).resolves({
        Locations: [
          {
            LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-s3-src",
            LocationUri: "s3://my-source-bucket",
          },
        ],
      });

      const result = await resolveDataSyncTask(baseParams);

      expect(result).toBe(existingTaskArn);
    });

    it("skips tasks whose destination does not match", async () => {
      dataSyncMock.on(ListTasksCommand).resolves({
        Tasks: [
          { TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-wrong-dest" },
        ],
      });

      dataSyncMock.on(DescribeTaskCommand).resolves({
        SourceLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-s3-src",
        DestinationLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-different",
        TaskMode: "BASIC",
      });

      // No match found → falls through to create
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({
        LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-new-s3",
      });
      dataSyncMock.on(CreateTaskCommand).resolves({
        TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-new",
      });

      const result = await resolveDataSyncTask(baseParams);

      expect(result).toBe("arn:aws:datasync:us-east-1:123456789012:task/task-new");
    });

    it("skips tasks whose mode does not match even if source and destination match", async () => {
      dataSyncMock.on(ListTasksCommand).resolves({
        Tasks: [
          { TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-basic-mode" },
        ],
      });

      dataSyncMock.on(DescribeTaskCommand).resolves({
        SourceLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-s3-src",
        DestinationLocationArn: baseParams.destinationLocationArn,
        TaskMode: "BASIC",
      });

      dataSyncMock.on(ListLocationsCommand).resolvesOnce({
        Locations: [
          {
            LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-s3-src",
            LocationUri: "s3://my-source-bucket",
          },
        ],
      }).resolves({ Locations: [] });

      dataSyncMock.on(CreateLocationS3Command).resolves({
        LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-new-s3",
      });
      dataSyncMock.on(CreateTaskCommand).resolves({
        TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-enhanced-new",
      });

      // Request ENHANCED mode — should skip the BASIC task and create a new one
      const result = await resolveDataSyncTask({ ...baseParams, taskMode: "ENHANCED" });

      expect(result).toBe("arn:aws:datasync:us-east-1:123456789012:task/task-enhanced-new");
      expect(dataSyncMock.commandCalls(CreateTaskCommand)).toHaveLength(1);
      expect(dataSyncMock.commandCalls(CreateTaskCommand)[0].args[0].input.TaskMode).toBe("ENHANCED");
    });

    it("paginates through tasks list", async () => {
      const matchingTaskArn = "arn:aws:datasync:us-east-1:123456789012:task/task-page2";

      dataSyncMock
        .on(ListTasksCommand)
        .resolvesOnce({
          Tasks: [{ TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-page1" }],
          NextToken: "page2-token",
        })
        .resolvesOnce({
          Tasks: [{ TaskArn: matchingTaskArn }],
        });

      dataSyncMock
        .on(DescribeTaskCommand)
        .resolvesOnce({
          SourceLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-other",
          DestinationLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-different",
        })
        .resolvesOnce({
          SourceLocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-s3-match",
          DestinationLocationArn: baseParams.destinationLocationArn,
        });

      dataSyncMock.on(ListLocationsCommand).resolves({
        Locations: [
          {
            LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-s3-match",
            LocationUri: "s3://my-source-bucket",
          },
        ],
      });

      const result = await resolveDataSyncTask(baseParams);

      expect(result).toBe(matchingTaskArn);
      const listCalls = dataSyncMock.commandCalls(ListTasksCommand);
      expect(listCalls).toHaveLength(2);
      expect(listCalls[1].args[0].input.NextToken).toBe("page2-token");
    });
  });

  describe("creating new tasks", () => {
    beforeEach(() => {
      // No existing tasks
      dataSyncMock.on(ListTasksCommand).resolves({ Tasks: [] });
    });

    it("creates a new task when no existing task matches", async () => {
      const newS3LocationArn = "arn:aws:datasync:us-east-1:123456789012:location/loc-new-s3";
      const newTaskArn = "arn:aws:datasync:us-east-1:123456789012:task/task-created";

      // No existing S3 location for the bucket
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({ LocationArn: newS3LocationArn });
      dataSyncMock.on(CreateTaskCommand).resolves({ TaskArn: newTaskArn });

      const result = await resolveDataSyncTask(baseParams);

      expect(result).toBe(newTaskArn);

      // Verify CreateLocationS3 was called with correct bucket
      const createLocCalls = dataSyncMock.commandCalls(CreateLocationS3Command);
      expect(createLocCalls).toHaveLength(1);
      expect(createLocCalls[0].args[0].input.S3BucketArn).toBe("arn:aws:s3:::my-source-bucket");
      expect(createLocCalls[0].args[0].input.S3Config?.BucketAccessRoleArn).toBe(baseParams.dataSyncS3RoleArn);

      // Verify CreateTask was called with correct source and destination
      const createTaskCalls = dataSyncMock.commandCalls(CreateTaskCommand);
      expect(createTaskCalls).toHaveLength(1);
      expect(createTaskCalls[0].args[0].input.SourceLocationArn).toBe(newS3LocationArn);
      expect(createTaskCalls[0].args[0].input.DestinationLocationArn).toBe(baseParams.destinationLocationArn);
    });

    it("reuses an existing S3 location if one matches the bucket", async () => {
      const existingS3LocationArn = "arn:aws:datasync:us-east-1:123456789012:location/loc-existing-s3";
      const newTaskArn = "arn:aws:datasync:us-east-1:123456789012:task/task-reuse-loc";

      dataSyncMock.on(ListLocationsCommand).resolves({
        Locations: [
          {
            LocationArn: existingS3LocationArn,
            LocationUri: "s3://my-source-bucket",
          },
        ],
      });
      dataSyncMock.on(CreateTaskCommand).resolves({ TaskArn: newTaskArn });

      const result = await resolveDataSyncTask(baseParams);

      expect(result).toBe(newTaskArn);

      // Should NOT have created a new S3 location
      const createLocCalls = dataSyncMock.commandCalls(CreateLocationS3Command);
      expect(createLocCalls).toHaveLength(0);

      // Task should use the existing S3 location
      const createTaskCalls = dataSyncMock.commandCalls(CreateTaskCommand);
      expect(createTaskCalls[0].args[0].input.SourceLocationArn).toBe(existingS3LocationArn);
    });

    it("sets task options for preserve, overwrite, and verify modes", async () => {
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({
        LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-new",
      });
      dataSyncMock.on(CreateTaskCommand).resolves({
        TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-options",
      });

      await resolveDataSyncTask(baseParams);

      const createTaskCalls = dataSyncMock.commandCalls(CreateTaskCommand);
      const options = createTaskCalls[0].args[0].input.Options;
      expect(options).toMatchObject({
        PreserveDeletedFiles: "PRESERVE",
        OverwriteMode: "ALWAYS",
        VerifyMode: "ONLY_FILES_TRANSFERRED",
        TransferMode: "CHANGED",
      });
    });

    it("defaults to BASIC task mode when not specified", async () => {
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({
        LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-new",
      });
      dataSyncMock.on(CreateTaskCommand).resolves({
        TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-basic",
      });

      await resolveDataSyncTask(baseParams);

      const createTaskCalls = dataSyncMock.commandCalls(CreateTaskCommand);
      expect(createTaskCalls[0].args[0].input.TaskMode).toBe("BASIC");
    });

    it("creates a task with ENHANCED mode when specified", async () => {
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({
        LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-new",
      });
      dataSyncMock.on(CreateTaskCommand).resolves({
        TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-enhanced",
      });

      const result = await resolveDataSyncTask({
        ...baseParams,
        taskMode: "ENHANCED",
      });

      expect(result).toBe("arn:aws:datasync:us-east-1:123456789012:task/task-enhanced");

      const createTaskCalls = dataSyncMock.commandCalls(CreateTaskCommand);
      expect(createTaskCalls[0].args[0].input.TaskMode).toBe("ENHANCED");
    });

    it("throws when CreateTask does not return a TaskArn", async () => {
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({
        LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-new",
      });
      dataSyncMock.on(CreateTaskCommand).resolves({});

      await expect(resolveDataSyncTask(baseParams)).rejects.toThrow(
        "CreateTask did not return a TaskArn"
      );
    });

    it("throws when CreateLocationS3 does not return a LocationArn", async () => {
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({});

      await expect(resolveDataSyncTask(baseParams)).rejects.toThrow(
        'CreateLocationS3 for bucket "my-source-bucket" did not return a LocationArn'
      );
    });
  });

  describe("agent mode validation", () => {
    beforeEach(() => {
      // Default: no existing tasks, create new
      dataSyncMock.on(ListTasksCommand).resolves({ Tasks: [] });
      dataSyncMock.on(ListLocationsCommand).resolves({ Locations: [] });
      dataSyncMock.on(CreateLocationS3Command).resolves({
        LocationArn: "arn:aws:datasync:us-east-1:123456789012:location/loc-new-s3",
      });
      dataSyncMock.on(CreateTaskCommand).resolves({
        TaskArn: "arn:aws:datasync:us-east-1:123456789012:task/task-new",
      });
    });

    it("throws when ENHANCED mode is requested but destination uses a Basic agent", async () => {
      dataSyncMock.on(DescribeLocationNfsCommand).resolves({
        OnPremConfig: {
          AgentArns: ["arn:aws:datasync:us-east-1:123456789012:agent/agent-basic"],
        },
      });
      dataSyncMock.on(DescribeAgentCommand).resolves({
        Platform: { Version: "2.0.1785300386.1" },
      });

      await expect(
        resolveDataSyncTask({ ...baseParams, taskMode: "ENHANCED" })
      ).rejects.toThrow("Task mode mismatch: requested ENHANCED mode");
    });

    it("throws when BASIC mode is requested but destination uses an Enhanced agent", async () => {
      dataSyncMock.on(DescribeLocationNfsCommand).resolves({
        OnPremConfig: {
          AgentArns: ["arn:aws:datasync:us-east-1:123456789012:agent/agent-enhanced"],
        },
      });
      dataSyncMock.on(DescribeAgentCommand).resolves({
        Platform: { Version: "3.1.6491607403" },
      });

      await expect(
        resolveDataSyncTask({ ...baseParams, taskMode: "BASIC" })
      ).rejects.toThrow("Task mode mismatch: requested BASIC mode");
    });

    it("succeeds when ENHANCED mode matches an Enhanced agent", async () => {
      dataSyncMock.on(DescribeLocationNfsCommand).resolves({
        OnPremConfig: {
          AgentArns: ["arn:aws:datasync:us-east-1:123456789012:agent/agent-enhanced"],
        },
      });
      dataSyncMock.on(DescribeAgentCommand).resolves({
        Platform: { Version: "3.1.6491607403" },
      });

      const result = await resolveDataSyncTask({ ...baseParams, taskMode: "ENHANCED" });
      expect(result).toBe("arn:aws:datasync:us-east-1:123456789012:task/task-new");
    });

    it("succeeds when BASIC mode matches a Basic agent", async () => {
      dataSyncMock.on(DescribeLocationNfsCommand).resolves({
        OnPremConfig: {
          AgentArns: ["arn:aws:datasync:us-east-1:123456789012:agent/agent-basic"],
        },
      });
      dataSyncMock.on(DescribeAgentCommand).resolves({
        Platform: { Version: "2.0.1785300386.1" },
      });

      const result = await resolveDataSyncTask({ ...baseParams, taskMode: "BASIC" });
      expect(result).toBe("arn:aws:datasync:us-east-1:123456789012:task/task-new");
    });

    it("skips validation gracefully when DescribeLocationNfs fails", async () => {
      dataSyncMock.on(DescribeLocationNfsCommand).rejects({ name: "InvalidRequestException" });

      const result = await resolveDataSyncTask({ ...baseParams, taskMode: "ENHANCED" });
      expect(result).toBe("arn:aws:datasync:us-east-1:123456789012:task/task-new");
    });

    it("skips validation when location has no agents configured", async () => {
      dataSyncMock.on(DescribeLocationNfsCommand).resolves({
        OnPremConfig: { AgentArns: [] },
      });

      const result = await resolveDataSyncTask({ ...baseParams, taskMode: "ENHANCED" });
      expect(result).toBe("arn:aws:datasync:us-east-1:123456789012:task/task-new");
    });
  });
});
