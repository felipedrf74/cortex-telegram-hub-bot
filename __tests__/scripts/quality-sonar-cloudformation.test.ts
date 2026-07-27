import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templatePath = path.resolve('ops/sonarqube/aws-s3-stack.yaml');
const guardPath = path.resolve('ops/sonarqube/aws-s3-stack.guard');
const yamlCheckPath = path.resolve(
  'scripts/quality-sonar-cloudformation-yaml-check.mjs',
);
const runbookPath = path.resolve('ops/sonarqube/README.md');
const awsConfigPath = path.resolve('ops/sonarqube/aws-config.example');
const activationControllerPath = path.resolve(
  'scripts/quality-sonar-cloudformation-activate.py',
);
const credentialBoundaryPath = path.resolve(
  'scripts/aws-credential-process-boundary.py',
);
const guardAvailable = spawnSync('cfn-guard', ['--version'], {
  encoding: 'utf8',
}).status === 0;

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function runGuard(template: string) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'nexus-sonar-guard-'));
  const templateCopy = path.join(directory, 'template.yaml');
  try {
    fs.writeFileSync(templateCopy, template);
    return spawnSync(
      'cfn-guard',
      [
        'validate',
        '--rules',
        guardPath,
        '--data',
        templateCopy,
        '--type',
        'CFNTemplate',
        '--show-summary',
        'fail',
      ],
      { encoding: 'utf8' },
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

describe('SonarQube backup CloudFormation boundary', () => {
  it('canonicalizes the AWS-required PEM CRL to its receipt-bound DER digest', () => {
    const der = Buffer.from('sonar-crl-der-fixture', 'utf8');
    const encoded = der.toString('base64');
    const pem = `-----BEGIN X509 CRL-----\n${encoded}\n-----END X509 CRL-----\n`;
    const harness = [
      'import base64,hashlib,importlib.util,sys',
      'spec=importlib.util.spec_from_file_location("controller",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'pem=base64.b64decode(sys.argv[2],validate=True)',
      'der=module.canonical_pem_crl_der(pem)',
      'assert hashlib.sha256(der).hexdigest()==sys.argv[3]',
    ].join('\n');
    const result = spawnSync(
      'python3',
      [
        '-c',
        harness,
        activationControllerPath,
        Buffer.from(pem, 'utf8').toString('base64'),
        sha256(der),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('creates retained private versioned storage separate from application DR', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain(
      'SonarBackupBucket:\n'
      + '    Type: AWS::S3::Bucket\n'
      + '    DeletionPolicy: Retain\n'
      + '    UpdateReplacePolicy: Retain',
    );
    expect(template).toContain(
      'SonarBackupBucketPolicy:\n'
      + '    Type: AWS::S3::BucketPolicy\n'
      + '    DeletionPolicy: Retain\n'
      + '    UpdateReplacePolicy: Retain',
    );
    expect(template).toContain('SSEAlgorithm: AES256');
    expect(template).toContain('VersioningConfiguration:\n        Status: Enabled');
    expect(template).toContain('ObjectOwnership: BucketOwnerEnforced');
    for (const control of [
      'BlockPublicAcls: true',
      'BlockPublicPolicy: true',
      'IgnorePublicAcls: true',
      'RestrictPublicBuckets: true',
    ]) {
      expect(template).toContain(control);
    }
    expect(template).toContain('Value: separate-from-application-dr');
    expect(template).not.toContain('DisasterRecoveryBucket');
    expect(template).not.toContain('/nexus/application-dr/');
  });

  it('uses two distinct short-lived Roles Anywhere identities without credentials', () => {
    const template = fs.readFileSync(templatePath, 'utf8');
    const backupRoleStart = template.indexOf('\n  SonarBackupRole:');
    const restoreRoleStart = template.indexOf('\n  SonarRestoreRole:');
    const backupProfileStart = template.indexOf(
      '\n  SonarBackupRolesAnywhereProfile:',
    );
    const restoreProfileStart = template.indexOf(
      '\n  SonarRestoreRolesAnywhereProfile:',
    );
    const policyStart = template.indexOf('\n  SonarBackupBucketPolicy:');
    const restoreRole = template.slice(restoreRoleStart, backupProfileStart);
    const restoreProfile = template.slice(restoreProfileStart, policyStart);

    expect(template.match(/Type: AWS::IAM::Role/g)).toHaveLength(2);
    expect(template.match(/Type: AWS::RolesAnywhere::Profile/g)).toHaveLength(2);
    expect(template.match(/Type: AWS::RolesAnywhere::TrustAnchor/g)).toHaveLength(1);
    expect(template.match(/Type: AWS::RolesAnywhere::CRL/g)).toHaveLength(1);
    expect(template).toContain(
      'Canonical PEM CRL for the Sonar-only private CA.',
    );
    expect(template).toContain(
      'SHA-256 of the exact DER bytes encoded by the PEM CRL above.',
    );
    expect(template.match(/DurationSeconds: 900/g)).toHaveLength(2);
    expect(template.match(/AcceptRoleSessionName: false/g)).toHaveLength(2);
    expect(template.match(/Enabled: !If \[EnableRolesAnywhere, true, false\]/g))
      .toHaveLength(4);
    expect(template).toContain(
      'SonarRolesAnywhereActivationRollbackAlarm:\n'
      + '    Type: AWS::CloudWatch::Alarm',
    );
    expect(template).toContain('DatapointsToAlarm: 4');
    expect(template).toContain('EvaluationPeriods: 4');
    expect(template).toContain('Period: 30');
    expect(template).toContain('TreatMissingData: breaching');
    expect(template.match(
      /aws:SourceArn: !GetAtt SonarRolesAnywhereTrustAnchor\.TrustAnchorArn/g,
    ))
      .toHaveLength(2);
    expect(template).toContain(
      'DependsOn: SonarRolesAnywhereCertificateRevocationList',
    );
    expect(template.match(/aws:SourceAccount: !Ref 'AWS::AccountId'/g))
      .toHaveLength(2);
    expect(template.match(/aws:PrincipalTag\/x509Issuer\/CN:/g)).toHaveLength(2);
    expect(template.match(/aws:PrincipalTag\/x509Subject\/CN:/g)).toHaveLength(2);
    expect(template.slice(backupRoleStart, restoreRoleStart))
      .toContain('s3:PutObject');
    expect(restoreRole).not.toMatch(/s3:(Put|Delete)/);
    expect(restoreProfile).not.toMatch(/s3:(Put|Delete)/);
    expect(restoreRole).toMatch(/^\s+- s3:GetObjectVersion$/m);
    expect(restoreRole).not.toMatch(/^\s+- s3:GetObject$/m);
    expect(restoreRole).not.toMatch(/^\s+- s3:ListBucket(?:Versions)?$/m);
    expect(restoreProfile).toContain('"Action": ["s3:GetObjectVersion"]');
    expect(restoreProfile).not.toContain('"s3:GetObject"');
    expect(restoreProfile).not.toContain('"s3:ListBucket"');
    expect(restoreProfile).not.toContain('"s3:ListBucketVersions"');
    expect(template).not.toContain('s3:ListBucketVersions');
    expect(template).not.toMatch(
      /AWS::IAM::(?:AccessKey|User)|SecretAccessKey|LoginProfile|PrivateKey/,
    );
  });

  it('keeps identity and lifecycle activation disabled until exact receipts exist', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain(
      'RolesAnywhereActivation:\n'
      + '    Type: String\n'
      + '    Default: DISABLED',
    );
    expect(template).toContain(
      'LifecycleActivation:\n'
      + '    Type: String\n'
      + '    Default: DISABLED',
    );
    expect(template).toContain('RolesAnywhereActivationRequiresReceipt:');
    expect(template).toContain('DisabledRolesAnywhereRejectsReceipt:');
    expect(template).toContain('LifecycleActivationRequiresFirstBackup:');
    expect(template).toContain('DisabledLifecycleRejectsReceipt:');
    expect(template).toContain(
      "RolesAnywhereActivationReceiptSha256:\n"
      + '    Type: String\n'
      + "    Default: ''\n"
      + "    AllowedPattern: '^$|^[0-9a-f]{64}$'",
    );
    expect(template).toContain(
      "LifecycleBootstrapReceiptSha256:\n"
      + '    Type: String\n'
      + "    Default: ''\n"
      + "    AllowedPattern: '^$|^[0-9a-f]{64}$'",
    );
    expect(template.match(/Status: !If \[EnableLifecycle, Enabled, Disabled\]/g))
      .toHaveLength(2);
    expect(template).toContain('ProtectedMainTemplateSha256:');
    expect(template).toContain('OwnerReceiptKeyId:');
    expect(template).toContain('OwnerReceiptPublicKeySha256:');
    expect(template.match(/Key: owner-activation-receipt-sha256/g))
      .toHaveLength(5);
    expect(template).toContain('Key: first-backup-receipt-sha256');
    expect(template).toContain(
      'RolesAnywhereActivationReceiptSha256:\n'
      + '    Description: Canonical digest of the exact owner-signed activation receipt.',
    );
    expect(template).toContain(
      'LifecycleBootstrapReceiptSha256:\n'
      + '    Description: Canonical digest of the exact owner-signed first-backup receipt.',
    );
  });

  it('bounds noncurrent versions while leaving visible 7/4 retention client-owned', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toContain('Id: SonarDailyNoncurrentVersionRetention');
    expect(template).toContain("Prefix: !Sub '${SonarPrefix}/daily/'");
    expect(template).toContain('NoncurrentDays: 35');
    expect(template).toContain('Id: SonarWeeklyNoncurrentVersionRetention');
    expect(template).toContain("Prefix: !Sub '${SonarPrefix}/weekly/'");
    expect(template).toContain('NoncurrentDays: 120');
    expect(template.match(/ExpiredObjectDeleteMarker: true/g)).toHaveLength(2);
    expect(template).toContain('Sid: DenyDirectVersionDeletion');
    expect(template).toContain('s3:DeleteObjectVersion');
    expect(template).toContain('Sid: DenyWriterBucketControlMutation');
    expect(template).toContain('Sid: DenyWriterObjectIOOutsideSonarPrefix');
    expect(template).not.toContain('s3:ListBucketVersions');
    expect(template).toContain('s3:GetBucketVersioning');
    expect(template).toContain('s3:DeleteObject');
    expect(template).not.toMatch(/Action:\s+s3:\*\s*\n\s+Resource:\s+!Sub.*SonarPrefix/u);
  });

  it('ships an explicit policy-as-code and owner-reviewed change-set sequence', () => {
    const guard = fs.readFileSync(guardPath, 'utf8');
    const runbook = fs.readFileSync(runbookPath, 'utf8');
    const awsConfig = fs.readFileSync(awsConfigPath, 'utf8');

    expect(guard).toContain(
      'rule sonar_backup_bucket_is_private_versioned_retained_and_isolated',
    );
    expect(guard).toContain(
      'rule sonar_backup_has_only_two_distinct_temporary_identity_roles',
    );
    expect(guard).toContain('rule sonar_roles_anywhere_trust_is_exact');
    expect(guard).toContain(
      'rule sonar_identity_policies_are_exact_and_version_pinned',
    );
    expect(guard).toContain(
      'rule sonar_profiles_are_single_role_short_lived_and_exact',
    );
    expect(guard).toContain(
      'rule sonar_receipt_parameters_are_strict_and_disabled_first',
    );
    expect(runbook).toContain('ops/sonarqube/aws-s3-stack.yaml');
    expect(runbook).toContain('cfn-lint --format json');
    expect(runbook).toContain('cfn-guard validate');
    expect(runbook).toContain('Create the change set without executing it');
    expect(runbook).toContain('explicit owner approval');
    expect(runbook).toContain('RolesAnywhereActivation=DISABLED');
    expect(runbook).toContain('LifecycleActivation=DISABLED');
    expect(runbook).toContain('LifecycleBootstrapReceiptSha256');
    expect(runbook).toContain('quality-sonar-stack-receipt.mjs');
    expect(runbook).toContain('quality-sonar-aws-stack-state');
    expect(runbook).toContain('--mode activation-transition');
    expect(runbook).toContain('--activation-transition-record');
    expect(runbook).toContain('successful `ExecuteChangeSet` CloudTrail event');
    expect(runbook).toContain(
      'Expired preauthorization and transition receipts alone never authorize',
    );
    expect(runbook).toContain('nexus.sonarqube-roles-anywhere-activation.v2');
    expect(runbook).toContain('nexus.sonarqube-lifecycle-bootstrap.v1');
    expect(runbook).toContain(
      'nexus.sonarqube-stack-transition-authorization.v1',
    );
    expect(runbook).toContain('sign-transition');
    expect(runbook).toContain('quality-sonar-cloudformation-activate');
    expect(runbook).toContain('--openssl-bin');
    expect(runbook.indexOf('capture the exact prior stack')).toBeLessThan(
      runbook.indexOf("use the activation verifier's canonical"),
    );
    expect(runbook).toContain('durably records `executionAttempted`');
    expect(runbook).toContain('sole CloudFormation');
    expect(runbook).toContain('within 120');
    expect(runbook).toContain('RollbackTriggers=[]');
    expect(runbook).toContain('preparation only');
    expect(runbook).toContain('--activation-transition-receipt');
    expect(runbook).toContain(
      'grant only `s3:GetObjectVersion` on the exact daily and weekly',
    );
    expect(runbook).toContain('Never use `UsePreviousValue`');
    expect(awsConfig).toContain(
      'REPLACE_WITH_STACK_OUTPUT_BackupRolesAnywhereProfileArn',
    );
    expect(awsConfig).toContain(
      'REPLACE_WITH_STACK_OUTPUT_RestoreRolesAnywhereProfileArn',
    );
    expect(awsConfig).toContain(
      'REPLACE_WITH_STACK_OUTPUT_BackupPrincipalArn',
    );
    expect(awsConfig).toContain(
      'REPLACE_WITH_STACK_OUTPUT_RestorePrincipalArn',
    );
  });

  it('binds each credential-process probe to the exact live identity and certificate serial', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(tmpdir(), 'nexus-sonar-boundary-')),
    );
    fs.chmodSync(root, 0o700);
    try {
      const helper = path.join(root, 'aws-signing-helper');
      const openssl = path.join(root, 'openssl');
      const certificate = path.join(root, 'certificate.pem');
      const privateKey = path.join(root, 'private-key.pem');
      const config = path.join(root, 'aws-config');
      const trustAnchorArn =
        'arn:aws:rolesanywhere:eu-west-1:111122223333:trust-anchor/'
        + '11111111-2222-4333-8444-555555555555';
      const profileArn =
        'arn:aws:rolesanywhere:eu-west-1:111122223333:profile/'
        + '22222222-3333-4444-8555-666666666666';
      const roleArn =
        'arn:aws:iam::111122223333:role/nexus/sonarqube/nexus-sonar-backup';
      fs.writeFileSync(helper, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
      fs.writeFileSync(
        openssl,
        '#!/bin/sh\n'
        + '[ "$1" = x509 ] || exit 91\n'
        + "printf '%s\\n' 'serial=00A1:B2'\n",
        { mode: 0o700 },
      );
      fs.writeFileSync(certificate, 'test-certificate\n', { mode: 0o600 });
      fs.writeFileSync(privateKey, 'test-private-key\n', { mode: 0o600 });
      fs.writeFileSync(
        config,
        '[profile sonar-probe]\n'
        + 'region = eu-west-1\n'
        + `credential_process = ${helper} credential-process `
        + `--certificate ${certificate} --private-key ${privateKey} `
        + `--trust-anchor-arn ${trustAnchorArn} --profile-arn ${profileArn} `
        + `--role-arn ${roleArn} --session-duration 900\n`,
        { mode: 0o600 },
      );
      const common = [
        credentialBoundaryPath,
        '--config',
        config,
        '--profile',
        'sonar-probe',
        '--region',
        'eu-west-1',
        '--helper',
        helper,
        '--helper-sha256',
        sha256(fs.readFileSync(helper)),
        '--expected-role-arn',
        roleArn,
        '--expected-trust-anchor-arn',
        trustAnchorArn,
        '--expected-profile-arn',
        profileArn,
        '--openssl-bin',
        openssl,
        '--expected-owner-uid',
        String(process.getuid?.() ?? 0),
        '--trust-boundary',
        root,
      ];
      const env = {
        AWS_CONFIG_FILE: config,
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_PROFILE: 'sonar-probe',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        PATH: '/usr/bin:/bin',
      };
      const accepted = spawnSync('/usr/bin/python3', common, {
        encoding: 'utf8',
        env,
      });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        certificateSerial: 'a1b2',
        profileArn,
        roleArn,
        trustAnchorArn,
      });

      const mismatched = [...common];
      mismatched[mismatched.indexOf('--expected-profile-arn') + 1] =
        'arn:aws:rolesanywhere:eu-west-1:111122223333:profile/'
        + '33333333-4444-4555-8666-777777777777';
      const rejected = spawnSync('/usr/bin/python3', mismatched, {
        encoding: 'utf8',
        env,
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'credential_process profile ARN differs from the exact expected profile',
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('write-ahead journals execution, reconciles accepted calls, and preserves lifecycle rollback identity', () => {
    const harness = String.raw`
import importlib.util
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("sonar_activate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

receipt = {
    "receiptSha256": "a" * 64,
    "payload": {
        "issuedAt": "2026-07-25T11:55:00.000Z",
        "expiresAt": "2026-07-25T13:00:00.000Z",
    },
}
args = SimpleNamespace(
    base_receipt=Path("/unused/base"),
    change_set_id="arn:aws:cloudformation:eu-west-1:111122223333:changeSet/exact/11111111-2222-4333-8444-555555555555",
    evidence_out=Path("/unused/evidence"),
    key_id="owner-key",
    node_bin=Path("/unused/node"),
    openssl_bin=Path("/unused/openssl"),
    public_key=Path("/unused/public"),
    receipt_helper=Path("/unused/helper"),
    review_receipt_sha256="b" * 64,
    stack_id="arn:aws:cloudformation:eu-west-1:111122223333:stack/nexus-sonar/11111111-2222-4333-8444-555555555555",
    stack_name="nexus-sonar",
    transition="roles-anywhere",
    transition_receipt=Path("/unused/transition"),
    command_timeout_seconds=10,
    wait_timeout_seconds=60,
)
journal = {
    "schemaVersion": module.JOURNAL_SCHEMA,
    "transition": args.transition,
    "stackId": args.stack_id,
    "changeSetId": args.change_set_id,
    "reviewReceiptSha256": args.review_receipt_sha256,
    "signedTransitionReceiptSha256": receipt["receiptSha256"],
    "executionAttempted": False,
    "executed": False,
}
events = []
verification_calls = 0
def verified(_args, *, allow_expired):
    global verification_calls
    assert allow_expired is False
    verification_calls += 1
    events.append(f"authorization-rechecked-{verification_calls}")
    return receipt
def updated(_args, value, phase, **extra):
    events.append(phase)
    return {**value, "phase": phase, **extra}
class Cli:
    def run(self, arguments, **kwargs):
        assert events[-1] == "authorization-margin-confirmed-2"
        assert arguments[1] == "execute-change-set"
        events.append("aws-execute")

module.verify_signed_transition = verified
module.update_journal = updated
original_margin = module.require_mutation_authorization_margin
margin_calls = 0
def margin(_args, checked_receipt, **_options):
    global margin_calls
    assert checked_receipt == receipt
    margin_calls += 1
    assert events[-1] == f"authorization-rechecked-{margin_calls}"
    events.append(f"authorization-margin-confirmed-{margin_calls}")
module.require_mutation_authorization_margin = margin
executed = module.execute_exact_change_set(args, Cli(), journal, receipt)
assert events == [
    "authorization-rechecked-1",
    "authorization-margin-confirmed-1",
    "change-set-execution-attempted",
    "authorization-rechecked-2",
    "authorization-margin-confirmed-2",
    "aws-execute",
    "change-set-executed",
]
assert executed["executionAttempted"] is True
assert executed["executed"] is True

events.clear()
def expired(_args, *, allow_expired):
    events.append("authorization-rejected")
    raise SystemExit("expired")
module.verify_signed_transition = expired
try:
    module.execute_exact_change_set(args, Cli(), journal, receipt)
except SystemExit:
    pass
else:
    raise AssertionError("expired authorization reached execution")
assert events == ["authorization-rejected"]

events.clear()
module.verify_signed_transition = verified
verification_calls = 0
def insufficient_before_journal(_args, _checked_receipt, **_options):
    events.append("authorization-margin-rejected-before-journal")
    raise SystemExit("insufficient remaining lifetime")
module.require_mutation_authorization_margin = insufficient_before_journal
try:
    module.execute_exact_change_set(args, Cli(), journal, receipt)
except SystemExit:
    pass
else:
    raise AssertionError("near-expiry authorization armed an attempt journal")
assert events == [
    "authorization-rechecked-1",
    "authorization-margin-rejected-before-journal",
]

events.clear()
verification_calls = 0
def expires_after_journal(_args, *, allow_expired):
    global verification_calls
    assert allow_expired is False
    verification_calls += 1
    if verification_calls == 1:
        events.append("authorization-valid-before-journal")
        return receipt
    events.append("authorization-expired-after-journal")
    raise SystemExit("expired")
module.verify_signed_transition = expires_after_journal
def valid_margin_before_journal(_args, checked_receipt, **_options):
    assert checked_receipt == receipt
    assert events[-1] == "authorization-valid-before-journal"
    events.append("authorization-margin-confirmed-1")
module.require_mutation_authorization_margin = valid_margin_before_journal
try:
    module.execute_exact_change_set(args, Cli(), journal, receipt)
except SystemExit:
    pass
else:
    raise AssertionError("authorization expiry after journaling reached execution")
assert events == [
    "authorization-valid-before-journal",
    "authorization-margin-confirmed-1",
    "change-set-execution-attempted",
    "authorization-expired-after-journal",
]

events.clear()
module.require_mutation_authorization_margin = original_margin
near_expiry = {
    **receipt,
    "payload": {
        **receipt["payload"],
        "expiresAt": "2026-07-25T12:00:59.999Z",
    },
}
try:
    module.require_mutation_authorization_margin(
        args,
        near_expiry,
        observed_at=datetime(2026, 7, 25, 12, 0, 0, tzinfo=timezone.utc),
    )
except SystemExit as error:
    assert "insufficient remaining lifetime" in str(error)
else:
    raise AssertionError("near-expiry authorization reached AWS mutation")

safe_margin = {
    **receipt,
    "payload": {
        **receipt["payload"],
        "expiresAt": "2026-07-25T12:01:00.001Z",
    },
}
module.require_mutation_authorization_margin(
    args,
    safe_margin,
    observed_at=datetime(2026, 7, 25, 12, 0, 0, tzinfo=timezone.utc),
)
near_pre_journal = {
    **receipt,
    "payload": {
        **receipt["payload"],
        "expiresAt": "2026-07-25T12:01:14.999Z",
    },
}
try:
    module.require_mutation_authorization_margin(
        args,
        near_pre_journal,
        include_final_verification=True,
        observed_at=datetime(2026, 7, 25, 12, 0, 0, tzinfo=timezone.utc),
    )
except SystemExit as error:
    assert "insufficient remaining lifetime" in str(error)
else:
    raise AssertionError("pre-journal margin omitted the final verifier deadline")

safe_pre_journal = {
    **receipt,
    "payload": {
        **receipt["payload"],
        "expiresAt": "2026-07-25T12:01:15.001Z",
    },
}
module.require_mutation_authorization_margin(
    args,
    safe_pre_journal,
    include_final_verification=True,
    observed_at=datetime(2026, 7, 25, 12, 0, 0, tzinfo=timezone.utc),
)

client_hash = module.sha256_bytes(module.execution_token(args).encode())
for transition in ("roles-anywhere", "lifecycle"):
    args.transition = transition
    attempted = {
        **journal,
        "transition": transition,
        "executionAttempted": True,
        "executionAttemptedAt": "2026-07-25T12:00:00Z",
        "authorizationReverifiedReceiptSha256": receipt["receiptSha256"],
        "clientRequestTokenSha256": client_hash,
    }
    module.update_journal = updated
    recovered = module.reconcile_execution(
        args,
        attempted,
        {
            "executionAccepted": True,
            "changeSetExecutionStatus": "EXECUTE_IN_PROGRESS",
            "stackStatus": "UPDATE_IN_PROGRESS",
        },
        receipt,
    )
    assert recovered["executed"] is True
    assert recovered["executionReconciled"] is True
    try:
        module.reconcile_execution(
            args,
            attempted,
            {
                "executionAccepted": False,
                "changeSetExecutionStatus": "AVAILABLE",
                "stackStatus": "CREATE_COMPLETE",
            },
            receipt,
        )
    except SystemExit:
        pass
    else:
        raise AssertionError("unaccepted attempt was treated as executed")

args.transition = "lifecycle"
calls = []
module.stack_status = lambda _cli, _stack: (
    "UPDATE_ROLLBACK_COMPLETE",
    {},
    {
        "BucketName": "nexus-sonar-backup",
        "SonarPrefix": "nexus/sonar",
        "RolesAnywhereActivationRollbackAlarmArn": "unused",
    },
)
module.validate_identity_plane = lambda _cli, **kwargs: calls.append(
    ("identity", kwargs["enabled"]),
) or {"a1b2"}
module.lifecycle_state = lambda _cli, _bucket, _prefix, enabled: calls.append(
    ("lifecycle", enabled),
)
module.persist_or_validate_result = lambda _args, result: result
module.sha256_file = lambda _path: "c" * 64
module.update_journal = lambda _args, value, phase, **extra: {
    **value,
    "phase": phase,
    **extra,
}
rolled_back = module.finalize_or_monitor(
    args,
    object(),
    attempted,
    {},
    {"RolesAnywhereActivationRollbackAlarmArn": "unused"},
)
assert rolled_back["status"] == "rolled-back"
assert calls == [("identity", True), ("lifecycle", False)]

valid_denial = subprocess.CompletedProcess(
    [],
    42,
    b"",
    b"AccessDeniedException: IAM Roles Anywhere CreateSession certificate revoked",
)
module.validate_revoked_denial(valid_denial)
for stderr in (b"network timeout", b"certificate file missing", b"AccessDenied"):
    try:
        module.validate_revoked_denial(
            subprocess.CompletedProcess([], 42, b"", stderr),
        )
    except SystemExit:
        pass
    else:
        raise AssertionError("generic credential error passed revocation proof")
module.validate_probe_certificates(
    {
        "positive": {"certificateSerial": "cafe"},
        "revoked": {"certificateSerial": "a1b2"},
    },
    positive_profile="positive",
    revoked_profile="revoked",
    revoked_serials={"a1b2"},
)
for invalid in (
    (
        {
            "positive": {"certificateSerial": "cafe"},
            "revoked": {"certificateSerial": "dead"},
        },
        {"a1b2"},
    ),
    (
        {
            "positive": {"certificateSerial": "a1b2"},
            "revoked": {"certificateSerial": "a1b2"},
        },
        {"a1b2"},
    ),
):
    try:
        module.validate_probe_certificates(
            invalid[0],
            positive_profile="positive",
            revoked_profile="revoked",
            revoked_serials=invalid[1],
        )
    except SystemExit:
        pass
    else:
        raise AssertionError("mismatched probe certificate inventory passed")

with tempfile.TemporaryDirectory() as directory:
    openssl = Path(directory) / "openssl"
    openssl.write_text(
        "#!/bin/sh\n"
        "cat >/dev/null\n"
        "printf '%s\\n' 'Certificate Revocation List (CRL):' "
        "'    Serial Number: 00:A1:B2'\n",
        encoding="utf-8",
    )
    os.chmod(openssl, 0o700)
    assert module.crl_serials(
        openssl,
        b"\x30\x00",
        timeout_seconds=5,
    ) == {"a1b2"}
`;
    const checked = spawnSync(
      '/usr/bin/python3',
      ['-c', harness, activationControllerPath],
      { encoding: 'utf8' },
    );
    expect(checked.status, checked.stderr).toBe(0);
  });

  it('rechecks the exact signed receipt and lifetime before every alarm-prime heartbeat', () => {
    const harness = String.raw`
import importlib.util
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("sonar_activate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

receipt = {
    "receiptSha256": "a" * 64,
    "payload": {
        "issuedAt": "2026-07-25T11:55:00.000Z",
        "expiresAt": "2026-07-25T13:00:00.000Z",
    },
}
args = SimpleNamespace(command_timeout_seconds=10)
alarm_arn = (
    "arn:aws:cloudwatch:eu-west-1:111122223333:"
    "alarm:nexus-sonar-activation-rollback"
)
stack_name = "nexus-sonar"
module.time.sleep = lambda _seconds: None

def run_case(*, tamper_on_verify=None, reject_margin_on=None):
    events = []
    alarm_states = iter(("ALARM", "ALARM", "OK"))
    counters = {"verify": 0, "margin": 0, "heartbeat": 0}

    def described(_cli, observed_alarm_arn, observed_stack_name):
        assert observed_alarm_arn == alarm_arn
        assert observed_stack_name == stack_name
        state = next(alarm_states)
        events.append(f"alarm-{state}")
        return state

    def verified(observed_args, *, allow_expired):
        assert observed_args is args
        assert allow_expired is False
        counters["verify"] += 1
        count = counters["verify"]
        events.append(f"verify-{count}")
        if tamper_on_verify == count:
            return {**receipt, "receiptSha256": "b" * 64}
        return receipt

    def margin(observed_args, observed_receipt, **options):
        assert observed_args is args
        assert observed_receipt == receipt
        assert options == {}
        counters["margin"] += 1
        count = counters["margin"]
        assert events[-1] == f"verify-{count}"
        events.append(f"margin-{count}")
        if reject_margin_on == count:
            raise SystemExit("insufficient remaining lifetime")

    def renewed(_cli, observed_stack_name):
        assert observed_stack_name == stack_name
        counters["heartbeat"] += 1
        count = counters["heartbeat"]
        assert events[-1] == f"margin-{count}"
        events.append(f"heartbeat-{count}")

    module.describe_alarm = described
    module.verify_signed_transition = verified
    module.require_mutation_authorization_margin = margin
    module.heartbeat = renewed
    return events

events = run_case()
module.prime_alarm(args, object(), receipt, alarm_arn, stack_name)
assert events == [
    "alarm-ALARM",
    "verify-1",
    "margin-1",
    "heartbeat-1",
    "alarm-ALARM",
    "verify-2",
    "margin-2",
    "heartbeat-2",
    "alarm-OK",
]

events = run_case(tamper_on_verify=2)
try:
    module.prime_alarm(args, object(), receipt, alarm_arn, stack_name)
except SystemExit as error:
    assert "signed transition changed" in str(error)
else:
    raise AssertionError("tampered signed receipt reached a second heartbeat")
assert events == [
    "alarm-ALARM",
    "verify-1",
    "margin-1",
    "heartbeat-1",
    "alarm-ALARM",
    "verify-2",
]

events = run_case(reject_margin_on=2)
try:
    module.prime_alarm(args, object(), receipt, alarm_arn, stack_name)
except SystemExit as error:
    assert "insufficient remaining lifetime" in str(error)
else:
    raise AssertionError("insufficient authorization lifetime reached a heartbeat")
assert events == [
    "alarm-ALARM",
    "verify-1",
    "margin-1",
    "heartbeat-1",
    "alarm-ALARM",
    "verify-2",
    "margin-2",
]
`;
    const checked = spawnSync(
      '/usr/bin/python3',
      ['-c', harness, activationControllerPath],
      { encoding: 'utf8' },
    );
    expect(checked.status, checked.stderr).toBe(0);
  });

  it('closes an unattempted activation only from exact available predecessor evidence', () => {
    const harness = String.raw`
import importlib.util
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("sonar_activate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

args = SimpleNamespace(
    change_set_id=(
        "arn:aws:cloudformation:eu-west-1:111122223333:"
        "changeSet/exact/11111111-2222-4333-8444-555555555555"
    ),
    review_receipt_sha256="b" * 64,
    stack_id=(
        "arn:aws:cloudformation:eu-west-1:111122223333:"
        "stack/nexus-sonar/11111111-2222-4333-8444-555555555555"
    ),
    transition="roles-anywhere",
)
receipt = {"receiptSha256": "a" * 64}
base_journal = {
    "schemaVersion": module.JOURNAL_SCHEMA,
    "phase": "exact-approval-verified",
    "createdAt": "2026-07-25T12:00:00Z",
    "updatedAt": "2026-07-25T12:00:01Z",
    "transition": args.transition,
    "stackId": args.stack_id,
    "changeSetId": args.change_set_id,
    "reviewReceiptSha256": args.review_receipt_sha256,
    "signedTransitionReceiptSha256": receipt["receiptSha256"],
    "executionAttempted": False,
    "executed": False,
}
available = {
    "executionAccepted": False,
    "changeSetExecutionStatus": "AVAILABLE",
    "stackStatus": "CREATE_COMPLETE",
}

for phase in ("exact-approval-verified", "lease-primed"):
    module.validate_unattempted_execution(
        args,
        {**base_journal, "phase": phase},
        available,
        receipt,
    )
for predecessor in sorted(module.COMPLETE_PRIOR):
    module.validate_unattempted_execution(
        args,
        base_journal,
        {**available, "stackStatus": predecessor},
        receipt,
    )
module.validate_unattempted_execution(
    args,
    {
        **base_journal,
        "phase": "not-executed",
        "resultSha256": "c" * 64,
    },
    available,
    receipt,
)

tampered_cases = (
    (
        "unexpected journal key",
        {**base_journal, "unreviewed": True},
        available,
    ),
    (
        "receipt digest",
        {**base_journal, "signedTransitionReceiptSha256": "d" * 64},
        available,
    ),
    (
        "execution-attempted flag",
        {**base_journal, "executionAttempted": True},
        available,
    ),
    (
        "executed flag",
        {**base_journal, "executed": True},
        available,
    ),
    (
        "accepted execution",
        base_journal,
        {**available, "executionAccepted": True},
    ),
    (
        "non-boolean unaccepted evidence",
        base_journal,
        {**available, "executionAccepted": 0},
    ),
    (
        "non-available change set",
        base_journal,
        {**available, "changeSetExecutionStatus": "EXECUTE_IN_PROGRESS"},
    ),
    (
        "non-predecessor stack",
        base_journal,
        {**available, "stackStatus": "UPDATE_IN_PROGRESS"},
    ),
    (
        "invalid closeout result digest",
        {
            **base_journal,
            "phase": "not-executed",
            "resultSha256": "tampered",
        },
        available,
    ),
)
for label, observed_journal, reconciliation in tampered_cases:
    try:
        module.validate_unattempted_execution(
            args,
            observed_journal,
            reconciliation,
            receipt,
        )
    except SystemExit as error:
        assert "cannot be closed safely" in str(error), label
    else:
        raise AssertionError(f"{label} passed unattempted closeout")
`;
    const checked = spawnSync(
      '/usr/bin/python3',
      ['-c', harness, activationControllerPath],
      { encoding: 'utf8' },
    );
    expect(checked.status, checked.stderr).toBe(0);
  });

  it('rejects identical duplicate YAML mapping keys before lint and Guard', () => {
    const accepted = spawnSync(
      process.execPath,
      [yamlCheckPath, templatePath],
      { encoding: 'utf8' },
    );
    expect(accepted.status, accepted.stderr).toBe(0);

    const directory = fs.mkdtempSync(
      path.join(tmpdir(), 'nexus-sonar-yaml-duplicate-'),
    );
    const duplicate = path.join(directory, 'duplicate.yaml');
    try {
      const template = fs.readFileSync(templatePath, 'utf8');
      fs.writeFileSync(
        duplicate,
        template.replace(
          '          Value: !Ref OwnerReceiptPublicKeySha256\n'
          + '        - Key: protected-main-template-sha256',
          '          Value: !Ref OwnerReceiptPublicKeySha256\n'
          + '          Value: !Ref OwnerReceiptPublicKeySha256\n'
          + '        - Key: protected-main-template-sha256',
        ),
      );
      const rejected = spawnSync(
        process.execPath,
        [yamlCheckPath, duplicate],
        { encoding: 'utf8' },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'duplicate block mapping key "Value"',
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.skipIf(!guardAvailable)(
    'passes the complete Guard policy and rejects security-boundary mutations',
    () => {
      const template = fs.readFileSync(templatePath, 'utf8');
      const accepted = runGuard(template);
      expect(accepted.status, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);

      const restoreStart = template.indexOf('\n  SonarRestoreRole:');
      const restoreEnd = template.indexOf(
        '\n  SonarBackupRolesAnywhereProfile:',
        restoreStart,
      );
      const restoreRole = template.slice(restoreStart, restoreEnd);
      const mutations = [
        {
          name: 'trust-anchor substitution',
          rule: 'sonar_roles_anywhere_trust_is_exact',
          template: template.replaceAll(
            'aws:SourceArn: !GetAtt SonarRolesAnywhereTrustAnchor.TrustAnchorArn',
            'aws:SourceArn: !GetAtt SonarBackupBucket.Arn',
          ),
        },
        {
          name: 'mutable-current restore access',
          rule: 'sonar_identity_policies_are_exact_and_version_pinned',
          template:
            template.slice(0, restoreStart)
            + restoreRole.replace(
              '                  - s3:GetObjectVersion',
              '                  - s3:GetObject',
            )
            + template.slice(restoreEnd),
        },
        {
          name: 'long-lived profile',
          rule: 'sonar_profiles_are_single_role_short_lived_and_exact',
          template: template.replace('DurationSeconds: 900', 'DurationSeconds: 3600'),
        },
        {
          name: 'slow activation rollback alarm',
          rule: 'sonar_roles_anywhere_trust_is_exact',
          template: template.replace('EvaluationPeriods: 4', 'EvaluationPeriods: 10'),
        },
        {
          name: 'shortened noncurrent retention',
          rule: 'sonar_lifecycle_is_exact_and_disabled_first',
          template: template.replace('NoncurrentDays: 35', 'NoncurrentDays: 5'),
        },
        {
          name: 'unexpected current-version expiration',
          rule: 'sonar_lifecycle_is_exact_and_disabled_first',
          template: template.replace(
            '            NoncurrentVersionExpiration:\n'
              + '              NoncurrentDays: 35',
            '            ExpirationInDays: 1\n'
              + '            NoncurrentVersionExpiration:\n'
              + '              NoncurrentDays: 35',
          ),
        },
        {
          name: 'unbound activation tag',
          rule: 'sonar_backup_bucket_is_private_versioned_retained_and_isolated',
          template: template.replace(
            'Value: !Ref RolesAnywhereActivationReceiptSha256',
            'Value: !Ref OwnerReceiptPublicKeySha256',
          ),
        },
        {
          name: 'application DR boundary reuse',
          rule: 'sonar_backup_bucket_is_private_versioned_retained_and_isolated',
          template: template.replaceAll(
            'Value: separate-from-application-dr',
            'Value: application-dr',
          ),
        },
        {
          name: 'extra bucket-policy grant',
          rule: 'sonar_bucket_policy_is_retained_and_fail_closed',
          template: template.replace(
            '          - Sid: AllowRestoreExactPrefixVersions\n',
            '          - Sid: UnreviewedMutableRead\n'
            + '            Effect: Allow\n'
            + "            Principal: '*'\n"
            + '            Action:\n'
            + '              - s3:GetObject\n'
            + "            Resource: '*'\n"
            + '          - Sid: AllowRestoreExactPrefixVersions\n',
          ),
        },
      ];

      for (const mutation of mutations) {
        const rejected = runGuard(mutation.template);
        expect(
          rejected.status,
          `${mutation.name} unexpectedly passed\n${rejected.stdout}\n${rejected.stderr}`,
        ).not.toBe(0);
        expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(mutation.rule);
      }
    },
  );
});
