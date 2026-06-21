import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * Props for the AuthConstruct.
 */
export interface AuthConstructProps {
  /** CloudFront distribution URL for callback/logout URLs */
  callbackUrl: string;
}

/**
 * CDK construct that provisions Cognito resources for authentication:
 * User Pool, User Pool Client, and Hosted UI domain.
 */
export class AuthConstruct extends Construct {
  /** The Cognito User Pool */
  public readonly userPool: cognito.UserPool;
  /** The User Pool Client */
  public readonly userPoolClient: cognito.UserPoolClient;
  /** The Cognito domain */
  public readonly userPoolDomain: cognito.UserPoolDomain;
  /** The full Cognito domain URL */
  public readonly cognitoDomainUrl: string;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    // Create User Pool with self-sign-up disabled, email sign-in, and strict password policy
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create User Pool Client with authorization code grant, PKCE support, no client secret
    this.userPoolClient = this.userPool.addClient('UserPoolClient', {
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [props.callbackUrl],
        logoutUrls: [props.callbackUrl],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });

    // Create Cognito domain with managed login (v2) and a prefix derived from the stack name
    const domainPrefix = cdk.Fn.join('-', [
      'auth',
      cdk.Fn.select(2, cdk.Fn.split('/', cdk.Stack.of(this).stackId)),
    ]);

    this.userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: domainPrefix.toString(),
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Enable managed login branding with Cognito-provided defaults
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      returnMergedResources: true,
      useCognitoProvidedValues: true,
    });

    this.cognitoDomainUrl = `https://${domainPrefix}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`;
  }
}
