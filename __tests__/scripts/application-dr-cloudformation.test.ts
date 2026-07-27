import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templatePath = path.resolve('ops/application-dr/aws-s3-stack.yaml');
const guardPath = path.resolve('ops/application-dr/aws-s3-stack.guard');
const operationsPath = path.resolve('ops/application-dr/OPERATIONS.txt');
const guardBinary = [
  process.env.CFN_GUARD_BIN,
  '/opt/homebrew/bin/cfn-guard',
  '/usr/local/bin/cfn-guard',
  '/usr/bin/cfn-guard',
].find((candidate): candidate is string => (
  typeof candidate === 'string' && fs.existsSync(candidate)
));
const cfnLintBinary = [
  process.env.CFN_LINT_BIN,
  '/opt/homebrew/bin/cfn-lint',
  '/usr/local/bin/cfn-lint',
  '/usr/bin/cfn-lint',
].find((candidate): candidate is string => (
  typeof candidate === 'string' && fs.existsSync(candidate)
));

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

  it('pins the fail-closed CloudFormation invariants in a Guard ruleset', () => {
    const guard = fs.readFileSync(guardPath, 'utf8');

    expect(guard).toContain("%s3_bucket_count == 1");
    expect(guard).toContain("DeletionPolicy == 'Retain'");
    expect(guard).toContain("UpdateReplacePolicy == 'Retain'");
    expect(guard).toContain('Properties.ObjectLockEnabled == true');
    expect(guard).toContain(
      "Properties.VersioningConfiguration.Status == 'Enabled'",
    );
    expect(guard).toContain(
      "ServerSideEncryptionByDefault.SSEAlgorithm == 'AES256'",
    );
    expect(guard).toContain(
      "ObjectOwnership == 'BucketOwnerEnforced'",
    );
    expect(guard).toContain('%iam_role_count == 2');
    expect(guard).toContain('%roles_anywhere_profile_count == 2');
    expect(guard).toContain('%iam_user_count == 0');
    expect(guard).toContain('%iam_access_key_count == 0');
    expect(guard).toContain('%bucket_policy_statement_count == 26');
    expect(guard).toContain(
      'roles_and_profiles_are_exact_prefix_least_privilege',
    );
    expect(guard).toContain(
      'bucket_policy_preserves_write_once_object_lock_and_control_denies',
    );
    expect(guard).toContain(
      "Condition.StringNotEquals.'s3:if-none-match' == '*'",
    );
    expect(guard).toContain(
      "Condition.StringNotEquals.'s3:object-lock-mode' == 'COMPLIANCE'",
    );
    expect(guard).toContain(
      "Condition.ArnEquals.'aws:SourceArn'.'Fn::GetAtt'",
    );
    expect(guard).toContain(
      "Condition.StringEquals.'aws:SourceAccount'.Ref == 'AWS::AccountId'",
    );
    expect(guard).toContain(
      '%restore_read_statement {',
    );
    expect(guard).toContain("'s3:GetObjectRetention'");
    expect(guard).toContain(
      "Parameters.LifecycleActivation.Default == 'DISABLED'",
    );
    expect(guard).not.toContain('PriorDisabledStackId');
    expect(guard).not.toContain(
      'disabled_first_activation_is_stack_identity_bound',
    );
    expect(guard).toContain(
      'Rules.LifecycleEnableRequiresFirstBackupReceipt.RuleCondition == {',
    );
    expect(guard).toContain('%retained_lifecycle_rule_count == 5');
    expect(guard).toContain("Status.'Fn::If'[0] == 'EnableLifecycle'");
    expect(guard).toContain("Status.'Fn::If'[2] == 'Disabled'");
  });

  it.runIf(guardBinary !== undefined)(
    'passes Guard and rejects critical storage, identity, and lifecycle mutations',
    () => {
      const valid = spawnSync(guardBinary, [
        'validate',
        '--rules',
        guardPath,
        '--data',
        templatePath,
        '--type',
        'CFNTemplate',
        '--show-summary',
        'all',
      ], { encoding: 'utf8' });
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);

      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dr-guard-'));
      try {
        const body = fs.readFileSync(templatePath, 'utf8');
        const mutations: Array<{
          name: string;
          expectedRule: string;
          mutate: (template: string) => string;
        }> = [
          {
            name: 'object-lock-disabled',
            expectedRule: 'retained_private_object_lock_bucket',
            mutate: (template) => template.replace(
              'ObjectLockEnabled: true',
              'ObjectLockEnabled: false',
            ),
          },
          {
            name: 'lifecycle-expiration-broadened',
            expectedRule: 'lifecycle_remains_disabled_until_receipt_bound_activation',
            mutate: (template) => template.replace(
              'ExpirationInDays: 92',
              'ExpirationInDays: 93',
            ),
          },
          {
            name: 'roles-anywhere-enabled-by-default',
            expectedRule: 'managed_identity_plane_is_exact_and_ephemeral',
            mutate: (template) => template.replace(
              'RolesAnywhereActivation:\n    Type: String\n    Default: DISABLED',
              'RolesAnywhereActivation:\n    Type: String\n    Default: ENABLED',
            ),
          },
          {
            name: 'restore-list-became-write',
            expectedRule: 'roles_and_profiles_are_exact_prefix_least_privilege',
            mutate: (template) => template.replace(
              'Action: s3:ListBucketVersions',
              'Action: s3:PutObject',
            ),
          },
          {
            name: 'write-once-precondition-weakened',
            expectedRule: 'bucket_policy_preserves_write_once_object_lock_and_control_denies',
            mutate: (template) => template.replace(
              "s3:if-none-match: '*'",
              "s3:if-none-match: 'optional'",
            ),
          },
          {
            name: 'iam-user-added',
            expectedRule: 'managed_identity_plane_is_exact_and_ephemeral',
            mutate: (template) => template.replace(
              '\nOutputs:',
              '\n  ForbiddenLongLivedUser:\n'
              + '    Type: AWS::IAM::User\n'
              + '\nOutputs:',
            ),
          },
        ];
        for (const mutation of mutations) {
          const invalidTemplate = path.join(root, `${mutation.name}.yaml`);
          const mutated = mutation.mutate(body);
          expect(mutated, mutation.name).not.toBe(body);
          fs.writeFileSync(invalidTemplate, mutated);
          const invalid = spawnSync(guardBinary, [
            'validate',
            '--rules',
            guardPath,
            '--data',
            invalidTemplate,
            '--type',
            'CFNTemplate',
            '--show-summary',
            'fail',
          ], { encoding: 'utf8' });
          expect(
            invalid.status,
            `${mutation.name}\n${invalid.stdout}\n${invalid.stderr}`,
          ).not.toBe(0);
          expect(`${invalid.stdout}\n${invalid.stderr}`).toContain(
            mutation.expectedRule,
          );
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(cfnLintBinary !== undefined)(
    'passes the CloudFormation parser and rejects duplicate mapping keys',
    () => {
      const valid = spawnSync(cfnLintBinary, [
        '--format', 'json',
        '--regions', 'eu-west-1',
        '--template', templatePath,
      ], { encoding: 'utf8' });
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);

      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dr-cfn-lint-'));
      try {
        const duplicate = path.join(root, 'duplicate-key.yaml');
        const body = fs.readFileSync(templatePath, 'utf8');
        const mutated = body.replace(
          '        AssertDescription: >-\n'
          + '          RestorePrincipalArn must be a separate read-only role',
          '        AssertDescription: exact duplicate must fail parsing\n'
          + '        AssertDescription: >-\n'
          + '          RestorePrincipalArn must be a separate read-only role',
        );
        expect(mutated).not.toBe(body);
        fs.writeFileSync(duplicate, mutated);
        const invalid = spawnSync(cfnLintBinary, [
          '--format', 'json',
          '--regions', 'eu-west-1',
          '--template', duplicate,
        ], { encoding: 'utf8' });
        expect(
          invalid.status,
          `${invalid.stdout}\n${invalid.stderr}`,
        ).not.toBe(0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('grants only exact governed tiers and denies all direct object deletion', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain('Sid: DenyPlaintextTransport');
    expect(template).toContain("aws:SecureTransport: 'false'");
    expect(template.match(/aws:PrincipalIsAWSService: 'false'/g)).toHaveLength(2);
    expect(template).toContain('Sid: DenyLegacyTls');
    expect(template).toContain('s3:TlsVersion: 1.2');
    expect(template).toContain("aws:PrincipalIsAWSService: 'false'");
    expect(template).toContain('Sid: DenyUnversionedObjectDeletion');
    expect(template).toContain('Action: s3:DeleteObject');
    expect(template.match(/s3:ListBucket(?!Versions)/g)).toHaveLength(3);
    expect(template).toContain('s3:ListBucketVersions');
    expect(template).not.toContain('s3:ListAllMyBuckets');
    const backupRoleStart = template.indexOf('\n  BackupRole:');
    const restoreRoleStart = template.indexOf('\n  RestoreRole:');
    const backupRole = template.slice(backupRoleStart, restoreRoleStart);
    expect(backupRole).toContain(
      'Action:\n'
      + '                  - s3:ListBucket\n'
      + '                  - s3:ListBucketVersions',
    );
    expect(backupRole).toContain(
      "s3:prefix:\n"
      + "                      - !Sub '${DrPrefix}/*'",
    );
    const backupProfileStart = template.indexOf('\n  BackupRolesAnywhereProfile:');
    const restoreProfileStart = template.indexOf('\n  RestoreRolesAnywhereProfile:');
    const backupProfile = template.slice(backupProfileStart, restoreProfileStart);
    expect(backupProfile).toContain(
      '"Action": ["s3:ListBucket", "s3:ListBucketVersions"]',
    );
    expect(backupProfile).toContain(
      '"Condition": {"StringLike": {"s3:prefix": ["${DrPrefix}/*"]}}',
    );
    const bucketListingStart = template.indexOf(
      'Sid: AllowExactPrefixListing',
    );
    const bucketListingEnd = template.indexOf('\n          - !If', bucketListingStart);
    const bucketListing = template.slice(bucketListingStart, bucketListingEnd);
    expect(bucketListing).toContain('- s3:ListBucket');
    expect(bucketListing).toContain('- s3:ListBucketVersions');
    expect(bucketListing).toContain("- !Sub '${DrPrefix}/*'");
    expect(template).toContain('Sid: DenyDirectVersionDeletion');
    expect(template).toContain('Action: s3:DeleteObjectVersion');
    expect(template).toContain('Sid: DenyBackupPrincipalObjectDeletion');
    expect(template.slice(backupRoleStart, restoreRoleStart))
      .not.toContain('s3:DeleteObjectVersion');
    expect(template.slice(backupProfileStart, restoreProfileStart))
      .not.toContain('s3:DeleteObjectVersion');
    expect(template).not.toContain(
      '"${DisasterRecoveryBucket.Arn}/${DrPrefix}/database/*"',
    );
    expect(template).toContain(
      "Resource: !Sub '${DisasterRecoveryBucket.Arn}/${DrPrefix}/database/hourly/*'",
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

  it('can provision a disabled-by-default, exact-identity IAM Roles Anywhere plane', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain(
      'PrincipalProvisioningMode:\n'
      + '    Type: String\n'
      + '    Default: EXTERNAL',
    );
    expect(template).toContain('RolesAnywhereActivation:');
    expect(template).toContain('Default: DISABLED');
    expect(template).not.toContain('PriorDisabledStackId');
    expect(template).not.toContain('EnabledControlRequiresPriorDisabledStack:');
    expect(template).not.toContain('DisabledControlsRejectPriorStackClaim:');
    expect(template).not.toContain('DisabledStackId:');
    expect(template).toContain(
      'condition cannot prove prior stack history',
    );
    expect(template).toContain(
      'reviewed\n'
      + '      external activation controller',
    );
    expect(template).toContain('Type: AWS::RolesAnywhere::TrustAnchor');
    expect(template).toContain('Type: AWS::RolesAnywhere::CRL');
    expect(template.match(/Type: AWS::RolesAnywhere::Profile/g)).toHaveLength(2);
    expect(template.match(/DependsOn: RolesAnywhereCertificateRevocationList/g))
      .toHaveLength(2);
    expect(template.match(/Type: AWS::IAM::Role/g)).toHaveLength(2);
    const crlChunkDeclarations = template.match(
      /^  CertificateRevocationListData\d{3}: \{Type: String, Default: '', MaxLength: \d+\}$/gm,
    ) || [];
    expect(crlChunkDeclarations).toHaveLength(74);
    expect(crlChunkDeclarations.filter((line) => line.endsWith('MaxLength: 4096}')))
      .toHaveLength(73);
    expect(crlChunkDeclarations.at(-1)).toContain('Data074:');
    expect(crlChunkDeclarations.at(-1)).toContain('MaxLength: 992');
    expect(template).not.toMatch(/^  CertificateRevocationListData:\s*$/m);
    expect(template.match(/!Ref CertificateRevocationListData\d{3}/g))
      .toHaveLength(76);
    expect(template).toContain('CrlData: !Join');
    expect(template).toContain("CertificateRevocationListSha256:");
    expect(template).toContain("AllowedPattern: '^$|^[0-9a-f]{64}$'");
    expect(template).toContain('Key: crl-sha256');
    expect(template).toContain('Value: !Ref CertificateRevocationListSha256');
    expect(template).toContain('RolesAnywhereCrlSha256:');
    expect(template).not.toMatch(/^\s+UsePreviousValue:/m);
    const parameters = template.slice(
      template.indexOf('Parameters:'),
      template.indexOf('\nConditions:'),
    );
    expect(parameters.match(/^  [A-Za-z][A-Za-z0-9]+:/gm)?.length).toBeLessThan(200);
    expect(Buffer.byteLength(template, 'utf8')).toBeLessThanOrEqual(51_200);
    expect(template).toContain(
      'X509CertificateData: !Ref TrustAnchorCertificateData',
    );
    expect(template.match(/Enabled: !If \[EnableRolesAnywhere, true, false\]/g))
      .toHaveLength(4);
    expect(template).not.toMatch(/^\s+Enabled: true$/m);
    expect(template).not.toContain('RequireInstanceProperties');
    expect(template.match(/AcceptRoleSessionName: false/g)).toHaveLength(2);
    expect(template.match(/DurationSeconds: 900/g)).toHaveLength(2);
    expect(template.match(/RoleArns:\n        - !GetAtt (Backup|Restore)Role\.Arn/g))
      .toHaveLength(2);

    expect(template.match(/Service: rolesanywhere\.amazonaws\.com/g)).toHaveLength(2);
    expect(template.match(/aws:SourceArn: !GetAtt RolesAnywhereTrustAnchor\.TrustAnchorArn/g))
      .toHaveLength(2);
    expect(template.match(/aws:SourceAccount: !Ref 'AWS::AccountId'/g)).toHaveLength(2);
    expect(template.match(/aws:PrincipalTag\/x509Issuer\/CN:/g)).toHaveLength(2);
    expect(template.match(/aws:PrincipalTag\/x509Subject\/CN:/g)).toHaveLength(2);
    expect(template.match(/CertificateField: x509Issuer/g)).toHaveLength(2);
    expect(template.match(/CertificateField: x509Subject/g)).toHaveLength(2);
    expect(template.match(/Specifier: CN/g)).toHaveLength(4);
    expect(template.match(/sts:AssumeRole/g)).toHaveLength(2);
    expect(template.match(/sts:SetSourceIdentity/g)).toHaveLength(2);
    expect(template.match(/sts:TagSession/g)).toHaveLength(2);

    expect(template).not.toMatch(/AWS: !Ref (Backup|Restore)PrincipalArn/);
    expect(template).toContain(
      'AWS: !If [ProvisionRolesAnywhere, !GetAtt BackupRole.Arn, !Ref BackupPrincipalArn]',
    );
    expect(template).toContain(
      'AWS: !If [ProvisionRolesAnywhere, !GetAtt RestoreRole.Arn, !Ref RestorePrincipalArn]',
    );
    expect(template).toContain(
      'Value: !If [ProvisionRolesAnywhere, !GetAtt BackupRole.Arn, !Ref BackupPrincipalArn]',
    );
    expect(template).toContain(
      'Value: !If [ProvisionRolesAnywhere, !GetAtt RestoreRole.Arn, !Ref RestorePrincipalArn]',
    );

    const restoreRoleStart = template.indexOf('\n  RestoreRole:');
    const backupProfileStart = template.indexOf('\n  BackupRolesAnywhereProfile:');
    const restoreProfileStart = template.indexOf('\n  RestoreRolesAnywhereProfile:');
    const bucketPolicyStart = template.indexOf('\n  DisasterRecoveryBucketPolicy:');
    const restoreRole = template.slice(restoreRoleStart, backupProfileStart);
    const restoreProfile = template.slice(restoreProfileStart, bucketPolicyStart);
    expect(restoreRole).toContain('PolicyName: NexusApplicationDrRestore');
    expect(restoreRole).not.toMatch(/s3:(Put|Delete)/);
    expect(restoreProfile).not.toMatch(/s3:(Put|Delete)/);
    expect(template.slice(template.indexOf('\n  BackupRole:'), bucketPolicyStart))
      .not.toContain('rolesanywhere:');
    expect(template).not.toMatch(/AWS::IAM::User|AWS::IAM::AccessKey|LoginProfile/);
    expect(template).not.toMatch(/PrivateKey|SecretAccessKey/);
  });

  it('uses disabled-first lifecycle and bounded COMPLIANCE retention for every tier', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain(
      'LifecycleActivation:\n'
      + '    Type: String\n'
      + '    Default: DISABLED',
    );
    expect(template).toContain(
      'LifecycleBootstrapReceiptSha256:\n'
      + '    Type: String\n'
      + "    Default: ''\n"
      + "    AllowedPattern: '^$|^[0-9a-f]{64}$'",
    );
    expect(template).toContain('LifecycleEnableRequiresFirstBackupReceipt:');
    expect(template).toContain('DisabledLifecycleRejectsBootstrapReceipt:');
    expect(template).toContain(
      'RuleCondition: !Equals [!Ref LifecycleActivation, ENABLED]',
    );
    expect(template).toContain(
      "Assert: !Not [!Equals [!Ref LifecycleBootstrapReceiptSha256, '']]",
    );
    expect(template).toContain(
      "Assert: !Equals [!Ref LifecycleBootstrapReceiptSha256, '']",
    );
    expect(template).toContain(
      'Value: !Ref LifecycleBootstrapReceiptSha256',
    );
    expect(template.match(/Status: !If \[EnableLifecycle, Enabled, Disabled\]/g))
      .toHaveLength(5);
    for (const expectedRule of [
      ['DatabaseHourlyWriteOnceRetention', 'database/hourly/', '3'],
      ['DatabaseDailyWriteOnceRetention', 'database/daily/', '9'],
      ['DatabaseWeeklyWriteOnceRetention', 'database/weekly/', '36'],
      ['DatabaseMonthlyWriteOnceRetention', 'database/monthly/', '191'],
      ['ReleaseWriteOnceRetention', 'releases/', '92'],
    ]) {
      const [id, prefix, days] = expectedRule;
      const start = template.indexOf(`- Id: ${id}`);
      expect(start).toBeGreaterThan(-1);
      const rule = template.slice(start, template.indexOf('\n          - Id:', start + 1));
      expect(rule).toContain(`/${prefix}'`);
      expect(rule).toContain(`ExpirationInDays: ${days}`);
      expect(rule).toContain('NoncurrentDays: 1');
    }
    expect(template).toContain('s3:GetObjectRetention');
    expect(template).toContain('s3:PutObjectRetention');
    expect(template).toContain('Sid: DenyGovernedPutWithoutIfNoneMatch');
    expect(template).toContain("s3:if-none-match: '*'");
    expect(template).toContain('Sid: DenyGovernedWriteWithoutRetentionDeadline');
    expect(template).toContain('Sid: DenyGovernedWriteWithoutCompliance');
    expect(template).toContain('s3:object-lock-mode: COMPLIANCE');
    for (const days of [2, 3, 8, 9, 35, 36, 190, 191, 90, 91]) {
      expect(template).toContain(
        `s3:object-lock-remaining-retention-days: ${days}`,
      );
    }
    expect(template).toContain('Sid: DenyBackupPrincipalWritesOutsideGovernedNamespaces');
    expect(template).toContain('Sid: DenyGovernedWritesFromNonBackupPrincipals');
    expect(template).toContain('ArnNotEquals:');
    expect(template).toContain('NotResource:');
    expect(template).toContain('s3:PutBucketPolicy');
    expect(template).toContain('s3:DeleteBucketPolicy');
    expect(template).toContain('s3:PutLifecycleConfiguration');
    expect(template).toContain('s3:PutBucketVersioning');
    expect(template).toContain('s3:PutBucketObjectLockConfiguration');
    expect(template).toContain('s3:PutObjectLegalHold');
    expect(template).toContain('s3:object-lock-remaining-retention-days: 90');
    expect(template).toContain('s3:object-lock-remaining-retention-days: 91');
    expect(template).not.toContain('DefaultRetention');
    expect(template).not.toContain('NoncurrentVersionExpirationInDays');
  });

  it('validates portable bounded inputs without accepting invalid S3 bucket forms', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain('MaxLength: 128');
    expect(template.match(/role\/\[A-Za-z0-9\+=,.@_\/-\]\{1,128\}/g))
      .toHaveLength(2);
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
    expect(operations).toContain(
      'cfn-guard validate --rules ops/application-dr/aws-s3-stack.guard',
    );
    expect(operations).toContain(
      'cfn-lint ops/application-dr/aws-s3-stack.yaml',
    );
    expect(operations).toMatch(/does not create an\s+IAM access key/u);
    expect(operations).toContain('IAM Roles Anywhere');
    expect(operations).toContain('RolesAnywhereActivation=DISABLED');
    expect(operations).toContain(
      'application-dr-cloudformation-activate.py',
    );
    expect(operations).toContain('--operation inspect');
    expect(operations).toContain('--execute-reviewed-change-set');
    expect(operations).toMatch(
      /standard\s+rollback-enabled deployment/u,
    );
    expect(operations).toContain('iam:PassRole');
    expect(operations).toContain(
      'omit `RoleARN` from `describe-change-set`',
    );
    expect(operations).not.toContain('PriorDisabledStackId');
    expect(operations).not.toContain('DisabledStackId');
    expect(operations).toContain('application-dr-crl-parameters.mjs');
    expect(operations).toContain('74');
    expect(operations).toContain('300,000');
    expect(operations).toContain('UsePreviousValue');
    expect(operations).toContain('PrivateDevices=true');
    expect(operations).toContain('storage-cost');
    expect(operations).toMatch(/separate (?:leaf )?certificate and read-only restore\s+role/u);
    expect(operations).toMatch(/explicit owner\s+approval/u);
  });
});
