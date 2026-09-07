// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag'

type GreengrassRuntime = 'nucleus' | 'nucleus-lite';

export class GreengrassEC2DeviceFarmStack extends cdk.Stack {

  linuxSecurityGroup: ec2.SecurityGroup;
  windowsSecurityGroup: ec2.SecurityGroup;
  vpc: cdk.aws_ec2.IVpc;
  instanceRole: iam.Role;
  greengrassRole: iam.Role;
  greengrassRoleAlias: iot.CfnRoleAlias;
  greengrassRolePolicy: iam.ManagedPolicy;
  iotThingPolicy: iot.CfnPolicy;
  allThingGroup: iot.CfnThingGroup;
  nucleusThingGroup: iot.CfnThingGroup;
  nucleusLiteThingGroup: iot.CfnThingGroup;
  keyPair: ec2.KeyPair;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = this.createVpc();
    
    this.keyPair = this.createKeyPair();

    this.linuxSecurityGroup = this.createSecurityGroup('Linux');
    this.windowsSecurityGroup = this.createSecurityGroup('Windows');

    this.greengrassRole = this.createGreengrassTokenExchangeRole();
    this.greengrassRolePolicy = this.createGreengrassTokenExchangePolicy();
    this.greengrassRole.addManagedPolicy(this.greengrassRolePolicy);
    this.greengrassRoleAlias = this.createRoleAlias();
    this.iotThingPolicy = this.createIotThingPolicy();

    this.allThingGroup = this.createThingGroup('all', this.stackName);
    this.nucleusThingGroup = this.createThingGroup('nucleus', `${this.stackName}-nucleus`);
    this.nucleusLiteThingGroup = this.createThingGroup('nucleus-lite', `${this.stackName}-nucleus-lite`);

    // All instances use the same EC2 role. It grants permissions for the Greengrass installer.
    this.instanceRole = this.createInstanceRole();

