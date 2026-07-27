import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve('scripts/quality-sonar-stack-receipt.mjs');
const liveVerifier = resolve('scripts/quality-sonar-aws-stack-state.mjs');
const activationController = resolve(
  'scripts/quality-sonar-cloudformation-activate.py',
);
const fixedNow = '2026-07-25T12:00:00.000Z';
const keyId = 'nexus-sonarqube-owner-2026-07';
const accountId = '111122223333';
const region = 'eu-west-1';
const stackName = 'nexus-sonarqube-backup';
const trustAnchorId = '11111111-2222-3333-4444-555555555555';
const backupProfileId = '22222222-3333-4444-5555-666666666666';
const restoreProfileId = '33333333-4444-5555-6666-777777777777';
const crlId = '88888888-9999-4aaa-8bbb-cccccccccccc';
const stackInstanceId = '44444444-5555-4666-8777-888888888888';
const activationChangeSetId = '55555555-6666-4777-8888-999999999999';
const lifecycleChangeSetId = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pemCrlFromDerBase64(value: string): string {
  const encoded = Buffer.from(value, 'base64').toString('base64');
  const lines = encoded.match(/.{1,64}/gu) as string[];
  return `-----BEGIN X509 CRL-----\n${lines.join('\n')}\n-----END X509 CRL-----\n`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
  ).join(',')}}`;
}

function writePrivate(path: string, value: Buffer | string | object): void {
  const body = typeof value === 'object' && !Buffer.isBuffer(value)
    ? `${JSON.stringify(value, null, 2)}\n`
    : value as Buffer | string;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEXUS_SONAR_RECEIPT_NOW: fixedNow,
      ...extraEnv,
    },
  });
}

function writeLiveAwsConfig(root: string, overrides: {
  backupProfileArn?: string;
  revokedProfileArn?: string;
  revokedTrustAnchorArn?: string;
  revokedRoleArn?: string;
} = {}): string {
  const awsConfig = join(root, 'live-aws-config');
  const backupCertificate = join(root, 'backup-certificate.pem');
  const revokedCertificate = join(root, 'revoked-certificate.pem');
  const backupPrivateKey = join(root, 'backup-private-key.pem');
  const revokedPrivateKey = join(root, 'revoked-private-key.pem');
  for (const path of [
    backupCertificate,
    revokedCertificate,
    backupPrivateKey,
    revokedPrivateKey,
  ]) {
    if (!existsSync(path)) writePrivate(path, `fixture:${path}\n`);
  }
  const trustAnchorArn =
    `arn:aws:rolesanywhere:${region}:${accountId}:trust-anchor/${trustAnchorId}`;
  const backupProfileArn =
    `arn:aws:rolesanywhere:${region}:${accountId}:profile/${backupProfileId}`;
  const backupRoleArn =
    `arn:aws:iam::${accountId}:role/nexus/sonarqube/nexus-sonar-backup`;
  const credentialProcess = (
    certificate: string,
    privateKey: string,
    selectedTrustAnchorArn: string,
    selectedProfileArn: string,
    selectedRoleArn: string,
  ) => '/usr/local/sbin/nexus-sonarqube-aws-signing-helper credential-process'
    + ` --certificate ${certificate}`
    + ` --private-key ${privateKey}`
    + ` --trust-anchor-arn ${selectedTrustAnchorArn}`
    + ` --profile-arn ${selectedProfileArn}`
    + ` --role-arn ${selectedRoleArn}`
    + ' --session-duration 900';
  writePrivate(
    awsConfig,
    `[profile owner]\nregion = ${region}\n\n`
    + '[profile nexus-sonarqube-backup]\n'
    + `region = ${region}\n`
    + `credential_process = ${credentialProcess(
      backupCertificate,
      backupPrivateKey,
      trustAnchorArn,
      overrides.backupProfileArn ?? backupProfileArn,
      backupRoleArn,
    )}\n\n`
    + '[profile nexus-sonarqube-revoked-probe]\n'
    + `region = ${region}\n`
    + `credential_process = ${credentialProcess(
      revokedCertificate,
      revokedPrivateKey,
      overrides.revokedTrustAnchorArn ?? trustAnchorArn,
      overrides.revokedProfileArn ?? backupProfileArn,
      overrides.revokedRoleArn ?? backupRoleArn,
    )}\n`,
  );
  return awsConfig;
}

function writeFakeOpenSsl(root: string): string {
  const executable = join(root, 'fake-openssl');
  if (existsSync(executable)) return executable;
  writePrivate(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'x509' && args.includes('-inform') && args.includes('PEM')
    && args.includes('-serial') && !args.includes('-in')) {
  let certificate = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    certificate += chunk;
  });
  process.stdin.on('end', () => {
    if (!certificate) {
      process.stderr.write('certificate stdin is empty\\n');
      process.exitCode = 91;
      return;
    }
    process.stdout.write(\`serial=\${process.env.FAKE_OPENSSL_CERT_SERIAL || '0A1B2C'}\\n\`);
  });
  return;
}
if (args[0] === 'crl' && args.includes('-inform') && args.includes('DER')
    && args.includes('-text')) {
  const serials = (process.env.FAKE_OPENSSL_CRL_SERIALS || '0A1B2C')
    .split(',')
    .filter(Boolean);
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stdout.write('Certificate Revocation List (CRL):\\n');
    for (const serial of serials) {
      process.stdout.write(\`    Serial Number: \${serial}\\n\`);
    }
  });
  process.exitCode = 0;
  return;
}
process.stderr.write(\`unhandled fake openssl request: \${args.join(' ')}\\n\`);
process.exit(90);
`);
  chmodSync(executable, 0o700);
  return executable;
}

function runLive(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const publicKeyIndex = args.indexOf('--public-key');
  const root = dirname(args[publicKeyIndex + 1]);
  const awsConfig = existsSync(join(root, 'live-aws-config'))
    ? join(root, 'live-aws-config')
    : writeLiveAwsConfig(root);
  const opensslBin = writeFakeOpenSsl(root);
  return spawnSync(process.execPath, [
    liveVerifier,
    'verify',
    ...args,
    '--aws-config',
    awsConfig,
    '--backup-probe-profile',
    'nexus-sonarqube-backup',
    '--revoked-probe-profile',
    'nexus-sonarqube-revoked-probe',
    '--openssl-bin',
    opensslBin,
  ], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEXUS_SONAR_STACK_TEST_MODE: '1',
      NEXUS_SONAR_RECEIPT_NOW: fixedNow,
      ...extraEnv,
    },
  });
}

