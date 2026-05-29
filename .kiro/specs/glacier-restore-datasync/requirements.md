# Requirements Document

## Introduction

This feature provides a streamlined process for restoring files from Amazon S3 Glacier storage classes (Deep Archive, Flexible Retrieval, and Instant Retrieval) and initiating an AWS DataSync task to copy the restored files back to on-premises storage. The system uses Lambda Durable Functions for orchestration, leverages S3 Batch Operations for cost-efficient bulk restores, and exposes a lightweight web UI for users to submit restore requests, select retrieval tiers, and monitor progress in real time.

## Glossary

- **Restore_Orchestrator**: The Lambda Durable Function responsible for coordinating the end-to-end restore and sync workflow
- **Web_UI**: The lightweight browser-based user interface for submitting restore requests and viewing status updates
- **API_Gateway**: The AWS API Gateway endpoint that receives requests from the Web_UI and routes them to the Restore_Orchestrator
- **Restore_Status_Service**: The component that polls or receives notifications about S3 object restore completion
- **DataSync_Agent**: The AWS DataSync agent and task configuration responsible for copying restored objects to on-premises storage
- **S3_Batch_Operations**: The AWS service used to submit bulk restore requests for multiple objects to reduce per-request costs
- **Retrieval_Tier**: The speed tier selected for Glacier restores (Expedited, Standard, or Bulk)
- **Storage_Class**: The S3 Glacier storage class of the archived object (Deep Archive, Flexible Retrieval, or Instant Retrieval)

## Requirements

### Requirement 1: Submit Restore Request

**User Story:** As an operator, I want to submit a restore request by providing a file path and S3 bucket, so that I can initiate the retrieval of archived files.

#### Acceptance Criteria

1. WHEN the operator submits a file path, bucket name, and Retrieval_Tier, THE Web_UI SHALL send the restore request to the API_Gateway
2. WHEN a restore request is received, THE API_Gateway SHALL validate that the bucket name is a non-empty string between 3 and 63 characters, the file path is a non-empty string of at most 1024 characters, and the Retrieval_Tier is one of Expedited, Standard, or Bulk
3. IF any field fails validation, THEN THE API_Gateway SHALL return a validation error to the Web_UI indicating which field failed and the reason for failure
4. WHEN a valid restore request is received, THE API_Gateway SHALL invoke the Restore_Orchestrator with the bucket name, file path, and selected Retrieval_Tier
5. IF the API_Gateway fails to invoke the Restore_Orchestrator, THEN THE API_Gateway SHALL return an error to the Web_UI indicating that the request could not be processed and the operator should retry

### Requirement 2: Retrieval Tier Selection

**User Story:** As an operator, I want to select a retrieval tier when submitting a restore request, so that I can balance cost and speed based on urgency.

#### Acceptance Criteria

1. THE Web_UI SHALL present the operator with a choice of Retrieval_Tier options: Expedited, Standard, and Bulk
2. WHEN the operator selects a Storage_Class of Deep Archive, THE Web_UI SHALL disable the Expedited tier option, display a message indicating Expedited is not available for Deep Archive, and reset the Retrieval_Tier selection to Standard if Expedited was previously selected
3. WHEN the selected Storage_Class is Instant Retrieval, THE Web_UI SHALL inform the operator that no restore is required and the file is directly accessible
4. THE Web_UI SHALL default the Retrieval_Tier selection to Standard

### Requirement 3: Storage Class Detection

**User Story:** As an operator, I want the system to detect the storage class of the requested object, so that the appropriate restore strategy is applied automatically.

#### Acceptance Criteria

1. WHEN the Restore_Orchestrator receives a restore request, THE Restore_Orchestrator SHALL issue a HeadObject API call to determine the Storage_Class of the specified object
2. IF the HeadObject call returns a 404 status, THEN THE Restore_Orchestrator SHALL return an error indicating the object was not found at the specified bucket and path
3. IF the HeadObject call returns a 403 status, THEN THE Restore_Orchestrator SHALL return an error indicating access is denied to the specified object
4. IF the HeadObject call fails due to a transient error, THEN THE Restore_Orchestrator SHALL retry up to 3 times with exponential backoff starting at 1 second before marking the request as failed
5. WHEN the Storage_Class is Instant Retrieval, THE Restore_Orchestrator SHALL skip the restore step and proceed directly to the DataSync task
6. WHEN the Storage_Class is Deep Archive or Flexible Retrieval, THE Restore_Orchestrator SHALL proceed to the Glacier restore step with the selected Retrieval_Tier

