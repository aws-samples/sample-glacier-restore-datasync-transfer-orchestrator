import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Props for the OrchestratorConstruct.
 */
export interface OrchestratorConstructProps {
  /** DynamoDB table from PersistenceConstruct for request state tracking */
  table: dynamodb.ITable;
  /** ARN of the pre-configured DataSync task */
  dataSyncTaskArn: string;
  /** Name of the S3 staging bucket for batch manifests */
  stagingBucket: string;
  /** AWS account ID */
  accountId: string;
  /** ARN of the IAM role used by S3 Batch Operations */
  batchRoleArn: string;
  /** ARN of the IAM role DataSync uses to access the manifest in S3 */
  dataSyncS3RoleArn: string;
}

/**
 * CDK construct that defines the Restore Orchestrator Lambda function
 * using Lambda Durable Functions for long-running Glacier restore workflows.
 */
export class OrchestratorConstruct extends Construct {
  /** The orchestrator Lambda function */
  public readonly function: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: OrchestratorConstructProps) {
    super(scope, id);

    this.function = new nodejs.NodejsFunction(this, 'OrchestratorFunction', {
      entry: 'src/orchestrator/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: 512,
      timeout: cdk.Duration.minutes(15),
      environment: {
        TABLE_NAME: props.table.tableName,
        DATASYNC_TASK_ARN: props.dataSyncTaskArn,
        STAGING_BUCKET: props.stagingBucket,
        ACCOUNT_ID: props.accountId,
        BATCH_ROLE_ARN: props.batchRoleArn,
        DATASYNC_S3_ROLE_ARN: props.dataSyncS3RoleArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
      durableConfig: {
        executionTimeout: cdk.Duration.days(3),
        retentionPeriod: cdk.Duration.days(7)
      }
    });

    // Attach the managed policy required for durable execution checkpointing
    this.function.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicDurableExecutionRolePolicy',
      ),
    );

    // DynamoDB permissions: PutItem, UpdateItem, GetItem, Query on table and indexes
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:GetItem',
          'dynamodb:Query',
        ],
        resources: [
          props.table.tableArn,
          `${props.table.tableArn}/index/*`,
        ],
      })
    );

    // S3 permissions: GetObject and HeadObject on source buckets, RestoreObject
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:HeadObject',
          's3:RestoreObject',
        ],
        resources: ['arn:aws:s3:::*/*'],
      })
    );

    // S3 permissions: ListBucket for glob pattern expansion
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: ['arn:aws:s3:::*'],
      })
    );

    // S3 permissions: PutObject on staging bucket for batch manifests
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::${props.stagingBucket}/*`],
      })
    );

    // S3 Batch Operations permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:CreateJob',
          's3:DescribeJob',
        ],
        resources: ['*'],
      })
    );

    // DataSync permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'datasync:StartTaskExecution',
          'datasync:DescribeTaskExecution',
          'datasync:ListTasks',
          'datasync:DescribeTask',
          'datasync:CreateTask',
          'datasync:ListLocations',
          'datasync:CreateLocationS3',
        ],
        resources: ['*'],
      })
    );

    // IAM PassRole for S3 Batch Operations
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [props.batchRoleArn, props.dataSyncS3RoleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': ['s3.amazonaws.com', 'datasync.amazonaws.com'],
          },
        },
      })
    );
  }
}