function fixture() {
  const root = realpathSync.native(mkdtempSync(
    join(realpathSync.native(tmpdir()), 'nexus-sonar-receipt-'),
  ));
  chmodSync(root, 0o700);
  const pair = generateKeyPairSync('ed25519');
  const privateKey = join(root, 'owner-private.pem');
  const publicKey = join(root, 'owner-public.pem');
  writePrivate(
    privateKey,
    pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );
  writePrivate(
    publicKey,
    pair.publicKey.export({ format: 'pem', type: 'spki' }),
  );
  const publicKeySha256 = sha256(
    pair.publicKey.export({ format: 'der', type: 'spki' }),
  );
  const stack = {
    name: stackName,
    region,
    accountId,
    templateSha256: 'a'.repeat(64),
    bucketName: 'nexus-sonarqube-backup-test',
    bucketArn: 'arn:aws:s3:::nexus-sonarqube-backup-test',
    sonarPrefix: 'nexus-hub/sonarqube',
    trustAnchorArn:
      `arn:aws:rolesanywhere:${region}:${accountId}:trust-anchor/${trustAnchorId}`,
  };
  const caCertificatePem =
    '-----BEGIN CERTIFICATE-----\nZmFrZS1zb25hci1jYQ==\n-----END CERTIFICATE-----\n';
  const crlData = Buffer.from('fake-sonar-crl', 'utf8').toString('base64');
  const activationPayload = {
    schema: 'nexus.sonarqube-roles-anywhere-activation.v2',
    ownerAuthorization: 'explicit',
    issuedAt: '2026-07-25T11:55:00.000Z',
    expiresAt: '2026-07-25T13:00:00.000Z',
    signingKeyId: keyId,
    signingPublicKeySha256: publicKeySha256,
    stack,
    issuerCommonName: 'nexus-sonarqube-ca',
    identities: {
      backup: {
        roleArn:
          `arn:aws:iam::${accountId}:role/nexus/sonarqube/nexus-sonar-backup`,
        profileArn:
          `arn:aws:rolesanywhere:${region}:${accountId}:profile/${backupProfileId}`,
        subjectCommonName: 'serverdominguez-nexus-sonar-backup',
      },
      restore: {
        roleArn:
          `arn:aws:iam::${accountId}:role/nexus/sonarqube/nexus-sonar-restore`,
        profileArn:
          `arn:aws:rolesanywhere:${region}:${accountId}:profile/${restoreProfileId}`,
        subjectCommonName: 'nexus-isolated-sonar-restore',
      },
    },
    evidence: {
      backupCertificateSha256: 'b'.repeat(64),
      caCertificateSha256: sha256(caCertificatePem),
      certificateIssuanceSha256: '1'.repeat(64),
      credentialBoundarySha256: '2'.repeat(64),
      keyCustodySha256: '3'.repeat(64),
      restoreCertificateSha256: 'c'.repeat(64),
      revocationMaterialSha256: sha256(Buffer.from(crlData, 'base64')),
    },
    material: {
      caCertificatePem,
      crlData,
      crlId,
    },
    controls: {
      certificateIssuancePrepared: true,
      credentialBoundaryPrepared: true,
      expectedLifecycleActivation: 'DISABLED',
      expectedRolesAnywhereActivation: 'ENABLED',
      livePositiveCredentialProbeExpected: true,
      liveRevokedCertificateDenialExpected: true,
      privateKeyCustodyPrepared: true,
      revocationMaterialPrepared: true,
    },
  };
  const activationTransitionPayload = {
    schema: 'nexus.sonarqube-stack-transition-authorization.v1',
    ownerAuthorization: 'explicit',
    issuedAt: '2026-07-25T11:55:00.000Z',
    expiresAt: '2026-07-25T13:00:00.000Z',
    signingKeyId: keyId,
    signingPublicKeySha256: publicKeySha256,
    stack,
    kind: 'activation',
    receiptSha256: '',
    transition: {
      changeSetId:
        `arn:aws:cloudformation:${region}:${accountId}:changeSet/enable-sonar-identities/${activationChangeSetId}`,
      executorArnSha256: '6'.repeat(64),
      executorUserIdSha256: '7'.repeat(64),
      priorStack: {
        capturedAt: '2026-07-25T11:54:00.000Z',
        stackId:
          `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/${stackInstanceId}`,
        stackStatus: 'CREATE_COMPLETE',
        rolesAnywhereActivation: 'DISABLED',
        rolesAnywhereActivationReceiptSha256: '',
        lifecycleActivation: 'DISABLED',
        lifecycleBootstrapReceiptSha256: '',
        protectedMainTemplateSha256: stack.templateSha256,
        ownerReceiptKeyId: keyId,
        ownerReceiptPublicKeySha256: publicKeySha256,
      },
    },
  };
  return {
    activationPayload,
    activationTransitionPayload,
    privateKey,
    publicKey,
    publicKeySha256,
    root,
    stack,
  };
}

function signActivationTransition(
  state: ReturnType<typeof fixture>,
  activationReceipt: string,
  activationDigest: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  state.activationTransitionPayload.receiptSha256 = activationDigest;
  const payload = join(state.root, 'activation-transition-payload.json');
  const receipt = join(state.root, 'activation-transition-receipt.json');
  writePrivate(payload, state.activationTransitionPayload);
  const result = run([
    'sign-transition',
    '--kind',
    'activation',
    '--input',
    payload,
    '--receipt',
    activationReceipt,
    '--private-key',
    state.privateKey,
    '--key-id',
    keyId,
    '--output',
    receipt,
  ], extraEnv);
  return { payload, receipt, result };
}

function writerPolicy(bucketArn: string, prefix: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'InspectBucketVersioning',
        Effect: 'Allow',
        Action: ['s3:GetBucketVersioning'],
        Resource: bucketArn,
      },
      {
        Sid: 'ListExactSonarPrefix',
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': [`${prefix}/*`] } },
      },
      {
        Sid: 'SonarBackupObjectIO',
        Effect: 'Allow',
        Action: [
          's3:DeleteObject',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        Resource: [`${bucketArn}/${prefix}/daily/*`, `${bucketArn}/${prefix}/weekly/*`],
      },
    ],
  };
}

function restorePolicy(bucketArn: string, prefix: string) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'ReadExactSonarVersions',
      Effect: 'Allow',
      Action: ['s3:GetObjectVersion'],
      Resource: [`${bucketArn}/${prefix}/daily/*`, `${bucketArn}/${prefix}/weekly/*`],
    }],
  };
}

function bucketPolicy(
  bucketArn: string,
  prefix: string,
  backupRoleArn: string,
  restoreRoleArn: string,
) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyPlaintextTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: {
          Bool: {
            'aws:SecureTransport': 'false',
            'aws:PrincipalIsAWSService': 'false',
          },
        },
      },
      {
        Sid: 'DenyLegacyTls',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: {
          NumericLessThan: { 's3:TlsVersion': 1.2 },
          Bool: { 'aws:PrincipalIsAWSService': 'false' },
        },
      },
      {
        Sid: 'DenyDirectVersionDeletion',
        Effect: 'Deny',
        Principal: '*',
        Action: ['s3:DeleteObjectVersion'],
        Resource: `${bucketArn}/${prefix}/*`,
      },
      {
        Sid: 'DenyWriterBucketControlMutation',
        Effect: 'Deny',
        Principal: { AWS: backupRoleArn },
        Action: [
          's3:DeleteBucketPolicy',
          's3:PutBucketPublicAccessBlock',
          's3:PutBucketPolicy',
          's3:PutBucketVersioning',
          's3:PutEncryptionConfiguration',
          's3:PutLifecycleConfiguration',
        ],
        Resource: bucketArn,
      },
      {
        Sid: 'DenyWriterObjectIOOutsideSonarPrefix',
        Effect: 'Deny',
        Principal: { AWS: backupRoleArn },
        Action: [
          's3:DeleteObject',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        NotResource: `${bucketArn}/${prefix}/*`,
      },
      {
        Sid: 'AllowWriterBucketInspection',
        Effect: 'Allow',
        Principal: { AWS: backupRoleArn },
        Action: ['s3:GetBucketVersioning'],
        Resource: bucketArn,
      },
      {
        Sid: 'AllowWriterExactPrefixListing',
        Effect: 'Allow',
        Principal: { AWS: backupRoleArn },
        Action: ['s3:ListBucket'],
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': [`${prefix}/*`] } },
      },
      {
        Sid: 'AllowWriterExactPrefixObjects',
        Effect: 'Allow',
        Principal: { AWS: backupRoleArn },
        Action: [
          's3:DeleteObject',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        Resource: [`${bucketArn}/${prefix}/daily/*`, `${bucketArn}/${prefix}/weekly/*`],
      },
      {
        Sid: 'AllowRestoreExactPrefixVersions',
        Effect: 'Allow',
        Principal: { AWS: restoreRoleArn },
        Action: ['s3:GetObjectVersion'],
        Resource: [`${bucketArn}/${prefix}/daily/*`, `${bucketArn}/${prefix}/weekly/*`],
      },
    ],
  };
}