    const ami_windows_server_2025 = ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2025_ENGLISH_CORE_BASE);
    const ami_al2023_x86_64 = this.getAmazonLinuxAmi(ec2.AmazonLinuxCpuType.X86_64);
    const ami_al2023_arm_64 = this.getAmazonLinuxAmi(ec2.AmazonLinuxCpuType.ARM_64);
    const ami_ubuntu_pro_2604_x86_64 = this.getUbuntuProAmi('26.04', 'amd64');
    const ami_ubuntu_pro_2604_arm_64 = this.getUbuntuProAmi('26.04', 'arm64');

    // Windows first because it's slowest to come up
    this.createInstance('ws2025-x86-nucleus', ami_windows_server_2025, 'nucleus');
    this.createInstance('al2023-x86-nucleus', ami_al2023_x86_64, 'nucleus');
    this.createInstance('al2023-arm-nucleus', ami_al2023_arm_64, 'nucleus');
    this.createInstance('ub2604-x86-nucleus', ami_ubuntu_pro_2604_x86_64, 'nucleus');
    this.createInstance('ub2604-arm-nucleus', ami_ubuntu_pro_2604_arm_64, 'nucleus');
    this.createInstance('al2023-x86-nucleus-lite', ami_al2023_x86_64, 'nucleus-lite');
    this.createInstance('al2023-arm-nucleus-lite', ami_al2023_arm_64, 'nucleus-lite');
    this.createInstance('ub2604-x86-nucleus-lite', ami_ubuntu_pro_2604_x86_64, 'nucleus-lite');
    this.createInstance('ub2604-arm-nucleus-lite', ami_ubuntu_pro_2604_arm_64, 'nucleus-lite');

    new cdk.CfnOutput(this, 'Key Pair Name', { value: this.keyPair.keyPairName });
    new cdk.CfnOutput(this, 'Download Key Command', {
      value: `aws ssm get-parameter --name /ec2/keypair/${this.keyPair.keyPairId} --with-decryption --query Parameter.Value --output text > ${this.keyPair.keyPairName}.pem && chmod 400 ${this.keyPair.keyPairName}.pem`
    });
    new cdk.CfnOutput(this, 'Greengrass Core Device Role', { value: this.greengrassRole.roleName });

    // Custom Resource to manage IoT/Greengrass lifecycle (create deployment, clean up on delete)
    this.createLifecycleResource();
  }

  private createLifecycleResource(): void {
    const lifecycleFn = new NodejsFunction(this, `${this.stackName}LifecycleFunction`, {
      entry: 'lambda/lifecycle-handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      timeout: cdk.Duration.minutes(15),
      description: 'Manages IoT/Greengrass resource lifecycle on stack create and delete',
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    lifecycleFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        // Create actions
        'greengrass:CreateDeployment',
        'greengrass:ListComponentVersions',
        'iot:DescribeThingGroup',
        'iot:CreateJob',
        'iot:DescribeJob',
        // Delete actions
        'iot:ListThingsInThingGroup',
        'iot:ListThingPrincipals',
        'iot:ListAttachedPolicies',
        'iot:DetachPolicy',
        'iot:DetachThingPrincipal',
        'iot:UpdateCertificate',
        'iot:DeleteCertificate',
        'iot:DeleteThing',
        'iot:CancelJob',
        'iot:DeleteJob',
        'greengrass:DeleteCoreDevice',
        'greengrass:ListDeployments',
        'greengrass:CancelDeployment',
        'greengrass:DeleteDeployment',
      ],
      resources: ['*'],
    }));

    NagSuppressions.addResourceSuppressions(lifecycleFn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Lambda basic execution role is required for CloudWatch Logs.'
      }
    ], true)

    NagSuppressions.addResourceSuppressions(lifecycleFn, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'IoT and Greengrass lifecycle management requires broad resource access.'
      }
    ], true)

    cdk.Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-lambda-nodejs:variableRuntimeExternals',
      'Only @aws-sdk/* is externalized, which is guaranteed to be available in all Node.js Lambda runtimes.'
    );

    const provider = new cr.Provider(this, `${this.stackName}LifecycleProvider`, {
      onEventHandler: lifecycleFn,
    });

    NagSuppressions.addResourceSuppressions(provider, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Custom resource provider framework uses managed policies.'
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Custom resource provider framework requires broad permissions.'
      }
    ], true)

    const lifecycleResource = new cdk.CustomResource(this, `${this.stackName}LifecycleResource`, {
      serviceToken: provider.serviceToken,
      properties: {
        FarmName: this.stackName,
        NucleusThingGroupArn: this.nucleusThingGroup.attrArn,
        AllThingGroupArn: this.allThingGroup.attrArn,
        NucleusConfig: JSON.stringify({
          interpolateComponentConfiguration: 'true',
          greengrassDataPlaneEndpoint: 'iotdata',
        }),
      },
    });

    lifecycleResource.node.addDependency(this.iotThingPolicy);
    lifecycleResource.node.addDependency(this.greengrassRoleAlias);
  }

  private createVpc(): ec2.Vpc {
    const vpc = new ec2.Vpc(this, `${this.stackName}Vpc`, {
      maxAzs: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: `${this.stackName}Subnet`,
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    });

    NagSuppressions.addResourceSuppressions(vpc, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC flow logs would add to costs for these non-critical resources.'
      }
    ])

    // Exclude this VPC from VPC Block Public Access so instances can reach the internet
    new ec2.CfnVPCBlockPublicAccessExclusion(this, `${this.stackName}BpaExclusion`, {
      internetGatewayExclusionMode: 'allow-bidirectional',
      vpcId: vpc.vpcId,
    });

    return vpc;
  }

  private createKeyPair(): ec2.KeyPair {
    return new ec2.KeyPair(this, `${this.stackName}KeyPair`, {
      keyPairName: `${this.stackName}`,
    });
  }

  private createSecurityGroup(name: string): ec2.SecurityGroup {
    const securityGroup = new ec2.SecurityGroup(this, `${this.stackName}${name}SG`, {
      securityGroupName: `${this.stackName}${name}SG`,
      description: `Security group for ${this.stackName} ${name} instances`,
      vpc: this.vpc,
      allowAllOutbound: true
    });

    return securityGroup;
  }

  private createInstanceRole(): iam.Role {
    // Create a basic EC2 role
    const role = new iam.Role(this, `${this.stackName}EC2Role`, {
      roleName: `${this.stackName}EC2Role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')
    });

    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
  
    NagSuppressions.addResourceSuppressions(role, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Allow use of AmazonSSMManagedInstanceCore.'
      }
    ])

    // Create and add the permissions needed by the Greengrass manual provisioning
    // https://docs.aws.amazon.com/greengrass/v2/developerguide/manual-installation.html
    const minimalInstallerPolicy = new iam.Policy(this, `${this.stackName}InstallerPolicy`, {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'iot:AddThingToThingGroup',
            'iot:AttachPolicy',
            'iot:AttachThingPrincipal',
            'iot:CreateKeysAndCertificate',
            'iot:CreateThing',
            'iot:DescribeEndpoint'
          ],
          resources: ['*'],
          effect: iam.Effect.ALLOW
        })
      ]
    });

    NagSuppressions.addResourceSuppressions(minimalInstallerPolicy, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Resource wildcards as documented for the minimal provisioning policy.'
      }
    ])

    minimalInstallerPolicy.attachToRole(role);

    return role;
  }

  private createGreengrassTokenExchangeRole(): iam.Role {
    return new iam.Role(this, `${this.stackName}TokenExchangeRole`, {
      assumedBy: new iam.ServicePrincipal('credentials.iot.amazonaws.com'),
      roleName: `${this.stackName}TokenExchangeRole`
    });
  }

  private createGreengrassTokenExchangePolicy(): iam.ManagedPolicy {
    const policy = new iam.ManagedPolicy(this, `${this.stackName}TokenExchangeRoleAccess`, {
      managedPolicyName: `${this.stackName}TokenExchangeRoleAccess`,
      statements: [
        // Basic token exchange role for nucleus 2.5.0 and later.
        // https://docs.aws.amazon.com/greengrass/v2/developerguide/device-service-role.html#device-service-role-permissions
        new iam.PolicyStatement({
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogStreams',
            's3:GetBucketLocation',
          ],
          effect: iam.Effect.ALLOW,
          resources: ['*']
        }),
        // Allow access to S3 buckets for component artifacts (placeholder resource)
        // https://docs.aws.amazon.com/greengrass/v2/developerguide/device-service-role.html#device-service-role-access-s3-bucket
        new iam.PolicyStatement({
          actions: [
            's3:GetObject'
          ],
          effect: iam.Effect.ALLOW,
          resources: ['arn:aws:s3:::DOC-EXAMPLE-BUCKET/*']
        })
      ]
    });

    NagSuppressions.addResourceSuppressions(policy, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Resource wildcard is what automatic provisioning would otherwise create.'
      }
    ])

    return policy;
  }

  private createRoleAlias(): iot.CfnRoleAlias {
    return new iot.CfnRoleAlias(this, `${this.stackName}RoleAlias`, {
      roleAlias: `${this.stackName}TokenExchangeRoleAlias`,
      roleArn: this.greengrassRole.roleArn,
    });
  }

  private createIotThingPolicy(): iot.CfnPolicy {
    const roleAliasArn = cdk.Stack.of(this).formatArn({
      service: 'iot',
      resource: 'rolealias',
      resourceName: this.greengrassRoleAlias.roleAlias!,
    });

    const policy = new iot.CfnPolicy(this, `${this.stackName}IotThingPolicy`, {
      policyName: this.stackName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'iot:Connect',
              'iot:Publish',
              'iot:Subscribe',
              'iot:Receive',
              'greengrass:*',
            ],
            Resource: '*',
          },
          {
            Effect: 'Allow',
            Action: 'iot:AssumeRoleWithCertificate',
            Resource: roleAliasArn,
          },
        ],
      },
    });

    // The role alias must exist before the policy references its ARN.
    policy.addResourceDependency(this.greengrassRoleAlias);

    return policy;
  }

  private createThingGroup(idSuffix: string, thingGroupName: string): iot.CfnThingGroup {
    return new iot.CfnThingGroup(this, `${this.stackName}ThingGroup-${idSuffix}`, {
      thingGroupName: thingGroupName,
    });
  }

  private getAmazonLinuxAmi(cpuType: ec2.AmazonLinuxCpuType): ec2.IMachineImage {
    return ec2.MachineImage.latestAmazonLinux2023({
      cpuType: cpuType
    });
  }

  private getUbuntuProAmi(release: string, arch: string): ec2.IMachineImage {
    return ec2.MachineImage.fromSsmParameter(
      `/aws/service/canonical/ubuntu/pro-server/${release}/stable/current/${arch}/hvm/ebs-gp3/ami-id`, {
        os: ec2.OperatingSystemType.LINUX
      }
    );
  }

  private createInstance(name: string, ami: ec2.IMachineImage, runtime: GreengrassRuntime) {
    const isWindows = name.includes('ws2025');
    const isLite = runtime === 'nucleus-lite';
    const instanceType = name.includes('arm') ? ec2.InstanceClass.T4G : ec2.InstanceClass.T3;
    const instanceSize = isWindows ? ec2.InstanceSize.MEDIUM
      : isLite ? ec2.InstanceSize.MICRO
      : ec2.InstanceSize.SMALL;
    const securityGroup = isWindows ? this.windowsSecurityGroup : this.linuxSecurityGroup;
    // Set volume sizes and root device names that match the AMI defaults
    const volumeSize = isWindows ? 30 : 8;
    const rootDeviceName = name.includes('al2023') ? '/dev/xvda' : '/dev/sda1';

    const runtimeThingGroupName = isLite
      ? this.nucleusLiteThingGroup.thingGroupName!
      : this.nucleusThingGroup.thingGroupName!;

    const ec2Instance = new ec2.Instance(this, `${this.stackName}-${name}`, {
      instanceName: `${this.stackName}-${name}`,
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(instanceType, instanceSize),
      machineImage: ami,
      securityGroup: securityGroup,
      keyPair: this.keyPair,
      role: this.instanceRole,
      userData: this.createUserData(`${this.stackName}-${name}`, runtime, runtimeThingGroupName),
      // Override the AMI root device name to enable encryption for the root device (for AwsSolutions-EC26)
      blockDevices: [{
        deviceName: rootDeviceName,
        volume: ec2.BlockDeviceVolume.ebs(volumeSize, {
          encrypted: true
        })
      }]
    });

    NagSuppressions.addResourceSuppressions(ec2Instance, [
      {
        id: 'AwsSolutions-EC28',
        reason: 'Detailed monitoring would add to costs for these non-critical instances.'
      },
      {
        id: 'AwsSolutions-EC29',
        reason: 'No ASG or termination protection needed for these non-critical instances.'
      }
    ])

    new cdk.CfnOutput(this, `${name} IP Address`, { value: ec2Instance.instancePublicIp });
  }

  // ===========================================================================================
  //  Each instance's user data is composed from the fragments below
  // ===========================================================================================

  // A bash retry() helper used by all Linux user data to ride out transient package-manager
  // lock/metadata failures during boot.
  private static readonly retryFn = `\
retry() {
  local n=0
  until "\$@"; do
    n=\$((n + 1))
    if [ "\$n" -ge 10 ]; then
      echo "Command failed after \$n attempts: \$*" >&2
      return 1
    fi
    echo "Attempt \$n failed: \$* -- retrying in 15s" >&2
    sleep 15
  done
}`;

  // Ubuntu apt preamble: boot-time apt patching (unattended-upgrades / apt-daily) starts within
  // a second and holds the apt lists lock for minutes. Pause it.
  private static readonly aptPreamble = `\
export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-o DPkg::Lock::Timeout=300 -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30"
systemctl stop unattended-upgrades.service apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
systemctl stop apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
wait_apt_lock() {
  local waited=0
  while fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    if [ "\$waited" -ge 300 ]; then
      echo "Timed out waiting for apt locks to be released" >&2
      break
    fi
    echo "Waiting for apt locks to be released..." >&2
    sleep 5
    waited=\$((waited + 5))
  done
}`;

  // The shared Linux IoT provisioning sequence.
  private iotProvisionLinux(
    instanceName: string, runtimeThingGroupName: string, certDir: string
  ): string {
    const region = this.region;
    const allThingGroupName = this.stackName;
    const policyName = this.iotThingPolicy.policyName!;
    return `\
DATA_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region ${region} --query endpointAddress --output text)
CRED_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:CredentialProvider --region ${region} --query endpointAddress --output text)

aws iot create-thing --thing-name ${instanceName} --region ${region}

CERT_ARN=$(aws iot create-keys-and-certificate --set-as-active --region ${region} \\
  --certificate-pem-outfile "${certDir}/device.pem.crt" \\
  --public-key-outfile "${certDir}/public.pem.key" \\
  --private-key-outfile "${certDir}/private.pem.key" \\
  --query certificateArn --output text)
chmod 600 "${certDir}/private.pem.key"

curl -fsSL https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "${certDir}/AmazonRootCA1.pem"

aws iot attach-thing-principal --thing-name ${instanceName} --principal "\${CERT_ARN}" --thing-principal-type EXCLUSIVE_THING --region ${region}
aws iot attach-policy --policy-name ${policyName} --target "\${CERT_ARN}" --region ${region}

aws iot add-thing-to-thing-group --thing-name ${instanceName} --thing-group-name ${allThingGroupName} --region ${region}
aws iot add-thing-to-thing-group --thing-name ${instanceName} --thing-group-name ${runtimeThingGroupName} --region ${region}`;
  }

  private dockerInstallAmazonLinux(componentUser: string): string {
    return `\
retry dnf install -y docker
service docker start
systemctl enable docker
curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
mkdir -p /usr/local/lib/docker/cli-plugins
cp /usr/local/bin/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
usermod -aG docker ec2-user
usermod -aG docker ${componentUser}`;
  }

  private dockerInstallUbuntu(componentUser: string): string {
    return `\
retry apt-get \${APT_OPTS} install -y ca-certificates curl gnupg lsb-release
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
retry apt-get \${APT_OPTS} update
retry apt-get \${APT_OPTS} install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
curl -fL https://raw.githubusercontent.com/docker/compose-switch/master/install_on_linux.sh | sh
usermod -aG docker ubuntu
usermod -aG docker ${componentUser}
# Re-enable the boot-time apt patching timers paused during provisioning so the instance
# auto-patches over its lifetime (on the normal daily schedule).
systemctl start apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true`;
  }

  private nucleusInstallDepsAmazonLinux(): string {
    return `\
#!/bin/bash
set -euxo pipefail
# A background 'dnf makecache' timer can run at boot and briefly hold the dnf lock (or
# invalidate metadata) while our install runs. Retry each transient package operation.
${GreengrassEC2DeviceFarmStack.retryFn}
retry yum update -y
retry yum install -y java
# Install tools needed to build wheels for some components (like Device Defender)
retry yum install -y gcc python3-devel
echo "root ALL=(ALL:ALL) ALL" > /etc/sudoers.d/gg-root-runas-all`;
  }

  private nucleusInstallDepsUbuntu(): string {
    return `\
#!/bin/bash
set -euxo pipefail
${GreengrassEC2DeviceFarmStack.aptPreamble}
${GreengrassEC2DeviceFarmStack.retryFn}
wait_apt_lock
retry apt-get \${APT_OPTS} update
retry apt-get \${APT_OPTS} install -y default-jre-headless unzip python3-pip python3-venv awscli
# Ubuntu 26.04+ ships sudo-rs as the default sudo, which does not support the -E flag
# used by the Greengrass nucleus. The classic sudo is provided by the "sudo" package.
retry apt-get \${APT_OPTS} install -y sudo
update-alternatives --set sudo /usr/bin/sudo.ws`;
  }

  private nucleusProvisionAndConfigureLinux(instanceName: string, runtimeThingGroupName: string): string {
    const region = this.region;
    const roleAliasName = this.greengrassRoleAlias.roleAlias!;
    return `\
GG_ROOT="/greengrass/v2"
mkdir -p "\${GG_ROOT}" GreengrassInstaller

${this.iotProvisionLinux(instanceName, runtimeThingGroupName, '${GG_ROOT}')}

cat > GreengrassInstaller/config.yaml <<EOF
---
system:
  certificateFilePath: "\${GG_ROOT}/device.pem.crt"
  privateKeyPath: "\${GG_ROOT}/private.pem.key"
  rootCaPath: "\${GG_ROOT}/AmazonRootCA1.pem"
  rootpath: "\${GG_ROOT}"
  thingName: "${instanceName}"
services:
  aws.greengrass.Nucleus:
    componentType: "NUCLEUS"
    configuration:
      awsRegion: "${region}"
      iotRoleAlias: "${roleAliasName}"
      iotDataEndpoint: "\${DATA_ENDPOINT}"
      iotCredEndpoint: "\${CRED_ENDPOINT}"
EOF`;
  }

  private static readonly nucleusInstallRuntimeLinux = `\
curl -s https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-nucleus-latest.zip > greengrass-nucleus-latest.zip
unzip -o greengrass-nucleus-latest.zip -d GreengrassInstaller
java -Droot="/greengrass/v2" -Dlog.store=FILE \\
  -jar ./GreengrassInstaller/lib/Greengrass.jar \\
  --init-config ./GreengrassInstaller/config.yaml \\
  --component-default-user ggc_user:ggc_group \\
  --provision false --setup-system-service true`;

  private static readonly nucleusInstallDepsWindows = `\
<powershell>
$ErrorActionPreference = "Stop"
cd ~
iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))
choco install -y python3 --version=3.11.8
choco install -y awscli
choco install -y openjdk --version=20.0.2
$ENV:PATH="$ENV:PATH;C:\\Python311;C:\\Program Files\\Amazon\\AWSCLIV2;C:\\Program Files\\OpenJDK\\jdk-20.0.2\\bin"
$env:PASSWORD = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 12 | % {[char]$_})
net user /add ggc_user $env:PASSWORD
wmic UserAccount where "Name='ggc_user'" set PasswordExpires=False
choco install -y psexec
psexec /accepteula -s cmd /c cmdkey /generic:ggc_user /user:ggc_user /pass:$env:PASSWORD
choco uninstall -y psexec`;

  private nucleusProvisionAndInstallRuntimeWindows(instanceName: string, runtimeThingGroupName: string): string {
    const region = this.region;
    const allThingGroupName = this.stackName;
    const policyName = this.iotThingPolicy.policyName!;
    const roleAliasName = this.greengrassRoleAlias.roleAlias!;
    return `\
