import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ApiConstruct } from '../../lib/constructs/api-construct';

describe('ApiConstruct', () => {
  let template: Template;
  let construct: ApiConstruct;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const table = new dynamodb.Table(stack, 'TestTable', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'submittedAt', type: dynamodb.AttributeType.STRING },
    });

    const orchestratorFn = new lambda.Function(stack, 'OrchestratorFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {}'),
    });

    construct = new ApiConstruct(stack, 'TestApi', {
      table,
      orchestratorFunction: orchestratorFn,
    });

    template = Template.fromStack(stack);
  });

  test('creates a REST API', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'GlacierRestoreApi',
    });
  });

  test('creates Lambda functions with Node.js 24.x runtime', () => {
    template.resourceCountIs('AWS::Lambda::Function', 5); // 4 API handlers + 1 orchestrator mock
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      MemorySize: 256,
      Timeout: 30,
    });
  });

  test('configures 256 MB memory for API handlers', () => {
    // All four API handler functions should have 256 MB
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: {
        MemorySize: 256,
      },
    });
    expect(Object.keys(functions).length).toBe(4);
  });

  test('configures 30 second timeout for API handlers', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Timeout: 30,
      },
    });
    expect(Object.keys(functions).length).toBe(4);
  });

  test('sets TABLE_NAME environment variable on request handlers', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: {
        MemorySize: 256,
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            TABLE_NAME: Match.anyValue(),
          }),
        }),
      },
    });

    // 3 request handlers have TABLE_NAME (submit, get-requests, get-request-status)
    // The datasync-destinations handler does not
    expect(Object.keys(functions).length).toBe(3);
  });

  test('sets ORCHESTRATOR_FUNCTION_NAME on submit handler', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATOR_FUNCTION_NAME: Match.anyValue(),
          TABLE_NAME: Match.anyValue(),
        }),
      },
      MemorySize: 256,
    });
  });

  test('creates POST method on /requests resource', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
  });

  test('creates GET methods on /requests and /requests/{requestId}', () => {
    const getMethods = template.findResources('AWS::ApiGateway::Method', {
      Properties: {
        HttpMethod: 'GET',
      },
    });
    // At least 2 GET methods (one for /requests, one for /requests/{requestId})
    expect(Object.keys(getMethods).length).toBeGreaterThanOrEqual(2);
  });

  test('configures CORS preflight OPTIONS methods', () => {
    const optionsMethods = template.findResources('AWS::ApiGateway::Method', {
      Properties: {
        HttpMethod: 'OPTIONS',
      },
    });
    // OPTIONS methods for /requests and /requests/{requestId}
    expect(Object.keys(optionsMethods).length).toBeGreaterThanOrEqual(2);
  });

  test('grants DynamoDB read/write to submit handler', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
              'dynamodb:DeleteItem',
            ]),
          }),
        ]),
      },
    });
  });

  test('grants DynamoDB read to get handlers', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'dynamodb:BatchGetItem',
              'dynamodb:Query',
              'dynamodb:GetItem',
              'dynamodb:Scan',
            ]),
          }),
        ]),
      },
    });
  });

  test('grants invoke permission on orchestrator function to submit handler', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'lambda:InvokeFunction',
          }),
        ]),
      },
    });
  });

  test('exposes the REST API as a public property', () => {
    expect(construct.api).toBeDefined();
    expect(construct.api.restApiId).toBeDefined();
  });
});
