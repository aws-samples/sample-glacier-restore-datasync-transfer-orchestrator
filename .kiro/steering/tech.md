---
inclusion: always
---

# Tech Stack

## Language & Runtime

- TypeScript 5.9.x (strict mode, ES2022 target, NodeNext module resolution)
- Node.js 24.x (Lambda runtime)
- Static web UI: vanilla JavaScript, HTML, CSS — no frontend framework

## Infrastructure

- AWS CDK v2 (^2.258.0, TypeScript) for all infrastructure
- CDK entry point: `bin/restore-transfer.ts`
- CDK app command: `npx ts-node --prefer-ts-exts bin/restore-transfer.ts`
- Lambda bundling: `NodejsFunction` with native esbuild (`forceDockerBundling: false`)

## AWS Services

| Service | Role |
|---------|------|
| Lambda | API handlers + durable workflow orchestrator |
| API Gateway | REST API with Cognito JWT authorizer |
| DynamoDB | Single-table design, ULID partition keys, 30-day TTL |
| S3 | Source buckets + shared staging bucket for manifests |
| S3 Batch Operations | Bulk Glacier restores (≥50 objects) |
| DataSync | S3 → NFS transfers using CSV manifests |
| Cognito | User Pool with hosted UI, PKCE auth code flow |
| CloudFront + S3 | Static web UI hosting |

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `aws-cdk-lib` | ^2.258.0 | CDK constructs |
| `constructs` | ^10.5.0 | CDK construct base |
| `@aws/durable-execution-sdk-js` | ^1.1.7 | Lambda durable functions (checkpointing, long-running workflows) |
| `@aws-sdk/client-*` | ^3.700.0 | AWS SDK v3 clients (S3, DynamoDB, DataSync, Lambda, S3Control) |
| `@aws-sdk/lib-dynamodb` | ^3.700.0 | DynamoDB document client |
| `@aws-sdk/s3-request-presigner` | ^3.1063.0 | S3 presigned URL generation |
| `ulid` | ^2.3.0 | Time-ordered unique IDs for request records |
| `esbuild` | ^0.28.0 | Lambda bundling (via CDK NodejsFunction) |

## Testing Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `jest` + `ts-jest` | ^30 / ^29 | Unit test runner with TypeScript support |
| `fast-check` | ^3.22.0 | Property-based testing |
| `aws-sdk-client-mock` | ^4.1.0 | Mock AWS SDK v3 clients |
| `@aws/durable-execution-sdk-js-testing` | ^1.1.1 | Test harness for durable functions |

## Common Commands

```bash
npm run build      # Compile TypeScript (tsc)
npm run watch      # Watch mode recompile
npm run test       # Run Jest unit tests
cdk synth          # Synthesize CloudFormation templates
cdk diff           # Compare deployed vs local
cdk deploy RestoreTransferStack           # Deploy main stack
cdk deploy RestoreTransferTestingStack    # Deploy test infrastructure
```

## TypeScript Compiler Rules

These flags are active in `tsconfig.json` — generated code must satisfy all of them:

- `strict: true` (enables strictNullChecks, noImplicitAny, alwaysStrict, noImplicitThis, strictPropertyInitialization)
- `noImplicitReturns: true` — every code path must return a value
- `target: ES2022` — top-level await, private fields, and other ES2022 features are available
- `module: NodeNext` / `moduleResolution: NodeNext` — use `.js` extensions in relative imports when needed
- `experimentalDecorators: true` — decorators are permitted
- `inlineSourceMap: true`, `inlineSources: true` — source maps embedded in output
- `skipLibCheck: true` — third-party type errors are suppressed
- Excludes: `node_modules`, `cdk.out`

## Dependency Management Rules

- Use exact or caret-pinned versions matching `package.json` ranges above
- Do not introduce new dependencies without explicit justification
- AWS SDK clients: always use `@aws-sdk/client-*` v3 (never v2)
- No frontend frameworks (React, Vue, Angular, etc.) in the web UI
