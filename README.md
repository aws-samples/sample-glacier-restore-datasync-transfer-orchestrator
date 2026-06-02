# ILM DataSync

An AWS CDK application that orchestrates S3 Glacier restores and DataSync transfers. It provides a REST API and web UI for submitting restore requests, tracking their status, and automatically syncing specific restored objects to an on-premises NFS destination via AWS DataSync.

## Architecture

The stack deploys four main components:

- **Persistence** — DynamoDB table for tracking restore request state with status timeline
- **Orchestrator** — Durable Lambda function that manages the multi-step restore workflow (detect storage class → initiate restore → monitor restore → start DataSync → monitor DataSync)
- **API** — REST API Gateway with Lambda integrations for submitting requests and checking status
- **Web UI** — S3 + CloudFront static site for interacting with the API

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
- An AWS account with permissions to create Lambda, API Gateway, DynamoDB, S3, CloudFront, and DataSync resources
- A pre-configured AWS DataSync task (source S3 → destination NFS/S3)
- An S3 bucket for staging batch operation manifests and DataSync manifests
- An IAM role for S3 Batch Operations
- An IAM role for DataSync to access the source bucket and manifest bucket

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd ilm-datasync

# Install dependencies
npm install
```

## Configuration

The stack uses environment variables to configure deployment. Set these before deploying:

| Variable | Description | Required |
|----------|-------------|----------|
| `ENV` | Target environment (`dev` or `prod`). Defaults to `dev`. | No |
| `DATASYNC_TASK_ARN` | ARN of the pre-configured DataSync task | Yes |
| `STAGING_BUCKET` | S3 bucket name for batch and DataSync manifests | Yes |
| `CDK_DEFAULT_ACCOUNT` | AWS account ID for deployment | Yes |
| `CDK_DEFAULT_REGION` | AWS region for deployment | Yes |
| `BATCH_ROLE_ARN` | IAM role ARN for S3 Batch Operations | Yes |
| `DATASYNC_S3_ROLE_ARN` | IAM role ARN for DataSync to access S3 (source + manifests) | Yes |

Example:

```bash
export ENV=dev
export DATASYNC_TASK_ARN=arn:aws:datasync:us-west-2:123456789012:task/task-abc123
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
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

### Build and synthesize

```bash
# Compile TypeScript
npm run build

# Preview the CloudFormation template
npx cdk synth
```

### Deploy

```bash
# Review changes before deploying
npx cdk diff

# Deploy the stack
npx cdk deploy IlmDatasyncStack
```

The deploy command will output the API endpoint URL and the Web UI CloudFront URL.

### Deploy to a specific environment

```bash
# Deploy to production
ENV=prod npx cdk deploy IlmDatasyncStack
```

## Testing Infrastructure (Optional)

An optional `IlmDatasyncTestingStack` provisions all prerequisite resources for dev/test:

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

npx cdk deploy IlmDatasyncTestingStack \
  --parameters ActivationCidr=$(curl -s ifconfig.me)/32
```

**Phase 2** — Activate the DataSync agent, then redeploy:

```bash
# Get the activation key (use the agent public IP from Phase 1 outputs)
curl -v "http://<agent-public-ip>/?gatewayType=SYNC&activationRegion=us-west-2&redirect_type=TEXT"
# The activation key is in the Location header of the 302 response

# Redeploy with the key
npx cdk deploy IlmDatasyncTestingStack \
  --parameters ActivationKey=XXXXX-XXXXX-XXXXX-XXXXX-XXXXX \
  --parameters ActivationCidr=$(curl -s ifconfig.me)/32
```

**Deploy the main stack using testing infrastructure outputs:**

```bash
export DATASYNC_TASK_ARN=$(aws cloudformation describe-stacks --stack-name IlmDatasyncTestingStack --query "Stacks[0].Outputs[?OutputKey=='DataSyncTaskArnOutput'].OutputValue" --output text)
export STAGING_BUCKET=$(aws cloudformation describe-stacks --stack-name IlmDatasyncTestingStack --query "Stacks[0].Outputs[?OutputKey=='StagingBucketNameOutput'].OutputValue" --output text)
export BATCH_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name IlmDatasyncTestingStack --query "Stacks[0].Outputs[?OutputKey=='BatchRoleArnOutput'].OutputValue" --output text)
export DATASYNC_S3_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name IlmDatasyncTestingStack --query "Stacks[0].Outputs[?OutputKey=='DataSyncS3RoleArnOutput'].OutputValue" --output text)

npx cdk deploy IlmDatasyncStack
```

### Upload test data

A helper script uploads sample files to various Glacier storage classes:

```bash
SOURCE_BUCKET=$(aws cloudformation describe-stacks --stack-name IlmDatasyncTestingStack \
  --query "Stacks[0].Outputs[?OutputKey=='SourceBucketNameOutput'].OutputValue" --output text)

./scripts/upload-test-data.sh "$SOURCE_BUCKET"
```

## Development

```bash
# Watch mode — recompile on file changes
npm run watch

# Run unit tests
npm run test

# Synthesize and check for drift
npx cdk diff
```

### Local UI development

Serve the web UI locally and point it at the deployed API:

```bash
# Update config with your API URL
API_URL=$(aws cloudformation describe-stacks --stack-name IlmDatasyncStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
echo "window.__CONFIG__ = { apiUrl: \"${API_URL%/}\" };" > src/web-ui/config.js

# Serve locally
python3 -m http.server 8080 --directory src/web-ui
```

Open http://localhost:8080 in your browser.

## Project Structure

```
├── bin/                    # CDK app entry point
├── lib/
│   ├── config/             # Environment configuration
│   ├── constructs/         # CDK construct definitions
│   ├── ilm-datasync-stack.ts          # Main application stack
│   └── testing-infrastructure-stack.ts # Optional test infrastructure
├── scripts/                # Helper scripts (test data upload)
├── src/
│   ├── api/                # API Lambda handlers
│   ├── orchestrator/       # Durable workflow Lambda + steps
│   ├── shared/             # Shared types, constants, validation
│   └── web-ui/             # Static web UI assets
└── test/                   # Unit tests
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch for changes and recompile |
| `npm run test` | Run Jest unit tests |
| `npx cdk synth` | Emit the synthesized CloudFormation template |
| `npx cdk diff` | Compare deployed stack with current state |
| `npx cdk deploy IlmDatasyncStack` | Deploy the main application stack |
| `npx cdk deploy IlmDatasyncTestingStack` | Deploy the testing infrastructure |
| `npx cdk destroy IlmDatasyncStack` | Remove the main stack |
| `npx cdk destroy IlmDatasyncTestingStack` | Remove the testing infrastructure |

## Cleanup

To tear down all deployed resources:

```bash
npx cdk destroy IlmDatasyncStack
npx cdk destroy IlmDatasyncTestingStack
```

Note: Destroy the main stack first, then the testing stack. The testing stack includes DynamoDB tables and S3 buckets that will be deleted along with their data.
