/**
 * Environment-specific configuration for the Glacier Restore DataSync stack.
 * Values can be overridden via CDK context or environment variables.
 */

export interface EnvironmentConfig {
  /** ARN of the pre-configured DataSync task */
  dataSyncTaskArn: string;
  /** S3 bucket used for batch operation manifests */
  stagingBucket: string;
  /** AWS account ID */
  accountId: string;
  /** IAM role ARN for S3 Batch Operations */
  batchRoleArn: string;
  /** IAM role ARN for DataSync to access the manifest and source bucket */
  dataSyncS3RoleArn: string;
  /** ACM certificate ARN for the internal ALB HTTPS listener */
  certificateArn: string;
  /** Optional existing VPC ID; when absent a new VPC is created */
  existingVpcId?: string;
  /**
   * Optional public/app URL that users access the web UI through (e.g.
   * https://restore-tool.internal). Used for Cognito callback/logout URLs and
   * the front-end redirect URIs. When absent, the internal ALB DNS name is used.
   * Set this when you access the app via a custom domain (private hosted zone
   * or hosts entry) rather than the raw ALB DNS name.
   */
  appUrl?: string;
}

const environments: Record<string, EnvironmentConfig> = {
  dev: {
    dataSyncTaskArn: process.env.DATASYNC_TASK_ARN ?? 'arn:aws:datasync:us-east-1:123456789012:task/task-dev-placeholder',
    stagingBucket: process.env.STAGING_BUCKET ?? 'restore-transfer-staging-dev',
    accountId: process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012',
    batchRoleArn: process.env.BATCH_ROLE_ARN ?? 'arn:aws:iam::123456789012:role/S3BatchOperationsRole-dev',
    dataSyncS3RoleArn: process.env.DATASYNC_S3_ROLE_ARN ?? 'arn:aws:iam::123456789012:role/DataSyncS3Role-dev',
    certificateArn: process.env.CERTIFICATE_ARN ?? 'arn:aws:acm:us-east-1:123456789012:certificate/placeholder-dev',
    existingVpcId: process.env.EXISTING_VPC_ID || undefined,
    appUrl: process.env.APP_URL || undefined,
  },
  prod: {
    dataSyncTaskArn: process.env.DATASYNC_TASK_ARN ?? 'arn:aws:datasync:us-east-1:123456789012:task/task-prod-placeholder',
    stagingBucket: process.env.STAGING_BUCKET ?? 'restore-transfer-staging-prod',
    accountId: process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012',
    batchRoleArn: process.env.BATCH_ROLE_ARN ?? 'arn:aws:iam::123456789012:role/S3BatchOperationsRole-prod',
    dataSyncS3RoleArn: process.env.DATASYNC_S3_ROLE_ARN ?? 'arn:aws:iam::123456789012:role/DataSyncS3Role-prod',
    certificateArn: process.env.CERTIFICATE_ARN ?? 'arn:aws:acm:us-east-1:123456789012:certificate/placeholder-prod',
    existingVpcId: process.env.EXISTING_VPC_ID || undefined,
    appUrl: process.env.APP_URL || undefined,
  },
};

/**
 * Returns environment-specific configuration.
 * Resolves the environment from the provided argument, the `ENV` environment variable,
 * or defaults to 'dev'.
 */
export function getEnvironmentConfig(env?: string): EnvironmentConfig {
  const resolvedEnv = env ?? process.env.ENV ?? 'dev';
  const config = environments[resolvedEnv];

  if (!config) {
    throw new Error(`Unknown environment: "${resolvedEnv}". Supported environments: ${Object.keys(environments).join(', ')}`);
  }

  return config;
}
