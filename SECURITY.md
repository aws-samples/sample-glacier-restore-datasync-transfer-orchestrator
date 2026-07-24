# Security

This document describes the known security considerations, deliberate trade-offs, and production hardening recommendations for the Restore and Transfer Orchestrator.

## Important disclaimer

This project is designed as an internal tool and sample architecture. It contains intentional simplifications that are acceptable for a controlled, internal deployment but **must be hardened before use in a production environment with broader access or sensitive data**. Review all items below before deploying to production.

---

## Known security considerations

### 1. Overly broad S3 IAM permissions (wildcard resources)

**File:** `lib/constructs/orchestrator-construct.ts` (lines 86–96)

**What:** The orchestrator Lambda has `s3:GetObject`, `s3:HeadObject`, and `s3:RestoreObject` permissions scoped to `arn:aws:s3:::*/*`, meaning it can read from and initiate Glacier restores on objects in **any** S3 bucket in the account.

**Why this exists:** The source bucket is user-specified at runtime — users submit restore requests against arbitrary buckets they own. At deploy time, the set of valid source buckets is not known and may change over time without redeployment.

**Risk:** If the Lambda is compromised or misused, it could access or restore objects in unrelated buckets across the account.

**Production hardening:**

- **Option A (recommended):** Scope the resource to an allowed bucket prefix pattern. Accept a `allowedBucketPrefix` prop on the construct and use it in the policy:
  ```typescript
  resources: [`arn:aws:s3:::${props.allowedBucketPrefix}*/*`]
  ```
- **Option B:** Maintain an explicit allowlist of bucket ARNs and pass them as a construct prop. Update the CDK stack when new buckets are onboarded.
- **Option C:** Use an S3 Access Point or bucket policy to enforce that only authorized principals can invoke `RestoreObject`, providing defense-in-depth independent of the Lambda's IAM policy.

Similarly, `s3:ListBucket` is scoped to `arn:aws:s3:::*` for glob pattern expansion. Apply the same prefix-scoping approach.

### 2. DataSync and S3 Batch Operations wildcard resources

**File:** `lib/constructs/orchestrator-construct.ts`

**What:** The DataSync actions (`datasync:StartTaskExecution`, `datasync:DescribeTaskExecution`, `datasync:ListTasks`, `datasync:DescribeTask`, `datasync:CreateTask`, `datasync:ListLocations`, `datasync:CreateLocationS3`) and S3 Batch Operations actions (`s3:CreateJob`, `s3:DescribeJob`) use `Resource: "*"`.

**Why this exists:** AWS DataSync and S3 Control (Batch Operations) APIs do not support resource-level permissions for all actions. `datasync:ListTasks`, `datasync:ListLocations`, `s3:CreateJob`, and `s3:DescribeJob` require `Resource: "*"` per AWS documentation. Additionally, the orchestrator dynamically resolves or creates DataSync tasks at runtime, so specific task ARNs are not known at deploy time.

**Risk:** The Lambda can interact with any DataSync task or S3 Batch job in the account.

**Production hardening:**

- Where possible, scope DataSync actions that do support resource-level permissions (`StartTaskExecution`, `DescribeTaskExecution`, `DescribeTask`) to a specific task ARN pattern (e.g., `arn:aws:datasync:*:*:task/task-*`).
- Use IAM condition keys to further restrict access (e.g., `aws:ResourceTag` if tasks are tagged).
- Use separate IAM roles for distinct workloads to limit blast radius.

### 3. Predictable fallback bucket and resource names

**File:** `lib/config/environment.ts`

**What:** Environment configuration uses hardcoded fallback values like `restore-transfer-staging-dev` and placeholder account IDs (`123456789012`) when environment variables are not set.

**Risk:** Predictable resource names could enable resource squatting in shared accounts, or an accidental deployment without proper environment variables could create resources with known names.

**Production hardening:**

- Remove fallback values entirely or use account/region-specific patterns (e.g., `restore-transfer-staging-${accountId}-${region}`).
- Fail loudly at synth time if required environment variables are missing (replace `??` fallbacks with explicit validation).
- Never deploy to production without setting all required environment variables.

### 4. No WAF (web application firewall)

**What:** The CloudFront distribution and API Gateway do not have AWS WAF attached.

**Why this exists:** WAF adds cost and configuration complexity that is unnecessary for a low-traffic internal tool with Cognito authentication.

**Production hardening:**

- Attach an AWS WAF WebACL to both CloudFront and API Gateway.
- Configure rate limiting, geo-restriction, and managed rule groups (e.g., AWSManagedRulesCommonRuleSet).
- Enable WAF logging for audit and incident response.

---

## What's already secure

The following security controls are implemented:

- **Authentication:** Cognito User Pool with PKCE authorization code flow, self-signup disabled, proper OAuth scopes.
- **Input validation:** Comprehensive validation module (`src/shared/validation.ts`) with explicit allowlists; ReDoS prevention via character allowlist before RegExp construction.
- **S3 access controls:** `BlockPublicAccess.BLOCK_ALL` on all S3 buckets; CloudFront uses Origin Access Control (OAC).
- **Specific IAM actions:** No `Action: "*"` anywhere; all policies enumerate specific actions.
- **IAM PassRole conditioning:** `iam:PassRole` is conditioned to specific services (`s3.amazonaws.com`, `datasync.amazonaws.com`).
- **Error handling:** Structured JSON error responses; no stack traces leaked to clients.
- **Data lifecycle:** DynamoDB TTL automatically removes records 30 days after completion.
- **No hardcoded secrets:** Clean secrets scan; no credentials committed to the repository.

---

## Resource cleanup

When decommissioning the stack:

1. Destroy the main stack first: `cdk destroy RestoreTransferStack`
2. Destroy the testing stack: `cdk destroy RestoreTransferTestingStack`
3. Manually review and delete any S3 buckets with `RemovalPolicy.RETAIN` if data is no longer needed.
4. Revoke or delete Cognito users.
5. Review CloudWatch log groups — they may persist after stack deletion depending on retention settings.

---

## Reporting security issues

If you discover a potential security issue in this project, please refer to [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for instructions on responsible disclosure.

---

## Dependency management

- All dependencies use caret-pinned versions with a lockfile (`package-lock.json`) for reproducible builds.
- AWS SDK v3 clients are used exclusively (no v2).
- Regularly audit dependencies with `npm audit` and update as needed.
- The lockfile should be committed and used in CI/CD (`npm ci`) to prevent supply chain drift.