function buildLiveAwsResponses(
  state: ReturnType<typeof fixture>,
  activationDigest: string,
  templateBody: string,
  identity: { Account: string; Arn: string; UserId: string },
) {
  const { stack } = state;
  const backup = state.activationPayload.identities.backup;
  const restore = state.activationPayload.identities.restore;
  const stackId = state.activationTransitionPayload.transition.priorStack.stackId;
  const alarmArn =
    `arn:aws:cloudwatch:${region}:${accountId}:alarm:`
    + `${stackName}-roles-anywhere-activation-rollback`;
  const parameters = {
    BackupCertificateSubjectCommonName: backup.subjectCommonName,
    BucketName: '',
    CertificateRevocationListData: pemCrlFromDerBase64(
      state.activationPayload.material.crlData,
    ),
    CertificateRevocationListSha256:
      state.activationPayload.evidence.revocationMaterialSha256,
    CertificateIssuerCommonName: state.activationPayload.issuerCommonName,
    LifecycleActivation: 'DISABLED',
    LifecycleBootstrapReceiptSha256: '',
    OwnerReceiptKeyId: keyId,
    OwnerReceiptPublicKeySha256: state.publicKeySha256,
    ProtectedMainTemplateSha256: stack.templateSha256,
    RestoreCertificateSubjectCommonName: restore.subjectCommonName,
    RolesAnywhereActivation: 'ENABLED',
    RolesAnywhereActivationReceiptSha256: activationDigest,
    SonarPrefix: stack.sonarPrefix,
    TrustAnchorCertificateData: state.activationPayload.material.caCertificatePem,
  };
  const parameterList = Object.entries(parameters).map(
    ([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }),
  );
  const outputs = {
    BackupPrincipalArn: backup.roleArn,
    BackupRolesAnywhereProfileArn: backup.profileArn,
    BucketArn: stack.bucketArn,
    BucketName: stack.bucketName,
    LifecycleActivation: 'DISABLED',
    LifecycleBootstrapReceiptSha256: '',
    OwnerReceiptKeyId: keyId,
    OwnerReceiptPublicKeySha256: state.publicKeySha256,
    ProtectedMainTemplateSha256: stack.templateSha256,
    RestorePrincipalArn: restore.roleArn,
    RestoreRolesAnywhereProfileArn: restore.profileArn,
    RolesAnywhereActivationRollbackAlarmArn: alarmArn,
    RolesAnywhereCrlId: state.activationPayload.material.crlId,
    RolesAnywhereCrlSha256:
      state.activationPayload.evidence.revocationMaterialSha256,
    RolesAnywhereActivation: 'ENABLED',
    RolesAnywhereActivationReceiptSha256: activationDigest,
    RolesAnywhereTrustAnchorArn: stack.trustAnchorArn,
    S3Endpoint: `https://s3.${region}.amazonaws.com`,
    SonarPrefix: stack.sonarPrefix,
  };
  const outputList = Object.entries(outputs).map(
    ([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }),
  );
  const backupRoleName = backup.roleArn.split('/').at(-1) as string;
  const restoreRoleName = restore.roleArn.split('/').at(-1) as string;
  const profileId = (arn: string) => arn.split('/').at(-1) as string;
  const trustPolicy = (subjectCommonName: string) => ({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'rolesanywhere.amazonaws.com' },
      Action: ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'],
      Condition: {
        ArnEquals: { 'aws:SourceArn': stack.trustAnchorArn },
        StringEquals: {
          'aws:SourceAccount': accountId,
          'aws:PrincipalTag/x509Issuer/CN': state.activationPayload.issuerCommonName,
          'aws:PrincipalTag/x509Subject/CN': subjectCommonName,
        },
      },
    }],
  });
  const commonTags = {
    application: 'nexus-hub',
    'owner-activation-receipt-sha256': activationDigest,
    'receipt-signing-public-key-sha256': state.publicKeySha256,
    'protected-main-template-sha256': stack.templateSha256,
  };
  const tagList = (purpose: string) => Object.entries({
    ...commonTags,
    purpose,
  }).map(([Key, Value]) => ({ Key, Value }));
  const profile = (
    kind: 'backup' | 'restore',
    selected: typeof backup,
    policy: object,
  ) => ({
    profile: {
      profileArn: selected.profileArn,
      profileId: profileId(selected.profileArn),
      name: `${stackName}-${kind}`,
      enabled: true,
      durationSeconds: 900,
      acceptRoleSessionName: false,
      roleArns: [selected.roleArn],
      attributeMappings: [
        { certificateField: 'x509Issuer', mappingRules: [{ specifier: 'CN' }] },
        { certificateField: 'x509Subject', mappingRules: [{ specifier: 'CN' }] },
      ],
      sessionPolicy: JSON.stringify(policy),
    },
  });
  const eventId = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
  const cloudTrailDetail = {
    eventTime: '2026-07-25T12:00:00.000Z',
    eventSource: 'cloudformation.amazonaws.com',
    eventName: 'ExecuteChangeSet',
    awsRegion: region,
    recipientAccountId: accountId,
    userIdentity: {
      accountId,
      arn: identity.Arn,
      principalId: identity.UserId,
    },
    requestParameters: {
      changeSetName: state.activationTransitionPayload.transition.changeSetId,
      stackName: stackId,
    },
    readOnly: false,
    eventID: eventId,
  };
  return {
    'sts get-caller-identity': identity,
    'cloudformation describe-stacks': {
      Stacks: [{
        StackId: stackId,
        StackName: stackName,
        StackStatus: 'UPDATE_COMPLETE',
        EnableTerminationProtection: true,
        DisableRollback: false,
        LastUpdatedTime: '2026-07-25T12:00:05.000Z',
        Parameters: parameterList,
        Outputs: outputList,
        Tags: [],
      }],
    },
    'cloudformation describe-change-set': {
      ChangeSetId: state.activationTransitionPayload.transition.changeSetId,
      StackId: stackId,
      StackName: stackName,
      ChangeSetType: 'UPDATE',
      Status: 'CREATE_COMPLETE',
      ExecutionStatus: 'EXECUTE_COMPLETE',
      CreationTime: '2026-07-25T11:56:00.000Z',
      Parameters: parameterList,
      RollbackConfiguration: {
        RollbackTriggers: [{ Arn: alarmArn, Type: 'AWS::CloudWatch::Alarm' }],
        MonitoringTimeInMinutes: 15,
      },
    },
    'cloudtrail lookup-events': {
      Events: [{
        EventId: eventId,
        EventName: 'ExecuteChangeSet',
        EventTime: '2026-07-25T12:00:00.000Z',
        CloudTrailEvent: JSON.stringify(cloudTrailDetail),
      }],
    },
    'cloudformation get-template': { TemplateBody: templateBody },
    'cloudformation list-stack-resources': {
      StackResourceSummaries: [
        ['SonarBackupBucket', 'AWS::S3::Bucket', stack.bucketName],
        ['SonarBackupBucketPolicy', 'AWS::S3::BucketPolicy', stack.bucketName],
        ['SonarBackupRole', 'AWS::IAM::Role', backupRoleName],
        ['SonarRestoreRole', 'AWS::IAM::Role', restoreRoleName],
        ['SonarBackupRolesAnywhereProfile', 'AWS::RolesAnywhere::Profile',
          profileId(backup.profileArn)],
        ['SonarRestoreRolesAnywhereProfile', 'AWS::RolesAnywhere::Profile',
          profileId(restore.profileArn)],
        ['SonarRolesAnywhereTrustAnchor', 'AWS::RolesAnywhere::TrustAnchor',
          trustAnchorId],
        ['SonarRolesAnywhereCertificateRevocationList', 'AWS::RolesAnywhere::CRL',
          state.activationPayload.material.crlId],
        ['SonarRolesAnywhereActivationRollbackAlarm', 'AWS::CloudWatch::Alarm',
          `${stackName}-roles-anywhere-activation-rollback`],
      ].map(([LogicalResourceId, ResourceType, PhysicalResourceId]) => ({
        LogicalResourceId,
        ResourceType,
        PhysicalResourceId,
        ResourceStatus: 'CREATE_COMPLETE',
      })),
    },
    [`iam get-role|${backupRoleName}`]: {
      Role: {
        Arn: backup.roleArn,
        RoleName: backupRoleName,
        Path: '/nexus/sonarqube/',
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: trustPolicy(backup.subjectCommonName),
      },
    },
    [`iam get-role|${restoreRoleName}`]: {
      Role: {
        Arn: restore.roleArn,
        RoleName: restoreRoleName,
        Path: '/nexus/sonarqube/',
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: trustPolicy(restore.subjectCommonName),
      },
    },
    [`iam list-role-policies|${backupRoleName}`]: {
      PolicyNames: ['NexusSonarBackupWriter'],
    },
    [`iam list-role-policies|${restoreRoleName}`]: {
      PolicyNames: ['NexusSonarBackupRestore'],
    },
    [`iam list-attached-role-policies|${backupRoleName}`]: { AttachedPolicies: [] },
    [`iam list-attached-role-policies|${restoreRoleName}`]: { AttachedPolicies: [] },
    [`iam get-role-policy|${backupRoleName}`]: {
      PolicyDocument: writerPolicy(stack.bucketArn, stack.sonarPrefix),
    },
    [`iam get-role-policy|${restoreRoleName}`]: {
      PolicyDocument: restorePolicy(stack.bucketArn, stack.sonarPrefix),
    },
    [`iam list-role-tags|${backupRoleName}`]: {
      Tags: tagList('sonarqube-backup-writer'),
    },
    [`iam list-role-tags|${restoreRoleName}`]: {
      Tags: tagList('sonarqube-backup-restore'),
    },
    [`rolesanywhere get-profile|${profileId(backup.profileArn)}`]:
      profile('backup', backup, writerPolicy(stack.bucketArn, stack.sonarPrefix)),
    [`rolesanywhere get-profile|${profileId(restore.profileArn)}`]:
      profile('restore', restore, restorePolicy(stack.bucketArn, stack.sonarPrefix)),
    [`rolesanywhere get-trust-anchor|${trustAnchorId}`]: {
      trustAnchor: {
        trustAnchorArn: stack.trustAnchorArn,
        trustAnchorId,
        name: `${stackName}-ca`,
        enabled: true,
        source: {
          sourceType: 'CERTIFICATE_BUNDLE',
          sourceData: {
            x509CertificateData: state.activationPayload.material.caCertificatePem,
          },
        },
      },
    },
    [`rolesanywhere get-crl|${state.activationPayload.material.crlId}`]: {
      crl: {
        crlArn: `arn:aws:rolesanywhere:${region}:${accountId}:crl/${crlId}`,
        crlId,
        crlData: Buffer.from(
          pemCrlFromDerBase64(state.activationPayload.material.crlData),
          'utf8',
        ).toString('base64'),
        name: `${stackName}-crl`,
        trustAnchorArn: stack.trustAnchorArn,
        enabled: true,
      },
    },
    [`rolesanywhere list-tags-for-resource|${backup.profileArn}`]: {
      tags: tagList('sonarqube-backup-writer').map(
        ({ Key: key, Value: value }) => ({ key, value }),
      ),
    },
    [`rolesanywhere list-tags-for-resource|${restore.profileArn}`]: {
      tags: tagList('sonarqube-backup-restore').map(
        ({ Key: key, Value: value }) => ({ key, value }),
      ),
    },
    [`rolesanywhere list-tags-for-resource|${stack.trustAnchorArn}`]: {
      tags: [
        { key: 'application', value: 'nexus-hub' },
        { key: 'purpose', value: 'sonarqube-backup-authentication' },
        { key: 'isolation-boundary', value: 'separate-from-application-dr' },
      ],
    },
    [`rolesanywhere list-tags-for-resource|arn:aws:rolesanywhere:${region}:${accountId}:crl/${crlId}`]:
      {
        tags: [
          { key: 'application', value: 'nexus-hub' },
          { key: 'purpose', value: 'sonarqube-backup-revocation' },
          { key: 'isolation-boundary', value: 'separate-from-application-dr' },
          {
            key: 'crl-sha256',
            value: state.activationPayload.evidence.revocationMaterialSha256,
          },
        ],
      },
    'cloudwatch describe-alarms': {
      MetricAlarms: [{
        AlarmArn: alarmArn,
        AlarmName: `${stackName}-roles-anywhere-activation-rollback`,
        ComparisonOperator: 'LessThanThreshold',
        DatapointsToAlarm: 4,
        Dimensions: [{ Name: 'StackName', Value: stackName }],
        EvaluationPeriods: 4,
        MetricName: 'ActivationLease',
        Namespace: 'Nexus/SonarQube',
        Period: 30,
        Statistic: 'Minimum',
        Threshold: 1,
        TreatMissingData: 'breaching',
        Unit: 'Count',
        StateValue: 'ALARM',
      }],
    },
    's3api get-bucket-versioning': { Status: 'Enabled' },
    's3api get-bucket-encryption': {
      ServerSideEncryptionConfiguration: {
        Rules: [{
          ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        }],
      },
    },
    's3api get-public-access-block': {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    },
    's3api get-bucket-ownership-controls': {
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    },
    's3api get-bucket-lifecycle-configuration': {
      Rules: [
        {
          ID: 'SonarNamespaceHygiene',
          Prefix: `${stack.sonarPrefix}/`,
          Status: 'Enabled',
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        },
        ...(['daily', 'weekly'] as const).map((tier) => ({
          ID: tier === 'daily'
            ? 'SonarDailyNoncurrentVersionRetention'
            : 'SonarWeeklyNoncurrentVersionRetention',
          Prefix: `${stack.sonarPrefix}/${tier}/`,
          Status: 'Disabled',
          ExpiredObjectDeleteMarker: true,
          NoncurrentVersionExpiration: {
            NoncurrentDays: tier === 'daily' ? 35 : 120,
          },
        })),
      ],
    },
    's3api get-bucket-tagging': {
      TagSet: Object.entries({
        application: 'nexus-hub',
        purpose: 'encrypted-sonarqube-backup',
        'isolation-boundary': 'separate-from-application-dr',
        'owner-activation-receipt-sha256': activationDigest,
        'first-backup-receipt-sha256': '',
        'receipt-signing-public-key-sha256': state.publicKeySha256,
        'protected-main-template-sha256': stack.templateSha256,
      }).map(([Key, Value]) => ({ Key, Value })),
    },
    's3api get-bucket-policy': {
      Policy: JSON.stringify(bucketPolicy(
        stack.bucketArn,
        stack.sonarPrefix,
        backup.roleArn,
        restore.roleArn,
      )),
    },
    'sts get-caller-identity|nexus-sonarqube-backup': {
      Account: accountId,
      Arn:
        `arn:aws:sts::${accountId}:assumed-role/${backupRoleName}/probe-session`,
      UserId: 'AROABACKUP:probe-session',
    },
    's3api list-objects-v2|nexus-sonarqube-backup': {
      KeyCount: 0,
      IsTruncated: false,
      Contents: [],
    },
  };
}

