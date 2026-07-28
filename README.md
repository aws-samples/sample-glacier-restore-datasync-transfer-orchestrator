# Restore and transfer orchestrator

An AWS CDK application that orchestrates S3 Glacier restores and DataSync transfers. It provides a REST API and web UI for submitting restore requests, tracking their status, and automatically syncing specific restored objects to an on-premises NFS destination via AWS DataSync.

> **⚠️ Non-production sample:** This project is intended as an internal tool and reference architecture. It contains deliberate simplifications (e.g., wildcard S3 IAM permissions, predictable fallback resource names) that must be hardened before production use. See [SECURITY.md](SECURITY.md) for details and hardening recommendations.

## Architecture

![Architecture Diagram](docs/glacier-restore-transfer-arch.png)

The stack deploys five main components:

- **Persistence** — DynamoDB table for tracking restore request state with status timeline
- **Orchestrator** — Durable Lambda function that manages the multi-step restore workflow (detect storage class → initiate restore → monitor restore → start DataSync → monitor DataSync)
- **Auth** — Amazon Cognito User Pool with hosted UI for user authentication (authorization code grant with PKCE)
- **API** — REST API Gateway with Lambda integrations and Cognito authorizer for submitting requests and checking status
- **Web UI** — S3 + CloudFront static site for interacting with the API, with integrated Cognito login flow

### Orchestrator workflow

The orchestrator handles each request intelligently:

1. **Detect storage class** — Checks each object's storage class and current restore status via HeadObject
2. **Skip already-restored objects** — Objects with an active restore or in warm tiers skip straight to DataSync
3. **Initiate restores** — Only initiates restores for cold objects that need it (individual for ≤50, S3 Batch Operations for >50)
4. **Monitor restores** — Polls restore status with exponential backoff until completion or timeout
5. **Start DataSync with manifest** — Uploads a CSV manifest of the specific files to transfer, then starts a DataSync task execution scoped to only those files
6. **Monitor DataSync** — Polls execution status until completion

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.x
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with appropriate credentials
- [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) v2 (`npm install -g aws-cdk`)
- An AWS account with permissions to create Lambda, API Gateway, DynamoDB, S3, CloudFront, Cognito, and DataSync resources
- (Optional) A pre-configured AWS DataSync task (source S3 → destination NFS/S3)
- (Optional) An S3 bucket for staging batch operation manifests and DataSync manifests
- (Optional) An IAM role for S3 Batch Operations
- (Optional) An IAM role for DataSync to access the source bucket and manifest bucket

## Installation

```bash
# Clone the repository
git clone https://github.com/aws-samples/sample-glacier-restore-datasync-transfer-orchestrator.git
cd sample-glacier-restore-datasync-transfer-orchestrator

# Install dependencies
npm install
```

## Configuration

The stack uses environment variables to configure deployment. Set these before deploying:

| Variable | Description | Required |
|----------|-------------|----------|
| `ENV` | Target environment (`dev` or `prod`). Defaults to `dev`. | No |
| `DATASYNC_TASK_ARN` | Default/fallback DataSync task ARN, used when a request does not specify a destination | No |
| `STAGING_BUCKET` | S3 bucket name for batch and DataSync manifests | Yes |
| `CDK_DEFAULT_ACCOUNT` | AWS account ID for deployment | Yes |
| `CDK_DEFAULT_REGION` | AWS region for deployment | Yes |
| `BATCH_ROLE_ARN` | IAM role ARN for S3 Batch Operations | Yes |
| `DATASYNC_S3_ROLE_ARN` | IAM role ARN for DataSync to access S3 (source + manifests); also used to create new DataSync tasks/locations dynamically | Yes |

> **Note on DataSync task resolution:** When a user selects a destination in the UI (via the `/datasync-destinations` endpoint), the orchestrator dynamically finds or creates a DataSync task matching the source bucket and chosen NFS destination. `DATASYNC_TASK_ARN` is only used as a fallback when no destination is specified in the request.

Example:

```bash
export ENV=dev
export DATASYNC_TASK_ARN=arn:aws:datasync:us-west-2:123456789012:task/task-abc123  # optional fallback
export STAGING_BUCKET=my-staging-bucket
export CDK_DEFAULT_ACCOUNT=123456789012
export CDK_DEFAULT_REGION=us-west-2
export BATCH_ROLE_ARN=arn:aws:iam::123456789012:role/S3BatchOperationsRole
export DATASYNC_S3_ROLE_ARN=arn:aws:iam::123456789012:role/DataSyncS3Role
```

## Deployment

### First-time setup

If this is your first CDK deployment in the target account/region, bootstrap the environment:

```bash
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

### Testing infrastructure (optional — if you don't have DataSync resources)

If you don't already have a DataSync task, staging bucket, S3 Batch Operations role, and DataSync S3 role, you can deploy the optional `RestoreTransferTestingStack` to provision all of these. Skip this section if you already have these resources.

The testing stack creates:

- VPC with public subnet
- Source S3 bucket (with Glacier lifecycle rule)
- Staging S3 bucket
- NFS server EC2 instance
- DataSync agent EC2 instance
- DataSync task, locations, and IAM roles
- S3 Batch Operations role

#### Two-phase deployment

**Phase 1** — Deploy without activation key to stand up EC2 instances:

```bash
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-west-2

cdk deploy RestoreTransferTestingStack \
  --parameters ActivationCidr=$(curl -s ifconfig.me)/32
```

**Phase 2** — Activate the DataSync agent, then redeploy:

```bash
# Get the activation key (use the agent public IP from Phase 1 outputs)
curl -v "http://<agent-public-ip>/?gatewayType=SYNC&activationRegion=us-west-2&redirect_type=TEXT"
# The activation key is in the Location header of the 302 response

# Redeploy with the key
cdk deploy RestoreTransferTestingStack \
  --parameters ActivationKey=XXXXX-XXXXX-XXXXX-XXXXX-XXXXX \
  --parameters ActivationCidr=$(curl -s ifconfig.me)/32
```

#### Set environment variables from testing stack outputs

```bash
export DATASYNC_TASK_ARN=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='DataSyncTaskArnOutput'].OutputValue" --output text)
export STAGING_BUCKET=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='StagingBucketNameOutput'].OutputValue" --output text)
export BATCH_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='BatchRoleArnOutput'].OutputValue" --output text)
export DATASYNC_S3_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='DataSyncS3RoleArnOutput'].OutputValue" --output text)
```

### Deploy

```bash
# Deploy the stack
cdk deploy RestoreTransferStack
```

The deploy command will output the API endpoint URL, the Web UI CloudFront URL, and the Cognito User Pool ID.

### Post-deployment: create a Cognito user

Self-sign-up is disabled, so you need to create users via the AWS CLI or Console:

```bash
# Create a user
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com \
  --temporary-password 'TempPass1!'

# Set a permanent password (skip the force-change-password flow)
aws cognito-idp admin-set-user-password \
  --user-pool-id <USER_POOL_ID> \
  --username user@example.com \
  --password 'YourSecureP@ss1' \
  --permanent
```

The User Pool ID and Client ID are available in the stack outputs (`CognitoUserPoolId` and `CognitoClientId`).

### Deploy to a specific environment

```bash
# Deploy to production
ENV=prod cdk deploy RestoreTransferStack
```

## Upload test data

A helper script uploads sample files to various Glacier storage classes. It supports configurable file counts, folder nesting depth, and storage class selection — useful for testing glob patterns and batch operation thresholds.

```bash
SOURCE_BUCKET=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack \
  --query "Stacks[0].Outputs[?OutputKey=='SourceBucketNameOutput'].OutputValue" --output text)

./scripts/upload-test-data.sh "$SOURCE_BUCKET"
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-n, --num-files <count>` | Number of files per storage class | 3 |
| `-d, --depth <levels>` | Folder nesting depth (2–4 levels) | 2 |
| `-s, --size <mb>` | Size of each file in MB | 1 |
| `--flat` | No nested folders — all files at top level | off |
| `--classes <list>` | Comma-separated storage classes | `GLACIER,GLACIER_IR,DEEP_ARCHIVE,INTELLIGENT_TIERING` |

**Examples:**

```bash
# Deep nesting for glob pattern testing
./scripts/upload-test-data.sh "$SOURCE_BUCKET" -n 10 -d 4

