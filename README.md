# Greengrass EC2 Device Farm for component testing

This [AWS Cloud Development Kit (CDK v2)](https://docs.aws.amazon.com/cdk/v2/guide/home.html) application deploys a heterogeneous test fleet of [AWS IoT Greengrass](https://docs.aws.amazon.com/greengrass/v2/developerguide/what-is-iot-greengrass.html) core devices as instances in EC2. The aim is to provide a fleet of Greengrass devices with disparate operating systems and machine architectures to support development and testing of [Greengrass components](https://docs.aws.amazon.com/greengrass/v2/developerguide/develop-greengrass-components.html) in non-production environments.

# Instances

The fleet of instances deployed is as follows.

| Operating System        | Architecture    | Type       | Greengrass runtime |
| ----------------------- | --------------- | ---------- | ------------------ |
| Amazon Linux 2023       | x86_64  (amd64) | t3.small   | Nucleus (Java)     |
| Amazon Linux 2023       | aarch64 (arm64) | t4g.small  | Nucleus (Java)     |
| Ubuntu Pro 26.04 LTS    | x86_64  (amd64) | t3.small   | Nucleus (Java)     |
| Ubuntu Pro 26.04 LTS    | aarch64 (arm64) | t4g.small  | Nucleus (Java)     |
| Windows Server 2025     | x86_64  (amd64) | t3.medium  | Nucleus (Java)     |
| Amazon Linux 2023       | x86_64  (amd64) | t3.micro   | Nucleus lite (C)   |
| Amazon Linux 2023       | aarch64 (arm64) | t4g.micro  | Nucleus lite (C)   |
| Ubuntu Pro 26.04 LTS    | x86_64  (amd64) | t3.micro   | Nucleus lite (C)   |
| Ubuntu Pro 26.04 LTS    | aarch64 (arm64) | t4g.micro  | Nucleus lite (C)   |

For each instance, Greengrass is [installed with manual resource provisioning](https://docs.aws.amazon.com/greengrass/v2/developerguide/manual-installation.html) via instance user data. The nucleus lite instances additionally build [Greengrass nucleus lite](https://github.com/aws-greengrass/aws-greengrass-lite) from source at the latest released tag.

Each Linux instance has an 8GB EBS volume and each Windows instance has a 30GB EBS volume.

## Connecting to instances

To debug your Greengrass components, it's necessary to be able to access Greengrass logs on each core device. Amazon EC2 offers many connection options, including:

| Linux instances | Windows instances |
| --------------- | ----------------- |
| [AWS Systems Manager Session Manager](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/session-manager.htmlhttps://docs.aws.amazon.com/AWSEC2/latest/UserGuide/session-manager.html) | [AWS Systems Manager Session Manager](https://docs.aws.amazon.com/AWSEC2/latest/WindowsGuide/connecting_to_windows_instance.html#session-manager) |
| [SSH](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/AccessingInstancesLinux.html) | [RDP](https://docs.aws.amazon.com/AWSEC2/latest/WindowsGuide/connecting_to_windows_instance.html#connect-rdp) |
| [EC2 Instance Connect](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-methods.html) | [Fleet Manager](https://docs.aws.amazon.com/AWSEC2/latest/WindowsGuide/connecting_to_windows_instance.html#connect-rdp-fleet-manager) |

By default, each instance in the Greengrass EC2 Device Farm is only accessible using AWS Systems Manager Session Manager.

However, each instance is deployed with a public IP address and with a shared EC2 key pair named **GreengrassEC2DeviceFarm**. The CDK application outputs instructions on how to download the private key.

Accordingly, if you choose to open the appropriate ports, Linux instances can be accessed using SSH (or EC2 Instance Connect) and Windows instances can be accessed using RDP (or Fleet Manager).

Linux instances are deployed in a security group named **GreengrassEC2DeviceFarmLinuxSG**. Open inbound port 22 to enable SSH client access (or EC2 Instance Connect).

Windows instances are deployed in a security group named **GreengrassEC2DeviceFarmWindowsSG**. Open inbound port 3389 to enable RDP client access (or Fleet Manager).

## Costs

Costs vary per region and are subject to change. Please consult latest pricing information for your region. Please consider to stop instances, when not actively using them, to minimize costs.

# How to

How to deploy the fleet.

## Prerequisites

Follow the [Getting started with the AWS SDK guide (for Typescript)](https://docs.aws.amazon.com/cdk/latest/guide/getting_started.html) to install CDK and bootstrap your environment.

## Install dependencies

Install required packages.

```
npm install
```

## Build the application

Compile TypeScript to JS.

```
npm run build
```

## Run unit tests

Uses the Jest framework.

```
npm run test
```

## Deploy the test fleet

Deploy the fleet, to create the instances and create the Greengrass core devices in AWS IoT.

```
cdk deploy
```

The Greengrass core devices take a few minutes to be provisioned in AWS IoT Core after the CDK application is deployed. The Windows instances, and associated Greengrass core devices, take several minutes longer to be created than the Linux instances.

## Undeploy the test fleet

Undeploy the fleet.

```
cdk destroy
```

# Using the fleet

## Deployment

The application creates three AWS IoT static thing groups:

| Thing group | Members |
| ----------- | ------- |
| **GreengrassEC2DeviceFarm** | All instances in the fleet. |
| **GreengrassEC2DeviceFarm-nucleus** | Only the nucleus (Java) instances. |
| **GreengrassEC2DeviceFarm-nucleus-lite** | Only the nucleus lite (C) instances. |

You can use these as targets for your deployments to test your components. This CDK application also creates a Greengrass deployment named **Deployment for GreengrassEC2DeviceFarm-nucleus** that targets the **GreengrassEC2DeviceFarm-nucleus** group only. This deployment installs the nucleus [Greengrass CLI](https://docs.aws.amazon.com/greengrass/v2/developerguide/greengrass-cli-component.html) so you can use it to develop and debug your components. The deployment also configures the nucleus runtime with best-practice settings.

The [nucleus lite CLI](https://github.com/aws-greengrass/aws-greengrass-lite/blob/main/docs/ggl-cli.md) is installed in each nucleus lite instance by default.

## Nucleus Configuration

Each nucleus (Java) core device is initialized with the following configuration:

| Parameter | Value | Purpose |
| --------- | ----- | ------- |
| `interpolateComponentConfiguration` | `true` | Enables recipe variable interpolation in component configurations |
| `greengrassDataPlaneEndpoint` | `iotdata` | Uses the IoT data endpoint for the Greengrass data plane |

Recipe variable interpolation is recommended in your components to allow you to specify [least privilege access control in inter-process communication](https://docs.aws.amazon.com/greengrass/v2/developerguide/interprocess-communication.html#ipc-authorization-policies).

## Core Device Role

The application creates a Greengrass core device IAM role named **GreengrassEC2DeviceFarmTokenExchangeRole** with attached IAM policy **GreengrassEC2DeviceFarmTokenExchangeRoleAccess**. All instances use this role through a role alias named **GreengrassEC2DeviceFarmTokenExchangeRoleAlias**.

This role is intentionally permissive enough that you can deploy and test most components without editing it. It grants permissive access to component artifacts in S3 and in Amazon ECR. It also grants the Amazon CloudWatch permissions needed by the AWS-provided [Log manager](https://docs.aws.amazon.com/greengrass/v2/developerguide/log-manager-component.html) and [System log forwarder](https://docs.aws.amazon.com/greengrass/v2/developerguide/system-log-forwarder-component.html) components, should you wish to use them to access your component logs.

If your components need additional permissions (for example, [allowing access to secrets in Secret Manager](https://docs.aws.amazon.com/greengrass/v2/developerguide/secret-manager-component.html#secret-manager-component-requirements)), please add to or adjust the policies attached to this role.

## IoT Thing Policy

The application creates an AWS IoT policy named **GreengrassEC2DeviceFarm** and attaches it to each device's certificate. This role is intentionally permissive enough that you can deploy and test most components without editing it. It grants the devices permissive rights to publish, subscribe and receive on any MQTT topic.

If you want stricter, per-topic scoping for a particular test (for example, to verify a component only uses the topics it should), please modify the policy. The [thing name policy variable](https://docs.aws.amazon.com/iot/latest/developerguide/thing-policy-variables.html) can be used to achieve scalable least-privilege policies that restrict each device to its own unique topics. This application attaches certificates to things using [exclusive thing association](https://docs.aws.amazon.com/iot/latest/developerguide/exclusive-thing.html), and this enables the use of thing policy variables with Greengrass core devices.

## Docker

The Linux instances in the fleet are deployed with [all requirements to run a Docker container](https://docs.aws.amazon.com/greengrass/v2/developerguide/run-docker-container.html#run-docker-container-requirements), with both **docker** and **docker-compose** installed. Therefore it's possible to deploy and test container-based components on those instances. The Windows instances do no support Docker. Accordingly to test container-based components, it's advisable to create another thing group that includes just the Linux instances, and create another deployment that targets just that group.

The core device role already grants the S3 and Amazon ECR permissions needed to [run container-based components](https://docs.aws.amazon.com/greengrass/v2/developerguide/run-docker-container.html#run-docker-container-requirements) (see [Core Device Role](#core-device-role)), so container components that pull images from S3 or a private ECR repository in this account work without editing the role.

## Security Groups

The application creates a security group named **GreengrassEC2DeviceFarmLinuxSG** for the Linux instances and **GreengrassEC2DeviceFarmWindowsSG** for the Windows instances. If you install a component that requires particular open ports, you should open the appropriate inbound ports in these security groups.

## VPC Block Public Access

The stack includes a [VPC Block Public Access](https://docs.aws.amazon.com/vpc/latest/userguide/security-vpc-bpa.html) (BPA) exclusion so that instances can reach the internet even if account-level BPA is enabled.

# Clean-up

Some resources are created by commands in EC2 user data or by a Lambda-backed custom resource:

* An AWS IoT Thing for each instance.
* An AWS IoT X.509 certificate for each thing as the thing principal.
* A Greengrass core device for each instance.
* A Greengrass deployment for the thing group.

These resources are deleted by the Lambda-backed Custom Resource included in the stack, when you run `cdk destroy`.

# Troubleshooting

Should any of the Greengrass core devices fail to be created successfully in AWS IoT Core, please connect to the instance and examine the AWS EC2 instance user data logs for details.

## Linux

```
/var/log/cloud-init-output.log
```

## Windows

The Windows Server 2025 instance uses **EC2Launch v2**. The agent log records user
data execution, including whether the script produced error output:

```
C:\ProgramData\Amazon\EC2Launch\log\agent.log
```

The agent log reports only that the script produced error output, not the error
itself. The user data script that ran, and its captured standard output and error,
are written under:

```
C:\ProgramData\Amazon\EC2Launch\state\previous-user-data.ps1
```