function writeFakeAws(
  root: string,
  responses: Record<string, unknown>,
): { executable: string; fixture: string } {
  const fixturePath = join(root, 'aws-responses.json');
  writePrivate(fixturePath, responses);
  const executable = join(root, 'fake-aws');
  writePrivate(executable, `#!${process.execPath}
const fs = require('fs');
const responses = JSON.parse(fs.readFileSync(
  process.env.FAKE_AWS_RESPONSES || ${JSON.stringify(fixturePath)},
  'utf8',
));
const args = process.argv.slice(2);
const services = new Set(['cloudformation', 'cloudtrail', 'cloudwatch', 'iam', 'rolesanywhere', 's3api', 'sts']);
const serviceIndex = args.findIndex(value => services.has(value));
if (serviceIndex < 0 || !args[serviceIndex + 1]) process.exit(90);
let key = \`\${args[serviceIndex]} \${args[serviceIndex + 1]}\`;
const profileIndex = args.indexOf('--profile');
const profile = profileIndex >= 0 ? args[profileIndex + 1] : '';
if (profile === 'nexus-sonarqube-revoked-probe'
    && key === 'sts get-caller-identity') {
  process.stderr.write(
    process.env.FAKE_AWS_REVOKED_DIAGNOSTIC
      || 'AccessDeniedException: IAM Roles Anywhere CreateSession denied: certificate revoked\\n',
  );
  process.exit(42);
}
for (const option of [
  '--role-name',
  '--profile-id',
  '--resource-arn',
  '--trust-anchor-id',
  '--crl-id',
]) {
  const index = args.indexOf(option);
  if (index >= 0) {
    key += \`|\${args[index + 1]}\`;
    break;
  }
}
if (profile && profile !== 'owner') key += \`|\${profile}\`;
if (!Object.hasOwn(responses, key)) {
  process.stderr.write(\`unhandled fake AWS request: \${key}\\n\`);
  process.exit(91);
}
process.stdout.write(\`\${JSON.stringify(responses[key])}\\n\`);
`);
  chmodSync(executable, 0o700);
  return { executable, fixture: fixturePath };
}

