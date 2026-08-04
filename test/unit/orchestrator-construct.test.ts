import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OrchestratorConstruct } from '../../lib/constructs/orchestrator-construct';

describe('OrchestratorConstruct', () => {
  let template: Template;
  const testProps = {
    dataSyncTaskArn: 'arn:aws:datasync:us-east-1:123456789012:task/task-abc123',
    stagingBucket: 'my-staging-bucket',
    accountId: '123456789012',
    batchRoleArn: 'arn:aws:iam::123456789012:role/BatchOperationsRole',
    dataSyncS3RoleArn: 'arn:aws:iam::123456789012:role/DataSyncS3Role',
  };

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const table = new dynamodb.Table(stack, 'TestTable', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'submittedAt', type: dynamodb.AttributeType.STRING },
    });

    new OrchestratorConstruct(stack, 'TestOrchestrator', {
      table,
      ...testProps,
    });

    template = Template.fromStack(stack);
  });

  test('creates Lambda function with Node.js 24.x runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
    });
  });

  test('configures 512 MB memory', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
    });
  });

  test('configures 15 minute timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 900,
    });
  });

  test('sets required environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DATASYNC_TASK_ARN: testProps.dataSyncTaskArn,
          STAGING_BUCKET: testProps.stagingBucket,
          ACCOUNT_ID: testProps.accountId,
          BATCH_ROLE_ARN: testProps.batchRoleArn,
        }),
      },
    });
  });

  test('grants DynamoDB permissions on table and indexes', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: [
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
              'dynamodb:GetItem',
              'dynamodb:Query',
            ],
          }),
        ]),
      },
    });
  });

  test('grants S3 GetObject, HeadObject, and RestoreObject permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: [
              's3:GetObject',
              's3:HeadObject',
              's3:RestoreObject',
            ],
            Resource: 'arn:aws:s3:::*/*',
          }),
        ]),
      },
    });
  });

  test('grants S3 PutObject on staging bucket', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:PutObject',
            Resource: `arn:aws:s3:::${testProps.stagingBucket}/*`,
          }),
        ]),
      },
    });
  });

  test('grants S3 Batch Operations permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: [
              's3:CreateJob',
              's3:DescribeJob',
            ],
          }),
        ]),
      },
    });
  });

  test('grants DataSync permissions on task ARN', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: [
              'datasync:StartTaskExecution',
              'datasync:DescribeTaskExecution',
              'datasync:ListTasks',
              'datasync:DescribeTask',
              'datasync:CreateTask',
              'datasync:ListLocations',
              'datasync:CreateLocationS3',
              'datasync:DescribeLocationNfs',
              'datasync:DescribeAgent',
            ],
          }),
        ]),
      },
    });
  });

  test('grants IAM PassRole for S3 Batch Operations and DataSync', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: [testProps.batchRoleArn, testProps.dataSyncS3RoleArn],
            Condition: {
              StringEquals: {
                'iam:PassedToService': ['s3.amazonaws.com', 'datasync.amazonaws.com'],
              },
            },
          }),
        ]),
      },
    });
  });

  test('exposes the Lambda function as a public property', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'PropTestStack');

    const table = new dynamodb.Table(stack, 'TestTable', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'submittedAt', type: dynamodb.AttributeType.STRING },
    });

    const construct = new OrchestratorConstruct(stack, 'TestOrchestrator', {
      table,
      ...testProps,
    });

    expect(construct.function).toBeDefined();
    expect(construct.function.functionName).toBeDefined();
  });
});
