// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IoTClient, ListThingsInThingGroupCommand, ListThingPrincipalsCommand,
  DetachThingPrincipalCommand, ListAttachedPoliciesCommand, DetachPolicyCommand,
  UpdateCertificateCommand, DeleteCertificateCommand, DeleteThingCommand,
  DeprecateThingTypeCommand, DeleteThingTypeCommand } from '@aws-sdk/client-iot';
import { GreengrassV2Client, DeleteCoreDeviceCommand,
  ListDeploymentsCommand, CancelDeploymentCommand, DeleteDeploymentCommand,
  CreateDeploymentCommand, ListComponentVersionsCommand } from '@aws-sdk/client-greengrassv2';

const iot = new IoTClient();
const greengrassv2 = new GreengrassV2Client();

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 5000;
const DELETE_RESERVE_MS = 7 * 60 * 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryOnThrottle<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e.name === 'ThrottlingException' || e.Code === 'ThrottlingException') {
        const delay = RETRY_BASE_DELAY_MS * (2 ** attempt);
        console.log(`  Throttled. Waiting ${delay}ms before retry (${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(delay);
      } else {
        throw e;
      }
    }
  }
  // Final attempt without catching
  return fn();
}

async function listThingsInGroup(thingGroupName: string): Promise<string[]> {
  const things: string[] = [];
  let nextToken: string | undefined;
  do {
    const response: any = await iot.send(new ListThingsInThingGroupCommand({
      thingGroupName, nextToken }));
    things.push(...(response.things || []));
    nextToken = response.nextToken;
  } while (nextToken);
  return things;
}

// Detach every policy attached to the certificate
async function detachAllPolicies(certificateArn: string): Promise<void> {
  let marker: string | undefined;
  do {
    const response: any = await iot.send(new ListAttachedPoliciesCommand({
      target: certificateArn, marker }));
    for (const policy of response.policies || []) {
      console.log(`  Detaching policy ${policy.policyName} from certificate`);
      await iot.send(new DetachPolicyCommand({
        policyName: policy.policyName!, target: certificateArn }));
    }
    marker = response.nextMarker;
  } while (marker);
}

async function deleteThingsInGroup(thingGroupArn: string): Promise<void> {
  const thingGroupName = thingGroupArn.split('thinggroup/')[1];
  console.log(`Getting things in thing group ${thingGroupName}`);
  let thingNames: string[];
  try {
    thingNames = await listThingsInGroup(thingGroupName);
  } catch (e: any) {
    console.log(`  Error listing things in thing group: ${e.message}`);
    return;
  }

  for (const thingName of thingNames) {
    try {
      console.log(`  Getting principals for thing ${thingName}`);
      const principals = (await iot.send(
        new ListThingPrincipalsCommand({ thingName }))).principals || [];

      for (const principal of principals) {
        console.log(`  Detaching principal from thing ${thingName}`);
        await iot.send(new DetachThingPrincipalCommand({ thingName, principal }));

        if (principal.includes('cert')) {
          const certificateId = principal.split('cert/')[1];
          await detachAllPolicies(principal);
          console.log(`  Deactivating certificate ${certificateId}`);
          await iot.send(new UpdateCertificateCommand({
            certificateId, newStatus: 'INACTIVE' }));
          console.log(`  Deleting certificate ${certificateId}`);
          await iot.send(new DeleteCertificateCommand({ certificateId }));
        }
      }

      console.log(`  Deleting core device (if any) for thing ${thingName}`);
      try {
        await greengrassv2.send(new DeleteCoreDeviceCommand({ coreDeviceThingName: thingName }));
      } catch (e: any) {
        if (e.name === 'ResourceNotFoundException') {
          console.log(`  No core device for thing ${thingName}, skipping`);
        } else {
          throw e;
        }
      }

      console.log(`  Deleting thing ${thingName}`);
      await iot.send(new DeleteThingCommand({ thingName }));
    } catch (e: any) {
      console.log(`  Error processing thing ${thingName}: ${e.message}`);
    }
  }
}

async function deleteDeployments(thingGroupArn: string, deadlineMs: number): Promise<void> {
  console.log('Getting Greengrass deployments');
  const deployments: any[] = [];
  try {
    let nextToken: string | undefined;
    do {
      const response: any = await greengrassv2.send(
        new ListDeploymentsCommand({ targetArn: thingGroupArn, historyFilter: 'ALL', nextToken }));
      deployments.push(...(response.deployments || []));
      nextToken = response.nextToken;
    } while (nextToken);
  } catch (e: any) {
    console.log(`  Error listing deployments: ${e.message}`);
    return;
  }

  console.log(`  Found ${deployments.length} deployment(s) to delete`);
  let processed = 0;
  for (const deployment of deployments) {
    // We might have too many deployments to delete them all within the Lambda timeout
    if (Date.now() >= deadlineMs) {
      const remaining = deployments.length - processed;
      console.log(`  Time budget reached; leaving ${remaining} deployment(s) for a later run`);
      break;
    }
    const deploymentId = deployment.deploymentId!;
    try {
      console.log(`  Canceling deployment ${deploymentId}`);
      await retryOnThrottle(() =>
        greengrassv2.send(new CancelDeploymentCommand({ deploymentId })));
    } catch (e: any) {
      console.log(`  Cancel skipped/failed for ${deploymentId}: ${e.message}`);
    }
    try {
      console.log(`  Deleting deployment ${deploymentId}`);
      await retryOnThrottle(() =>
        greengrassv2.send(new DeleteDeploymentCommand({ deploymentId })));
      await sleep(2000);
    } catch (e: any) {
      console.log(`  Error deleting deployment ${deploymentId}: ${e.message}`);
    }
    processed++;
  }
}

async function deprecateThingType(thingTypeName: string): Promise<number | null> {
  console.log(`Deprecating thing type ${thingTypeName}`);
  try {
    await iot.send(new DeprecateThingTypeCommand({ thingTypeName, undoDeprecate: false }));
    return Date.now();
  } catch (e: any) {
    if (e.name === 'ResourceNotFoundException') {
      console.log(`  Thing type ${thingTypeName} not found, nothing to do`);
    } else {
      console.log(`  Error deprecating thing type: ${e.message}`);
    }
    return null;
  }
}

// Deletion can't occur until 5 minutes after deprecation
async function deleteThingTypeAfterWait(thingTypeName: string, deprecatedAtMs: number): Promise<void> {
  const REQUIRED_WAIT_MS = 5 * 60 * 1000 + 15000;
  const remainingMs = Math.max(0, REQUIRED_WAIT_MS - (Date.now() - deprecatedAtMs));
  console.log(`  Waiting ${remainingMs}ms more before deleting thing type ${thingTypeName}`);
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }

  console.log(`  Deleting thing type ${thingTypeName}`);
  const DELETE_ATTEMPTS = 5;
  const DELETE_BACKOFF_MS = 20000;
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
    try {
      await iot.send(new DeleteThingTypeCommand({ thingTypeName }));
      console.log(`  Deleted thing type ${thingTypeName}`);
      return;
    } catch (e: any) {
      const tooEarly = e.name === 'InvalidRequestException';
      const throttled = e.name === 'ThrottlingException' || e.Code === 'ThrottlingException';
      if ((tooEarly || throttled) && attempt < DELETE_ATTEMPTS - 1) {
        console.log(`  Delete not ready (${e.name}); retrying in ${DELETE_BACKOFF_MS}ms `
          + `(${attempt + 1}/${DELETE_ATTEMPTS})...`);
        await sleep(DELETE_BACKOFF_MS);
      } else {
        console.log(`  Error deleting thing type ${thingTypeName} (left deprecated): ${e.message}`);
        return;
      }
    }
  }
}

async function createDeployment(thingGroupArn: string, deploymentName: string, nucleusConfig: string): Promise<void> {
  // Look up the latest nucleus version (CLI uses the same version)
  const region = process.env.AWS_REGION;

  const nucleusArn = `arn:aws:greengrass:${region}:aws:components:aws.greengrass.Nucleus`;
  const nucleusVersions = await greengrassv2.send(new ListComponentVersionsCommand({ arn: nucleusArn }));
  const nucleusVersion = nucleusVersions.componentVersions![0].componentVersion!;
  console.log(`Latest nucleus version: ${nucleusVersion}`);

  console.log(`Creating Greengrass deployment: ${deploymentName}`);
  const deploymentResponse = await greengrassv2.send(new CreateDeploymentCommand({
    targetArn: thingGroupArn,
    deploymentName: deploymentName,
    components: {
      'aws.greengrass.Nucleus': {
        componentVersion: nucleusVersion,
        configurationUpdate: {
          merge: nucleusConfig,
        },
      },
      'aws.greengrass.Cli': {
        componentVersion: nucleusVersion,
      },
    },
  }));
  console.log(`Created deployment ${deploymentResponse.deploymentId}`);
}

export async function handler(event: any, context?: any): Promise<any> {
  console.log('Event:', JSON.stringify(event));

  const requestType = event.RequestType;
  const farmName = event.ResourceProperties.FarmName;
  const nucleusThingGroupArn = event.ResourceProperties.NucleusThingGroupArn;
  const allThingGroupArn = event.ResourceProperties.AllThingGroupArn;
  const nucleusConfig = event.ResourceProperties.NucleusConfig;
  const thingTypeName = event.ResourceProperties.ThingTypeName;

  if (requestType === 'Create') {
    console.log(`Creating Greengrass deployment for ${farmName}`);
    await createDeployment(nucleusThingGroupArn, `Deployment for ${farmName}-nucleus`, nucleusConfig);
    console.log('Create complete.');
    return { PhysicalResourceId: farmName };
  }

  if (requestType === 'Update') {
    console.log(`Update requested for ${farmName}, nothing to do.`);
    return { PhysicalResourceId: farmName };
  }

  if (requestType === 'Delete') {
    console.log(`Cleaning up IoT resources for ${farmName}`);

    const deprecatedAtMs = await deprecateThingType(thingTypeName);
    await deleteThingsInGroup(allThingGroupArn);

    // We might not have time to delete all deployments. Put a cap on it.
    const nowMs = Date.now();
    const remainingMs = (context && typeof context.getRemainingTimeInMillis === 'function')
      ? context.getRemainingTimeInMillis()
      : 14 * 60 * 1000;
    const deployDeadlineMs = nowMs + Math.max(0, remainingMs - DELETE_RESERVE_MS);
    await deleteDeployments(nucleusThingGroupArn, deployDeadlineMs);

    if (deprecatedAtMs !== null) {
      await deleteThingTypeAfterWait(thingTypeName, deprecatedAtMs);
    }

    console.log('Clean-up complete.');
    return { PhysicalResourceId: farmName };
  }

  return { PhysicalResourceId: farmName };
}
