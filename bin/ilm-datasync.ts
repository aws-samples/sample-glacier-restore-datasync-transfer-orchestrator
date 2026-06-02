#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { IlmDatasyncStack } from '../lib/ilm-datasync-stack';
import { TestingInfrastructureStack } from '../lib/testing-infrastructure-stack';

const app = new cdk.App();

// Main application stack
new IlmDatasyncStack(app, 'IlmDatasyncStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});

// Optional testing infrastructure stack — deploys prerequisite resources
// (DataSync task, NFS server, staging bucket, etc.) for dev/test environments.
// Deploy with: npx cdk deploy IlmDatasyncTestingStack
new TestingInfrastructureStack(app, 'IlmDatasyncTestingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Testing infrastructure for ILM DataSync — includes DataSync task, NFS server, and staging bucket',
});
