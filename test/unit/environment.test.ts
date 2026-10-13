/**
 * Unit tests for environment configuration resolution and validation.
 * Verifies that required variables fail fast at synth time and that optional
 * variables fall back to undefined.
 */
import { getEnvironmentConfig } from '../../lib/config/environment';

const REQUIRED_VARS = [
  'CDK_DEFAULT_ACCOUNT',
  'STAGING_BUCKET',
  'BATCH_ROLE_ARN',
  'DATASYNC_S3_ROLE_ARN',
  'CERTIFICATE_ARN',
] as const;

const OPTIONAL_VARS = ['DATASYNC_TASK_ARN', 'EXISTING_VPC_ID', 'APP_URL', 'ENV'] as const;

const VALID_VALUES: Record<string, string> = {
  CDK_DEFAULT_ACCOUNT: '123456789012',
  STAGING_BUCKET: 'restore-transfer-staging-test',
  BATCH_ROLE_ARN: 'arn:aws:iam::123456789012:role/S3BatchOperationsRole-test',
  DATASYNC_S3_ROLE_ARN: 'arn:aws:iam::123456789012:role/DataSyncS3Role-test',
  CERTIFICATE_ARN: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert',
};

describe('getEnvironmentConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot and clear every variable the config reads so each test starts clean.
    for (const key of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function setAllRequired(): void {
    for (const [key, value] of Object.entries(VALID_VALUES)) {
      process.env[key] = value;
    }
  }

  it('returns config when all required variables are set', () => {
    setAllRequired();

    const config = getEnvironmentConfig();

    expect(config.accountId).toBe(VALID_VALUES.CDK_DEFAULT_ACCOUNT);
    expect(config.stagingBucket).toBe(VALID_VALUES.STAGING_BUCKET);
    expect(config.batchRoleArn).toBe(VALID_VALUES.BATCH_ROLE_ARN);
    expect(config.dataSyncS3RoleArn).toBe(VALID_VALUES.DATASYNC_S3_ROLE_ARN);
    expect(config.certificateArn).toBe(VALID_VALUES.CERTIFICATE_ARN);
  });

  it('leaves optional variables undefined when unset', () => {
    setAllRequired();

    const config = getEnvironmentConfig();

    expect(config.dataSyncTaskArn).toBeUndefined();
    expect(config.existingVpcId).toBeUndefined();
    expect(config.appUrl).toBeUndefined();
  });

  it('populates optional variables when set', () => {
    setAllRequired();
    process.env.DATASYNC_TASK_ARN = 'arn:aws:datasync:us-east-1:123456789012:task/task-abc';
    process.env.EXISTING_VPC_ID = 'vpc-0abc1234def56789a';
    process.env.APP_URL = 'https://restore-tool.internal';

    const config = getEnvironmentConfig();

    expect(config.dataSyncTaskArn).toBe('arn:aws:datasync:us-east-1:123456789012:task/task-abc');
    expect(config.existingVpcId).toBe('vpc-0abc1234def56789a');
    expect(config.appUrl).toBe('https://restore-tool.internal');
  });

  it.each(REQUIRED_VARS)('throws naming the variable when %s is missing', (missing) => {
    setAllRequired();
    delete process.env[missing];

    expect(() => getEnvironmentConfig()).toThrow(missing);
  });

  it('treats a blank/whitespace required variable as missing', () => {
    setAllRequired();
    process.env.CERTIFICATE_ARN = '   ';

    expect(() => getEnvironmentConfig()).toThrow('CERTIFICATE_ARN');
  });

  it('trims surrounding whitespace from required values', () => {
    setAllRequired();
    process.env.CERTIFICATE_ARN = `  ${VALID_VALUES.CERTIFICATE_ARN}  `;

    const config = getEnvironmentConfig();

    expect(config.certificateArn).toBe(VALID_VALUES.CERTIFICATE_ARN);
  });

  it('throws for an unknown environment', () => {
    setAllRequired();

    expect(() => getEnvironmentConfig('staging')).toThrow(/Unknown environment/);
  });
});