$GG_ROOT = "C:\\greengrass\\v2"
New-Item -ItemType Directory -Force -Path $GG_ROOT | Out-Null
New-Item -ItemType Directory -Force -Path .\\GreengrassInstaller | Out-Null

$DATA_ENDPOINT = (aws iot describe-endpoint --endpoint-type iot:Data-ATS --region ${region} --query endpointAddress --output text)
$CRED_ENDPOINT = (aws iot describe-endpoint --endpoint-type iot:CredentialProvider --region ${region} --query endpointAddress --output text)

aws iot create-thing --thing-name ${instanceName} --region ${region}

$CERT_ARN = (aws iot create-keys-and-certificate --set-as-active --region ${region} \`
  --certificate-pem-outfile "$GG_ROOT\\device.pem.crt" \`
  --public-key-outfile "$GG_ROOT\\public.pem.key" \`
  --private-key-outfile "$GG_ROOT\\private.pem.key" \`
  --query certificateArn --output text)

Invoke-WebRequest -UseBasicParsing "https://www.amazontrust.com/repository/AmazonRootCA1.pem" -OutFile "$GG_ROOT\\AmazonRootCA1.pem"

aws iot attach-thing-principal --thing-name ${instanceName} --principal "$CERT_ARN" --thing-principal-type EXCLUSIVE_THING --region ${region}
aws iot attach-policy --policy-name ${policyName} --target "$CERT_ARN" --region ${region}

aws iot add-thing-to-thing-group --thing-name ${instanceName} --thing-group-name ${allThingGroupName} --region ${region}
aws iot add-thing-to-thing-group --thing-name ${instanceName} --thing-group-name ${runtimeThingGroupName} --region ${region}

$CONFIG = @"
---
system:
  certificateFilePath: '$GG_ROOT\\device.pem.crt'
  privateKeyPath: '$GG_ROOT\\private.pem.key'
  rootCaPath: '$GG_ROOT\\AmazonRootCA1.pem'
  rootpath: '$GG_ROOT'
  thingName: "${instanceName}"
services:
  aws.greengrass.Nucleus:
    componentType: "NUCLEUS"
    configuration:
      awsRegion: "${region}"
      iotRoleAlias: "${roleAliasName}"
      iotDataEndpoint: "$DATA_ENDPOINT"
      iotCredEndpoint: "$CRED_ENDPOINT"
"@
Set-Content -Path .\\GreengrassInstaller\\config.yaml -Value $CONFIG -Encoding ascii

Invoke-WebRequest -UseBasicParsing "https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-nucleus-latest.zip" -o greengrass-nucleus-latest.zip
tar -xf greengrass-nucleus-latest.zip -C GreengrassInstaller
java -Droot="C:\\greengrass\\v2" "-Dlog.store=FILE" \`
  -jar ./GreengrassInstaller/lib/Greengrass.jar \`
  --init-config ./GreengrassInstaller/config.yaml \`
  --component-default-user ggc_user \`
  --provision false --setup-system-service true`;
  }

  private static readonly nucleusLiteBuildDepsAmazonLinux = `\
#!/bin/bash
set -euxo pipefail
${GreengrassEC2DeviceFarmStack.retryFn}
retry dnf update -y
# Toolchain and nucleus lite build dependencies (Amazon Linux 2023 / dnf package names).
# uriparser is not packaged for AL2023 (built from source below). curl is omitted because
# AL2023 preinstalls curl-minimal, which the full curl package conflicts with.
retry dnf install -y gcc gcc-c++ make cmake git tar \\
  pkgconf-pkg-config openssl-devel libcurl-devel libuuid-devel libzip-devel \\
  sqlite-devel libyaml-devel systemd-devel libevent-devel \\
  libcgroup-tools awscli
# Build liburiparser from source (>=0.9.6 required by nucleus lite) and install to
# /usr/local so pkg-config/CMake find it during the gg-lite build. AL2023 has no
# uriparser package; upstream gg-lite only packages for Debian (.deb) and Nix.
URIPARSER_TAG="uriparser-1.0.2"
URIPARSER_SRC="/opt/uriparser"
rm -rf "\${URIPARSER_SRC}"
retry git clone --depth 1 --branch "\${URIPARSER_TAG}" https://github.com/uriparser/uriparser.git "\${URIPARSER_SRC}"
cmake -S "\${URIPARSER_SRC}" -B "\${URIPARSER_SRC}/build" \\
  -D CMAKE_BUILD_TYPE=Release \\
  -D URIPARSER_BUILD_DOCS=OFF \\
  -D URIPARSER_BUILD_TESTS=OFF \\
  -D URIPARSER_BUILD_TOOLS=OFF
make -C "\${URIPARSER_SRC}/build" -j"$(nproc)"
make -C "\${URIPARSER_SRC}/build" install
ldconfig`;

  private static readonly nucleusLiteBuildDepsUbuntu = `\
#!/bin/bash
set -euxo pipefail
${GreengrassEC2DeviceFarmStack.aptPreamble}
${GreengrassEC2DeviceFarmStack.retryFn}
wait_apt_lock
retry apt-get \${APT_OPTS} update
# Toolchain and nucleus lite build dependencies (from the build guide) plus awscli.
retry apt-get \${APT_OPTS} install -y build-essential pkg-config cmake git curl \\
  libssl-dev libcurl4-openssl-dev uuid-dev libzip-dev libsqlite3-dev libyaml-dev \\
  libsystemd-dev libevent-dev liburiparser-dev cgroup-tools awscli`;

  private nucleusLiteProvisionAndBuildRuntime(instanceName: string, runtimeThingGroupName: string): string {
    const region = this.region;
    const roleAliasName = this.greengrassRoleAlias.roleAlias!;
    return `\
GG_ROOT="/var/lib/greengrass"
GG_CONFIG="/etc/greengrass"
CERT_DIR="\${GG_ROOT}/credentials"
mkdir -p "\${CERT_DIR}" "\${GG_CONFIG}" "\${GG_CONFIG}/config.d"

# Service user/group for the nucleus lite systemd services, and component user/group.
getent group ggcore >/dev/null 2>&1 || groupadd -r ggcore
getent passwd ggcore >/dev/null 2>&1 || useradd -r -g ggcore -s /usr/sbin/nologin ggcore
getent group gg_component >/dev/null 2>&1 || groupadd -r gg_component
getent passwd gg_component >/dev/null 2>&1 || useradd -r -g gg_component -s /usr/sbin/nologin gg_component

${this.iotProvisionLinux(instanceName, runtimeThingGroupName, '${CERT_DIR}')}

# Build and install nucleus lite from source at the latest released tag.
GGL_SRC="/opt/aws-greengrass-lite"
# Fetch before parsing; piping curl into grep -m1 can make curl exit 23 and trip pipefail.
RELEASE_JSON=$(curl -fsSL https://api.github.com/repos/aws-greengrass/aws-greengrass-lite/releases/latest)
LATEST_TAG=$(printf '%s' "\${RELEASE_JSON}" | sed -E -n 's/.*"tag_name": *"([^"]+)".*/\\1/p' | head -n1)
echo "Building nucleus lite from tag \${LATEST_TAG}"
rm -rf "\${GGL_SRC}"
git clone --depth 1 --branch "\${LATEST_TAG}" https://github.com/aws-greengrass/aws-greengrass-lite.git "\${GGL_SRC}"
cd "\${GGL_SRC}"
cmake -B build \\
  -D CMAKE_BUILD_TYPE=MinSizeRel \\
  -D GGL_SYSTEMD_SYSTEM_USER=ggcore \\
  -D GGL_SYSTEMD_SYSTEM_GROUP=ggcore
make -C build -j"$(nproc)"
make -C build install
cd -

# The Greengrass root path must be owned by the service user/group.
chown -R ggcore:ggcore "\${GG_ROOT}"

cat > "\${GG_CONFIG}/config.yaml" <<EOF
---
system:
  privateKeyPath: "\${CERT_DIR}/private.pem.key"
  certificateFilePath: "\${CERT_DIR}/device.pem.crt"
  rootCaPath: "\${CERT_DIR}/AmazonRootCA1.pem"
  rootPath: "\${GG_ROOT}"
  thingName: "${instanceName}"
services:
  aws.greengrass.NucleusLite:
    componentType: "NUCLEUS"
    configuration:
      awsRegion: "${region}"
      iotCredEndpoint: "\${CRED_ENDPOINT}"
      iotDataEndpoint: "\${DATA_ENDPOINT}"
      iotRoleAlias: "${roleAliasName}"
      runWithDefault:
        posixUser: "gg_component:gg_component"
      greengrassDataPlanePort: "8443"
EOF

# Force a re-read of the YAML config on next start.
rm -f "\${GG_ROOT}/config.db"

# The config must be readable by the service user/group (ggcore). The Greengrass root
# path (including the credentials dir) is already owned by ggcore above.
chown root:ggcore "\${GG_CONFIG}" "\${GG_CONFIG}/config.d" "\${GG_CONFIG}/config.yaml"
chmod 750 "\${GG_CONFIG}" "\${GG_CONFIG}/config.d"
chmod 640 "\${GG_CONFIG}/config.yaml"

# Enable and start all nucleus lite services. run_nucleus enables the target AND every
# individual ggl.* socket and service, then starts the target. Enabling only the target
# leaves it with no members, so the services (including iotcored) never run.
"\${GGL_SRC}/misc/run_nucleus"`;
  }

  private createUserData(instanceName: string, runtime: GreengrassRuntime, runtimeThingGroupName: string) : ec2.UserData {
    const isLite = runtime === 'nucleus-lite';
    const isAmazonLinux = instanceName.includes('al2023');

    let userData: string;

    if (instanceName.includes('ws2025')) {
      userData = `${GreengrassEC2DeviceFarmStack.nucleusInstallDepsWindows}\n`
        + `${this.nucleusProvisionAndInstallRuntimeWindows(instanceName, runtimeThingGroupName)}\n`
        + `</powershell>`;
    } else if (isLite) {
      const buildDeps = isAmazonLinux
        ? GreengrassEC2DeviceFarmStack.nucleusLiteBuildDepsAmazonLinux
        : GreengrassEC2DeviceFarmStack.nucleusLiteBuildDepsUbuntu;
      const dockerInstall = isAmazonLinux
        ? this.dockerInstallAmazonLinux('gg_component')
        : this.dockerInstallUbuntu('gg_component');
      userData = `${buildDeps}\n`
        + `${this.nucleusLiteProvisionAndBuildRuntime(instanceName, runtimeThingGroupName)}\n`
        + `${dockerInstall}`;
    } else {
      const installDeps = isAmazonLinux ? this.nucleusInstallDepsAmazonLinux() : this.nucleusInstallDepsUbuntu();
      const dockerInstall = isAmazonLinux
        ? this.dockerInstallAmazonLinux('ggc_user')
        : this.dockerInstallUbuntu('ggc_user');
      userData = `${installDeps}\n`
        + `${this.nucleusProvisionAndConfigureLinux(instanceName, runtimeThingGroupName)}\n`
        + `${GreengrassEC2DeviceFarmStack.nucleusInstallRuntimeLinux}\n`
        + `${dockerInstall}`;
    }

    return ec2.UserData.custom(userData);
  }
}
