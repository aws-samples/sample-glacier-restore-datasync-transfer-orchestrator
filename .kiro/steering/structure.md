---
inclusion: always
---

# Project Structure & Conventions

## Directory Layout

```
bin/                              CDK app entry point
  restore-transfer.ts

lib/                              CDK infrastructure definitions
  config/
    environment.ts                Environment-specific config (dev/prod)
  constructs/                     Modular CDK constructs (one per logical component)
    api-construct.ts              REST API + Cognito authorizer
    auth-construct.ts             Cognito User Pool & Client
    orchestrator-construct.ts     Durable workflow Lambda
    persistence-construct.ts      DynamoDB table
    web-ui-construct.ts           S3 + CloudFront static site
  restore-transfer-stack.ts       Main application stack
  testing-infrastructure-stack.ts Optional dev/test resources

src/                              Application runtime code
  api/                            API Gateway Lambda handlers (one file per endpoint)
    submit-request.ts
    get-request-status.ts
    get-requests.ts
    get-manifest-url.ts
    get-datasync-destinations.ts
  orchestrator/                   Durable workflow engine
    handler.ts                    Entry point (withDurableExecution wrapper)
    steps/                        Individual workflow steps (one per phase)
      expand-globs.ts
      detect-storage-class.ts
      initiate-restore.ts
      monitor-restore.ts
      start-datasync.ts
      monitor-datasync.ts
    utils/                        Orchestrator utility modules
      resolve-datasync-task.ts
      retry.ts
      status.ts                   DynamoDB record create/update helpers
  shared/                         Code shared across all Lambda functions
    types.ts                      TypeScript interfaces and type definitions
    constants.ts                  App-wide constants
    validation.ts                 Input validation logic
  web-ui/                         Static frontend (vanilla JS, no framework)
    index.html
    app.js
    auth.js                       Cognito PKCE auth flow
    config.js                     Runtime config (generated at deploy, never committed with real values)
    styles.css

test/                             Unit tests
  unit/                           Flat directory — test files named after their source module
    submit-request.test.ts
    expand-globs.test.ts
    ...

scripts/                          Helper scripts (test data upload)
docs/                             Architecture diagrams
```

## Architecture Patterns

### CDK Constructs
- Each construct is a self-contained class extending `Construct` in `lib/constructs/`.
- Constructs expose typed `Props` interfaces and public resources.
- Lambda functions are created with `NodejsFunction` (esbuild bundling, minified, with source maps).
- Import style: aliased namespace imports (`import * as apigateway from 'aws-cdk-lib/aws-apigateway'`).

### API Handlers
- One named `handler` export per file (signature: `APIGatewayProxyEvent → APIGatewayProxyResult`).
- AWS SDK clients are instantiated at module scope (reused across invocations).
- Standard CORS headers object returned in every response.
- Input validation delegated to `src/shared/validation.ts`; validation errors return 400 with `{ errors: ValidationError[] }`.
- Success responses return the minimal payload needed; async operations return 202.

### Orchestrator (Durable Execution)
- Entry point wraps the workflow in `withDurableExecution` from `@aws/durable-execution-sdk-js`.
- Each step is a separate file in `steps/` exporting pure async functions.
- Constants for timeouts, polling intervals, and thresholds live in `src/shared/constants.ts`.
- Status updates go through helper functions in `orchestrator/utils/status.ts`.

### Shared Code
- `src/shared/types.ts` — all domain interfaces and type aliases; exported individually (no barrel).
- `src/shared/constants.ts` — numeric and string constants used across handlers and orchestrator.
- `src/shared/validation.ts` — request validation returning a `ValidationResult`.

## Code Style Rules

- Named exports only (no default exports).
- JSDoc block comment at the top of every file describing purpose.
- Functions documented with JSDoc when non-trivial.
- Type imports use `import type` syntax where possible.
- Environment variables read from `process.env` with explicit checks; missing vars return 500.
- Error handling: try/catch around AWS SDK calls; errors produce structured JSON responses, not stack traces.

## Testing Conventions

- Test runner: Jest with `ts-jest`.
- Test files: `test/unit/<module-name>.test.ts` (flat, mirrors source module name).
- AWS SDK mocking: `aws-sdk-client-mock` — mock clients created at module scope, reset in `beforeEach`.
- Deterministic IDs: `jest.mock("ulid", ...)` for predictable request IDs.
- Fake timers: `jest.useFakeTimers()` + `jest.setSystemTime()` for timestamp-dependent tests.
- Helper factories (e.g., `makeEvent`) create minimal typed test fixtures inline.
- Property-based testing: `fast-check` for validation and domain logic.
- Durable function tests: `@aws/durable-execution-sdk-js-testing` harness.

## Naming Conventions

- Files: `kebab-case.ts` (e.g., `submit-request.ts`, `detect-storage-class.ts`).
- Types/Interfaces: `PascalCase` (e.g., `RestoreRequest`, `StorageClassInfo`).
- Functions: `camelCase` (e.g., `createRequestRecord`, `expandAllGlobs`).
- Constants: `UPPER_SNAKE_CASE` (e.g., `BATCH_THRESHOLD`, `RESTORE_POLL_MAX_MS`).
- CDK construct IDs: `PascalCase` strings (e.g., `'SubmitRequestFunction'`).

## Adding New Code

| To add... | Place it in... | Follow pattern of... |
|-----------|----------------|---------------------|
| New API endpoint | `src/api/<verb-noun>.ts` | `submit-request.ts` |
| New orchestrator step | `src/orchestrator/steps/<step-name>.ts` | `expand-globs.ts` |
| New shared type | `src/shared/types.ts` | existing interfaces |
| New CDK construct | `lib/constructs/<name>-construct.ts` | `api-construct.ts` |
| New unit test | `test/unit/<module-name>.test.ts` | `submit-request.test.ts` |

## Important Rules

- Never commit `src/web-ui/config.js` with real values — it is generated at deploy time.
- `cdk.out/` is generated output; do not edit manually.
- Environment config (`lib/config/environment.ts`) resolves values at synth time from env vars with fallback defaults.
- Lambda bundling uses `forceDockerBundling: false` (native esbuild).
- All API methods use a Cognito authorizer when a User Pool is provided.
