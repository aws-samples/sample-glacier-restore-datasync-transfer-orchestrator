/**
 * VPC Web UI construct that serves the static web UI via ECS Fargate
 * behind an internal Application Load Balancer with HTTPS.
 * Replaces the public CloudFront + S3 hosting pattern.
 */

import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

/**
 * Props for the VpcWebUiConstruct.
 */
export interface VpcWebUiConstructProps {
  /** The VPC to deploy into */
  vpc: ec2.IVpc;
  /** API Gateway invoke URL (injected as runtime config) */
  apiUrl: string;
  /** Cognito configuration for auth */
  cognitoConfig: {
    userPoolId: string;
    userPoolClientId: string;
    cognitoDomain: string;
  };
  /** ACM certificate ARN for HTTPS on the ALB */
  certificateArn: string;
  /**
   * Public URL users access the app through (e.g. https://restore-tool.internal).
   * Used for the Cognito redirect/logout URIs injected into config.js. When
   * omitted, the internal ALB HTTPS URL is used.
   */
  publicUrl?: string;
}

/**
 * CDK construct that deploys the web UI as an ECS Fargate service
 * behind an internal ALB with HTTPS. The container builds from
 * src/web-ui/ and injects runtime config via environment variables.
 */
export class VpcWebUiConstruct extends Construct {
  /** The internal ALB */
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  /** The ALB DNS name */
  public readonly albDnsName: string;
  /** The full HTTPS URL of the ALB */
  public readonly albUrl: string;
  /** The ECS Fargate service */
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: VpcWebUiConstructProps) {
    super(scope, id);

    // --- Security Groups ---

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'ALB security group - inbound 443 from VPC CIDR, outbound 8080 to Fargate',
      allowAllOutbound: false,
    });

    const fargateSecurityGroup = new ec2.SecurityGroup(this, 'FargateSecurityGroup', {
      vpc: props.vpc,
      description: 'Fargate security group - inbound 8080 from ALB, outbound 443 to internet',
      allowAllOutbound: false,
    });

    // ALB SG: inbound 443 from VPC CIDR
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS inbound from VPC CIDR',
    );

    // ALB SG: outbound 8080 to Fargate SG only
    albSecurityGroup.addEgressRule(
      fargateSecurityGroup,
      ec2.Port.tcp(8080),
      'Allow HTTP outbound to Fargate tasks',
    );

    // Fargate SG: inbound 8080 from ALB SG only
    fargateSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(8080),
      'Allow HTTP inbound from ALB',
    );

    // Fargate SG: outbound 443 to 0.0.0.0/0 (for Cognito via NAT)
    fargateSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound to internet (Cognito via NAT)',
    );

    // --- Internal ALB ---

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.albDnsName = this.loadBalancer.loadBalancerDnsName;
    this.albUrl = `https://${this.albDnsName}`;

    // --- ECS Cluster ---

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
    });

    // --- Task Definition ---
    // Use ARM64 (Graviton) for better price/performance; the nginx image supports both architectures
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDefinition.addContainer('WebUiContainer', {
      image: ecs.ContainerImage.fromAsset('src/web-ui', {
        platform: ecr_assets.Platform.LINUX_ARM64,
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web-ui' }),
      environment: {
        API_URL: props.apiUrl,
        COGNITO_USER_POOL_ID: props.cognitoConfig.userPoolId,
        COGNITO_CLIENT_ID: props.cognitoConfig.userPoolClientId,
        COGNITO_DOMAIN: props.cognitoConfig.cognitoDomain,
        REDIRECT_URI: props.publicUrl ?? cdk.Lazy.string({ produce: () => this.albUrl }),
        LOGOUT_URI: props.publicUrl ?? cdk.Lazy.string({ produce: () => this.albUrl }),
      },
    });

    container.addPortMappings({
      // Unprivileged port — the container runs as the non-root `nginx` user.
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // --- Fargate Service ---

    this.service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [fargateSecurityGroup],
      // Enables `aws ecs execute-command` for in-container debugging (curl to the
      // private API, DNS checks, etc.). Uses the SSM channel over the VPC.
      enableExecuteCommand: true,
      // Keep the full desired task count in service during deployments so the
      // UI stays available while a new task set rolls out.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Fail (and roll back) a bad deployment quickly instead of waiting out
      // the multi-hour default before ECS gives up.
      circuitBreaker: { rollback: true },
    });

    // --- HTTPS Listener ---

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      props.certificateArn,
    );

    const httpsListener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
    });

    httpsListener.addTargets('FargateTarget', {
      port: 8080,
      targets: [this.service],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
  }
}
