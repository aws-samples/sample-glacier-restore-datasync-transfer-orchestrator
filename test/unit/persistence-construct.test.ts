import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { PersistenceConstruct } from '../../lib/constructs/persistence-construct';

describe('PersistenceConstruct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');
    new PersistenceConstruct(stack, 'TestPersistence');
    template = Template.fromStack(stack);
  });

  test('creates DynamoDB table with requestId partition key and submittedAt sort key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'requestId', KeyType: 'HASH' },
        { AttributeName: 'submittedAt', KeyType: 'RANGE' },
      ],
    });
  });

  test('configures StatusIndex GSI with status partition key and submittedAt sort key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        {
          IndexName: 'StatusIndex',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'submittedAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });

  test('configures TTL attribute', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('uses PAY_PER_REQUEST billing mode', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('defines all required attribute definitions', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: [
        { AttributeName: 'requestId', AttributeType: 'S' },
        { AttributeName: 'submittedAt', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
      ],
    });
  });
});
