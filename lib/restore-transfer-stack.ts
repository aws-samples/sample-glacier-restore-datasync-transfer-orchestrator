import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { PersistenceConstruct } from './constructs/persistence-construct';
import { OrchestratorConstruct } from './constructs/orchestrator-construct';
import { ApiConstruct } from './constructs/api-construct';
import { WebUiConstruct } from './constructs/web-ui-construct';
import { AuthConstruct } from './constructs/auth-construct';
import { getEnvironmentConfig } from './config/environment';

export class RestoreTransferStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const envConfig = getEnvironmentConfig();

    // 1. Persistence — DynamoDB table for request tracking
    const persistence = new PersistenceConstruct(this, 'Persistence');

    // 2. Orchestrator — Durable Function Lambda for restore workflow
    const orchestrator = new OrchestratorConstruct(this, 'Orchestrator', {
      table: persistence.table,
      dataSyncTaskArn: envConfig.dataSyncTaskArn,
      stagingBucket: envConfig.stagingBucket,
      accountId: envConfig.accountId,
      batchRoleArn: envConfig.batchRoleArn,
      dataSyncS3RoleArn: envConfig.dataSyncS3RoleArn,
    });

    // 3. Auth — Cognito User Pool, Client, and Hosted UI domain
    // Uses Lazy.string for callbackUrl to break circular reference with WebUi
    const auth: AuthConstruct = new AuthConstruct(this, 'Auth', {
      callbackUrl: cdk.Lazy.string({ produce: (): string => webUi.distributionUrl }),
    });

    // 4. API — REST API Gateway with Lambda integrations and Cognito authorizer
    const api: ApiConstruct = new ApiConstruct(this, 'Api', {
      table: persistence.table,
      orchestratorFunction: orchestrator.function,
      stagingBucket: envConfig.stagingBucket,
      userPool: auth.userPool,
    });

    // 5. Web UI — S3 + CloudFront static hosting with Cognito config
    const webUi: WebUiConstruct = new WebUiConstruct(this, 'WebUi', {
      apiUrl: api.api.url,
      cognitoConfig: {
        userPoolId: auth.userPool.userPoolId,
        userPoolClientId: auth.userPoolClient.userPoolClientId,
        cognitoDomain: auth.cognitoDomainUrl,
        redirectUri: cdk.Lazy.string({ produce: (): string => webUi.distributionUrl }),
        logoutUri: cdk.Lazy.string({ produce: (): string => webUi.distributionUrl }),
      },
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.api.url,
      description: 'REST API endpoint URL',
    });

    new cdk.CfnOutput(this, 'WebUiUrl', {
      value: webUi.distributionUrl,
      description: 'Web UI CloudFront URL',
    });

    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: auth.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'CognitoClientId', {
      value: auth.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
  }
}
