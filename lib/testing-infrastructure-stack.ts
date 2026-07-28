import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as datasync from 'aws-cdk-lib/aws-datasync';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Optional testing infrastructure stack that provisions the prerequisite
 * resources needed by the RestoreTransferStack:
 *
 * - VPC with public subnet
 * - Source S3 bucket (with Glacier lifecycle rule for testing)
 * - Staging S3 bucket (for batch manifests)
 * - NFS server EC2 instance (destination for DataSync)
 * - DataSync agent EC2 instance
 * - DataSync task (S3 source → NFS destination)
 * - IAM role for S3 Batch Operations
 *
 * This stack is intended for development/testing only and should NOT
 * be deployed to production environments.
 *
 * ## Two-phase deployment:
 *
 * Phase 1 — Deploy without activation key to stand up EC2 instances:
 *   npx cdk deploy RestoreTransferTestingStack
 *
 * Phase 2 — Get the activation key from the agent, then redeploy:
 *   curl "http://<agent-public-ip>/?gatewayType=SYNC&activationRegion=<region>&redirect_type=TEXT"
 *   npx cdk deploy RestoreTransferTestingStack --parameters ActivationKey=<key>
 */
export class TestingInfrastructureStack extends cdk.Stack {
  /** ARN of the DataSync task */
  public readonly dataSyncTaskArn: string;
  /** Name of the staging bucket */
  public readonly stagingBucketName: string;
  /** ARN of the S3 Batch Operations role */
  public readonly batchRoleArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── Parameters ────────────────────────────────────────────────────
    const activationKeyParam = new cdk.CfnParameter(this, 'ActivationKey', {
      type: 'String',
      default: '',
      description: 'DataSync agent activation key. Leave empty on first deploy, then provide after retrieving from the agent EC2 instance.',
      allowedPattern: '([A-Z0-9]{5}(-[A-Z0-9]{5}){4})?',
      constraintDescription: 'Must be a valid activation key (e.g. AAAAA-BBBBB-CCCCC-DDDDD-EEEEE) or empty',
    });

    const hasActivationKey = new cdk.CfnCondition(this, 'HasActivationKey', {
      expression: cdk.Fn.conditionNot(
        cdk.Fn.conditionEquals(activationKeyParam.valueAsString, ''),
      ),
    });

    const activationCidrParam = new cdk.CfnParameter(this, 'ActivationCidr', {
      type: 'String',
      default: '0.0.0.0/0',
      description: 'CIDR block allowed to reach the DataSync agent on port 80 for activation. Restrict to your IP (e.g. 203.0.113.5/32). Only needed temporarily during activation.',
    });

    // ─── VPC ───────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'TestVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ─── Security Groups ───────────────────────────────────────────────
    const nfsSg = new ec2.SecurityGroup(this, 'NfsSecurityGroup', {
      vpc,
      description: 'Allow NFS traffic from DataSync agent',
      allowAllOutbound: true,
    });

    const agentSg = new ec2.SecurityGroup(this, 'AgentSecurityGroup', {
      vpc,
      description: 'DataSync agent security group',
      allowAllOutbound: true,
    });

    // NFS server allows inbound from the DataSync agent
    nfsSg.addIngressRule(agentSg, ec2.Port.tcp(2049), 'NFS from DataSync agent');
    nfsSg.addIngressRule(agentSg, ec2.Port.tcp(111), 'NFS portmapper from DataSync agent');

    // Allow activation traffic only from the specified CIDR (port 80, temporary)
    agentSg.addIngressRule(
      ec2.Peer.ipv4(activationCidrParam.valueAsString),
      ec2.Port.tcp(80),
      'DataSync agent activation (restrict to your IP)',
    );

    // ─── NFS Server EC2 Instance ───────────────────────────────────────
    const nfsInstance = new ec2.Instance(this, 'NfsServer', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: nfsSg,
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(50, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // Install and configure NFS server
    nfsInstance.addUserData(
      'dnf install -y nfs-utils',
      'mkdir -p /data/datasync-destination',
      'chmod 777 /data/datasync-destination',
      'mkdir -p /data/datasync-destination-2',
      'chmod 777 /data/datasync-destination-2',
      'echo "/data/datasync-destination *(rw,sync,no_subtree_check,no_root_squash)" >> /etc/exports',
      'echo "/data/datasync-destination-2 *(rw,sync,no_subtree_check,no_root_squash)" >> /etc/exports',
      'systemctl enable nfs-server',
      'systemctl start nfs-server',
      'exportfs -arv',
    );

    // ─── DataSync Agent EC2 Instance ───────────────────────────────────
    // Uses the AWS-provided DataSync agent AMI
    // See: https://docs.aws.amazon.com/datasync/latest/userguide/deploy-agents.html
    const dataSyncAgentAmi = ec2.MachineImage.lookup({
      name: 'aws-datasync-*',
      owners: ['amazon'],
    });

    const agentInstance = new ec2.Instance(this, 'DataSyncAgent', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.XLARGE2),
      machineImage: dataSyncAgentAmi,
      securityGroup: agentSg,
      associatePublicIpAddress: true,
    });