# Flat structure, single class
./scripts/upload-test-data.sh "$SOURCE_BUCKET" -n 5 --flat --classes GLACIER

# Large batch to exceed the 50-object threshold (triggers S3 Batch Operations)
./scripts/upload-test-data.sh "$SOURCE_BUCKET" -n 15 -d 3
```

## Testing a transfer in the UI

Once the testing stack and main stack are deployed, you can submit a restore-and-transfer request through the web UI. This walkthrough uses the test environment resources.

### 1. Log in

Open the Web UI URL from the stack outputs (`WebUiUrl`). You'll be redirected to the Cognito hosted login page. Sign in with the user you created in the [post-deployment step](#post-deployment-create-a-cognito-user).

![Amazon Cognito login window](docs/cognito-signin.png)

### 2. Fill out the restore request form

| Field | What to enter |
|-------|---------------|
| **S3 Bucket** | The source bucket name from the testing stack (the `SourceBucketNameOutput` value) |
| **File Paths** | One path per line. Use exact keys (e.g., `project-alpha/renders/v01/renders_000.exr`) or glob patterns (e.g., `project-alpha/renders/v01/*`). These should match files you uploaded with the test data script. |
| **Retrieval Tier** | `Standard` is a good default for testing. `Expedited` is faster (minutes) but only works for Glacier, not Deep Archive. `Bulk` is cheapest but can take multiple hours, depending on the tier. |
| **Restore Duration** | Number of days the restored copies remain accessible. Use a low value like `1` for testing. |
| **Transfer Destination** | Select an NFS destination from the dropdown. The testing stack creates two: `/data/datasync-destination` and `/data/datasync-destination-2`. |

> **Glob pattern limitations:** Only single-level `*` wildcards are supported (e.g., `renders/*.exr` matches files directly in `renders/`). Recursive patterns (`**`) and single-character wildcards (`?`) are not supported. To match files in nested subdirectories, submit separate patterns for each level (e.g., `renders/shot-01/*.exr`, `renders/shot-02/*.exr`) or use exact paths.

![Restore transfer inputs](docs/transfer-setup.png)

### 3. Submit and monitor

Click **Submit Restore Request**. The request appears in the dashboard below the form with a status of **Submitted**. The dashboard auto-refreshes every 10 seconds.

The request progresses through these stages:

1. **Resolving Paths** — Glob patterns are expanded to concrete S3 keys
2. **Detecting Storage Class** — Each object is checked for its current storage tier
3. **Initiating Restore** — Glacier restore requests are issued
4. **Restore In Progress** — Polling until objects are restored (duration depends on retrieval tier)
5. **Starting DataSync** — A manifest is uploaded and a DataSync task execution starts
6. **DataSync In Progress** — Transfer is running to the NFS destination
7. **Transfer Complete** — All objects have been transferred

### 4. View request details

Click any row in the dashboard to open the detail panel. This shows:

- Full request parameters (bucket, tier, destination)
- Object progress (restored count / total)
- Status timeline with timestamps and duration between each step
- A link to download the transfer manifest (once generated)

![Restore transfer status](docs/transfer-status.png)

### 5. Verify on the NFS server

Connect to the NFS server instance using SSM Session Manager (no SSH or key pair is configured on the instance).

**Option A — From the AWS Console:**

1. Open the [EC2 Instances console](https://console.aws.amazon.com/ec2/home#Instances)
2. Find the instance named `RestoreTransferTestingStack/NfsServer`
3. Select it → **Connect** → **SSM Session Manager** tab → **Connect**
4. In the shell session, run: `ls /data/datasync-destination/`

> **Note:** Your IAM user/role needs the `ssm:StartSession` permission on the instance. See the [Session Manager prerequisites](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html) for required IAM policies.

**Option B — From the CLI (requires the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)):**

```bash
# Get the NFS server instance ID
NFS_INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=RestoreTransferTestingStack/NfsServer" \
             "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" --output text)

# Start a session
aws ssm start-session --target "$NFS_INSTANCE_ID"

# Once connected, check the destination directory
ls /data/datasync-destination/
```

### Tips for testing

- **Quick iteration:** Use `Expedited` tier with Glacier Flexible Retrieval objects for restores that complete in 1–5 minutes.
- **Test batch operations:** Upload 50+ files with the test data script to trigger S3 Batch Operations instead of individual `RestoreObject` calls.
- **Test glob patterns:** Use deep nesting (`-d 4`) when uploading test data, then submit a request with patterns like `glacier/depth-2/*.dat` to match files at a specific level.
- **Test multiple destinations:** Submit separate requests targeting each NFS destination to verify the dynamic task resolution logic.

## Development

```bash
# Watch mode — recompile on file changes
npm run watch

# Run unit tests
npm run test

# Synthesize and check for drift
cdk diff
```

### Local UI development

Serve the web UI locally and point it at the deployed API and Cognito:

```bash
# Build config from stack outputs
API_URL=$(aws cloudformation describe-stacks --stack-name RestoreTransferStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name RestoreTransferStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name RestoreTransferStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoClientId'].OutputValue" --output text)
WEB_UI_URL=$(aws cloudformation describe-stacks --stack-name RestoreTransferStack \
  --query "Stacks[0].Outputs[?OutputKey=='WebUiUrl'].OutputValue" --output text) \
COGNITO_DOMAIN=$(aws cognito-idp describe-user-pool \
  --user-pool-id "$USER_POOL_ID" \
  --query "UserPool.Domain" --output text)

cat > src/web-ui/config.js << EOF
window.__CONFIG__ = {
  "apiUrl": "${API_URL%/}",
  "cognito": {
    "userPoolId": "${USER_POOL_ID}",
    "clientId": "${CLIENT_ID}",
    "domain": "https://${COGNITO_DOMAIN}.auth.${CDK_DEFAULT_REGION}.amazoncognito.com",
    "redirectUri": "http://localhost:8080",
    "logoutUri": "http://localhost:8080"
  }
};
EOF

# Serve locally
python3 -m http.server 8080 --directory src/web-ui
```

> **Note:** For local development, you must add `http://localhost:8080` to the Cognito User Pool Client's allowed callback and logout URLs in the AWS Console (or update the CDK code to include it).

## Project structure

```
├── bin/                                # CDK app entry point
├── lib/
│   ├── config/                         # Environment configuration
│   ├── constructs/                     # CDK construct definitions
│   │   ├── api-construct.ts            # REST API with Cognito authorizer
│   │   ├── auth-construct.ts           # Cognito User Pool, Client & Hosted UI
│   │   ├── orchestrator-construct.ts   # Durable workflow Lambda
│   │   ├── persistence-construct.ts    # DynamoDB table
│   │   └── web-ui-construct.ts         # S3 + CloudFront with auth config
│   ├── restore-transfer-stack.ts       # Main application stack
│   └── testing-infrastructure-stack.ts # Optional test infrastructure
├── scripts/                            # Helper scripts (test data upload)
├── src/
│   ├── api/                            # API Lambda handlers
│   ├── orchestrator/                   # Durable workflow Lambda + steps
│   ├── shared/                         # Shared types, constants, validation
│   └── web-ui/                         # Static web UI assets (with Cognito login)
└── test/                               # Unit tests
```

## Useful commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch for changes and recompile |
| `npm run test` | Run Jest unit tests |
| `cdk synth` | Emit the synthesized CloudFormation template |
| `cdk diff` | Compare deployed stack with current state |
| `cdk deploy RestoreTransferStack` | Deploy the main application stack |
| `cdk deploy RestoreTransferTestingStack` | Deploy the testing infrastructure |
| `cdk destroy RestoreTransferStack` | Remove the main stack |
| `cdk destroy RestoreTransferTestingStack` | Remove the testing infrastructure |

## Cleanup

To tear down all deployed resources:

```bash
cdk destroy RestoreTransferStack
cdk destroy RestoreTransferTestingStack
```

Note: Destroy the main stack first, then the testing stack. The testing stack includes DynamoDB tables and S3 buckets that will be deleted along with their data.

## Security

This project has documented security trade-offs and production hardening recommendations. See [SECURITY.md](SECURITY.md) for:

- Known IAM permission scoping decisions and how to tighten them
- Predictable resource name risks and mitigations
- WAF and other defense-in-depth recommendations

To report a security issue, see [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications).

## License

This library is licensed under the MIT-0 License. See the LICENSE file.