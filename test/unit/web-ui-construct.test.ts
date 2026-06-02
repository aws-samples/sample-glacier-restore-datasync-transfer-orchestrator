import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WebUiConstruct } from '../../lib/constructs/web-ui-construct';

describe('WebUiConstruct', () => {
  let template: Template;
  let construct: WebUiConstruct;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    construct = new WebUiConstruct(stack, 'TestWebUi', {
      apiUrl: 'https://api.example.com/prod',
    });

    template = Template.fromStack(stack);
  });

  test('creates an S3 bucket with block public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates a CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  test('configures default root object as index.html', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
      }),
    });
  });

  test('configures 404 error response to redirect to /index.html for SPA routing', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      }),
    });
  });

  test('configures HTTPS redirect viewer protocol policy', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  test('creates Origin Access Control for S3', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  test('creates a BucketDeployment for web UI files', () => {
    // BucketDeployment creates a Custom::CDKBucketDeployment resource
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DistributionPaths: ['/*'],
    });
  });

  test('creates a config.js deployment when apiUrl is provided', () => {
    // Should have two BucketDeployment resources (web UI files + config.js)
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    expect(Object.keys(deployments).length).toBe(2);
  });

  test('exposes the CloudFront distribution URL as a public property', () => {
    expect(construct.distributionUrl).toBeDefined();
    expect(construct.distributionUrl).toContain('https://');
  });

  test('exposes the CloudFront distribution as a public property', () => {
    expect(construct.distribution).toBeDefined();
    expect(construct.distribution.distributionDomainName).toBeDefined();
  });

  test('outputs the Web UI URL', () => {
    template.hasOutput('*', {
      Value: Match.anyValue(),
    });
  });
});

describe('WebUiConstruct without apiUrl', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStackNoApi');

    new WebUiConstruct(stack, 'TestWebUiNoApi');

    template = Template.fromStack(stack);
  });

  test('creates only one BucketDeployment when no apiUrl is provided', () => {
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    expect(Object.keys(deployments).length).toBe(1);
  });

  test('still creates CloudFront distribution without apiUrl', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });
});
