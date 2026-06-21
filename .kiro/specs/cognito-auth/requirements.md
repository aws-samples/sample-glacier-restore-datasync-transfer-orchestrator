# Requirements Document

## Introduction

This feature adds Amazon Cognito authentication to the Glacier Restore & DataSync application. The web UI will require users to sign in before accessing any functionality, and the API Gateway will use a Cognito authorizer to reject unauthenticated requests. Self-sign-up is disabled — only administrators can create user accounts.

## Glossary

- **User_Pool**: The Amazon Cognito User Pool that stores user identities and handles authentication flows
- **User_Pool_Client**: The Cognito application client configured for the web UI single-page application
- **Cognito_Authorizer**: The API Gateway authorizer that validates JWT tokens issued by the User Pool
- **Web_UI**: The static single-page application hosted on S3 and served via CloudFront
- **API_Gateway**: The REST API Gateway that exposes Lambda-backed endpoints for restore requests
- **Auth_Construct**: The CDK construct that provisions the Cognito User Pool, User Pool Client, and related resources
- **ID_Token**: The JWT token issued by Cognito after successful authentication, used to authorize API requests
- **Hosted_UI**: The Cognito-hosted login and signup pages used for the OAuth2 authentication flow
- **Callback_URL**: The URL Cognito redirects to after successful authentication (the CloudFront distribution URL)

## Requirements

### Requirement 1: Cognito User Pool Provisioning

**User Story:** As an administrator, I want a Cognito User Pool with self-sign-up disabled, so that only admin-created users can access the application.

#### Acceptance Criteria

1. THE Auth_Construct SHALL create a Cognito User Pool with self-sign-up disabled
2. THE Auth_Construct SHALL configure the User Pool to use email as the primary sign-in attribute
3. THE Auth_Construct SHALL enforce a password policy requiring minimum 8 characters with uppercase, lowercase, numbers, and symbols
4. THE Auth_Construct SHALL configure the User Pool with email verification for admin-created users

### Requirement 2: Cognito User Pool Client Configuration

**User Story:** As a developer, I want a User Pool Client configured for SPA authentication, so that the web UI can authenticate users via the OAuth2 implicit grant or authorization code flow.

#### Acceptance Criteria

1. THE Auth_Construct SHALL create a User Pool Client that supports the authorization code grant flow with PKCE
2. THE Auth_Construct SHALL configure the User Pool Client with the CloudFront distribution URL as the callback URL
3. THE Auth_Construct SHALL configure the User Pool Client with the CloudFront distribution URL as the logout URL
4. THE Auth_Construct SHALL configure the User Pool Client to issue ID tokens and access tokens
5. THE Auth_Construct SHALL configure the User Pool Client without a client secret for public SPA usage

### Requirement 3: Cognito Hosted UI Domain

**User Story:** As a user, I want a hosted login page, so that I can authenticate without the application needing to implement custom login UI.

#### Acceptance Criteria

1. THE Auth_Construct SHALL configure a Cognito domain for the Hosted UI
2. THE Auth_Construct SHALL configure OAuth scopes including openid, email, and profile

### Requirement 4: API Gateway Authorization

**User Story:** As a developer, I want all API routes protected by a Cognito authorizer, so that only authenticated users can make API requests.

#### Acceptance Criteria

1. THE API_Gateway SHALL configure a Cognito Authorizer that validates ID tokens from the User Pool
2. THE API_Gateway SHALL apply the Cognito Authorizer to all API methods (POST /requests, GET /requests, GET /requests/{requestId}, GET /requests/{requestId}/manifest)
3. IF an API request lacks a valid Authorization header, THEN THE API_Gateway SHALL return a 401 Unauthorized response
4. THE API_Gateway SHALL include the Authorization header in the CORS allowed headers configuration

### Requirement 5: Web UI Authentication Integration

**User Story:** As a user, I want the web UI to redirect me to login when I am not authenticated, so that I can securely access the application.

#### Acceptance Criteria

1. WHEN the Web_UI loads, THE Web_UI SHALL check for a valid authentication session
2. IF no valid session exists, THEN THE Web_UI SHALL redirect the user to the Cognito Hosted UI login page
3. WHEN the user returns from Cognito with an authorization code, THE Web_UI SHALL exchange the code for tokens and store them in the session
4. WHEN making API requests, THE Web_UI SHALL include the ID_Token in the Authorization header as a Bearer token
5. WHEN the user clicks a logout button, THE Web_UI SHALL clear the local session and redirect to the Cognito logout endpoint
6. THE Web_UI SHALL display the authenticated user's email in the header area

### Requirement 6: Token Lifecycle Management

**User Story:** As a user, I want my session to remain valid without frequent re-authentication, so that I have a smooth experience while using the application.

#### Acceptance Criteria

1. WHEN an ID_Token expires, THE Web_UI SHALL attempt to refresh the session using the refresh token
2. IF the refresh token is expired or invalid, THEN THE Web_UI SHALL redirect the user to the Cognito login page
3. WHEN the user's session is refreshed, THE Web_UI SHALL update the stored tokens transparently without interrupting the user

### Requirement 7: Infrastructure Wiring

**User Story:** As a developer, I want the authentication components wired into the existing CDK stack, so that deployment is seamless and all outputs are accessible.

#### Acceptance Criteria

1. THE RestoreTransferStack SHALL pass the CloudFront distribution URL from the Web_UI construct to the Auth_Construct
2. THE RestoreTransferStack SHALL pass the User Pool information from the Auth_Construct to the API construct for authorizer configuration
3. THE RestoreTransferStack SHALL output the Cognito User Pool ID and Client ID as CloudFormation outputs
4. THE Web_UI SHALL receive Cognito configuration (User Pool ID, Client ID, domain) via the config.js deployment mechanism
