# Restore and Transfer Orchestrator

An AWS CDK application that orchestrates S3 Glacier restores and DataSync transfers. It provides a REST API and web UI for submitting restore requests, tracking their status, and automatically syncing specific restored objects to an on-premises NFS destination via AWS DataSync.

## Architecture

![Architecture Diagram](docs/glacier-restore-transfer-arch.png)

The stack deploys five main components:

- **Persistence** — DynamoDB table for tracking restore request state with status timeline
- **Orchestrator** — Durable Lambda function that manages the multi-step restore workflow (detect storage class → initiate restore → monitor restore → start DataSync → monitor DataSync)
- **Auth** — Amazon Cognito User Pool with hosted UI for user authentication (authorization code grant with PKCE)
- **API** — REST API Gateway with Lambda integrations and Cognito authorizer for submitting requests and checking status
- **Web UI** — S3 + CloudFront static site for interacting with the API, with integrated Cognito login flow

### Orchestrator Workflow

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
- A pre-configured AWS DataSync task (source S3 → destination NFS/S3)
- An S3 bucket for staging batch operation manifests and DataSync manifests
- An IAM role for S3 Batch Operations
- An IAM role for DataSync to access the source bucket and manifest bucket

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd restore-transfer-orchestrator

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

### Build and synthesize

```bash
# Compile TypeScript
npm run build

# Preview the CloudFormation template
cdk synth
```

### Deploy

```bash
# Review changes before deploying
cdk diff

# Deploy the stack
cdk deploy RestoreTransferStack
```

> **Note:** If you don't already have prerequisite resources (DataSync task, S3 staging bucket, S3 Batch Operations role, DataSync S3 role), you can deploy the `RestoreTransferTestingStack` first — it provisions all of these for you. See [Testing Infrastructure](#testing-infrastructure-optional) below.

The deploy command will output the API endpoint URL and the Web UI CloudFront URL.

### Post-deployment: Create a Cognito user

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

## Testing Infrastructure (Optional)

An optional `RestoreTransferTestingStack` provisions all prerequisite resources for dev/test:

- VPC with public subnet
- Source S3 bucket (with Glacier lifecycle rule)
- Staging S3 bucket
- NFS server EC2 instance
- DataSync agent EC2 instance
- DataSync task, locations, and IAM roles
- S3 Batch Operations role

### Two-phase deployment

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

**Deploy the main stack using testing infrastructure outputs:**

```bash
export DATASYNC_TASK_ARN=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='DataSyncTaskArnOutput'].OutputValue" --output text)
export STAGING_BUCKET=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='StagingBucketNameOutput'].OutputValue" --output text)
export BATCH_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='BatchRoleArnOutput'].OutputValue" --output text)
export DATASYNC_S3_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack --query "Stacks[0].Outputs[?OutputKey=='DataSyncS3RoleArnOutput'].OutputValue" --output text)

cdk deploy RestoreTransferStack
```

### Upload test data

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
  --query "Stacks[0].Outputs[?OutputKey=='WebUiUrl'].OutputValue" --output text)

cat > src/web-ui/config.js << EOF
window.__CONFIG__ = {
  "apiUrl": "${API_URL%/}",
  "cognito": {
    "userPoolId": "${USER_POOL_ID}",
    "clientId": "${CLIENT_ID}",
    "domain": "https://<your-cognito-domain>.auth.${CDK_DEFAULT_REGION}.amazoncognito.com",
    "redirectUri": "http://localhost:8080",
    "logoutUri": "http://localhost:8080"
  }
};
EOF

# Serve locally
python3 -m http.server 8080 --directory src/web-ui
```

> **Note:** For local development, you must add `http://localhost:8080` to the Cognito User Pool Client's allowed callback and logout URLs in the AWS Console (or update the CDK code to include it).

## Project Structure

```
├── bin/                    # CDK app entry point
├── lib/
│   ├── config/             # Environment configuration
│   ├── constructs/         # CDK construct definitions
│   │   ├── api-construct.ts            # REST API with Cognito authorizer
│   │   ├── auth-construct.ts           # Cognito User Pool, Client & Hosted UI
│   │   ├── orchestrator-construct.ts   # Durable workflow Lambda
│   │   ├── persistence-construct.ts    # DynamoDB table
│   │   └── web-ui-construct.ts         # S3 + CloudFront with auth config
│   ├── restore-transfer-stack.ts       # Main application stack
│   └── testing-infrastructure-stack.ts # Optional test infrastructure
├── scripts/                # Helper scripts (test data upload)
├── src/
│   ├── api/                # API Lambda handlers
│   ├── orchestrator/       # Durable workflow Lambda + steps
│   ├── shared/             # Shared types, constants, validation
│   └── web-ui/             # Static web UI assets (with Cognito login)
└── test/                   # Unit tests
```

## Useful Commands

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

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.