import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { IlmDatasyncStack } from '../lib/ilm-datasync-stack';

describe('IlmDatasyncStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new IlmDatasyncStack(app, 'TestStack');
    template = Template.fromStack(stack);
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

  test('creates CloudFront distribution', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
      },
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

  test('exports WebUiUrl output', () => {
    const outputs = template.findOutputs('WebUiUrl');
    expect(Object.keys(outputs).length).toBe(1);
  });
});
