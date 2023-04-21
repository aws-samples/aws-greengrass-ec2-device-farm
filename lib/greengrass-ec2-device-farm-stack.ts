// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag'

export class GreengrassEC2DeviceFarmStack extends cdk.Stack {

  linuxSecurityGroup: ec2.SecurityGroup;
  windowsSecurityGroup: ec2.SecurityGroup;
  vpc: cdk.aws_ec2.IVpc;
  instanceRole: iam.Role;
  greengrassRole: iam.Role;
  greengrassPolicy: iam.ManagedPolicy;
  keyPair: ec2.CfnKeyPair;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = this.createVpc();
    
    this.keyPair = this.createKeyPair();

    this.linuxSecurityGroup = this.createSecurityGroup('Linux');
    this.windowsSecurityGroup = this.createSecurityGroup('Windows');

    this.greengrassRole = this.createGreengrassTokenExchangeRole();
    this.greengrassPolicy = this.createGreengrassTokenExchangePolicy();
    this.greengrassRole.addManagedPolicy(this.greengrassPolicy);

    // All instances use the same EC2 role. It grants permissions for the Greengrass installer.
    this.instanceRole = this.createInstanceRole();

    const ami_windows_server_2022 = ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_CORE_BASE);
    const ami_windows_server_2019 = ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2019_ENGLISH_CORE_BASE);
    const ami_al2_x86_64 = this.getAmazonLinuxAmi(ec2.AmazonLinuxCpuType.X86_64);
    const ami_al2_arm_64 = this.getAmazonLinuxAmi(ec2.AmazonLinuxCpuType.ARM_64);
    const ami_ubuntu_2204_x86_64 = this.getUbuntuAmi('22.04', 'amd64');
    const ami_ubuntu_2204_arm_64 = this.getUbuntuAmi('22.04', 'arm64');
    const ami_ubuntu_2004_x86_64 = this.getUbuntuAmi('20.04', 'amd64');
    const ami_ubuntu_2004_arm_64 = this.getUbuntuAmi('20.04', 'arm64');

    // Windows first because it's slowest to come up
    this.createInstance('windows-server-2022', ami_windows_server_2022);
    this.createInstance('windows-server-2019', ami_windows_server_2019);
    this.createInstance('al2-x86-64', ami_al2_x86_64);
    this.createInstance('al2-arm-64', ami_al2_arm_64);
    this.createInstance('ubuntu-22-04-x86-64', ami_ubuntu_2204_x86_64);
    this.createInstance('ubuntu-22-04-arm-64', ami_ubuntu_2204_arm_64);
    this.createInstance('ubuntu-20-04-x86-64', ami_ubuntu_2004_x86_64);
    this.createInstance('ubuntu-20-04-arm-64', ami_ubuntu_2004_arm_64);

    new cdk.CfnOutput(this, 'Key Pair Name', { value: this.keyPair.keyName });
    new cdk.CfnOutput(this, 'Download Key Command', {
      value: `aws ssm get-parameter --name /ec2/keypair/${this.keyPair.attrKeyPairId} --with-decryption --query Parameter.Value --output text > ${this.keyPair.keyName}.pem && chmod 400 ${this.keyPair.keyName}.pem`
    });
    new cdk.CfnOutput(this, 'Greengrass Core Device Role', { value: this.greengrassRole.roleName });
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

    return vpc;
  }

  private createKeyPair(): ec2.CfnKeyPair {
    return new ec2.CfnKeyPair(this, `${this.stackName}KeyPair`, {
      keyName: `${this.stackName}`,
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

    // Create and add the permissions needed by the Greengrass automatic provisioning.
    // https://docs.aws.amazon.com/greengrass/v2/developerguide/provision-minimal-iam-policy.html
    const minimalInstallerPolicy = new iam.Policy(this, `${this.stackName}InstallerPolicy`, {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'iam:AttachRolePolicy',
            'iam:CreatePolicy',
            'iam:CreateRole',
            'iam:GetPolicy',
            'iam:GetRole',
            'iam:PassRole'
          ],
          resources: [`${this.greengrassRole.roleArn}`, `${this.greengrassPolicy.managedPolicyArn}`],
          effect: iam.Effect.ALLOW
        }),
        new iam.PolicyStatement({
          actions: [
            'iot:AddThingToThingGroup',
            'iot:AttachPolicy',
            'iot:AttachThingPrincipal',
            'iot:CreateKeysAndCertificate',
            'iot:CreatePolicy',
            'iot:CreateRoleAlias',
            'iot:CreateThing',
            'iot:CreateThingGroup',
            'iot:DescribeEndpoint',
            'iot:DescribeRoleAlias',
            'iot:DescribeThingGroup',
            'iot:GetPolicy'
          ],
          resources: ['*'],
          effect: iam.Effect.ALLOW
        }),
        new iam.PolicyStatement({
          actions: [
            'greengrass:CreateDeployment',
            'iot:CancelJob',
            'iot:CreateJob',
            'iot:DeleteThingShadow',
            'iot:DescribeJob',
            'iot:DescribeThing',
            'iot:DescribeThingGroup',
            'iot:GetThingShadow',
            'iot:UpdateJob',
            'iot:UpdateThingShadow'
          ],
          effect: iam.Effect.ALLOW,
          resources: ['*']
        })
      ]
    });

    NagSuppressions.addResourceSuppressions(minimalInstallerPolicy, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Resource wildcards as documented for the minimal automatic provisioning policy.'
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
        // Basic token exchange role for Nucleus 2.5.0 and later.
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

  private getAmazonLinuxAmi(cpuType: ec2.AmazonLinuxCpuType): ec2.IMachineImage {
    return ec2.MachineImage.latestAmazonLinux({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      cpuType: cpuType
    });
  }

  private getUbuntuAmi(release: string, arch: string): ec2.IMachineImage {
    return ec2.MachineImage.fromSsmParameter(
      `/aws/service/canonical/ubuntu/server/${release}/stable/current/${arch}/hvm/ebs-gp2/ami-id`, {
        os: ec2.OperatingSystemType.LINUX
      }
    );
  }

  private createInstance(name: string, ami: ec2.IMachineImage) {
    const instanceType = name.includes('arm') ? ec2.InstanceClass.T4G : ec2.InstanceClass.T3;
    const instanceSize = name.includes('windows') ? ec2.InstanceSize.SMALL : ec2.InstanceSize.MICRO;
    const securityGroup = name.includes('windows') ? this.windowsSecurityGroup : this.linuxSecurityGroup;

    const ec2Instance = new ec2.Instance(this, `${this.stackName}-${name}`, {
      instanceName: `${this.stackName}-${name}`,
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(instanceType, instanceSize),
      machineImage: ami,
      securityGroup: securityGroup,
      keyName: this.keyPair.keyName,
      role: this.instanceRole,
      userData: this.createUserData(`${this.stackName}-${name}`)
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

  private createUserData(instanceName: string) : ec2.UserData {
    const baseInstallAmazonLinux = `\
#!/bin/bash
yum update -y
yum install -y java
# Install tools needed to build wheels for some components (like Device Defender)
yum install -y gcc python3-devel
echo "root ALL=(ALL:ALL) ALL" > /etc/sudoers.d/gg-root-runas-all`;
    const baseInstallUbuntu = `\
#!/bin/bash
apt update
apt install -y default-jre unzip python3-pip python3-venv`;
    const baseInstallWindows = `\
<powershell>
cd ~
iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))
choco install -y python3 --version=3.9.0
choco install -y awscli
choco install -y openjdk --version=19.0
$ENV:PATH="$ENV:PATH;C:\\Python39;C:\\Program Files\\Amazon\\AWSCLIV2;C:\\Program Files\\OpenJDK\\jdk-19\\bin"
$env:PASSWORD = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 12 | % {[char]$_})
net user /add ggc_user $env:PASSWORD
wmic UserAccount where "Name='ggc_user'" set PasswordExpires=False
choco install -y psexec
psexec /accepteula -s cmd /c cmdkey /generic:ggc_user /user:ggc_user /pass:$env:PASSWORD
choco uninstall -y psexec`;
    const ggInstallLinux = `\
curl -s https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-nucleus-latest.zip > greengrass-nucleus-latest.zip
unzip greengrass-nucleus-latest.zip -d GreengrassInstaller
java -Droot="/greengrass/v2" -Dlog.store=FILE -jar`;
    const ggInstallWindows = `\
Invoke-WebRequest -UseBasicParsing "https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-nucleus-latest.zip" -o greengrass-nucleus-latest.zip
mkdir GreengrassInstaller
tar -xf greengrass-nucleus-latest.zip -C GreengrassInstaller
java -Droot="C:\\greengrass\\v2" "-Dlog.store=FILE"`;
    const ggOptions = `\
-jar ./GreengrassInstaller/lib/Greengrass.jar \
--aws-region ${this.region} --thing-name ${instanceName} --thing-group-name ${this.stackName} \
--thing-policy-name ${this.stackName} --tes-role-name ${this.greengrassRole.roleName} \
--tes-role-alias-name ${this.greengrassRole.roleName}Alias \
--provision true --setup-system-service true --deploy-dev-tools true`;
    const ggCodaLinux = '--component-default-user ggc_user:ggc_group';
    const ggCodaWindows = '--component-default-user ggc_user';
    const dockerInstallAmazonLinux = `\
amazon-linux-extras install docker
service docker start
systemctl enable docker
curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
usermod -aG docker ec2-user
usermod -aG docker ggc_user
newgrp docker`;
    const dockerInstallUbuntu = `\
apt install -y ca-certificates curl gnupg lsb-release
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
curl -fL https://raw.githubusercontent.com/docker/compose-switch/master/install_on_linux.sh | sh
usermod -aG docker ubuntu
usermod -aG docker ggc_user
newgrp docker`;

    var userData: string;

    if (instanceName.includes('windows')) {
      userData = `${baseInstallWindows}\n${ggInstallWindows} ${ggOptions} ${ggCodaWindows}\n</powershell>`;
    } else {
      const baseInstall = instanceName.includes('al2') ? baseInstallAmazonLinux : baseInstallUbuntu;
      const dockerInstall = instanceName.includes('al2') ? dockerInstallAmazonLinux : dockerInstallUbuntu;
      userData = `${baseInstall}\n${ggInstallLinux} ${ggOptions} ${ggCodaLinux}\n${dockerInstall}`;
    }

    return ec2.UserData.custom(userData);
  }
}
