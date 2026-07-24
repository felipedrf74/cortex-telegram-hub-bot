import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templatePath = path.resolve('ops/application-dr/aws-s3-stack.yaml');
const operationsPath = path.resolve('ops/application-dr/OPERATIONS.txt');

describe('application DR CloudFormation', () => {
  it('creates only retained, private, versioned and encrypted Object Lock storage', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain("Type: AWS::S3::Bucket\n    DeletionPolicy: Retain");
    expect(template).toContain('UpdateReplacePolicy: Retain');
    expect(template).toContain(
      'DisasterRecoveryBucketPolicy:\n'
      + '    Type: AWS::S3::BucketPolicy\n'
      + '    DeletionPolicy: Retain\n'
      + '    UpdateReplacePolicy: Retain',
    );
    expect(template).toContain('ObjectLockEnabled: true');
    expect(template).toContain('VersioningConfiguration:\n        Status: Enabled');
    expect(template).toContain('SSEAlgorithm: AES256');
    expect(template).toContain('BlockPublicAcls: true');
    expect(template).toContain('BlockPublicPolicy: true');
    expect(template).toContain('IgnorePublicAcls: true');
    expect(template).toContain('RestrictPublicBuckets: true');
    expect(template).toContain('ObjectOwnership: BucketOwnerEnforced');
    expect(template).not.toMatch(/AWS::IAM::AccessKey|SecretAccessKey|LoginProfile/);
  });

  it('grants only the governed prefix and denies plaintext and unversioned deletion', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain('Sid: DenyPlaintextTransport');
    expect(template).toContain("aws:SecureTransport: 'false'");
    expect(template.match(/aws:PrincipalIsAWSService: 'false'/g)).toHaveLength(2);
    expect(template).toContain('Sid: DenyLegacyTls');
    expect(template).toContain('s3:TlsVersion: 1.2');
    expect(template).toContain("aws:PrincipalIsAWSService: 'false'");
    expect(template).toContain('Sid: DenyUnversionedObjectDeletion');
    expect(template).toContain('Action: s3:DeleteObject');
    expect(template).toContain('s3:ListBucketVersions');
    expect(template).toContain('s3:DeleteObjectVersion');
    expect(template).toContain(
      "Resource: !Sub '${DisasterRecoveryBucket.Arn}/${DrPrefix}/database/*'",
    );
    expect(template).toContain(
      "Resource: !Sub '${DisasterRecoveryBucket.Arn}/${DrPrefix}/releases/*'",
    );
    expect(template).not.toMatch(/Action:\s+['"]?s3:\*['"]?\s*\n\s+Resource:\s+!\S+\s+.*DrPrefix/);
  });

  it('separates the write-capable backup role from an optional read-only drill role', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain('BackupPrincipalArn:');
    expect(template).toContain('RestorePrincipalArn:');
    expect(template).toContain(':role/');
    expect(template).not.toContain('(role|user)');
    expect(template).toContain('HasRestorePrincipal:');
    expect(template).toContain('RestorePrincipalMustBeReadOnlyAndDistinct:');
    expect(template).toContain(
      "Assert: !Not [!Equals [!Ref RestorePrincipalArn, !Ref BackupPrincipalArn]]",
    );
    expect(template).toContain('Sid: AllowRestoreExactPrefixVersionListing');
    const restoreStart = template.indexOf('Sid: AllowRestoreReadOnlyObjects');
    const restoreEnd = template.indexOf("- !Ref 'AWS::NoValue'", restoreStart);
    const restoreStatement = template.slice(restoreStart, restoreEnd);
    expect(restoreStatement).toContain('s3:GetObjectVersion');
    expect(restoreStatement).toContain('s3:GetObjectRetention');
    expect(restoreStatement).not.toMatch(/s3:(Put|Delete)/);
    expect(template).toContain(
      'BackupPrincipalArn:\n'
      + '    Description: Exact writer role ARN',
    );
    expect(template).toContain(
      'RestorePrincipalArn:\n'
      + '    Condition: HasRestorePrincipal',
    );
  });

  it('limits release retention controls to a 90-day governed window', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain('s3:GetObjectRetention');
    expect(template).toContain('s3:PutObjectRetention');
    expect(template).toContain('Sid: AllowCompliantReleasePut');
    expect(template).toContain('Sid: DenyReleasePutWithoutCompliance');
    expect(template).toContain('Sid: DenyReleaseRetentionWithoutCompliance');
    expect(template).toContain('s3:object-lock-mode: COMPLIANCE');
    expect(template).toContain('s3:object-lock-remaining-retention-days: 90');
    expect(template).toContain('s3:object-lock-remaining-retention-days: 91');
    expect(template).toContain('Sid: DenyDatabaseRetention');
    expect(template).not.toContain('DefaultRetention');
  });

  it('validates portable bounded inputs without accepting invalid S3 bucket forms', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain('MaxLength: 512');
    expect(template).toContain(
      'DrPrefix:\n'
      + '    Type: String\n'
      + '    Default: nexus-hub/application',
    );
    expect(template).toContain('(?!.*\\.\\.)');
    expect(template).toContain('(?!.*-s3alias$)');
    expect(template).toContain('(?!.*--ol-s3$)');
    expect(template).toContain('(?!.*\\.mrap$)');
    expect(template).toContain('(?!.*--x-s3$)');
    expect(template).toContain('(?!.*--table-s3$)');
    expect(template).toContain(
      "Value: !Sub 'https://s3.${AWS::Region}.${AWS::URLSuffix}'",
    );
  });

  it('documents that provisioning and authentication remain owner-authorized', () => {
    const operations = fs.readFileSync(operationsPath, 'utf8');

    expect(operations).toContain('aws-s3-stack.yaml');
    expect(operations).toMatch(/does not create an\s+IAM access key/u);
    expect(operations).toContain('IAM Roles Anywhere');
    expect(operations).toContain('PrivateDevices=true');
    expect(operations).toMatch(/separate certificate and read-only restore\s+role/u);
    expect(operations).toContain('explicit owner approval');
  });
});
