import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PersistenceConstruct } from './constructs/persistence-construct';
import { OrchestratorConstruct } from './constructs/orchestrator-construct';
import { ApiConstruct } from './constructs/api-construct';
import { VpcConstruct } from './constructs/vpc-construct';
import { VpcWebUiConstruct } from './constructs/vpc-web-ui-construct';
import { AuthConstruct } from './constructs/auth-construct';
import { getEnvironmentConfig } from './config/environment';

export class RestoreTransferStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const envConfig = getEnvironmentConfig();

    // 1. VPC Network — VPC, endpoints, and security groups
    const vpcNetwork = new VpcConstruct(this, 'VpcNetwork', {
      ...(envConfig.existingVpcId && {
        existingVpc: ec2.Vpc.fromLookup(this, 'ImportedVpc', { vpcId: envConfig.existingVpcId }),
      }),
    });

    // 2. Persistence — DynamoDB table for request tracking
    const persistence = new PersistenceConstruct(this, 'Persistence');

    // 3. Orchestrator — Durable Function Lambda for restore workflow
    const orchestrator = new OrchestratorConstruct(this, 'Orchestrator', {
      table: persistence.table,
      dataSyncTaskArn: envConfig.dataSyncTaskArn,
      stagingBucket: envConfig.stagingBucket,
      accountId: envConfig.accountId,
      batchRoleArn: envConfig.batchRoleArn,
      dataSyncS3RoleArn: envConfig.dataSyncS3RoleArn,
      vpc: vpcNetwork.vpc,
      lambdaSecurityGroup: vpcNetwork.lambdaSecurityGroup,
    });

    // Public URL users access the app through. Prefer the configured custom
    // domain (APP_URL); otherwise fall back to the internal ALB DNS name.
    const publicUrl: string = envConfig.appUrl
      ?? cdk.Lazy.string({ produce: (): string => webUi.albUrl });

    // 4. Auth — Cognito User Pool, Client, and Hosted UI domain
    // callbackUrl uses the public app URL so Cognito redirects the browser back
    // to a URL it can actually resolve (and that matches the TLS certificate).
    const auth = new AuthConstruct(this, 'Auth', {
      callbackUrl: publicUrl,
    });

    // 5. API — Private REST API Gateway with Lambda integrations and Cognito authorizer
    const api: ApiConstruct = new ApiConstruct(this, 'Api', {
      table: persistence.table,
      orchestratorFunction: orchestrator.function,
      stagingBucket: envConfig.stagingBucket,
      userPool: auth.userPool,
      vpc: vpcNetwork.vpc,
      lambdaSecurityGroup: vpcNetwork.lambdaSecurityGroup,
      vpcEndpointId: vpcNetwork.executeApiEndpoint.vpcEndpointId,
      allowedOrigin: publicUrl,
    });

    // 6. Web UI — ECS Fargate behind internal ALB with HTTPS
    const webUi: VpcWebUiConstruct = new VpcWebUiConstruct(this, 'WebUi', {
      vpc: vpcNetwork.vpc,
      apiUrl: api.api.url,
      cognitoConfig: {
        userPoolId: auth.userPool.userPoolId,
        userPoolClientId: auth.userPoolClient.userPoolClientId,
        cognitoDomain: auth.cognitoDomainUrl,
      },
      certificateArn: envConfig.certificateArn,
      publicUrl: envConfig.appUrl,
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.api.url,
      description: 'REST API endpoint URL',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: webUi.albDnsName,
      description: 'Internal ALB DNS name for the web UI',
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
