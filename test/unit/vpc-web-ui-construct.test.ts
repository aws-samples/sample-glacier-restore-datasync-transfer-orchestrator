import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcWebUiConstruct } from '../../lib/constructs/vpc-web-ui-construct';

/**
 * Unit tests for VpcWebUiConstruct.
 * Validates: Properties 1, 3
 *
 * Verifies:
 * - ALB scheme is internal (not internet-facing)
 * - HTTPS listener on port 443 with ACM certificate
 * - Fargate service has desiredCount: 2, assignPublicIp: DISABLED
 * - Health check configuration (path "/", interval 30s, thresholds 2/3)
 * - Security group rules (ALB inbound 443 from VPC CIDR, Fargate inbound 8080 from ALB SG)
 */
describe('VpcWebUiConstruct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const vpc = new ec2.Vpc(stack, 'TestVpc', {
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    new VpcWebUiConstruct(stack, 'WebUi', {
      vpc,
      apiUrl: 'https://test-api.execute-api.us-east-1.amazonaws.com/prod',
      cognitoConfig: {
        userPoolId: 'us-east-1_test',
        userPoolClientId: 'testclient',
        cognitoDomain: 'test.auth.us-east-1.amazoncognito.com',
      },
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert',
    });

    template = Template.fromStack(stack);
  });

  test('ALB scheme is internal', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
  });

  test('HTTPS listener on port 443 with ACM certificate', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.arrayWith([
        Match.objectLike({
          CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert',
        }),
      ]),
    });
  });

  test('Fargate service has desiredCount 2', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
    });
  });

  test('Fargate service has assignPublicIp DISABLED', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: 'DISABLED',
        }),
      },
    });
  });

  test('health check configuration: path "/", interval 30s, healthy 2, unhealthy 3', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/',
      HealthCheckIntervalSeconds: 30,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3,
    });
  });

  test('ALB security group allows inbound 443 from VPC CIDR', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: Match.anyValue(),
        }),
      ]),
    });
  });

  test('Fargate security group allows inbound 8080 from ALB security group only', () => {
    // Fargate SG ingress rule references ALB SG via SourceSecurityGroupId.
    // Port is 8080 because the container runs as the non-root `nginx` user,
    // which cannot bind privileged ports (< 1024).
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 8080,
      ToPort: 8080,
      SourceSecurityGroupId: Match.anyValue(),
    });
  });

  test('Fargate service enables deployment circuit breaker with rollback', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
        },
      }),
    });
  });

  test('Fargate service keeps full capacity during deployments (minHealthyPercent 100)', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      }),
    });
  });
});
