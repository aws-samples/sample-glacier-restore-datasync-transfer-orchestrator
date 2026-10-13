import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { RestoreTransferStack } from '../lib/restore-transfer-stack';

describe('RestoreTransferStack', () => {
  let template: Template;

  // Required deployment configuration. getEnvironmentConfig() validates these
  // at synth time, so the full-stack test must provide valid-looking values.
  const requiredEnv: Record<string, string> = {
    CDK_DEFAULT_ACCOUNT: '123456789012',
    STAGING_BUCKET: 'restore-transfer-staging-test',
    BATCH_ROLE_ARN: 'arn:aws:iam::123456789012:role/S3BatchOperationsRole-test',
    DATASYNC_S3_ROLE_ARN: 'arn:aws:iam::123456789012:role/DataSyncS3Role-test',
    CERTIFICATE_ARN: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert',
  };
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(requiredEnv)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    const app = new cdk.App();
    const stack = new RestoreTransferStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  afterAll(() => {
    for (const key of Object.keys(requiredEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test('stack synthesizes without errors', () => {
    expect(template.toJSON()).toBeDefined();
  });

  test('creates DynamoDB table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'requestId', KeyType: 'HASH' },
        { AttributeName: 'submittedAt', KeyType: 'RANGE' },
      ],
    });
  });

  test('creates REST API Gateway', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'GlacierRestoreApi',
    });
  });

  test('creates internal ALB for web UI', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
  });

  test('creates orchestrator Lambda function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      MemorySize: 512,
      Timeout: 900,
    });
  });

  test('exports ApiEndpoint output', () => {
    const outputs = template.findOutputs('ApiEndpoint');
    expect(Object.keys(outputs).length).toBe(1);
  });

  test('exports AlbDnsName output', () => {
    const outputs = template.findOutputs('AlbDnsName');
    expect(Object.keys(outputs).length).toBe(1);
  });
});