### Requirement 4: Initiate Glacier Restore

**User Story:** As an operator, I want the system to initiate a Glacier restore using the selected retrieval tier, so that the archived file becomes accessible for transfer.

#### Acceptance Criteria

1. WHEN a single object requires restore, THE Restore_Orchestrator SHALL issue a RestoreObject API call with the selected Retrieval_Tier and a restore duration of 7 days
2. WHEN the number of objects requiring restore exceeds 50, THE Restore_Orchestrator SHALL create an S3_Batch_Operations job to restore all objects with the selected Retrieval_Tier and a restore duration of 7 days
3. WHEN the S3_Batch_Operations job is created, THE Restore_Orchestrator SHALL record the job ID for status tracking
4. IF the restore request fails due to a throttling error, THEN THE Restore_Orchestrator SHALL retry the request with exponential backoff starting at 1 second, doubling on each attempt, up to a maximum of 5 attempts
5. IF all 5 retry attempts are exhausted, THEN THE Restore_Orchestrator SHALL mark the restore request as failed and report an error indicating the object key and failure reason
6. IF the restore request fails due to a non-throttling error (e.g., object not found or access denied), THEN THE Restore_Orchestrator SHALL not retry and SHALL immediately mark the request as failed with an error indicating the object key and failure reason

### Requirement 5: Monitor Restore Completion

**User Story:** As an operator, I want the system to monitor the restore process and notify me when the file is available, so that I know when the transfer can begin.

#### Acceptance Criteria

1. WHILE the object restore is in progress, THE Restore_Orchestrator SHALL poll the object's restore status using exponential backoff with a 2x multiplier, starting at 5 minutes and capping at 30 minutes between polls
2. WHEN the object restore completes, THE Restore_Orchestrator SHALL update the request status to "Restore Complete" and proceed to the DataSync step
3. WHILE the S3_Batch_Operations job is in progress, THE Restore_Orchestrator SHALL poll the batch job status at 5-minute intervals
4. IF the restore does not complete within the maximum expected duration for the selected tier (12 hours for Expedited, 48 hours for Standard, 72 hours for Bulk), THEN THE Restore_Orchestrator SHALL mark the request as "Restore Timed Out" and notify the operator
5. IF a poll request fails due to a transient error, THEN THE Restore_Orchestrator SHALL retry the poll up to 3 times with a 60-second delay between retries before marking the request as "Poll Error" and notifying the operator

### Requirement 6: Initiate DataSync Transfer

**User Story:** As an operator, I want the system to automatically start a DataSync task after the restore completes, so that the file is copied to on-premises storage without manual intervention.

#### Acceptance Criteria

1. WHEN the object restore is complete, THE Restore_Orchestrator SHALL start a DataSync task to transfer the restored object to the configured on-premises location within 60 seconds of detecting restore completion
2. WHEN the DataSync task is started, THE Restore_Orchestrator SHALL record the DataSync task execution ARN for status tracking
3. IF the DataSync task fails to start, THEN THE Restore_Orchestrator SHALL retry up to 3 times with exponential backoff starting at a 2-second base interval before marking the request as "DataSync Failed"
4. IF the DataSync task starts successfully but reports a failed status during transfer, THEN THE Restore_Orchestrator SHALL mark the request as "DataSync Failed" and record the task execution ARN and failure reason for diagnosis

### Requirement 7: Monitor DataSync Completion

**User Story:** As an operator, I want the system to monitor the DataSync transfer and report completion, so that I know when the file is available on-premises.

#### Acceptance Criteria

1. WHEN the DataSync task execution is initiated, THE Restore_Orchestrator SHALL begin polling the task execution status at 60-second intervals until the task reaches a terminal state or the polling timeout of 60 minutes is exceeded
2. WHEN the DataSync task completes successfully, THE Restore_Orchestrator SHALL update the request status to "Transfer Complete"
3. IF the DataSync task fails, THEN THE Restore_Orchestrator SHALL update the request status to "Transfer Failed" and include the failure reason from DataSync
4. IF the polling timeout of 60 minutes is exceeded without the task reaching a terminal state, THEN THE Restore_Orchestrator SHALL update the request status to "Transfer Timed Out" and cease polling
5. IF a polling attempt fails due to a transient error, THEN THE Restore_Orchestrator SHALL retry the status check on the next polling interval for up to 3 consecutive transient failures before updating the request status to "Transfer Status Unknown"

