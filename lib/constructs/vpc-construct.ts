/**
 * VPC networking construct for the Restore and Transfer Orchestrator.
 * Supports two modes: creating a new VPC or importing an existing one.
 * In both modes, provisions VPC Endpoints and security groups for
 * private connectivity to AWS services.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Props for the VpcConstruct.
 */
export interface VpcConstructProps {
  /**
   * An existing VPC to use instead of creating a new one.
   * When provided, the construct will NOT create a VPC, subnets, or NAT Gateway.
   * The provided VPC must have at least 2 private subnets in separate AZs.
   */
  existingVpc?: ec2.IVpc;
  /** Maximum number of AZs to use when creating a new VPC (default: 2). Ignored if existingVpc is provided. */
  maxAzs?: number;
  /** Number of NAT Gateways when creating a new VPC (default: 1). Ignored if existingVpc is provided. */
  natGateways?: number;
}

/**
 * CDK construct that encapsulates all VPC networking resources.
 * Creates or imports a VPC, provisions gateway and interface VPC endpoints,
 * and creates security groups for Lambda functions and VPC endpoints.
 */
export class VpcConstruct extends Construct {
  /** The VPC (either imported or newly created) */
  public readonly vpc: ec2.IVpc;
  /** Security group for Lambda functions — outbound 443 to VPC CIDR and 0.0.0.0/0, no inbound */
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  /** Security group for VPC Endpoints — inbound 443 from VPC CIDR */
  public readonly vpcEndpointSecurityGroup: ec2.SecurityGroup;
  /** The execute-api VPC Endpoint (used for Private API Gateway access) */
  public readonly executeApiEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props: VpcConstructProps = {}) {
    super(scope, id);

    if (props.existingVpc) {
      // Import mode: use the provided VPC
      this.vpc = props.existingVpc;
      this.validateExistingVpc(this.vpc);
    } else {
      // Create mode: provision a new VPC
      // Public subnets are required to host NAT Gateways; application resources use private subnets only
      this.vpc = new ec2.Vpc(this, 'Vpc', {
        ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
        maxAzs: props.maxAzs ?? 2,
        natGateways: props.natGateways ?? 1,
        subnetConfiguration: [
          {
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
          {
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 24,
          },
        ],
      });
    }

    // --- Security Groups ---

    this.vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for VPC Endpoints - allows inbound HTTPS from VPC CIDR',
      allowAllOutbound: false,
    });

    this.vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS inbound from VPC CIDR',
    );

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Lambda functions - outbound HTTPS only, no inbound',
      allowAllOutbound: false,
    });

    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound to VPC CIDR (VPC endpoints)',
    );

    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound to internet (via NAT)',
    );

    // --- Gateway Endpoints ---
    // Only create gateway endpoints when provisioning a new VPC.
    // Existing VPCs may already have these endpoints attached to their route tables,
    // and attempting to add a duplicate causes a deployment failure.
    if (!props.existingVpc) {
      this.vpc.addGatewayEndpoint('S3Endpoint', {
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });

      this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      });
    }

    // --- Interface Endpoints ---

    const privateSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };

    this.executeApiEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ExecuteApiEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      privateDnsEnabled: true,
      subnets: privateSubnets,
      securityGroups: [this.vpcEndpointSecurityGroup],
    });

    new ec2.InterfaceVpcEndpoint(this, 'LambdaEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      privateDnsEnabled: true,
      subnets: privateSubnets,
      securityGroups: [this.vpcEndpointSecurityGroup],
    });

    new ec2.InterfaceVpcEndpoint(this, 'LogsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: privateSubnets,
      securityGroups: [this.vpcEndpointSecurityGroup],
    });

    new ec2.InterfaceVpcEndpoint(this, 'MonitoringEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      privateDnsEnabled: true,
      subnets: privateSubnets,
      securityGroups: [this.vpcEndpointSecurityGroup],
    });

    new ec2.InterfaceVpcEndpoint(this, 'StsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      privateDnsEnabled: true,
      subnets: privateSubnets,
      securityGroups: [this.vpcEndpointSecurityGroup],
    });

    // NOTE: We intentionally do NOT create a DataSync interface endpoint with
    // private DNS. Doing so hijacks datasync.<region>.amazonaws.com resolution
    // for the whole VPC, which breaks DataSync agents that activated against the
    // public service endpoint (they go OFFLINE). The orchestrator's DataSync API
    // calls route through the NAT Gateway instead.
  }

  /**
   * Validates that an existing VPC has at least 2 private subnets in separate AZs.
   * Throws a descriptive error if the validation fails.
   */
  private validateExistingVpc(vpc: ec2.IVpc): void {
    const privateSubnets = vpc.privateSubnets;

    if (privateSubnets.length < 2) {
      throw new Error(
        `The provided VPC must have at least 2 private subnets, but only ${privateSubnets.length} were found. ` +
        'Ensure the VPC has PRIVATE_WITH_EGRESS or PRIVATE_ISOLATED subnets in at least 2 Availability Zones.',
      );
    }

    const uniqueAzs = new Set(privateSubnets.map((subnet) => subnet.availabilityZone));
    if (uniqueAzs.size < 2) {
      throw new Error(
        `The provided VPC must have private subnets in at least 2 separate Availability Zones, ` +
        `but all ${privateSubnets.length} private subnets are in the same AZ (${[...uniqueAzs].join(', ')}). ` +
        'Distribute private subnets across at least 2 AZs for high availability.',
      );
    }
  }
}
