# Implementation Plan: VPC Private Hosting

## Overview

Migrate the S3 Glacier Restore and Transfer Orchestrator from public internet-facing architecture to fully VPC-private deployment. This involves creating a VPC with private subnets, replacing CloudFront/S3 web hosting with ECS Fargate behind an internal ALB, converting the public API Gateway to a Private API Gateway, and placing all Lambda functions inside the VPC with VPC Endpoints for AWS service connectivity.

## Tasks

- [x] 1. Update environment configuration and add VPC network foundation
  - [x] 1.1 Extend environment configuration with new VPC fields
    - Add `certificateArn` (required) and `existingVpcId` (optional) to `EnvironmentConfig` interface in `lib/config/environment.ts`
    - `certificateArn` resolves from `CERTIFICATE_ARN` environment variable
    - `existingVpcId` resolves from `EXISTING_VPC_ID` environment variable (empty/absent means create new VPC)
    - Add placeholder values in dev and prod config objects
    - _Requirements: 10.3, 1.1_

  - [x] 1.2 Create the VpcConstruct
    - Create `lib/constructs/vpc-construct.ts`
    - Implement `VpcConstructProps` interface with `existingVpc?: ec2.IVpc`, `maxAzs?: number`, `natGateways?: number`
    - When `existingVpc` is NOT provided: create a new VPC with CIDR 10.0.0.0/16, 2 AZs, `PRIVATE_WITH_EGRESS` subnets only, and 1 NAT Gateway
    - When `existingVpc` IS provided: use it directly, validate at least 2 private subnets in separate AZs exist (throw descriptive error if validation fails)
    - In both modes: create gateway endpoints for S3 and DynamoDB, interface endpoints for execute-api, lambda, logs, monitoring, and sts (all with private DNS enabled)
    - Create `lambdaSecurityGroup` (outbound 443 to VPC CIDR and 0.0.0.0/0, no inbound)
    - Create `vpcEndpointSecurityGroup` (inbound 443 from VPC CIDR)
    - Expose `vpc`, `lambdaSecurityGroup`, `vpcEndpointSecurityGroup`, and `executeApiEndpoint` as public readonly properties
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 5.1, 5.2, 5.3, 5.4, 5.6, 6.3, 6.4_

- [x] 2. Checkpoint - Verify VPC foundation compiles
  - Ensure `npm run build` passes with the new VpcConstruct and updated environment config. Ask the user if questions arise.

