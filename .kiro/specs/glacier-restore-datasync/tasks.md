# Implementation Plan: Glacier Restore DataSync

## Overview

This plan implements an end-to-end Glacier restore and DataSync transfer system using AWS CDK v2 (TypeScript) for infrastructure, Lambda Durable Functions for orchestration, and a lightweight web UI for operator visibility. Tasks are ordered to build foundational types and infrastructure first, then layer in orchestration logic, API handlers, and finally the web UI.

## Tasks

- [ ] 1. Set up project structure, shared types, and CDK scaffolding
  - [ ] 1.1 Initialize CDK project and configure dependencies
    - Create `package.json` with dependencies: `aws-cdk-lib`, `constructs`, `@aws/durable-execution-sdk-js`, `ulid`, `@aws-sdk/client-s3`, `@aws-sdk/client-datasync`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`
    - Create `cdk.json`, `tsconfig.json`, and `jest.config.ts`
    - Create `bin/glacier-restore-datasync.ts` CDK app entry point
    - _Requirements: 11.1_

  - [ ] 1.2 Define shared types, constants, and validation logic
    - Create `src/shared/types.ts` with `RestoreRequest`, `RestoreRequestRecord`, `RequestStatus`, `StorageClassInfo`, `ErrorDetail` interfaces
    - Create `src/shared/constants.ts` with timeout configuration, batch threshold (50), polling intervals, status values, and retrieval tier constraints
    - Create `src/shared/validation.ts` with input validation functions for bucket (3-63 chars), filePath (1-1024 chars), retrievalTier enum, and path deduplication (2-1000 unique paths)
    - _Requirements: 1.2, 1.3, 9.1_

  - [ ]* 1.3 Write property tests for input validation
    - **Property 1: Input validation correctness**
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 1.4 Write property test for path deduplication and count validation
    - **Property 11: Path deduplication and count validation**
    - **Validates: Requirements 9.1**

- [ ] 2. Implement DynamoDB persistence construct and data layer
  - [ ] 2.1 Create DynamoDB persistence CDK construct
    - Create `lib/constructs/persistence-construct.ts` defining the DynamoDB table with `requestId` as partition key, `submittedAt` as sort key
    - Add GSI `StatusIndex` with `status` as partition key and `submittedAt` as sort key, projection ALL
    - Configure TTL attribute for automatic cleanup (30 days after completion)
    - _Requirements: 10.1_

  - [ ] 2.2 Implement status update helpers
    - Create `src/orchestrator/utils/status.ts` with functions to create request records, update status, record error details, and set completion timestamps
    - Ensure all required fields are persisted: bucket, filePaths, retrievalTier, status, submittedAt, and completedAt on completion
    - _Requirements: 10.1, 10.4_

  - [ ]* 2.3 Write property test for request persistence completeness
    - **Property 13: Request persistence completeness**
    - **Validates: Requirements 10.1**

  - [ ]* 2.4 Write property test for request query correctness
    - **Property 14: Request query correctness**
    - **Validates: Requirements 10.2, 10.3**

- [ ] 3. Implement retry utilities and error classification
  - [ ] 3.1 Create exponential backoff retry utility
    - Create `src/orchestrator/utils/retry.ts` with a generic retry function supporting configurable max attempts, base delay, and 2x backoff multiplier
    - Implement error classification: throttling errors (retryable), transient errors (retryable), and non-retryable errors (AccessDenied, NoSuchKey, InvalidRequest)
    - _Requirements: 3.4, 4.4, 4.5, 4.6_

  - [ ]* 3.2 Write property test for exponential backoff retry
    - **Property 3: Exponential backoff retry**
    - **Validates: Requirements 3.4, 4.4**

  - [ ]* 3.3 Write property test for non-retryable error classification
    - **Property 4: Non-retryable error classification**
    - **Validates: Requirements 4.6**

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement orchestrator steps
  - [ ] 5.1 Implement storage class detection step
    - Create `src/orchestrator/steps/detect-storage-class.ts` with HeadObject logic to determine storage class
    - Handle 404 (object not found), 403 (access denied), and transient errors with retry
    - Return `StorageClassInfo` for each object
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 5.2 Write property test for restore routing by storage class
    - **Property 5: Restore routing by storage class**
    - **Validates: Requirements 3.5, 3.6**

  - [ ] 5.3 Implement restore initiation step
    - Create `src/orchestrator/steps/initiate-restore.ts` with logic to issue RestoreObject calls for ≤50 objects via `context.map` or create S3 Batch Operations job for >50 objects
    - Include manifest CSV generation and upload for batch operations
    - Set restore duration to 7 days, apply selected retrieval tier
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 5.4 Write property test for batch operations threshold
    - **Property 6: Batch operations threshold**
    - **Validates: Requirements 4.2**

  - [ ]* 5.5 Write property test for tier availability by storage class
    - **Property 2: Tier availability by storage class**
    - **Validates: Requirements 2.2**

  - [ ] 5.6 Implement restore monitoring step
    - Create `src/orchestrator/steps/monitor-restore.ts` with polling logic using exponential backoff (5 min initial, 2x multiplier, 30 min cap)
    - Implement tier-specific timeout detection (12h Expedited, 48h Standard, 72h Bulk)
    - Handle batch job polling at 5-minute intervals via DescribeJob
    - Implement partial failure handling: continue processing remaining files when individual restores fail
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 11.2, 11.5_

  - [ ]* 5.7 Write property test for restore polling backoff calculation
    - **Property 7: Restore polling backoff calculation**
    - **Validates: Requirements 5.1, 11.2**

  - [ ]* 5.8 Write property test for tier-to-timeout mapping
    - **Property 8: Tier-to-timeout mapping**
    - **Validates: Requirements 5.4**

  - [ ]* 5.9 Write property test for batch partial failure resilience
    - **Property 15: Batch partial failure resilience**
    - **Validates: Requirements 11.5**

  - [ ] 5.10 Implement DataSync start step
    - Create `src/orchestrator/steps/start-datasync.ts` with StartTaskExecution logic
    - Retry up to 3 times with 2-second base exponential backoff on failure
    - Record task execution ARN for status tracking
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 5.11 Implement DataSync monitoring step
    - Create `src/orchestrator/steps/monitor-datasync.ts` with 60-second fixed interval polling
    - Implement 60-minute timeout detection
    - Track consecutive transient failures (3 consecutive → "Transfer Status Unknown")
    - Handle terminal states: success → "Transfer Complete", failure → "DataSync Failed"
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 5.12 Write property test for consecutive polling failure detection
    - **Property 9: Consecutive polling failure detection**
    - **Validates: Requirements 7.5**

- [ ] 6. Implement durable function handler and orchestrator construct
  - [ ] 6.1 Create the durable function handler
    - Create `src/orchestrator/handler.ts` using `withDurableExecution` from `@aws/durable-execution-sdk-js`
    - Wire together all steps: persist request → detect storage classes → initiate restores → monitor restores → start DataSync → monitor DataSync → mark complete
    - Use `context.map` for concurrent file processing (max 50 concurrency)
    - Use `context.waitForCondition` for restore and DataSync polling
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ] 6.2 Create orchestrator CDK construct
    - Create `lib/constructs/orchestrator-construct.ts` defining the Lambda function using `NodejsFunction` with esbuild bundling
    - Configure IAM permissions for S3 (HeadObject, RestoreObject, PutObject for manifests), S3 Batch Operations (CreateJob, DescribeJob), DataSync (StartTaskExecution, DescribeTaskExecution), and DynamoDB (PutItem, UpdateItem, GetItem, Query)
    - _Requirements: 11.1_

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement API layer
  - [ ] 8.1 Implement submit-request API handler
    - Create `src/api/submit-request.ts` as POST /requests handler
    - Validate input using shared validation logic, return field-specific errors on failure
    - Invoke the Restore Orchestrator on valid requests
    - Return request ID and initial status to caller
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 8.2 Implement get-requests API handler
    - Create `src/api/get-requests.ts` as GET /requests handler
    - Query DynamoDB for 50 most recent requests ordered by submittedAt descending
    - Support optional status filter query parameter (one or more status values)
    - _Requirements: 10.2, 10.3_

  - [ ] 8.3 Implement get-request-status API handler
    - Create `src/api/get-request-status.ts` as GET /requests/{requestId} handler
    - Return full request record including status, object counts, error details
    - _Requirements: 8.1_

  - [ ] 8.4 Create API Gateway CDK construct
    - Create `lib/constructs/api-construct.ts` defining REST API with three endpoints
    - Configure Lambda integrations using `NodejsFunction` for each handler
    - Set up CORS for web UI access
    - _Requirements: 1.1, 1.4_

  - [ ]* 8.5 Write property test for partial batch validation
    - **Property 12: Partial batch validation**
    - **Validates: Requirements 9.4, 9.5**

- [ ] 9. Implement Web UI
  - [ ] 9.1 Create Web UI static files
    - Create `src/web-ui/index.html` with restore request form (bucket, file paths textarea, retrieval tier dropdown) and status dashboard
    - Create `src/web-ui/styles.css` with responsive styling
    - Create `src/web-ui/app.js` with API integration, auto-refresh (10-second polling), elapsed time display (5-second updates), and connectivity warning after 30 seconds of failures
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1_

  - [ ]* 9.2 Write property test for elapsed time formatting
    - **Property 10: Elapsed time formatting**
    - **Validates: Requirements 8.3**

  - [ ] 9.3 Create Web UI hosting CDK construct
    - Create `lib/constructs/web-ui-construct.ts` with S3 bucket for static hosting and CloudFront distribution
    - Use `BucketDeployment` to deploy web UI files from `src/web-ui/`
    - _Requirements: 8.1_

- [ ] 10. Wire up main CDK stack and environment configuration
  - [ ] 10.1 Create environment configuration
    - Create `lib/config/environment.ts` with environment-specific settings (DataSync task ARN, source/destination locations, staging bucket name)
    - _Requirements: 6.1_

  - [ ] 10.2 Assemble main CDK stack
    - Create `lib/glacier-restore-datasync-stack.ts` composing all constructs: persistence, orchestrator, API, and web UI
    - Wire construct outputs (table name, API URL) as environment variables to Lambda functions
    - Export CloudFront URL and API endpoint as stack outputs
    - _Requirements: 11.1_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All infrastructure is defined using AWS CDK v2 with TypeScript
- Lambda functions use `NodejsFunction` construct for esbuild bundling
- The orchestrator uses `@aws/durable-execution-sdk-js` for durable execution primitives

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "3.2", "3.3"] },
    { "id": 4, "tasks": ["2.3", "2.4", "5.1", "5.3"] },
    { "id": 5, "tasks": ["5.2", "5.4", "5.5", "5.6", "5.10"] },
    { "id": 6, "tasks": ["5.7", "5.8", "5.9", "5.11"] },
    { "id": 7, "tasks": ["5.12", "6.1"] },
    { "id": 8, "tasks": ["6.2", "8.1", "8.2", "8.3"] },
    { "id": 9, "tasks": ["8.4", "8.5", "9.1"] },
    { "id": 10, "tasks": ["9.2", "9.3", "10.1"] },
    { "id": 11, "tasks": ["10.2"] }
  ]
}
```
