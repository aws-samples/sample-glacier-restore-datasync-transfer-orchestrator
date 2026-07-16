import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Props for the ApiConstruct.
 */
export interface ApiConstructProps {
  /** DynamoDB table for request persistence (TABLE_NAME env var on all handlers) */
  table: dynamodb.ITable;
  /** Orchestrator Lambda function (ORCHESTRATOR_FUNCTION_NAME env var on submit handler) */
  orchestratorFunction: lambda.IFunction;
  /** Staging bucket name for manifest pre-signed URLs */
  stagingBucket?: string;
  /** Cognito User Pool for API authorization */
  userPool?: cognito.IUserPool;
}

/**
 * CDK construct that defines the REST API Gateway with three endpoints
 * for submitting and querying Glacier restore requests.
 */
export class ApiConstruct extends Construct {
  /** The REST API Gateway */
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    // Build CORS allowed headers — include Authorization when Cognito is configured
    const allowHeaders = props.userPool
      ? ['Content-Type', 'Authorization']
      : ['Content-Type'];

    // Create REST API with CORS enabled
    this.api = new apigateway.RestApi(this, 'RestoreApi', {
      restApiName: 'GlacierRestoreApi',
      description: 'API for Glacier restore and DataSync transfer requests',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders,
      },
    });

    // Create Cognito authorizer if a User Pool is provided
    let methodOptions: apigateway.MethodOptions | undefined;
    if (props.userPool) {
      const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
        cognitoUserPools: [props.userPool],
      });
      methodOptions = {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer,
      };
    }

    // --- Submit Request Handler (POST /requests) ---
    const submitRequestFn = new nodejs.NodejsFunction(this, 'SubmitRequestFunction', {
      entry: 'src/api/submit-request.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
        ORCHESTRATOR_FUNCTION_NAME: props.orchestratorFunction.functionName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
    });

    // --- Get Requests Handler (GET /requests) ---
    const getRequestsFn = new nodejs.NodejsFunction(this, 'GetRequestsFunction', {
      entry: 'src/api/get-requests.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
    });

    // --- Get DataSync Destinations Handler (GET /datasync-destinations) ---
    const getDataSyncDestinationsFn = new nodejs.NodejsFunction(this, 'GetDataSyncDestinationsFunction', {
      entry: 'src/api/get-datasync-destinations.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {},
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
    });

    // DataSync ListLocations permission for destinations handler
    getDataSyncDestinationsFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['datasync:ListLocations'],
      resources: ['*'],
    }));

    // --- Get Request Status Handler (GET /requests/{requestId}) ---
    const getRequestStatusFn = new nodejs.NodejsFunction(this, 'GetRequestStatusFunction', {
      entry: 'src/api/get-request-status.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
    });

    // --- IAM Permissions ---

    // Submit handler needs DynamoDB read/write and invoke on orchestrator
    props.table.grantReadWriteData(submitRequestFn);
    props.orchestratorFunction.grantInvoke(submitRequestFn);

    // Get handlers need DynamoDB read permissions
    props.table.grantReadData(getRequestsFn);
    props.table.grantReadData(getRequestStatusFn);

    // --- API Gateway Resource & Method Configuration ---

    const requestsResource = this.api.root.addResource('requests');

    // POST /requests
    requestsResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(submitRequestFn),
      methodOptions
    );

    // GET /requests
    requestsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(getRequestsFn),
      methodOptions
    );

    // GET /datasync-destinations
    const dataSyncDestinationsResource = this.api.root.addResource('datasync-destinations');
    dataSyncDestinationsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(getDataSyncDestinationsFn),
      methodOptions
    );

    // GET /requests/{requestId}
    const singleRequestResource = requestsResource.addResource('{requestId}');
    singleRequestResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(getRequestStatusFn),
      methodOptions
    );

    // --- Get Manifest URL Handler (GET /requests/{requestId}/manifest) ---
    if (props.stagingBucket) {
      const getManifestUrlFn = new nodejs.NodejsFunction(this, 'GetManifestUrlFunction', {
        entry: 'src/api/get-manifest-url.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(30),
        environment: {
          TABLE_NAME: props.table.tableName,
          STAGING_BUCKET: props.stagingBucket,
        },
        bundling: {
          minify: true,
          sourceMap: true,
          forceDockerBundling: false,
        },
      });

      props.table.grantReadData(getManifestUrlFn);

      // Grant S3 read access for generating pre-signed URLs
      getManifestUrlFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${props.stagingBucket}/manifests/*`],
      }));

      const manifestResource = singleRequestResource.addResource('manifest');
      manifestResource.addMethod(
        'GET',
        new apigateway.LambdaIntegration(getManifestUrlFn),
        methodOptions
      );
    }
  }
}
