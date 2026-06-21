# Implementation Plan: Cognito Authentication

## Overview

Add Cognito authentication to the Glacier Restore & DataSync application. The implementation follows the existing CDK construct pattern, adding a new `AuthConstruct` and modifying the API and Web UI constructs to wire in authentication. The web UI gets a new `auth.js` module for handling login/logout/token lifecycle.

## Tasks

- [x] 1. Create the AuthConstruct
  - [x] 1.1 Create `lib/constructs/auth-construct.ts` with Cognito User Pool, User Pool Client, and domain
    - Create `AuthConstructProps` interface accepting `callbackUrl: string`
    - Create User Pool with `selfSignUpEnabled: false`, email sign-in, password policy (min 8, uppercase, lowercase, digits, symbols)
    - Create User Pool Client with authorization code grant, PKCE support, no client secret
    - Configure OAuth scopes: openid, email, profile
    - Set callback URLs and logout URLs to the provided CloudFront URL
    - Create Cognito domain using a prefix derived from the stack name
    - Expose `userPool`, `userPoolClient`, `userPoolDomain`, and `cognitoDomainUrl` as public properties
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2_

  - [ ]* 1.2 Write CDK assertion tests for AuthConstruct
    - Create `test/unit/auth-construct.test.ts`
    - Test User Pool has self-sign-up disabled
    - Test User Pool Client has correct grant types and scopes
    - Test callback and logout URLs are set correctly
    - Test password policy configuration
    - Test Cognito domain is created
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2_

- [x] 2. Modify the ApiConstruct to add Cognito authorization
  - [x] 2.1 Update `lib/constructs/api-construct.ts` to accept a User Pool and attach a Cognito authorizer
    - Add optional `userPool?: cognito.IUserPool` to `ApiConstructProps`
    - When `userPool` is provided, create a `CognitoUserPoolsAuthorizer`
    - Attach authorizer to all `addMethod()` calls with `authorizationType: AuthorizationType.COGNITO`
    - Update CORS `allowHeaders` to include `'Authorization'`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 2.2 Update CDK assertion tests for ApiConstruct
    - Update `test/unit/api-construct.test.ts`
    - Test that Cognito authorizer is created when userPool prop is provided
    - Test that all methods reference the authorizer
    - Test that CORS headers include Authorization
    - Test backward compatibility: no authorizer when userPool is not provided
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 3. Update the WebUiConstruct and RestoreTransferStack
  - [x] 3.1 Update `lib/constructs/web-ui-construct.ts` to accept and deploy Cognito config
    - Add optional `cognitoConfig` to `WebUiConstructProps` with `userPoolId`, `clientId`, `cognitoDomain`, `redirectUri`, `logoutUri`
    - When provided, include the Cognito config in the `config.js` deployment source
    - _Requirements: 7.4_

  - [x] 3.2 Update `lib/restore-transfer-stack.ts` to wire all constructs together
    - Instantiate `AuthConstruct` with `callbackUrl: webUi.distributionUrl`
    - Pass `userPool: auth.userPool` to `ApiConstruct`
    - Pass `cognitoConfig` to `WebUiConstruct` with User Pool ID, Client ID, domain URL
    - Add CfnOutputs for `CognitoUserPoolId` and `CognitoClientId`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 3.3 Update CDK assertion tests for WebUiConstruct
    - Update `test/unit/web-ui-construct.test.ts`
    - Test that config.js includes Cognito config when provided
    - Test backward compatibility when cognitoConfig is not provided
    - _Requirements: 7.4_

- [x] 4. Checkpoint - Ensure all CDK tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement the web UI authentication module
  - [x] 5.1 Create `src/web-ui/auth.js` with PKCE-based authentication logic
    - Implement `generateCodeVerifier()` — random 43-128 char string
    - Implement `generateCodeChallenge(verifier)` — Base64URL(SHA-256(verifier))
    - Implement `redirectToLogin()` — build `/oauth2/authorize` URL with code_challenge, store verifier in sessionStorage
    - Implement `handleCallback()` — exchange auth code for tokens via `/oauth2/token`, store tokens in sessionStorage
    - Implement `getIdToken()` — return token if valid, attempt refresh if expired
    - Implement `refreshTokens()` — POST to `/oauth2/token` with refresh_token grant type
    - Implement `isAuthenticated()` — check token existence and expiry
    - Implement `getUserEmail()` — decode JWT payload, return email claim
    - Implement `logout()` — clear sessionStorage, redirect to Cognito `/logout`
    - Implement `initAuth()` — orchestrate: check URL for code param, handle callback, check existing session, redirect if needed
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3_

  - [x] 5.2 Update `src/web-ui/index.html` to include auth.js and add header UI elements
    - Add `<script src="auth.js"></script>` before `app.js`
    - Add user email display element to the header
    - Add logout button to the header
    - _Requirements: 5.5, 5.6_

  - [x] 5.3 Update `src/web-ui/app.js` to integrate authentication
    - Modify `init()` to call `initAuth()` first; halt if not authenticated
    - Update `submitRequest()` to include `Authorization: Bearer <token>` header
    - Update `fetchRequests()` to include `Authorization: Bearer <token>` header
    - Update `fetchManifestUrl()` to include `Authorization: Bearer <token>` header
    - Add 401 response handling — attempt token refresh, retry request, or redirect to login
    - Wire logout button click handler
    - Display authenticated user's email in the header
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2_

  - [ ]* 5.4 Write unit tests for the auth module
    - Create `test/unit/auth.test.ts`
    - Test `isAuthenticated()` returns false when no token exists
    - Test `isAuthenticated()` returns false when token is expired
    - Test `isAuthenticated()` returns true when token is valid
    - Test `getUserEmail()` correctly decodes email from JWT payload
    - Test PKCE code challenge generation produces correct format
    - _Requirements: 5.1, 5.6, 6.1_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The feature is primarily IaC (CDK) and integration code, tested via CDK assertion tests
- The web UI uses vanilla JavaScript consistent with the existing `app.js` approach
- PKCE is required since the User Pool Client has no client secret (public SPA client)
- Tokens are stored in sessionStorage (not localStorage) for better security — cleared on tab close
- The AuthConstruct is optional/backwards-compatible via optional props on ApiConstruct and WebUiConstruct

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3"] },
    { "id": 4, "tasks": ["5.1", "5.2"] },
    { "id": 5, "tasks": ["5.3", "5.4"] }
  ]
}
```
