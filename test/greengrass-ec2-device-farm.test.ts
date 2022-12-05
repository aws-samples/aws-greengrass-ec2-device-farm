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
    template.resourceCountIs('AWS::IAM::Role', 2);
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 1);
    template.resourceCountIs('AWS::EC2::Instance', 8);
});
