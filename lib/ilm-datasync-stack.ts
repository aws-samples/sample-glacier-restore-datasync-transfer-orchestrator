import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { PersistenceConstruct } from './constructs/persistence-construct';
import { OrchestratorConstruct } from './constructs/orchestrator-construct';
import { ApiConstruct } from './constructs/api-construct';
import { WebUiConstruct } from './constructs/web-ui-construct';
import { getEnvironmentConfig } from './config/environment';

export class IlmDatasyncStack extends cdk.Stack {
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

    // 3. API — REST API Gateway with Lambda integrations
    const api = new ApiConstruct(this, 'Api', {
      table: persistence.table,
      orchestratorFunction: orchestrator.function,
    });

    // 4. Web UI — S3 + CloudFront static hosting
    const webUi = new WebUiConstruct(this, 'WebUi', {
      apiUrl: api.api.url,
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
  }
}
