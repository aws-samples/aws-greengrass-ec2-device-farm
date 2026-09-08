// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as GreengrassEC2DeviceFarm from '../lib/greengrass-ec2-device-farm-stack';

test('Good stack', () => {
  
    const app = new cdk.App();
    const stack = new GreengrassEC2DeviceFarm.GreengrassEC2DeviceFarmStack(app, 'MyTestStack');
  
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::KeyPair', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
    template.resourceCountIs('AWS::IAM::Role', 4);
    template.resourceCountIs('AWS::IAM::Policy', 3);
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 1);
    template.resourceCountIs('AWS::EC2::Instance', 9);
    template.resourceCountIs('AWS::IoT::Policy', 1);
    template.resourceCountIs('AWS::IoT::RoleAlias', 1);
    template.resourceCountIs('AWS::IoT::ThingGroup', 3);
    template.resourceCountIs('AWS::IoT::ThingType', 1);
});

// All nine device type names, for building custom-count context in the tests below.
const ALL_DEVICE_TYPES = [
  'ws2025-x86-nucleus',
  'al2023-x86-nucleus',
  'al2023-arm-nucleus',
  'ub2604-x86-nucleus',
  'ub2604-arm-nucleus',
  'al2023-x86-nucleus-lite',
  'al2023-arm-nucleus-lite',
  'ub2604-x86-nucleus-lite',
  'ub2604-arm-nucleus-lite',
];

// Build a context object with every device type set to 0, then apply the given overrides.
function countContext(overrides: Record<string, number>): Record<string, number> {
  const ctx: Record<string, number> = {};
  for (const name of ALL_DEVICE_TYPES) {
    ctx[name] = 0;
  }
  return { ...ctx, ...overrides };
}

test('Default counts create one of each of the nine device types', () => {
  const app = new cdk.App();
  const stack = new GreengrassEC2DeviceFarm.GreengrassEC2DeviceFarmStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::Instance', 9);
});

test('Custom counts create the requested number of each device type', () => {
  // 10 of one type, 0 of everything else.
  const app = new cdk.App({
    context: countContext({ 'ub2604-arm-nucleus-lite': 10 }),
  });
  const stack = new GreengrassEC2DeviceFarm.GreengrassEC2DeviceFarmStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::Instance', 10);

  // Every instance should be a ub2604-arm-nucleus-lite replica with a 1-based suffix.
  const instances = template.findResources('AWS::EC2::Instance');
  const names = Object.values(instances)
    .map((r: any) => (r.Properties.Tags || []).find((t: any) => t.Key === 'Name')?.Value)
    .sort();
  for (let i = 1; i <= 10; i++) {
    expect(names).toContain(`MyTestStack-ub2604-arm-nucleus-lite-${i}`);
  }
});

test('Mixed counts sum to the expected number of instances', () => {
  const app = new cdk.App({
    context: countContext({
      'ws2025-x86-nucleus': 2,
      'al2023-arm-nucleus-lite': 3,
    }),
  });
  const stack = new GreengrassEC2DeviceFarm.GreengrassEC2DeviceFarmStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::Instance', 5);
});

test('Zero of every device type creates no instances but keeps the fleet infrastructure', () => {
  const app = new cdk.App({ context: countContext({}) });
  const stack = new GreengrassEC2DeviceFarm.GreengrassEC2DeviceFarmStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::Instance', 0);
  // Thing groups and thing type still exist even with no devices.
  template.resourceCountIs('AWS::IoT::ThingGroup', 3);
  template.resourceCountIs('AWS::IoT::ThingType', 1);
});

test.each([
  ['negative', -1],
  ['non-integer', 2.5],
  ['non-numeric string', 'abc'],
])('Invalid count (%s) is rejected', (_label, value) => {
  const app = new cdk.App({
    context: { 'ub2604-arm-nucleus-lite': value },
  });
  expect(() => new GreengrassEC2DeviceFarm.GreengrassEC2DeviceFarmStack(app, 'MyTestStack'))
    .toThrow(/Invalid count for device type/);
});
