# Requirements Document

## Introduction

Migrate the S3 Glacier Restore and Transfer Orchestrator from a public internet-facing architecture to a fully VPC-private deployment. The current architecture uses a public API Gateway, CloudFront + S3 static hosting for the web UI, and Lambda functions for API handlers. The target architecture removes all public endpoints: the API Gateway becomes a private API accessible only from within the VPC, CloudFront and S3 static hosting are eliminated, and the web UI is served by an ECS Fargate task running inside the VPC. An internal Application Load Balancer fronts the Fargate service. Outbound internet access (required for AWS API calls not covered by VPC Endpoints) is provided via a NAT Gateway. VPC Endpoints provide private connectivity to AWS services where supported.

## Glossary

- **VPC**: Virtual Private Cloud — the isolated network environment hosting all application resources
- **Private_API_Gateway**: An API Gateway REST API configured with an `ENDPOINT_TYPE` of `PRIVATE`, accessible only from within the VPC via a VPC Endpoint for `execute-api`
- **ALB**: Application Load Balancer — an internal (non-internet-facing) load balancer that routes HTTP traffic to Fargate tasks
- **Fargate_Service**: An ECS Fargate service running containers that serve the web UI and proxy API requests
- **NAT_Gateway**: A managed network address translation gateway providing outbound internet access from private subnets
- **VPC_Endpoint**: An interface or gateway endpoint providing private connectivity from the VPC to an AWS service without traversing the internet
- **Resource_Policy**: An API Gateway resource policy that restricts invoke access to requests originating from the VPC or VPC Endpoint
- **Web_UI_Container**: A lightweight HTTP server container (e.g., nginx) serving the static web UI files within the Fargate_Service
- **Private_Subnet**: A VPC subnet with no internet gateway route, relying on NAT_Gateway for outbound traffic
- **Security_Group**: A virtual firewall controlling inbound and outbound traffic for VPC resources

## Requirements

### Requirement 1: VPC Network Foundation

**User Story:** As an infrastructure operator, I want to either provide my own existing VPC or have the stack create one automatically, so that I can integrate with my organization's existing network infrastructure or get a turnkey deployment.

#### Acceptance Criteria

1. IF an existing VPC is provided (via VPC ID or IVpc reference in the construct props), THEN THE CDK_Stack SHALL use that VPC and SHALL NOT create a new VPC, subnets, or NAT Gateway
2. IF no existing VPC is provided, THEN THE CDK_Stack SHALL provision a new VPC with a CIDR block of at least /24 and with exactly two private subnets (subnet type PRIVATE_WITH_EGRESS) placed in two separate Availability Zones
3. IF no existing VPC is provided, THEN THE VPC SHALL include exactly one NAT_Gateway to provide outbound internet connectivity from all private subnets
4. THE VPC (whether provided or created) SHALL NOT include an internet gateway route in any private subnet (i.e., subnets hosting Lambda functions, DataSync tasks, or any compute resources defined in the stack)
5. WHEN the CDK_Stack is deployed with a newly created VPC, THE VPC SHALL be tagged with a tag key of "aws:cloudformation:stack-name" whose value equals the deployed stack name
6. IF an existing VPC is provided, THEN THE CDK_Stack SHALL validate that the VPC has at least two private subnets in separate Availability Zones before proceeding with resource creation
7. IF an existing VPC is provided that does not meet the minimum subnet requirements, THEN THE CDK_Stack SHALL fail synthesis with a descriptive error indicating the missing subnet configuration
8. IF the VPC's private subnets cannot route outbound traffic through a NAT_Gateway (whether pre-existing or stack-created), THEN THE CDK_Stack SHALL fail deployment with a CloudFormation error indicating the routing misconfiguration

### Requirement 2: Private API Gateway

**User Story:** As a security engineer, I want the REST API to be accessible only from within the VPC, so that no external traffic can reach the API endpoints.

#### Acceptance Criteria

1. THE Private_API_Gateway SHALL be configured with endpoint type `PRIVATE`
2. THE CDK_Stack SHALL provision a VPC_Endpoint of type `Interface` for the `com.amazonaws.{region}.execute-api` service within the application VPC
3. THE Private_API_Gateway SHALL include a Resource_Policy that allows `execute-api:Invoke` access only from the VPC_Endpoint using the `aws:sourceVpce` condition key and denies all other traffic
4. IF a request arrives that does not originate from the VPC_Endpoint, THEN THE Private_API_Gateway SHALL return a 403 Forbidden response
5. THE Private_API_Gateway SHALL retain the existing Cognito User Pools authorizer for JWT-based authentication on all API methods
6. THE VPC_Endpoint SHALL be configured with a security group that allows inbound HTTPS traffic (port 443) from the VPC CIDR range
7. THE CDK_Stack SHALL configure the Web_UI_Container to invoke the Private_API_Gateway through the VPC_Endpoint so that API requests are routed via the VPC network path