- [x] 3. Create Fargate Web UI infrastructure
  - [x] 3.1 Create the Dockerfile and entrypoint script for the web UI container
    - Create `src/web-ui/Dockerfile` using `public.ecr.aws/nginx/nginx:1-alpine` base image
    - Copy all static files from the build context into `/usr/share/nginx/html/`
    - Create `src/web-ui/docker-entrypoint.sh` that writes `config.js` from environment variables (`API_URL`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `REDIRECT_URI`, `LOGOUT_URI`)
    - Place the entrypoint script at `/docker-entrypoint.d/40-inject-config.sh` and make it executable
    - _Requirements: 4.2, 4.3, 8.5_

  - [x] 3.2 Create the VpcWebUiConstruct
    - Create `lib/constructs/vpc-web-ui-construct.ts`
    - Implement `VpcWebUiConstructProps` with `vpc`, `apiUrl`, `cognitoConfig` (userPoolId, userPoolClientId, cognitoDomain), and `certificateArn`
    - Create an ECS Cluster in the provided VPC
    - Build a Docker image from `src/web-ui/` using `ecs.ContainerImage.fromAsset()`
    - Create a Fargate task definition with container environment variables for runtime config injection
    - Create a Fargate service with `desiredCount: 2`, placed in private subnets, `assignPublicIp: false`
    - Create an internal ALB (`scheme: internal`) with HTTPS listener on port 443 using the ACM certificate
    - Configure ALB health checks at path "/" with 30s interval, 2 healthy threshold, 3 unhealthy threshold
    - Create ALB security group: inbound 443 from VPC CIDR, outbound only on port 80 to Fargate SG
    - Create Fargate security group: inbound 80 from ALB SG only, outbound 443 to 0.0.0.0/0 (for Cognito via NAT)
    - Expose `loadBalancer`, `albDnsName`, `albUrl` (https://), and `service` as public readonly properties
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 6.1, 6.2, 6.6, 8.4, 9.1, 9.4_

- [x] 4. Modify ApiConstruct for private API Gateway
  - [x] 4.1 Convert ApiConstruct to Private API Gateway
    - Add optional `vpc`, `lambdaSecurityGroup`, and `vpcEndpointId` props to `ApiConstructProps`
    - Configure `RestApi` with `endpointTypes: [apigateway.EndpointType.PRIVATE]` when `vpcEndpointId` is provided
    - Add a resource policy that allows `execute-api:Invoke` only from the specified VPC Endpoint (`aws:sourceVpce` condition) and denies all other traffic
    - Configure all Lambda functions (`NodejsFunction`) with `vpc` and `securityGroups` when VPC props are provided
    - Scope CORS `allowOrigins` to the internal ALB URL (passed as a new prop `allowedOrigin`)
    - Retain the existing Cognito authorizer logic unchanged
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 7.1, 7.2, 7.3_

- [x] 5. Modify OrchestratorConstruct for VPC placement
  - [x] 5.1 Add VPC connectivity to OrchestratorConstruct
    - Add optional `vpc` and `lambdaSecurityGroup` props to `OrchestratorConstructProps`
    - Configure the orchestrator `NodejsFunction` with `vpc` and `securityGroups` when provided
    - No other behavioral changes needed — SDK calls route through VPC endpoints (S3, DynamoDB) or NAT (DataSync)
    - _Requirements: 7.1, 7.2, 7.4_

- [x] 6. Checkpoint - Verify all constructs compile
  - Ensure `npm run build` passes with all modified and new constructs. Ask the user if questions arise.

- [x] 7. Wire everything together in the main stack
  - [x] 7.1 Rewrite RestoreTransferStack to use VPC-private architecture
    - Remove `WebUiConstruct` import and usage
    - Import and instantiate `VpcConstruct` first (use `Vpc.fromLookup` when `existingVpcId` is set in config, otherwise omit `existingVpc`)
    - Pass VPC and `lambdaSecurityGroup` to `ApiConstruct` and `OrchestratorConstruct`
    - Pass VPC Endpoint ID from `VpcConstruct.executeApiEndpoint` to `ApiConstruct`
    - Replace `WebUiConstruct` with `VpcWebUiConstruct`, passing VPC, API URL, Cognito config, and certificate ARN
    - Update `AuthConstruct` callback URL to use `Lazy.string` resolving to the ALB HTTPS URL (same circular-reference pattern as before)
    - Remove `WebUiUrl` CloudFront output
    - Add `AlbDnsName` output with the internal ALB DNS name
    - Pass VPC and security group references from VpcConstruct to all constructs requiring network placement
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.2, 9.5, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

- [x] 8. Delete the old WebUiConstruct
  - [x] 8.1 Remove `lib/constructs/web-ui-construct.ts`
    - Delete the file entirely
    - Verify no remaining imports reference it
    - _Requirements: 3.5_

- [x] 9. Checkpoint - Full stack synthesis
  - Run `cdk synth` to verify the synthesized CloudFormation template is valid. Ensure no public-facing resources exist. Ask the user if questions arise.

- [x] 10. Write CDK assertion tests
  - [x] 10.1 Write unit tests for VpcConstruct
    - Create `test/unit/vpc-construct.test.ts`
    - Test new VPC creation mode: verify VPC with 2 private subnets, 1 NAT Gateway, no IGW routes
    - Test existing VPC mode: verify no new VPC/subnet/NAT is created
    - Verify all 7 VPC Endpoints are provisioned (S3, DynamoDB, execute-api, lambda, logs, monitoring, sts)
    - Verify security group rules: VPC Endpoint SG allows inbound 443 from VPC CIDR, Lambda SG has correct egress
    - **Validates: Properties 1, 2, 3, 4**
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 5.1, 5.2, 5.3, 5.4, 5.6, 6.3, 6.4_

  - [x] 10.2 Write unit tests for VpcWebUiConstruct
    - Create `test/unit/vpc-web-ui-construct.test.ts`
    - Verify ALB scheme is `internal` (not internet-facing)
    - Verify HTTPS listener on port 443 with ACM certificate
    - Verify Fargate service has `desiredCount: 2` and `assignPublicIp: DISABLED`
    - Verify health check configuration (path "/", interval 30s, thresholds 2/3)
    - Verify ALB SG allows inbound 443 from VPC CIDR and Fargate SG allows inbound 80 from ALB SG only
    - **Validates: Properties 1, 3**
    - _Requirements: 4.1, 4.4, 4.5, 4.6, 4.7, 6.1, 6.2, 6.6, 9.1, 9.4_

  - [x] 10.3 Write unit tests for Private API Gateway configuration
    - Add tests in `test/unit/api-construct.test.ts` (or create new file)
    - Verify API Gateway endpoint type is `PRIVATE`
    - Verify resource policy contains `Deny` with `StringNotEquals` on `aws:sourceVpce`
    - Verify Lambda functions are placed in VPC with security groups
    - **Validates: Properties 1, 5**
    - _Requirements: 2.1, 2.3, 2.4, 7.1_

  - [x] 10.4 Write integration-level stack test verifying no public endpoints
    - Test the full `RestoreTransferStack` synthesis
    - Assert no resource has `PubliclyAccessible: true`, no ALB with scheme `internet-facing`, no Fargate with `AssignPublicIp: ENABLED`, no API Gateway with endpoint type `REGIONAL` or `EDGE`
    - Assert `WebUiUrl` output is removed, `AlbDnsName` output exists
    - **Validates: Properties 1, 2, 5**
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.4, 10.5_

- [x] 11. Final checkpoint - All tests pass
  - Run `npm run test` and `cdk synth` to confirm all assertion tests pass and the template is valid. Ask the user if questions arise.

## Notes

- This is entirely an Infrastructure as Code (CDK) migration — no application logic changes
- Property-based testing does NOT apply (design explicitly states this); correctness is verified via CDK assertion tests
- The existing Cognito PKCE auth flow in `auth.js` is unchanged — only the `config.js` injection mechanism changes (S3 deploy → container entrypoint script)
- The web UI static files (`index.html`, `app.js`, `auth.js`, `styles.css`) are unchanged and served from the nginx container
- Certificate ARN must be provisioned separately (ACM certificate matching ALB domain); it is an input to the stack
- When using an existing VPC, the user is responsible for ensuring NAT Gateway routing is already configured
- `cdk synth` is the primary validation tool — a successful synth with no public-facing resources confirms the migration is correct

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1", "5.1"] },
    { "id": 3, "tasks": ["7.1"] },
    { "id": 4, "tasks": ["8.1"] },
    { "id": 5, "tasks": ["10.1", "10.2", "10.3"] },
    { "id": 6, "tasks": ["10.4"] }
  ]
}
```
