/**
 * Environment-specific configuration for the Glacier Restore DataSync stack.
 * Values are sourced from environment variables. Required variables are
 * validated at synth time so a missing value fails fast with a clear message
 * rather than surfacing as a cryptic service error partway through deployment
 * (e.g. ELB rejecting a placeholder ACM certificate ARN).
 */

export interface EnvironmentConfig {
  /**
   * Optional default/fallback DataSync task ARN, used only when a request does
   * not specify a destination. The orchestrator otherwise finds or creates a
   * task dynamically, so this is not required to deploy.
   */
  dataSyncTaskArn?: string;
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

/**
 * Reads a required environment variable, throwing a descriptive error when it
 * is missing or blank. The error names the variable and points at the README
 * configuration section so the fix is obvious.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it before running cdk synth/deploy — see the "Configuration" section of the README. ` +
        `For ${name === 'CERTIFICATE_ARN' ? 'the ACM certificate, see "Create the ACM certificate (before deploying)"' : 'DataSync/staging resources, see "Testing infrastructure"'}.`,
    );
  }
  return value.trim();
}

/**
 * Builds the configuration for the resolved environment. Required variables are
 * read via requireEnv (fail-fast); optional variables fall back to undefined.
 * The dev/prod distinction only affects the ENV value validated here — all
 * concrete values come from the environment, so there are no deploy-time
 * placeholder fallbacks.
 */
function buildConfig(): EnvironmentConfig {
  return {
    dataSyncTaskArn: process.env.DATASYNC_TASK_ARN || undefined,
    stagingBucket: requireEnv('STAGING_BUCKET'),
    accountId: requireEnv('CDK_DEFAULT_ACCOUNT'),
    batchRoleArn: requireEnv('BATCH_ROLE_ARN'),
    dataSyncS3RoleArn: requireEnv('DATASYNC_S3_ROLE_ARN'),
    certificateArn: requireEnv('CERTIFICATE_ARN'),
    existingVpcId: process.env.EXISTING_VPC_ID || undefined,
    appUrl: process.env.APP_URL || undefined,
  };
}

const SUPPORTED_ENVIRONMENTS = ['dev', 'prod'] as const;

/**
 * Returns environment-specific configuration.
 * Resolves the environment from the provided argument, the `ENV` environment variable,
 * or defaults to 'dev'. Throws if required environment variables are not set.
 */
export function getEnvironmentConfig(env?: string): EnvironmentConfig {
  const resolvedEnv = env ?? process.env.ENV ?? 'dev';

  if (!SUPPORTED_ENVIRONMENTS.includes(resolvedEnv as (typeof SUPPORTED_ENVIRONMENTS)[number])) {
    throw new Error(
      `Unknown environment: "${resolvedEnv}". Supported environments: ${SUPPORTED_ENVIRONMENTS.join(', ')}`,
    );
  }

  return buildConfig();
}