    // ─── DataSync Agent Resource (conditional) ─────────────────────────
    // Only created when an activation key is provided (phase 2 deploy)
    const agent = new datasync.CfnAgent(this, 'Agent', {
      activationKey: activationKeyParam.valueAsString,
      agentName: 'RestoreTransferTestAgent',
    });
    (agent.node.defaultChild as cdk.CfnResource ?? agent).cfnOptions.condition = hasActivationKey;

    // ─── Staging Bucket ────────────────────────────────────────────────
    // Defined early because DataSync S3 role needs access to it for manifests
    const stagingBucket = new s3.Bucket(this, 'StagingBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'CleanupOldManifests',
          expiration: cdk.Duration.days(30),
        },
      ],
    });

    this.stagingBucketName = stagingBucket.bucketName;

    // ─── Source S3 Bucket ──────────────────────────────────────────────
    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'TransitionToGlacier',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(0),
            },
          ],
        },
      ],
    });

    // IAM role for DataSync to access S3
    const dataSyncS3Role = new iam.Role(this, 'DataSyncS3Role', {
      assumedBy: new iam.ServicePrincipal('datasync.amazonaws.com'),
      inlinePolicies: {
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                's3:GetBucketLocation',
                's3:ListBucket',
                's3:ListBucketMultipartUploads',
              ],
              resources: [sourceBucket.bucketArn],
            }),
            new iam.PolicyStatement({
              actions: [
                's3:AbortMultipartUpload',
                's3:DeleteObject',
                's3:GetObject',
                's3:ListMultipartUploadParts',
                's3:PutObject',
                's3:GetObjectTagging',
                's3:PutObjectTagging',
              ],
              resources: [`${sourceBucket.bucketArn}/*`],
            }),
            // Manifest access: DataSync needs to read manifests from staging bucket
            new iam.PolicyStatement({
              actions: [
                's3:GetObject',
                's3:GetObjectVersion',
              ],
              resources: [`${stagingBucket.bucketArn}/*`],
            }),
            new iam.PolicyStatement({
              actions: [
                's3:GetBucketLocation',
                's3:ListBucket',
              ],
              resources: [stagingBucket.bucketArn],
            }),
          ],
        }),
      },
    });

    // ─── DataSync Locations (conditional) ──────────────────────────────
    const s3Location = new datasync.CfnLocationS3(this, 'S3Location', {
      s3BucketArn: sourceBucket.bucketArn,
      s3Config: {
        bucketAccessRoleArn: dataSyncS3Role.roleArn,
      },
    });
    s3Location.cfnOptions.condition = hasActivationKey;

    const nfsLocation = new datasync.CfnLocationNFS(this, 'NfsLocation', {
      serverHostname: nfsInstance.instancePrivateIp,
      subdirectory: '/data/datasync-destination',
      onPremConfig: {
        agentArns: [agent.attrAgentArn],
      },
    });
    nfsLocation.cfnOptions.condition = hasActivationKey;

    // Second NFS location — different export path for testing destination selection
    const nfsLocation2 = new datasync.CfnLocationNFS(this, 'NfsLocation2', {
      serverHostname: nfsInstance.instancePrivateIp,
      subdirectory: '/data/datasync-destination-2',
      onPremConfig: {
        agentArns: [agent.attrAgentArn],
      },
    });
    nfsLocation2.cfnOptions.condition = hasActivationKey;

    // ─── DataSync Task (conditional) ───────────────────────────────────
    const taskLogGroup = new logs.LogGroup(this, 'DataSyncTaskLogGroup', {
      logGroupName: `/aws/datasync/RestoreTransferTestTask`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (taskLogGroup.node.defaultChild as cdk.CfnResource).cfnOptions.condition = hasActivationKey;

    // Allow DataSync service to write to the log group
    const logResourcePolicy = new logs.CfnResourcePolicy(this, 'DataSyncLogPolicy', {
      policyName: 'DataSyncLogAccess',
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowDataSyncToWriteLogs',
            Effect: 'Allow',
            Principal: { Service: 'datasync.amazonaws.com' },
            Action: [
              'logs:PutLogEvents',
              'logs:CreateLogStream',
            ],
            Resource: `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/datasync/*:*`,
          },
        ],
      }),
    });
    logResourcePolicy.cfnOptions.condition = hasActivationKey;

    const task = new datasync.CfnTask(this, 'DataSyncTask', {
      sourceLocationArn: s3Location.attrLocationArn,
      destinationLocationArn: nfsLocation.attrLocationArn,
      name: 'RestoreTransferTestTask',
      cloudWatchLogGroupArn: taskLogGroup.logGroupArn,
      options: {
        verifyMode: 'ONLY_FILES_TRANSFERRED',
        overwriteMode: 'ALWAYS',
        preserveDeletedFiles: 'PRESERVE',
        logLevel: 'BASIC',
      },
    });
    task.cfnOptions.condition = hasActivationKey;

    // Explicit dependencies: locations and agent must not be deleted before the task.
    // CloudFormation reverses these during deletion, ensuring the task is removed first.
    task.addResourceDependency(s3Location);
    task.addResourceDependency(nfsLocation);
    task.addResourceDependency(agent);

    // The S3 location depends on its IAM role — prevent role deletion while location exists
    s3Location.addResourceDependency(dataSyncS3Role.node.defaultChild as cdk.CfnResource);

    this.dataSyncTaskArn = task.attrTaskArn;

    // ─── S3 Batch Operations Role ──────────────────────────────────────
    const batchRole = new iam.Role(this, 'S3BatchOperationsRole', {
      assumedBy: new iam.ServicePrincipal('batchoperations.s3.amazonaws.com'),
      inlinePolicies: {
        RestoreAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:RestoreObject', 's3:GetObject'],
              resources: [`${sourceBucket.bucketArn}/*`],
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:GetObjectVersion'],
              resources: [`${stagingBucket.bucketArn}/*`],
            }),
            new iam.PolicyStatement({
              actions: ['s3:PutObject'],
              resources: [`${stagingBucket.bucketArn}/reports/*`],
            }),
          ],
        }),
      },
    });

    this.batchRoleArn = batchRole.roleArn;

    // ─── Outputs ───────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DataSyncTaskArnOutput', {
      value: task.attrTaskArn,
      description: 'DataSync task ARN — use as DATASYNC_TASK_ARN',
      exportName: 'RestoreTransferTest-DataSyncTaskArn',
      condition: hasActivationKey,
    });

    new cdk.CfnOutput(this, 'StagingBucketNameOutput', {
      value: stagingBucket.bucketName,
      description: 'Staging bucket name — use as STAGING_BUCKET',
      exportName: 'RestoreTransferTest-StagingBucket',
    });

    new cdk.CfnOutput(this, 'BatchRoleArnOutput', {
      value: batchRole.roleArn,
      description: 'S3 Batch Operations role ARN — use as BATCH_ROLE_ARN',
      exportName: 'RestoreTransferTest-BatchRoleArn',
    });

    new cdk.CfnOutput(this, 'DataSyncS3RoleArnOutput', {
      value: dataSyncS3Role.roleArn,
      description: 'DataSync S3 access role ARN — use as DATASYNC_S3_ROLE_ARN',
      exportName: 'RestoreTransferTest-DataSyncS3RoleArn',
    });

    new cdk.CfnOutput(this, 'SourceBucketNameOutput', {
      value: sourceBucket.bucketName,
      description: 'Source S3 bucket (objects transition to Glacier immediately)',
    });

    new cdk.CfnOutput(this, 'NfsServerPrivateIp', {
      value: nfsInstance.instancePrivateIp,
      description: 'NFS server private IP',
    });

    new cdk.CfnOutput(this, 'NfsLocation1Arn', {
      value: nfsLocation.attrLocationArn,
      description: 'DataSync NFS location ARN — /data/datasync-destination',
      condition: hasActivationKey,
    });

    new cdk.CfnOutput(this, 'NfsLocation2Arn', {
      value: nfsLocation2.attrLocationArn,
      description: 'DataSync NFS location ARN — /data/datasync-destination-2',
      condition: hasActivationKey,
    });

    new cdk.CfnOutput(this, 'DataSyncAgentPublicIp', {
      value: agentInstance.instancePublicIp,
      description: 'DataSync agent public IP — use for agent activation',
    });

    new cdk.CfnOutput(this, 'AgentActivationCommand', {
      value: `curl -v "http://${agentInstance.instancePublicIp}/?gatewayType=SYNC&activationRegion=${this.region}&redirect_type=TEXT"`,
      description: 'Run this after Phase 1 deploy to get the activation key for Phase 2',
    });
  }
}