### Requirement 3: Remove CloudFront and S3 Static Hosting

**User Story:** As an infrastructure operator, I want to remove the CloudFront distribution and S3 website hosting bucket, so that the web UI is no longer exposed to the public internet.

#### Acceptance Criteria

1. THE CDK_Stack SHALL NOT provision a CloudFront distribution for the web UI
2. THE CDK_Stack SHALL NOT provision an S3 bucket for static website hosting of the web UI
3. THE CDK_Stack SHALL NOT deploy static web UI assets to S3 via BucketDeployment
4. WHEN the migration is complete, THE CDK_Stack SHALL remove the `WebUiUrl` CloudFront output
5. THE CDK_Stack SHALL remove the `WebUiConstruct` class and its import from the main stack file

### Requirement 4: Fargate Web UI Hosting

**User Story:** As an application user, I want the web UI served from a container within the VPC, so that I can access the application from my VPC-connected workstation without internet routing.

#### Acceptance Criteria

1. THE CDK_Stack SHALL provision an ECS Cluster and Fargate_Service in the private subnets of the VPC
2. THE Fargate_Service SHALL run a Web_UI_Container that serves the static web UI files over HTTP on container port 80
3. THE Web_UI_Container SHALL inject runtime configuration at container startup via environment variables, including the Private_API_Gateway invoke URL, Cognito User Pool ID, Cognito User Pool Client ID, and Cognito hosted UI domain
4. THE Fargate_Service SHALL be fronted by an internal ALB that is not internet-facing
5. THE ALB SHALL listen on HTTPS port 443 with an ACM-managed TLS certificate and forward traffic to the Web_UI_Container target group on port 80
6. THE ALB SHALL route health check requests to the Web_UI_Container at path "/" every 30 seconds, and mark the target healthy after 2 consecutive HTTP 200 responses or unhealthy after 3 consecutive non-200 responses
7. THE Fargate_Service SHALL run a minimum of two tasks across separate Availability Zones for high availability
8. WHEN a Fargate task fails its health check, THE Fargate_Service SHALL replace the task automatically
9. IF the Web_UI_Container fails to start or crashes before passing its first health check, THEN THE Fargate_Service SHALL retry launching a replacement task without affecting other running tasks

### Requirement 5: VPC Endpoints for AWS Services

**User Story:** As a security engineer, I want AWS service calls to traverse VPC Endpoints instead of the public internet, so that data stays within the AWS network and reduces NAT Gateway costs.

#### Acceptance Criteria

1. THE CDK_Stack SHALL provision a gateway VPC_Endpoint for `com.amazonaws.{region}.s3` and associate it with all route tables used by subnets containing Lambda functions
2. THE CDK_Stack SHALL provision a gateway VPC_Endpoint for `com.amazonaws.{region}.dynamodb` and associate it with all route tables used by subnets containing Lambda functions
3. THE CDK_Stack SHALL provision an interface VPC_Endpoint for `com.amazonaws.{region}.execute-api` with private DNS enabled and a security group that allows inbound HTTPS (port 443) from the Lambda functions' security group
4. THE CDK_Stack SHALL provision an interface VPC_Endpoint for `com.amazonaws.{region}.lambda` with private DNS enabled and a security group that allows inbound HTTPS (port 443) from the Lambda functions' security group
5. WHEN a VPC-connected Lambda function makes an AWS SDK call to S3 or DynamoDB, THE request SHALL resolve to the VPC_Endpoint IP address as verified by the presence of the corresponding gateway endpoint route in the subnet route table
6. THE CDK_Stack SHALL provision interface VPC_Endpoints for `com.amazonaws.{region}.logs`, `com.amazonaws.{region}.monitoring`, and `com.amazonaws.{region}.sts`, each with private DNS enabled and a security group that allows inbound HTTPS (port 443) from the Lambda functions' security group

### Requirement 6: Security Group Configuration

**User Story:** As a security engineer, I want network traffic restricted by least-privilege security groups, so that each component can only communicate with its required dependencies.

#### Acceptance Criteria

1. THE ALB Security_Group SHALL allow inbound TCP traffic only on port 443 from the VPC CIDR range
2. THE Fargate_Service Security_Group SHALL allow inbound TCP traffic only on the container listener port from the ALB Security_Group
3. THE VPC_Endpoint Security_Group SHALL allow inbound TCP traffic on port 443 from the VPC CIDR range
4. THE Lambda Security_Group SHALL allow outbound TCP traffic on port 443 to the VPC CIDR range and to 0.0.0.0/0 via the NAT_Gateway, and SHALL NOT allow any inbound traffic
5. IF a Security_Group rule is not explicitly required for application functionality, THEN THE CDK_Stack SHALL NOT include that rule
6. THE ALB Security_Group SHALL allow outbound TCP traffic only on the container listener port to the Fargate_Service Security_Group

### Requirement 7: Lambda VPC Connectivity

