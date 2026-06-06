import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Props for the WebUiConstruct.
 */
export interface WebUiConstructProps {
  /** Optional API URL to inject into the web UI configuration */
  apiUrl?: string;
}

/**
 * CDK construct that hosts the static web UI using S3 and CloudFront.
 * The S3 bucket blocks all public access and is only accessible via CloudFront
 * using Origin Access Control.
 */
export class WebUiConstruct extends Construct {
  /** The CloudFront distribution URL */
  public readonly distributionUrl: string;

  /** The CloudFront distribution */
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: WebUiConstructProps) {
    super(scope, id);

    // S3 bucket for static hosting — block all public access
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // CloudFront distribution with Origin Access Control for S3
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    this.distributionUrl = `https://${this.distribution.distributionDomainName}`;

    // Deploy web UI files from src/web-ui/ to the S3 bucket
    // If an API URL is provided, also deploy a config.js with the runtime endpoint
    const deploySources: s3deploy.ISource[] = [
      s3deploy.Source.asset(path.join(__dirname, '../../src/web-ui')),
    ];

    if (props?.apiUrl) {
      // Strip trailing slash to avoid double-slash when app appends paths
      const apiUrl = props.apiUrl.replace(/\/+$/, '');
      deploySources.push(
        s3deploy.Source.data(
          'config.js',
          `window.__CONFIG__ = { apiUrl: "${apiUrl}" };`
        ),
      );
    }

    new s3deploy.BucketDeployment(this, 'DeployWebUI', {
      sources: deploySources,
      destinationBucket: websiteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    // Output the CloudFront URL
    new cdk.CfnOutput(this, 'WebUiUrl', {
      value: this.distributionUrl,
      description: 'Web UI CloudFront URL',
    });
  }
}