describe('Sonar owner-signed stack receipts', () => {
  it('signs and verifies an exact canonical Ed25519 activation receipt', () => {
    const state = fixture();
    try {
      const payload = join(state.root, 'activation-payload.json');
      const receipt = join(state.root, 'activation-receipt.json');
      writePrivate(payload, state.activationPayload);

      const signed = run([
        'sign-activation',
        '--input',
        payload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        receipt,
      ]);
      expect(signed.status, signed.stderr).toBe(0);
      const signResult = JSON.parse(signed.stdout);
      expect(signResult).toMatchObject({
        ok: true,
        kind: 'activation',
        signingPublicKeySha256: state.publicKeySha256,
      });
      expect(signResult.receiptSha256).toMatch(/^[0-9a-f]{64}$/);

      const verified = run([
        'verify-activation',
        '--input',
        receipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
      ]);
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        ok: true,
        kind: 'activation',
        keyId,
        receiptSha256: signResult.receiptSha256,
        payload: state.activationPayload,
      });
      expect(readFileSync(receipt, 'utf8')).toBe(
        `${canonicalJson(JSON.parse(readFileSync(receipt, 'utf8')))}\n`,
      );
      const noncanonical = join(state.root, 'noncanonical-receipt.json');
      writePrivate(
        noncanonical,
        JSON.stringify(JSON.parse(readFileSync(receipt, 'utf8')), null, 2),
      );
      const noncanonicalResult = run([
        'verify-activation',
        '--input',
        noncanonical,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
      ]);
      expect(noncanonicalResult.status).not.toBe(0);
      expect(noncanonicalResult.stderr).toContain(
        'signed receipt is not canonical JSON',
      );
      const relabeled = join(state.root, 'relabeled-receipt.json');
      const relabeledValue = JSON.parse(readFileSync(receipt, 'utf8'));
      relabeledValue.keyId = `${keyId}-attacker`;
      writePrivate(relabeled, `${canonicalJson(relabeledValue)}\n`);
      const relabeledResult = run([
        'verify-activation',
        '--input',
        relabeled,
        '--public-key',
        state.publicKey,
        '--key-id',
        `${keyId}-attacker`,
      ]);
      expect(relabeledResult.status).not.toBe(0);
      expect(relabeledResult.stderr).toContain(
        'signingKeyId is invalid or mismatched',
      );

      const tampered = join(state.root, 'tampered-receipt.json');
      const tamperedValue = JSON.parse(readFileSync(receipt, 'utf8'));
      tamperedValue.payload.stack.sonarPrefix = 'nexus-hub/other';
      writePrivate(tampered, `${canonicalJson(tamperedValue)}\n`);
      const rejected = run([
        'verify-activation',
        '--input',
        tampered,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('receipt signature is invalid');
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('rejects expired, extra-field, and wrong-key activation authority', () => {
    const state = fixture();
    try {
      const payload = join(state.root, 'activation-payload.json');
      const receipt = join(state.root, 'activation-receipt.json');
      writePrivate(payload, state.activationPayload);
      const signed = run([
        'sign-activation',
        '--input',
        payload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        receipt,
      ]);
      expect(signed.status, signed.stderr).toBe(0);
      const expired = run([
        'verify-activation',
        '--input',
        receipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
      ], { NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z' });
      expect(expired.status).not.toBe(0);
      expect(expired.stderr).toContain('authorization expired');
      expect(run([
        'verify-activation',
        '--input',
        receipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--allow-expired',
      ], { NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z' }).status).toBe(0);

      const extraPayload = join(state.root, 'extra-payload.json');
      writePrivate(extraPayload, { ...state.activationPayload, ungoverned: true });
      const extra = run([
        'sign-activation',
        '--input',
        extraPayload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        join(state.root, 'extra-receipt.json'),
      ]);
      expect(extra.status).not.toBe(0);
      expect(extra.stderr).toContain('payload keys are invalid');

      const attacker = generateKeyPairSync('ed25519');
      const attackerPublic = join(state.root, 'attacker-public.pem');
      writePrivate(
        attackerPublic,
        attacker.publicKey.export({ format: 'pem', type: 'spki' }),
      );
      const wrongKey = run([
        'verify-activation',
        '--input',
        receipt,
        '--public-key',
        attackerPublic,
        '--key-id',
        keyId,
      ]);
      expect(wrongKey.status).not.toBe(0);
      expect(wrongKey.stderr).toContain('does not bind the selected public key');
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('requires an unexpired receipt before live transition verification touches AWS', () => {
    const state = fixture();
    try {
      const payload = join(state.root, 'activation-payload.json');
      const receipt = join(state.root, 'activation-receipt.json');
      const template = join(state.root, 'template.yaml');
      const evidence = join(state.root, 'activation-transition.json');
      writePrivate(payload, state.activationPayload);
      writePrivate(template, 'Resources: {}\n');
      const signed = run([
        'sign-activation',
        '--input',
        payload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        receipt,
      ]);
      expect(signed.status, signed.stderr).toBe(0);
      state.activationTransitionPayload.expiresAt = '2026-07-25T12:30:00.000Z';
      const transition = signActivationTransition(
        state,
        receipt,
        JSON.parse(signed.stdout).receiptSha256,
      );
      expect(transition.result.status, transition.result.stderr).toBe(0);

      const liveArguments = [
        '--mode',
        'activation-transition',
        '--region',
        region,
        '--stack-name',
        stackName,
        '--aws-profile',
        'owner',
        '--activation-receipt',
        receipt,
        '--activation-transition-receipt',
        transition.receipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--template',
        template,
        '--evidence-out',
        evidence,
      ];
      const boundary = runLive(liveArguments, {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-25T12:30:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: '/usr/bin/false',
      });
      expect(boundary.status).not.toBe(0);
      expect(boundary.stderr).toContain('receipt authorization expired');
      expect(boundary.stderr).not.toContain('AWS caller identity failed');
      expect(existsSync(evidence)).toBe(false);

      const result = runLive(liveArguments, {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-25T12:45:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: '/usr/bin/false',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('receipt authorization expired');
      expect(result.stderr).not.toContain('AWS caller identity failed');
      expect(existsSync(evidence)).toBe(false);
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('never accepts an expired steady-state receipt without its durable record', () => {
    const state = fixture();
    try {
      const result = runLive([
        '--mode',
        'steady',
        '--region',
        region,
        '--stack-name',
        stackName,
        '--aws-profile',
        'owner',
        '--activation-receipt',
        join(state.root, 'not-read.json'),
        '--activation-transition-receipt',
        join(state.root, 'transition-not-read.json'),
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--template',
        join(state.root, 'not-read.yaml'),
        '--evidence-out',
        join(state.root, 'not-written.json'),
      ], {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: '/usr/bin/false',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'steady mode requires the activation record',
      );
      expect(result.stderr).not.toContain('AWS caller identity failed');
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('confines verifier test hooks to isolated temporary evidence', () => {
    const state = fixture();
    try {
      const awsConfig = writeLiveAwsConfig(state.root);
      const opensslBin = writeFakeOpenSsl(state.root);
      const argumentsWithoutIsolation = [
        liveVerifier,
        'verify',
        '--mode',
        'activation-transition',
        '--region',
        region,
        '--stack-name',
        stackName,
        '--aws-profile',
        'owner',
        '--activation-receipt',
        join(state.root, 'not-read.json'),
        '--activation-transition-receipt',
        join(state.root, 'transition-not-read.json'),
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--template',
        join(state.root, 'not-read.yaml'),
        '--evidence-out',
        join(state.root, 'not-written.json'),
        '--aws-config',
        awsConfig,
        '--backup-probe-profile',
        'nexus-sonarqube-backup',
        '--revoked-probe-profile',
        'nexus-sonarqube-revoked-probe',
        '--openssl-bin',
        opensslBin,
      ];
      const unisolated = spawnSync(process.execPath, argumentsWithoutIsolation, {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          NEXUS_SONAR_RECEIPT_NOW: fixedNow,
          NEXUS_SONAR_STACK_AWS_BIN: '/usr/bin/false',
        },
      });
      expect(unisolated.status).not.toBe(0);
      expect(unisolated.stderr).toContain(
        'test hooks require explicit isolated test mode',
      );
      expect(unisolated.stderr).not.toContain('live Sonar stack evidence');

      const productionEvidencePath =
        '/var/lib/nexus-sonarqube/aws-stack-state-test.json';
      const productionPath = runLive([
        '--mode',
        'activation-transition',
        '--region',
        region,
        '--stack-name',
        stackName,
        '--aws-profile',
        'owner',
        '--activation-receipt',
        join(state.root, 'not-read.json'),
        '--activation-transition-receipt',
        join(state.root, 'transition-not-read.json'),
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--template',
        join(state.root, 'not-read.yaml'),
        '--evidence-out',
        productionEvidencePath,
      ]);
      expect(productionPath.status).not.toBe(0);
      expect(productionPath.stderr).toContain(
        'isolated test mode may write evidence only below an OS temporary directory',
      );
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('binds live transition verification to the exact authorized AWS executor', () => {
    const state = fixture();
    try {
      const template = join(state.root, 'template.yaml');
      const templateBody = 'Resources: {}\n';
      writePrivate(template, templateBody);
      state.activationPayload.stack.templateSha256 = sha256(templateBody);
      state.activationTransitionPayload.transition.priorStack
        .protectedMainTemplateSha256 =
        sha256(templateBody);
      const payload = join(state.root, 'activation-payload.json');
      const receipt = join(state.root, 'activation-receipt.json');
      writePrivate(payload, state.activationPayload);
      const signed = run([
        'sign-activation',
        '--input',
        payload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        receipt,
      ]);
      expect(signed.status, signed.stderr).toBe(0);
      const transition = signActivationTransition(
        state,
        receipt,
        JSON.parse(signed.stdout).receiptSha256,
      );
      expect(transition.result.status, transition.result.stderr).toBe(0);
      const fakeAws = join(state.root, 'fake-aws');
      writePrivate(
        fakeAws,
        '#!/bin/sh\n'
        + `printf '%s\\n' '{"Account":"${accountId}",`
        + '"Arn":"arn:aws:sts::111122223333:assumed-role/owner/wrong",'
        + '"UserId":"AROAWRONG:wrong"}\'\n',
      );
      chmodSync(fakeAws, 0o700);

      const result = runLive([
        '--mode',
        'activation-transition',
        '--region',
        region,
        '--stack-name',
        stackName,
        '--aws-profile',
        'owner',
        '--activation-receipt',
        receipt,
        '--activation-transition-receipt',
        transition.receipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--template',
        template,
        '--evidence-out',
        join(state.root, 'not-written.json'),
      ], { NEXUS_SONAR_STACK_AWS_BIN: fakeAws });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'transition verifier is not running as the authorized executor',
      );
      expect(result.stderr).not.toContain('CloudFormation stack');
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('accepts expired steady-state authority only through its exact successful transition record', () => {
    const state = fixture();
    try {
      const template = join(state.root, 'template.yaml');
      const templateBody = 'AWSTemplateFormatVersion: "2010-09-09"\nResources: {}\n';
      writePrivate(template, templateBody);
      state.activationPayload.stack.templateSha256 = sha256(templateBody);
      state.activationTransitionPayload.transition.priorStack
        .protectedMainTemplateSha256 =
        sha256(templateBody);
      const identity = {
        Account: accountId,
        Arn: `arn:aws:sts::${accountId}:assumed-role/sonar-owner/exact-session`,
        UserId: 'AROAEXACT:exact-session',
      };
      state.activationTransitionPayload.transition.executorArnSha256 =
        sha256(identity.Arn);
      state.activationTransitionPayload.transition.executorUserIdSha256 = sha256(
        identity.UserId,
      );
      const payload = join(state.root, 'activation-payload.json');
      const receipt = join(state.root, 'activation-receipt.json');
      writePrivate(payload, state.activationPayload);
      const signed = run([
        'sign-activation',
        '--input',
        payload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        receipt,
      ]);
      expect(signed.status, signed.stderr).toBe(0);
      const activationDigest = JSON.parse(signed.stdout).receiptSha256;
      const transitionAuthorization = signActivationTransition(
        state,
        receipt,
        activationDigest,
      );
      expect(
        transitionAuthorization.result.status,
        transitionAuthorization.result.stderr,
      ).toBe(0);
      const fake = writeFakeAws(
        state.root,
        buildLiveAwsResponses(state, activationDigest, templateBody, identity),
      );
      const common = [
        '--region',
        region,
        '--stack-name',
        stackName,
        '--aws-profile',
        'owner',
        '--activation-receipt',
        receipt,
        '--activation-transition-receipt',
        transitionAuthorization.receipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--template',
        template,
      ];
      const transitionRecord = join(state.root, 'activation-transition.json');
      const transition = runLive([
        '--mode',
        'activation-transition',
        ...common,
        '--evidence-out',
        transitionRecord,
      ], {
        NEXUS_SONAR_STACK_AWS_BIN: fake.executable,
        FAKE_AWS_RESPONSES: fake.fixture,
      });
      expect(transition.status, transition.stderr).toBe(0);
      const transitionEvidence = JSON.parse(
        readFileSync(transitionRecord, 'utf8'),
      );
      expect(transitionEvidence.authorization).toMatchObject({
        schema: 'nexus.sonarqube-aws-stack-transition-proof.v1',
        mode: 'activation-transition',
        lifecycle: null,
        activation: {
          receiptSha256: activationDigest,
          changeSetId: state.activationTransitionPayload.transition.changeSetId,
          executorArnSha256:
            state.activationTransitionPayload.transition.executorArnSha256,
          executorUserIdSha256:
            state.activationTransitionPayload.transition.executorUserIdSha256,
          cloudTrailLookupVerified: true,
          executionWithinAuthorizationWindow: true,
          successfulTransition: true,
        },
      });
      expect(transitionEvidence.postEnableCredentialProbes).toEqual({
        exactProbeProfileBindingsPassed: true,
        positiveCredentialsPassed: true,
        exactPrefixListingPassed: true,
        revokedCertificateSerialPresentInLiveCrl: true,
        revokedCertificateSerialSha256: sha256('A1B2C'),
        revokedCertificateDenied: true,
        revocationDenialClassified: true,
        revokedCredentialProcessFailed: true,
        postDenialPositiveCredentialsPassed: true,
        credentialsPersisted: false,
        rawAwsResponsesPersisted: false,
      });

      const steadyEvidence = join(state.root, 'steady-state.json');
      const steady = runLive([
        '--mode',
        'steady',
        ...common,
        '--activation-transition-record',
        transitionRecord,
        '--evidence-out',
        steadyEvidence,
      ], {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: fake.executable,
        FAKE_AWS_RESPONSES: fake.fixture,
      });
      expect(steady.status, steady.stderr).toBe(0);
      expect(JSON.parse(readFileSync(steadyEvidence, 'utf8')).authorization)
        .toMatchObject({
          mode: 'steady',
          activation: transitionEvidence.authorization.activation,
          lifecycle: null,
        });

      const revokedCertificate = join(state.root, 'revoked-certificate.pem');
      chmodSync(revokedCertificate, 0o666);
      const writableRevokedCertificate = runLive([
        '--mode',
        'steady',
        ...common,
        '--activation-transition-record',
        transitionRecord,
        '--evidence-out',
        join(state.root, 'writable-revoked-certificate.json'),
      ], {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: fake.executable,
        FAKE_AWS_RESPONSES: fake.fixture,
      });
      expect(writableRevokedCertificate.status).not.toBe(0);
      expect(writableRevokedCertificate.stderr).toContain(
        'revoked Sonar certificate is unsafe',
      );
      expect(existsSync(join(
        state.root,
        'writable-revoked-certificate.json',
      ))).toBe(false);
      chmodSync(revokedCertificate, 0o600);

      writeLiveAwsConfig(state.root, {
        revokedProfileArn: state.activationPayload.identities.restore.profileArn,
      });
      const substitutedProbeProfile = runLive([
        '--mode',
        'steady',
        ...common,
        '--activation-transition-record',
        transitionRecord,
        '--evidence-out',
        join(state.root, 'substituted-probe-profile.json'),
      ], {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: fake.executable,
        FAKE_AWS_RESPONSES: fake.fixture,
      });
      expect(substitutedProbeProfile.status).not.toBe(0);
      expect(substitutedProbeProfile.stderr).toContain(
        'credential probe --profile-arn differs from the exact stack output',
      );
      expect(existsSync(join(
        state.root,
        'substituted-probe-profile.json',
      ))).toBe(false);
      writeLiveAwsConfig(state.root);

      const absentRevokedSerial = runLive([
        '--mode',
        'steady',
        ...common,
        '--activation-transition-record',
        transitionRecord,
        '--evidence-out',
        join(state.root, 'absent-revoked-serial.json'),
      ], {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: fake.executable,
        FAKE_AWS_RESPONSES: fake.fixture,
        FAKE_OPENSSL_CRL_SERIALS: 'DEADBEEF',
      });
      expect(absentRevokedSerial.status).not.toBe(0);
      expect(absentRevokedSerial.stderr).toContain(
        'certificate serial is absent from the exact live CRL',
      );
      expect(existsSync(join(
        state.root,
        'absent-revoked-serial.json',
      ))).toBe(false);

      const genericCredentialFailure = runLive([
        '--mode',
        'steady',
        ...common,
        '--activation-transition-record',
        transitionRecord,
        '--evidence-out',
        join(state.root, 'generic-credential-failure.json'),
      ], {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: fake.executable,
        FAKE_AWS_RESPONSES: fake.fixture,
        FAKE_AWS_REVOKED_DIAGNOSTIC: 'AccessDenied: certificate revoked\n',
      });
      expect(genericCredentialFailure.status).not.toBe(0);
      expect(genericCredentialFailure.stderr).toContain(
        'was not an IAM Roles Anywhere revocation denial',
      );
      expect(existsSync(join(
        state.root,
        'generic-credential-failure.json',
      ))).toBe(false);

      const forgedRecord = join(state.root, 'forged-transition.json');
      const forged = structuredClone(transitionEvidence);
      forged.authorization.activation.changeSetId =
        `arn:aws:cloudformation:${region}:${accountId}:changeSet/other/${lifecycleChangeSetId}`;
      writePrivate(forgedRecord, forged);
      const rejected = runLive([
        '--mode',
        'steady',
        ...common,
        '--activation-transition-record',
        forgedRecord,
        '--evidence-out',
        join(state.root, 'forged-steady.json'),
      ], {
        NEXUS_SONAR_RECEIPT_NOW: '2026-07-26T13:00:00.000Z',
        NEXUS_SONAR_STACK_AWS_BIN: '/usr/bin/false',
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'transition proof does not bind a successful authorized execution',
      );
      expect(rejected.stderr).not.toContain('AWS caller identity failed');
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  }, 30_000);

  it('binds lifecycle activation to the exact immutable first-backup receipt', () => {
    const state = fixture();
    try {
      const activationPayload = join(state.root, 'activation-payload.json');
      const activationReceipt = join(state.root, 'activation-receipt.json');
      writePrivate(activationPayload, state.activationPayload);
      const signedActivation = run([
        'sign-activation',
        '--input',
        activationPayload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        activationReceipt,
      ]);
      expect(signedActivation.status, signedActivation.stderr).toBe(0);
      const activationDigest = JSON.parse(signedActivation.stdout).receiptSha256;

      const dailyRetention = {
        schemaVersion: 'SonarRetentionEvidenceV1',
        tier: 'daily',
        targetReached: false,
      };
      const weeklyRetention = {
        schemaVersion: 'SonarRetentionEvidenceV1',
        tier: 'weekly',
        targetReached: false,
      };
      const backup = {
        schemaVersion: 'SonarBackupSuccessV2',
        encrypted: true,
        remoteObjectVerified: true,
        dailyKey:
          'nexus-hub/sonarqube/daily/nexus-sonarqube-20260725T110000Z.dump.age',
        encryptedSha256: '5'.repeat(64),
        encryptedSizeBytes: 4096,
        dailyObjectVersionId: '--opaque-daily-version-✓|',
        dailyChecksumVersionId: '--opaque-checksum-version-✓|',
        weeklyUploaded: false,
        weeklyKey: null,
        weeklyObjectVersionId: null,
        weeklyChecksumVersionId: null,
        remoteVerification: {
          method: 'version-pinned-head-content-length-metadata-and-s3-sha256',
          daily: true,
          weekly: false,
        },
        retention: {
          daily: 7,
          weekly: 4,
          basis: 'distinct-utc-days-and-iso-weeks',
        },
        retentionEvidence: {
          daily: dailyRetention,
          weekly: weeklyRetention,
        },
        completedAt: '2026-07-25T11:30:00.000Z',
      };
      const backupReceipt = join(state.root, 'last-backup-success.v2.json');
      writePrivate(backupReceipt, backup);
      const backupBytes = readFileSync(backupReceipt);
      const lifecyclePayload = {
        schema: 'nexus.sonarqube-lifecycle-bootstrap.v1',
        ownerAuthorization: 'explicit',
        issuedAt: '2026-07-25T11:55:00.000Z',
        expiresAt: '2026-07-25T13:00:00.000Z',
        signingKeyId: keyId,
        signingPublicKeySha256: state.publicKeySha256,
        stack: state.stack,
        activationReceiptSha256: activationDigest,
        controls: {
          dailyNoncurrentDays: 35,
          expectedLifecycleActivation: 'ENABLED',
          expectedRolesAnywhereActivation: 'ENABLED',
          visibleDailyPoints: 7,
          visibleWeeklyPoints: 4,
          weeklyNoncurrentDays: 120,
        },
        firstBackup: {
          successReceiptSha256: sha256(backupBytes),
          completedAt: backup.completedAt,
          dailyKey: backup.dailyKey,
          dailyObjectVersionId: backup.dailyObjectVersionId,
          dailyChecksumVersionId: backup.dailyChecksumVersionId,
          encryptedSha256: backup.encryptedSha256,
          encryptedSizeBytes: backup.encryptedSizeBytes,
          remoteObjectVerified: true,
          dailyRetentionEvidenceSha256: sha256(canonicalJson(dailyRetention)),
          weeklyRetentionEvidenceSha256: sha256(canonicalJson(weeklyRetention)),
        },
      };
      const payload = join(state.root, 'lifecycle-payload.json');
      const receipt = join(state.root, 'lifecycle-receipt.json');
      writePrivate(payload, lifecyclePayload);
      const signed = run([
        'sign-lifecycle',
        '--input',
        payload,
        '--backup-success-receipt',
        backupReceipt,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        receipt,
      ]);
      expect(signed.status, signed.stderr).toBe(0);
      const verified = run([
        'verify-lifecycle',
        '--input',
        receipt,
        '--backup-success-receipt',
        backupReceipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
      ]);
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        ok: true,
        kind: 'lifecycle',
        payload: lifecyclePayload,
      });
      const lifecycleTransitionPayload = {
        schema: 'nexus.sonarqube-stack-transition-authorization.v1',
        ownerAuthorization: 'explicit',
        issuedAt: '2026-07-25T11:55:00.000Z',
        expiresAt: '2026-07-25T13:00:00.000Z',
        signingKeyId: keyId,
        signingPublicKeySha256: state.publicKeySha256,
        stack: state.stack,
        kind: 'lifecycle',
        receiptSha256: JSON.parse(signed.stdout).receiptSha256,
        transition: {
          changeSetId:
            `arn:aws:cloudformation:${region}:${accountId}:changeSet/enable-sonar-lifecycle/${lifecycleChangeSetId}`,
          executorArnSha256: '6'.repeat(64),
          executorUserIdSha256: '7'.repeat(64),
          priorStack: {
            capturedAt: '2026-07-25T11:54:00.000Z',
            stackId:
              `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/${stackInstanceId}`,
            stackStatus: 'UPDATE_COMPLETE',
            rolesAnywhereActivation: 'ENABLED',
            rolesAnywhereActivationReceiptSha256: activationDigest,
            lifecycleActivation: 'DISABLED',
            lifecycleBootstrapReceiptSha256: '',
            protectedMainTemplateSha256: state.stack.templateSha256,
            ownerReceiptKeyId: keyId,
            ownerReceiptPublicKeySha256: state.publicKeySha256,
          },
        },
      };
      const transitionPayload = join(state.root, 'lifecycle-transition-payload.json');
      const transitionReceipt = join(state.root, 'lifecycle-transition-receipt.json');
      writePrivate(transitionPayload, lifecycleTransitionPayload);
      const signedTransition = run([
        'sign-transition',
        '--kind',
        'lifecycle',
        '--input',
        transitionPayload,
        '--receipt',
        receipt,
        '--backup-success-receipt',
        backupReceipt,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        transitionReceipt,
      ]);
      expect(signedTransition.status, signedTransition.stderr).toBe(0);
      const verifiedTransition = run([
        'verify-transition',
        '--kind',
        'lifecycle',
        '--input',
        transitionReceipt,
        '--receipt',
        receipt,
        '--backup-success-receipt',
        backupReceipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
      ]);
      expect(verifiedTransition.status, verifiedTransition.stderr).toBe(0);
      expect(JSON.parse(verifiedTransition.stdout)).toMatchObject({
        ok: true,
        kind: 'transition',
        transitionKind: 'lifecycle',
        payload: lifecycleTransitionPayload,
      });

      const substitutedBackup = join(state.root, 'substituted-backup.json');
      writePrivate(substitutedBackup, { ...backup, encryptedSizeBytes: 4097 });
      const rejected = run([
        'verify-lifecycle',
        '--input',
        receipt,
        '--backup-success-receipt',
        substitutedBackup,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'does not bind the exact first-backup success receipt',
      );
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('inspects the exact activation change set through the bounded fake AWS boundary', () => {
    const state = fixture();
    try {
      const controllerClock = new Date();
      const controllerClockIso = controllerClock.toISOString();
      const controllerIssuedAt = new Date(
        controllerClock.getTime() - 60_000,
      ).toISOString();
      const controllerCapturedAt = new Date(
        controllerClock.getTime() - 120_000,
      ).toISOString();
      const controllerExpiresAt = new Date(
        controllerClock.getTime() + 60 * 60_000,
      ).toISOString();
      state.activationPayload.issuedAt = controllerIssuedAt;
      state.activationPayload.expiresAt = controllerExpiresAt;
      state.activationTransitionPayload.issuedAt = controllerIssuedAt;
      state.activationTransitionPayload.expiresAt = controllerExpiresAt;
      state.activationTransitionPayload.transition.priorStack.capturedAt =
        controllerCapturedAt;
      const templateBody = readFileSync(
        resolve('ops/sonarqube/aws-s3-stack.yaml'),
        'utf8',
      );
      const templateSha256 = sha256(templateBody);
      state.stack.templateSha256 = templateSha256;
      state.activationTransitionPayload.transition.priorStack
        .protectedMainTemplateSha256 = templateSha256;
      const identity = {
        Account: accountId,
        Arn:
          `arn:aws:sts::${accountId}:assumed-role/`
          + 'AWSReservedSSO_NexusSonarOwner/test-session',
        UserId: 'AROANEXUSOWNER:test-session',
      };
      state.activationTransitionPayload.transition.executorArnSha256 =
        sha256(identity.Arn);
      state.activationTransitionPayload.transition.executorUserIdSha256 =
        sha256(identity.UserId);

      const activationPayload = join(state.root, 'controller-activation.json');
      const activationReceipt = join(
        state.root,
        'controller-activation-receipt.json',
      );
      writePrivate(activationPayload, state.activationPayload);
      const activationSigned = run([
        'sign-activation',
        '--input',
        activationPayload,
        '--private-key',
        state.privateKey,
        '--key-id',
        keyId,
        '--output',
        activationReceipt,
      ], { NEXUS_SONAR_RECEIPT_NOW: controllerClockIso });
      expect(activationSigned.status, activationSigned.stderr).toBe(0);
      const activationDigest = JSON.parse(
        activationSigned.stdout,
      ).receiptSha256 as string;
      const transition = signActivationTransition(
        state,
        activationReceipt,
        activationDigest,
        { NEXUS_SONAR_RECEIPT_NOW: controllerClockIso },
      );
      expect(transition.result.status, transition.result.stderr).toBe(0);

      const responses = buildLiveAwsResponses(
        state,
        activationDigest,
        templateBody,
        identity,
      ) as Record<string, any>;
      const changeSet = responses['cloudformation describe-change-set'];
      const priorParameters = structuredClone(changeSet.Parameters);
      for (const parameter of priorParameters) {
        if (parameter.ParameterKey === 'RolesAnywhereActivation') {
          parameter.ParameterValue = 'DISABLED';
        }
        if (
          parameter.ParameterKey
          === 'RolesAnywhereActivationReceiptSha256'
        ) {
          parameter.ParameterValue = '';
        }
      }
      const stack = responses['cloudformation describe-stacks'].Stacks[0];
      stack.StackStatus = 'CREATE_COMPLETE';
      stack.Parameters = priorParameters;
      stack.NotificationARNs = [];
      stack.Tags = [];
      changeSet.ExecutionStatus = 'AVAILABLE';
      changeSet.Capabilities = ['CAPABILITY_IAM'];
      changeSet.IncludeNestedStacks = false;
      changeSet.ImportExistingResources = false;
      changeSet.NotificationARNs = [];
      changeSet.Tags = [];
      changeSet.Changes = Object.entries({
        SonarBackupBucket: 'AWS::S3::Bucket',
        SonarBackupRole: 'AWS::IAM::Role',
        SonarRestoreRole: 'AWS::IAM::Role',
        SonarBackupRolesAnywhereProfile: 'AWS::RolesAnywhere::Profile',
        SonarRestoreRolesAnywhereProfile: 'AWS::RolesAnywhere::Profile',
        SonarRolesAnywhereTrustAnchor: 'AWS::RolesAnywhere::TrustAnchor',
        SonarRolesAnywhereCertificateRevocationList:
          'AWS::RolesAnywhere::CRL',
      }).map(([LogicalResourceId, ResourceType]) => ({
        Type: 'Resource',
        ResourceChange: {
          Action: 'Modify',
          LogicalResourceId,
          Replacement: 'False',
          ResourceType,
        },
      }));
      const fakeAws = writeFakeAws(state.root, responses);

      const ownerConfig = join(state.root, 'controller-owner-aws-config');
      writePrivate(
        ownerConfig,
        `[profile owner]\n`
        + `region = ${region}\n`
        + `sso_account_id = ${accountId}\n`
        + 'sso_role_name = NexusSonarOwner\n'
        + 'sso_start_url = https://example.awsapps.com/start\n',
      );
      const probeConfig = join(state.root, 'controller-probe-aws-config');
      writePrivate(probeConfig, '[profile unused]\nregion = eu-west-1\n');
      const signingHelper = join(state.root, 'aws-signing-helper');
      writePrivate(signingHelper, '#!/bin/sh\nexit 1\n');
      chmodSync(signingHelper, 0o700);
      const pythonWrapper = join(state.root, 'python3');
      writePrivate(pythonWrapper, '#!/bin/sh\nexec /usr/bin/python3 "$@"\n');
      chmodSync(pythonWrapper, 0o700);
      const opensslBin = writeFakeOpenSsl(state.root);
      const nodeArguments = join(state.root, 'node-arguments.json');
      const nodeWrapper = join(state.root, 'node-wrapper');
      writePrivate(nodeWrapper, `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(nodeArguments)}, JSON.stringify({
  args,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  nodePath: process.env.NODE_PATH ?? null,
}));
const result = spawnSync(${JSON.stringify(process.execPath)}, args, {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
`);
      chmodSync(nodeWrapper, 0o700);
      const reviewReceipt = join(state.root, 'activation-review.json');

      const controllerArgs = [
        activationController,
        '--operation',
        'inspect',
        '--transition',
        'roles-anywhere',
        '--stack-id',
        state.activationTransitionPayload.transition.priorStack.stackId,
        '--stack-name',
        stackName,
        '--change-set-id',
        state.activationTransitionPayload.transition.changeSetId,
        '--region',
        region,
        '--expected-template-sha256',
        templateSha256,
        '--aws-bin',
        fakeAws.executable,
        '--aws-config',
        ownerConfig,
        '--aws-profile',
        'owner',
        '--node-bin',
        nodeWrapper,
        '--python-bin',
        pythonWrapper,
        '--openssl-bin',
        opensslBin,
        '--receipt-helper',
        helper,
        '--base-receipt',
        activationReceipt,
        '--transition-receipt',
        transition.receipt,
        '--public-key',
        state.publicKey,
        '--key-id',
        keyId,
        '--review-receipt',
        reviewReceipt,
        '--probe-aws-config',
        probeConfig,
        '--backup-probe-profile',
        'nexus-sonarqube-backup',
        '--revoked-probe-profile',
        'nexus-sonarqube-revoked-probe',
        '--credential-boundary-helper',
        resolve('scripts/aws-credential-process-boundary.py'),
        '--aws-signing-helper',
        signingHelper,
        '--aws-signing-helper-sha256',
        sha256(readFileSync(signingHelper)),
        '--expected-owner-uid',
        String(process.getuid?.() ?? 0),
        '--trust-boundary',
        '/',
        '--command-timeout-seconds',
        '10',
      ];
      const inspected = spawnSync('/usr/bin/python3', controllerArgs, {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '--require /definitely/not/a/real/module.cjs',
          NODE_PATH: '/hostile/node/path',
        },
      });
      expect(inspected.status, inspected.stderr).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        ok: true,
        operation: 'inspect',
        schemaVersion: 'NexusSonarCloudFormationActivationReviewV1',
      });
      expect(JSON.parse(readFileSync(nodeArguments, 'utf8'))).toEqual({
        args: [
          helper,
          'verify-transition',
          '--kind',
          'activation',
          '--input',
          transition.receipt,
          '--receipt',
          activationReceipt,
          '--public-key',
          state.publicKey,
          '--key-id',
          keyId,
        ],
        nodeOptions: null,
        nodePath: null,
      });
      expect(JSON.parse(readFileSync(reviewReceipt, 'utf8'))).toMatchObject({
        transition: 'roles-anywhere',
        stackId:
          state.activationTransitionPayload.transition.priorStack.stackId,
        changeSetId:
          state.activationTransitionPayload.transition.changeSetId,
        rollbackConfiguration: {
          monitoringTimeInMinutes: 15,
          rollbackTriggers: [{
            Type: 'AWS::CloudWatch::Alarm',
          }],
        },
      });

      rmSync(reviewReceipt);
      changeSet.RollbackConfiguration.MonitoringTimeInMinutes = 14;
      writePrivate(fakeAws.fixture, responses);
      const rejected = spawnSync('/usr/bin/python3', controllerArgs, {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '--require /definitely/not/a/real/module.cjs',
          NODE_PATH: '/hostile/node/path',
        },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'change set does not use the exact transition rollback configuration',
      );
      expect(existsSync(reviewReceipt)).toBe(false);

      changeSet.RollbackConfiguration.MonitoringTimeInMinutes = 15;
      stack.StackStatus = 'UPDATE_IN_PROGRESS';
      writePrivate(fakeAws.fixture, responses);
      const activeStackRejected = spawnSync('/usr/bin/python3', controllerArgs, {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '--require /definitely/not/a/real/module.cjs',
          NODE_PATH: '/hostile/node/path',
        },
      });
      expect(activeStackRejected.status).not.toBe(0);
      expect(activeStackRejected.stderr).toContain(
        'stack identity, status, rollback, or termination protection is unsafe',
      );
      expect(existsSync(reviewReceipt)).toBe(false);
    } finally {
      rmSync(state.root, { force: true, recursive: true });
    }
  });

  it('keeps the live verifier read-only, pagination-complete, and root-private', () => {
    const source = readFileSync(liveVerifier, 'utf8');
    expect(source).toContain('const READ_ONLY_COMMANDS = new Set([');
    expect(source).toContain("'cloudformation describe-change-set'");
    expect(source).toContain("'cloudtrail lookup-events'");
    expect(source).toContain('manualTokenPages');
    expect(source).toContain("'--starting-token'");
    expect(source).not.toContain("'--next-token'");
    expect(source).not.toContain("'--marker'");
    expect(source).toContain('CloudFormation stack contains unexpected resources');
    expect(source).toContain(
      'CloudFormation parameters contain unexpected or missing entries',
    );
    expect(source).toContain('CloudFormation outputs contain unexpected or missing entries');
    expect(source).toContain('has unexpected tags');
    expect(source.match(/'--expected-bucket-owner'/g)).toHaveLength(8);
    expect(source).toContain('IAM role has attached policies');
    expect(source).toContain('mutableCurrentRestoreAccessAbsent: true');
    expect(source).toContain(
      "options.mode !== 'activation-transition'",
    );
    expect(source).toContain('readTransitionRecord(');
    expect(source).toContain('executionWithinAuthorizationWindow: true');
    expect(source).toContain('live Sonar stack evidence must be produced as root');
    expect(source).toContain('evidence parent must be root-owned mode 0700');
    expect(source).toContain('linkSync(temporary, output)');
    expect(source).not.toContain('renameSync(temporary, output)');
    expect(source).not.toMatch(
      /['"](?:cloudformation|iam|rolesanywhere|s3api) (?:create|update|delete|put|enable|disable|tag|untag|attach|detach|import)-/u,
    );
  });

  it('contains no duplicate string keys in controller result or journal dictionaries', () => {
    const checked = spawnSync('/usr/bin/python3', [
      '-c',
      `import ast
import sys
source = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(source, filename=sys.argv[1])
duplicates = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Dict):
        continue
    keys = {}
    for key in node.keys:
        if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
            continue
        if key.value in keys:
            duplicates.append((node.lineno, key.value, keys[key.value]))
        else:
            keys[key.value] = getattr(key, "lineno", node.lineno)
if duplicates:
    print(duplicates, file=sys.stderr)
    raise SystemExit(1)
`,
      activationController,
    ], { encoding: 'utf8' });
    expect(checked.status, checked.stderr).toBe(0);
  });
});