**User Story:** As a developer, I want Lambda functions to run inside the VPC, so that they can reach the private DynamoDB and S3 endpoints and other VPC-only resources.

#### Acceptance Criteria

1. THE CDK_Stack SHALL configure all Lambda functions to run within the private subnets of the VPC and attach the Lambda Security_Group defined in Requirement 6
2. THE Lambda functions SHALL route AWS SDK calls to S3 and DynamoDB through the corresponding gateway VPC_Endpoints, and route all other AWS service calls through the NAT_Gateway
3. THE CDK_Stack SHALL grant Lambda execution roles the `ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, and `ec2:DeleteNetworkInterface` permissions scoped to the VPC's private subnets
4. WHEN a Lambda function is invoked after a cold start, THE function SHALL successfully complete an AWS SDK call to DynamoDB or S3 within the function's configured timeout (30 seconds for API handlers, 15 minutes for the orchestrator)
5. IF a Lambda function cannot establish network connectivity to a required AWS service, THEN THE function SHALL return an error response indicating a connectivity failure

### Requirement 8: Cognito Authentication Adaptation

**User Story:** As an application user, I want to continue authenticating via Cognito, so that my login workflow remains functional in the VPC-private environment.

#### Acceptance Criteria

1. THE Cognito User Pool SHALL remain as the identity provider with the hosted UI domain, OAuth scopes (openid, email, profile), and managed login branding unchanged from the existing deployment
2. THE User Pool Client callback and logout URLs SHALL be set to the internal ALB HTTPS URL (matching the ALB DNS name with `https://` scheme) replacing the previous CloudFront distribution URL
3. IF a user accesses the web UI without a valid authentication session, THEN THE Web_UI_Container SHALL serve the auth.js client-side code that redirects the user's browser to the Cognito hosted UI login page via an HTTP 302 or JavaScript location change within 1 second of page load
4. THE Fargate_Service Security_Group SHALL allow outbound HTTPS (port 443) traffic to the Cognito hosted UI domain via the NAT_Gateway so that server-side health checks or token validation can reach Cognito endpoints
5. THE auth.js client-side code SHALL use the ALB HTTPS URL as both the redirect_uri and logout_uri parameters in the PKCE authorization code flow, injected via the config.js runtime configuration at container startup
6. IF the PKCE authorization code exchange fails after the user returns from the Cognito hosted UI, THEN THE Web_UI_Container SHALL serve auth.js code that displays an error message indicating authentication failure and provides the user an option to retry login
7. WHEN the user initiates logout, THE auth.js client-side code SHALL clear the session tokens from sessionStorage and redirect the user's browser to the Cognito logout endpoint with the logout_uri set to the internal ALB HTTPS URL

### Requirement 9: No Public Internet Accessibility

**User Story:** As a security engineer, I want to verify that no application component is reachable from the public internet, so that the system meets the private-hosting security requirement.

#### Acceptance Criteria

1. THE ALB SHALL be configured with scheme `internal`, placing all listeners in private subnets with no public IP addresses
2. IF a request to the Private_API_Gateway does not originate from within the VPC, THEN THE Private_API_Gateway SHALL return a 403 Forbidden response
3. THE VPC SHALL NOT have an internet gateway route in the route tables of any subnet where application resources (ALB, Fargate_Service, Lambda functions, VPC_Endpoints) run
4. THE Fargate_Service tasks SHALL be configured with `assignPublicIp` set to `DISABLED`, resulting in no public IP addresses assigned to task elastic network interfaces
5. THE CDK_Stack SHALL NOT provision any resource with a publicly routable endpoint that accepts inbound application traffic; this excludes AWS-managed service endpoints (Cognito hosted UI) and the NAT_Gateway which provides outbound-only connectivity
6. WHEN `cdk synth` is executed, THE synthesized CloudFormation template SHALL contain no resource with a public DNS name or public IP that routes inbound traffic to the application

### Requirement 10: Infrastructure as Code Migration

**User Story:** As a developer, I want the entire migration expressed as CDK constructs, so that the infrastructure change is repeatable, reviewable, and version-controlled.

#### Acceptance Criteria

1. THE CDK_Stack SHALL replace the `WebUiConstruct` with a new `VpcWebUiConstruct` that provisions the Fargate_Service and ALB
2. THE CDK_Stack SHALL replace the public `ApiConstruct` configuration with private API Gateway settings including the Resource_Policy and endpoint type PRIVATE
3. THE CDK_Stack SHALL introduce a `VpcConstruct` that encapsulates VPC, subnets, NAT_Gateway, and VPC_Endpoints
4. WHEN `cdk synth` is executed, THE output SHALL produce a valid CloudFormation template with no public-facing resources
5. THE CDK_Stack SHALL output the internal ALB DNS name as a stack output for user access
6. THE CDK_Stack SHALL pass the VPC and subnet references from the VpcConstruct to all constructs that require network placement (ApiConstruct, OrchestratorConstruct, VpcWebUiConstruct)