### Requirement 8: Real-Time Status Updates

**User Story:** As an operator, I want to see real-time status updates in the UI, so that I can track the progress of my restore and transfer requests.

#### Acceptance Criteria

1. THE Web_UI SHALL display the current status of each submitted request as one of the following values: Submitted, Detecting Storage Class, Initiating Restore, Restore In Progress, Restore Complete, Starting DataSync, DataSync In Progress, Transfer Complete, or Error
2. WHEN the request status changes, THE Web_UI SHALL update the displayed status within 10 seconds without requiring manual page refresh
3. THE Web_UI SHALL display the elapsed time since the request was submitted, updated every 5 seconds, in the format "Xd Xh Xm Xs" omitting zero-value leading units
4. WHEN a batch restore is in progress, THE Web_UI SHALL display the number of objects restored out of the total requested in the format "N of M objects restored"
5. IF a request enters an Error state, THEN THE Web_UI SHALL display an error indication including the failed step name and a description of the failure reason
6. IF the Web_UI fails to retrieve status updates for more than 30 seconds, THEN THE Web_UI SHALL display a connectivity warning indicating that status information may be stale and SHALL resume automatic updates when connectivity is restored

### Requirement 9: Batch File Restore

**User Story:** As an operator, I want to submit multiple file paths in a single request, so that I can restore a set of related files efficiently using S3 Batch Operations.

#### Acceptance Criteria

1. THE Web_UI SHALL allow the operator to submit between 2 and 1000 unique file paths in a single restore request, removing any duplicate entries before submission
2. WHEN multiple file paths are submitted, THE Restore_Orchestrator SHALL use S3_Batch_Operations to initiate restores for all objects in a single batch job
3. WHEN a batch restore is submitted, THE Restore_Orchestrator SHALL validate that all specified objects exist within 60 seconds before creating the batch job
4. IF any objects in the batch do not exist and at least one valid object remains, THEN THE Restore_Orchestrator SHALL display a list of the missing object paths to the operator and proceed with creating the batch job for the valid objects only
5. IF all objects in the batch do not exist, THEN THE Restore_Orchestrator SHALL display a list of the missing object paths to the operator and shall not create a batch job
6. WHEN a batch job is successfully created, THE Restore_Orchestrator SHALL display a confirmation to the operator that includes the total number of objects submitted for restore

### Requirement 10: Request History and Persistence

**User Story:** As an operator, I want to view the history of my restore requests, so that I can track past operations and their outcomes.

#### Acceptance Criteria

1. THE Restore_Orchestrator SHALL persist each request's metadata (bucket, file paths, Retrieval_Tier, status, submission timestamp, and completion timestamp) to a DynamoDB table within 5 seconds of each state change
2. WHEN the operator opens the Web_UI, THE Web_UI SHALL display the 50 most recent requests ordered by submission time descending (newest first), showing an empty-state message when no requests exist
3. THE Web_UI SHALL allow the operator to filter requests by status, supporting selection of one or more status values simultaneously
4. IF the Restore_Orchestrator fails to persist request metadata to DynamoDB, THEN THE Restore_Orchestrator SHALL retry up to 3 times with exponential backoff and, if all retries fail, SHALL record the failure in the system log and indicate a persistence error to the operator

### Requirement 11: Orchestrator Technology Evaluation

**User Story:** As a developer, I want the system to use Lambda Durable Functions for orchestration, so that long-running Glacier restore waits are handled without incurring compute charges during idle periods.

#### Acceptance Criteria

1. THE Restore_Orchestrator SHALL be implemented using Lambda Durable Functions to avoid compute charges during restore wait periods that can last up to 48 hours
2. THE Restore_Orchestrator SHALL use the waitForCondition primitive with exponential backoff starting at a 5-minute initial interval, doubling up to a maximum interval of 30 minutes, to poll for restore completion
3. THE Restore_Orchestrator SHALL use the context.map primitive to process up to 50 files concurrently within a batch restore request
4. IF a restore operation does not complete within 48 hours, THEN THE Restore_Orchestrator SHALL mark the restore as timed out, cease polling, and record the failure status for the affected files
5. IF one or more individual file restores within a batch fail or time out, THEN THE Restore_Orchestrator SHALL continue processing the remaining files in the batch and report per-file success or failure status upon batch completion
