#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { RestoreTransferStack } from '../lib/restore-transfer-stack';
import { TestingInfrastructureStack } from '../lib/testing-infrastructure-stack';

const app = new cdk.App();
new AwsSolutionsChecks(app, { verbose: true });

// Main application stack
new RestoreTransferStack(app, 'RestoreTransferStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// Optional testing infrastructure stack — deploys prerequisite resources
// (DataSync task, NFS server, staging bucket, etc.) for dev/test environments.
// Deploy with: npx cdk deploy RestoreTransferTestingStack
new TestingInfrastructureStack(app, 'RestoreTransferTestingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Testing infrastructure for Restore and Transfer Orchestrator — includes DataSync task, NFS server, and staging bucket',
});