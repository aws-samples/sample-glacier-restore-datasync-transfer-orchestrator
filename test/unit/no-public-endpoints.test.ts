/**
 * Integration-level stack test verifying no public endpoints exist in the
 * RestoreTransferStack. Uses the pre-synthesized CloudFormation template
 * from cdk.out/ to avoid Docker image build requirements during testing.
 *
 * Validates: Properties 1, 2, 5
 */
import * as fs from 'fs';
import * as path from 'path';
import { Template, Match } from 'aws-cdk-lib/assertions';

describe('RestoreTransferStack - No public endpoints', () => {
  let template: Template;

  beforeAll(() => {
    const templatePath = path.resolve(
      __dirname,
      '../../cdk.out/RestoreTransferStack.template.json',
    );
    const templateJson = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
    template = Template.fromJSON(templateJson);
  });

  test('no ALB has scheme internet-facing', () => {
    const albs = template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer');
    for (const [logicalId, resource] of Object.entries(albs)) {
      const scheme = (resource as any).Properties?.Scheme;
      expect(scheme).not.toBe('internet-facing');
      // All ALBs should be internal
      expect(scheme).toBe('internal');
    }
    // Ensure at least one ALB exists (the internal one)
    expect(Object.keys(albs).length).toBeGreaterThanOrEqual(1);
  });

  test('no Fargate service has AssignPublicIp ENABLED', () => {
    const services = template.findResources('AWS::ECS::Service');
    for (const [logicalId, resource] of Object.entries(services)) {
      const networkConfig = (resource as any).Properties?.NetworkConfiguration?.AwsvpcConfiguration;
      if (networkConfig) {
        expect(networkConfig.AssignPublicIp).not.toBe('ENABLED');
      }
    }
    // Ensure at least one ECS service exists
    expect(Object.keys(services).length).toBeGreaterThanOrEqual(1);
  });

  test('no API Gateway has endpoint type REGIONAL or EDGE', () => {
    const restApis = template.findResources('AWS::ApiGateway::RestApi');
    for (const [logicalId, resource] of Object.entries(restApis)) {
      const endpointConfig = (resource as any).Properties?.EndpointConfiguration;
      if (endpointConfig?.Types) {
        expect(endpointConfig.Types).not.toContain('REGIONAL');
        expect(endpointConfig.Types).not.toContain('EDGE');
      }
    }
    // Ensure at least one REST API exists
    expect(Object.keys(restApis).length).toBeGreaterThanOrEqual(1);
  });

  test('API Gateway endpoint type is PRIVATE', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: {
        Types: ['PRIVATE'],
      },
    });
  });

  test('no resource has PubliclyAccessible set to true', () => {
    const allResources = template.toJSON().Resources;
    for (const [logicalId, resource] of Object.entries(allResources)) {
      const props = (resource as any).Properties;
      if (props && typeof props === 'object') {
        expect(props.PubliclyAccessible).not.toBe(true);
      }
    }
  });

  test('AlbDnsName output exists', () => {
    const outputs = template.toJSON().Outputs;
    const outputKeys = Object.keys(outputs ?? {});
    const hasAlbDnsName = outputKeys.some((key) => key === 'AlbDnsName');
    expect(hasAlbDnsName).toBe(true);
  });

  test('WebUiUrl output does not exist', () => {
    const outputs = template.toJSON().Outputs;
    const outputKeys = Object.keys(outputs ?? {});
    const hasWebUiUrl = outputKeys.some((key) => key === 'WebUiUrl');
    expect(hasWebUiUrl).toBe(false);
  });
});
