# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Cleans Greengrass EC2 Device Farm IoT resources created by the Greengrass automatic installer
"""

import boto3

TEST_FARM_NAME = 'GreengrassEC2DeviceFarm'

iot = boto3.client('iot')
greengrassv2 = boto3.client('greengrassv2')

print('Getting IoT policies in the account')
policies = iot.list_policies()['policies']
for policy in policies:
    policy_name = policy['policyName']
    if TEST_FARM_NAME in policy_name:
        print(f'Getting principals associated to policy {policy_name}')
        principals = iot.list_policy_principals(policyName=policy_name)['principals']
        for principal in principals:
            print(f'Detaching policy {policy_name} from principal')
            iot.detach_principal_policy(policyName=policy_name, principal=principal)

        print(f'Deleting IoT policy {policy_name}')
        iot.delete_policy(policyName=policy_name)

print(f'Getting thing group {TEST_FARM_NAME}')
thing_group_arn = iot.describe_thing_group(thingGroupName=TEST_FARM_NAME)['thingGroupArn']

print('Getting core devices in the thing group')
core_devices = greengrassv2.list_core_devices(thingGroupArn=thing_group_arn)['coreDevices']

for core_device in core_devices:
    thing_name = core_device['coreDeviceThingName']
    print(f'Getting principals attached to thing {thing_name}')
    principals = iot.list_thing_principals(thingName=thing_name)['principals']
    for principal in principals:
        print(f'Detaching principal from thing {thing_name}')
        iot.detach_thing_principal(thingName=thing_name, principal=principal)

        if 'cert' in principal:
            certificate_id = principal.split('cert/')[-1]
            print(f'Deactivating certificate {certificate_id}')
            iot.update_certificate(certificateId=certificate_id, newStatus='INACTIVE')
            print(f'Deleting certificate {certificate_id}')
            iot.delete_certificate(certificateId=certificate_id)

    print(f'Deleting core device and corresponding thing {thing_name}')
    greengrassv2.delete_core_device(coreDeviceThingName=thing_name)
    iot.delete_thing(thingName=thing_name)

print(f'Deleting thing group {TEST_FARM_NAME}')
iot.delete_thing_group(thingGroupName=TEST_FARM_NAME)

print('Getting role aliases in the account')
role_aliases = iot.list_role_aliases()['roleAliases']
for role_alias in role_aliases:
    if role_alias.startswith(TEST_FARM_NAME):
        print(f'Deleting role alias {role_alias}')
        iot.delete_role_alias(roleAlias=role_alias)

print(f'Getting Greengrass deployments for thing group {TEST_FARM_NAME}')
deployments = greengrassv2.list_deployments(targetArn=thing_group_arn,
                                                historyFilter='ALL')['deployments']
for deployment in deployments:
    deployment_id = deployment['deploymentId']
    print(f'Canceling and deleting {deployment_id} for "{deployment["deploymentName"]}"')
    greengrassv2.cancel_deployment(deploymentId=deployment_id)
    greengrassv2.delete_deployment(deploymentId=deployment_id)
