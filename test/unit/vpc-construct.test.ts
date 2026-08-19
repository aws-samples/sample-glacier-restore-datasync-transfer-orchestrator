import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcConstruct } from '../../lib/constructs/vpc-construct';

describe('VpcConstruct', () => {
  describe('New VPC creation mode', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');
      new VpcConstruct(stack, 'TestVpc');
      template = Template.fromStack(stack);
    });

    test('creates a VPC with CIDR 10.0.0.0/16', () => {
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
      });
    });

    test('creates private subnets across 2 AZs', () => {
      // Private subnets (PRIVATE_WITH_EGRESS) have routes to NAT Gateway
      const subnets = template.findResources('AWS::EC2::Subnet');
      const subnetKeys = Object.keys(subnets);
      // With 2 AZs, we expect 2 public + 2 private = 4 subnets
      expect(subnetKeys.length).toBe(4);

      // Verify private subnets exist with correct naming
      template.hasResourceProperties('AWS::EC2::Subnet', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'aws-cdk:subnet-name', Value: 'Private' }),
        ]),
      });
    });

    test('creates exactly 1 NAT Gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('creates gateway endpoint for S3', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.s3'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Gateway',
      });
    });

    test('creates gateway endpoint for DynamoDB', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.dynamodb'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Gateway',
      });
    });

    test('creates interface endpoint for execute-api', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.execute-api'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
    });

    test('creates interface endpoint for lambda', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.lambda'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
    });

    test('creates interface endpoint for CloudWatch Logs', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.logs'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
    });

    test('creates interface endpoint for CloudWatch Monitoring', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.monitoring'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
    });

    test('creates interface endpoint for STS', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.sts'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
    });

    test('does NOT create a DataSync interface endpoint (would break agents via private DNS)', () => {
      const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
      const hasDataSync = Object.values(endpoints).some((res) => {
        const svc = JSON.stringify((res as { Properties?: { ServiceName?: unknown } }).Properties?.ServiceName ?? '');
        return svc.includes('.datasync');
      });
      expect(hasDataSync).toBe(false);
    });

    test('provisions all 7 VPC endpoints total (2 gateway + 5 interface)', () => {
      template.resourceCountIs('AWS::EC2::VPCEndpoint', 7);
    });

    test('VPC Endpoint security group allows inbound TCP 443 from VPC CIDR', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for VPC Endpoints - allows inbound HTTPS from VPC CIDR',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            CidrIp: Match.anyValue(),
            FromPort: 443,
            ToPort: 443,
            IpProtocol: 'tcp',
            Description: 'Allow HTTPS inbound from VPC CIDR',
          }),
        ]),
      });
    });

    test('Lambda security group allows egress TCP 443 to VPC CIDR', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for Lambda functions - outbound HTTPS only, no inbound',
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({
            CidrIp: Match.anyValue(),
            FromPort: 443,
            ToPort: 443,
            IpProtocol: 'tcp',
            Description: 'Allow HTTPS outbound to VPC CIDR (VPC endpoints)',
          }),
        ]),
      });
    });

    test('Lambda security group allows egress TCP 443 to 0.0.0.0/0', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for Lambda functions - outbound HTTPS only, no inbound',
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({
            CidrIp: '0.0.0.0/0',
            FromPort: 443,
            ToPort: 443,
            IpProtocol: 'tcp',
          }),
        ]),
      });
    });
  });

  describe('Existing VPC mode', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      // Create a test VPC with 2 private subnets across 2 AZs
      const existingVpc = new ec2.Vpc(stack, 'ExistingVpc', {
        ipAddresses: ec2.IpAddresses.cidr('172.16.0.0/16'),
        maxAzs: 2,
        natGateways: 1,
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

      new VpcConstruct(stack, 'TestVpc', { existingVpc });
      template = Template.fromStack(stack);
    });

    test('does not create an additional VPC (only the test VPC exists)', () => {
      // Only 1 VPC should exist — the one we passed in
      template.resourceCountIs('AWS::EC2::VPC', 1);
    });

    test('does not create additional subnets beyond the existing VPC subnets', () => {
      // 2 AZs × 2 subnet types (public + private) = 4 subnets from ExistingVpc only
      template.resourceCountIs('AWS::EC2::Subnet', 4);
    });

    test('does not create additional NAT Gateways beyond the existing VPC', () => {
      // Only 1 NAT from the ExistingVpc we created
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('provisions only 5 interface VPC endpoints (no gateway endpoints for existing VPC)', () => {
      template.resourceCountIs('AWS::EC2::VPCEndpoint', 5);
    });

    test('still creates VPC Endpoint security group', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for VPC Endpoints - allows inbound HTTPS from VPC CIDR',
      });
    });

    test('still creates Lambda security group', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for Lambda functions - outbound HTTPS only, no inbound',
      });
    });
  });

  describe('Validation failure for insufficient subnets', () => {
    test('throws error when existing VPC has fewer than 2 private subnets', () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      // Create a VPC with only 1 AZ (1 private subnet)
      const insufficientVpc = new ec2.Vpc(stack, 'InsufficientVpc', {
        ipAddresses: ec2.IpAddresses.cidr('192.168.0.0/16'),
        maxAzs: 1,
        natGateways: 1,
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

      expect(() => {
        new VpcConstruct(stack, 'TestVpc', { existingVpc: insufficientVpc });
      }).toThrow(/at least 2 private subnets/);
    });
  });
});
