import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const helper = resolve('scripts/application-dr-crl-parameters.mjs');
const issuerCn = 'Nexus Test CA';
const accountId = '111122223333';
const region = 'eu-west-1';
const trustAnchorId = '11111111-2222-3333-4444-555555555555';
const trustAnchorArn =
  `arn:aws:rolesanywhere:${region}:${accountId}:trust-anchor/${trustAnchorId}`;
const backupProfileId = '22222222-3333-4444-5555-666666666666';
const restoreProfileId = '33333333-4444-5555-6666-777777777777';
const backupProfileArn =
  `arn:aws:rolesanywhere:${region}:${accountId}:profile/${backupProfileId}`;
const restoreProfileArn =
  `arn:aws:rolesanywhere:${region}:${accountId}:profile/${restoreProfileId}`;
const crlId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const crlName = 'nexus-application-dr-crl';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactCrl(size: number, marker = ''): Buffer {
  const begin = Buffer.from('-----BEGIN X509 CRL-----\n', 'ascii');
  const end = Buffer.from('\n-----END X509 CRL-----\n', 'ascii');
  const markerBytes = Buffer.from(marker, 'ascii');
  const fillerLength = size - begin.length - end.length - markerBytes.length;
  if (fillerLength < 0) throw new Error('requested CRL fixture is too small');
  return Buffer.concat([
    begin,
    markerBytes,
    Buffer.alloc(fillerLength, 0x41),
    end,
  ]);
}

function writeGoverned(path: string, bytes: Buffer | string): void {
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function createFixtureRoot(stem: string) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), stem));
  chmodSync(root, 0o700);
  const ca = join(root, 'ca.pem');
  writeGoverned(
    ca,
    '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
  );
  return { root, ca };
}

function writeFakeOpenSsl(root: string): string {
  const path = join(root, 'fake-openssl');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const pathModule = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'x509') {
  process.stdout.write(Buffer.from('DER-NEXUS-TEST-CA'));
  process.exit(0);
}
if (args[0] !== 'crl') process.exit(91);
const inputIndex = args.indexOf('-in');
const input = inputIndex >= 0 ? pathModule.basename(args[inputIndex + 1]) : '';
const prior = input.includes('prior');
const sameNumber = input.includes('same-number');
const dropsSerial = input.includes('drops');
const number = prior || sameNumber ? '0x1' : '0x2';
const lastUpdate = prior
  ? 'Jan 01 00:00:00 2020 GMT'
  : 'Jan 02 00:00:00 2020 GMT';
const serials = prior
  ? ['AA', 'BB']
  : dropsSerial
    ? ['AA']
    : ['AA', 'BB', 'CC'];
if (args.includes('-text')) {
  process.stdout.write(
    serials.map(serial => '    Serial Number: ' + serial + '\\n').join(''),
  );
} else {
  process.stdout.write(
    'issuer=\\n'
      + '    CN = ${issuerCn}\\n'
      + 'lastUpdate=' + lastUpdate + '\\n'
      + 'nextUpdate=Jan 01 00:00:00 2099 GMT\\n'
      + 'crlNumber=' + number + '\\n',
  );
}
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

function writeFakeAws(root: string): string {
  const path = join(root, 'fake-aws');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const localCrl = fs.readFileSync(process.env.FAKE_CRL_PATH);
const liveCrl = fs.readFileSync(
  process.env.FAKE_LIVE_CRL_PATH || process.env.FAKE_CRL_PATH,
);
const localDigest = crypto.createHash('sha256').update(localCrl).digest('hex');
const command = args.slice(0, 2).join(' ');
let value;
if (command === 'sts get-caller-identity') {
  value = {
    Account: '${accountId}',
    Arn: 'arn:aws:sts::${accountId}:assumed-role/owner-sso/test-session',
    UserId: 'AROATEST:owner-session',
  };
} else if (command === 'rolesanywhere get-trust-anchor') {
  value = {
    trustAnchor: {
      trustAnchorArn:
        process.env.FAKE_RESPONSE_ANCHOR_ARN || process.env.FAKE_ANCHOR_ARN,
      trustAnchorId: '${trustAnchorId}',
      enabled:
        process.env.FAKE_RESPONSE_ANCHOR_ENABLED === undefined
          ? true
          : process.env.FAKE_RESPONSE_ANCHOR_ENABLED === 'true',
      source: {
        sourceType: 'CERTIFICATE_BUNDLE',
        sourceData: {
          x509CertificateData: fs.readFileSync(process.env.FAKE_CA_PATH, 'ascii'),
        },
      },
    },
  };
} else if (command === 'rolesanywhere get-profile') {
  const profileId = args[args.indexOf('--profile-id') + 1];
  const backup = profileId === '${backupProfileId}';
  const restore = profileId === '${restoreProfileId}';
  if (!backup && !restore) process.exit(93);
  const kind = backup ? 'BACKUP' : 'RESTORE';
  value = {
    profile: {
      profileId:
        process.env['FAKE_RESPONSE_' + kind + '_PROFILE_ID'] || profileId,
      profileArn:
        process.env['FAKE_RESPONSE_' + kind + '_PROFILE_ARN']
          || (backup ? '${backupProfileArn}' : '${restoreProfileArn}'),
      name: backup
        ? 'nexus-application-dr-backup'
        : 'nexus-application-dr-restore',
      enabled:
        process.env['FAKE_RESPONSE_' + kind + '_PROFILE_ENABLED'] === undefined
          ? true
          : process.env['FAKE_RESPONSE_' + kind + '_PROFILE_ENABLED'] === 'true',
      updatedAt: '2026-07-24T20:00:00.000Z',
    },
  };
} else if (command === 'rolesanywhere get-crl') {
  value = {
    crl: {
      crlId: process.env.FAKE_RESPONSE_CRL_ID || '${crlId}',
      crlArn:
        'arn:aws:rolesanywhere:${region}:${accountId}:crl/${crlId}',
      name: '${crlName}',
      trustAnchorArn: process.env.FAKE_ANCHOR_ARN,
      enabled:
        process.env.FAKE_RESPONSE_ENABLED === undefined
          ? true
          : process.env.FAKE_RESPONSE_ENABLED === 'true',
      crlData: liveCrl.toString('base64'),
      updatedAt: '2026-07-24T20:00:00.000Z',
    },
  };
} else if (command === 'rolesanywhere list-tags-for-resource') {
  value = {
    tags: [{
      key: 'crl-sha256',
      value: process.env.FAKE_TAG_DIGEST || localDigest,
    }],
  };
} else {
  process.stderr.write('unexpected or mutating AWS command: ' + command + '\\n');
  process.exit(92);
}
process.stdout.write(JSON.stringify(value));
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

function testEnvironment(
  fakeOpenSsl: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    NEXUS_APPLICATION_DR_CRL_TEST_MODE: '1',
    NEXUS_APPLICATION_DR_CRL_OPENSSL_BIN: fakeOpenSsl,
    ...overrides,
  };
}

function runHelper(
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env,
  });
}

function generateArgs(
  ca: string,
  crl: string,
  parametersOut: string,
  evidenceOut: string,
  operation: 'bootstrap' | 'rotate' = 'bootstrap',
  priorCrl?: string,
): string[] {
  return [
    'generate',
    '--operation',
    operation,
    '--issuer-cn',
    issuerCn,
    '--ca-certificate',
    ca,
    '--crl',
    crl,
    ...(priorCrl ? ['--prior-crl', priorCrl] : []),
    '--parameters-out',
    parametersOut,
    '--evidence-out',
    evidenceOut,
  ];
}

function verifyArgs(
  ca: string,
  crl: string,
  parameterEvidence: string,
  evidenceOut: string,
  expectedEnabled = true,
): string[] {
  return [
    'verify',
    '--region',
    region,
    '--trust-anchor-arn',
    trustAnchorArn,
    '--backup-profile-arn',
    backupProfileArn,
    '--restore-profile-arn',
    restoreProfileArn,
    '--crl-id',
    crlId,
    '--name',
    crlName,
    '--expected-enabled',
    String(expectedEnabled),
    '--issuer-cn',
    issuerCn,
    '--ca-certificate',
    ca,
    '--crl',
    crl,
    '--parameter-evidence',
    parameterEvidence,
    '--aws-profile',
    'owner-sso',
    '--evidence-out',
    evidenceOut,
  ];
}

function readAwsLog(path: string): string[][] {
  const body = readFileSync(path, 'utf8');
  return body
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expectReadOnlyAwsCommands(commands: string[][]): void {
  const commandNames = commands.map((args) => args.slice(0, 2).join(' '));
  expect(commandNames).toEqual([
    'sts get-caller-identity',
    'rolesanywhere get-trust-anchor',
    'rolesanywhere get-profile',
    'rolesanywhere get-profile',
    'rolesanywhere get-crl',
    'rolesanywhere list-tags-for-resource',
  ]);
  const forbidden = new Set([
    'import-crl',
    'update-crl',
    'enable-crl',
    'disable-crl',
    'delete-crl',
    'tag-resource',
    'untag-resource',
  ]);
  expect(commands.some((args) => forbidden.has(args[1]))).toBe(false);
}

describe('application DR CRL CloudFormation parameter helper', () => {
  for (const size of [4097, 300_000]) {
    it(`emits 74 explicit chunks that reassemble a ${size}-byte CRL exactly`, () => {
      const { root, ca } = createFixtureRoot(`nexus-crl-${size}-`);
      try {
        const fakeOpenSsl = writeFakeOpenSsl(root);
        const crl = join(root, `crl-${size}.pem`);
        const parameters = join(root, 'parameters.json');
        const evidence = join(root, 'evidence.json');
        const crlBytes = exactCrl(size);
        writeGoverned(crl, crlBytes);

        const first = runHelper(
          generateArgs(ca, crl, parameters, evidence),
          testEnvironment(fakeOpenSsl),
        );
        expect(first.status, first.stderr).toBe(0);

        const values = JSON.parse(readFileSync(parameters, 'utf8'));
        const chunks = values.slice(0, 74);
        expect(values).toHaveLength(75);
        expect(chunks).toHaveLength(74);
        expect(chunks.map((item: { ParameterKey: string }) => item.ParameterKey))
          .toEqual(
            Array.from(
              { length: 74 },
              (_, index) =>
                `CertificateRevocationListData${String(index + 1).padStart(3, '0')}`,
            ),
          );
        expect(
          chunks.every(
            (item: Record<string, unknown>) =>
              typeof item.ParameterValue === 'string'
              && !Object.hasOwn(item, 'UsePreviousValue'),
          ),
        ).toBe(true);
        const reassembled = Buffer.from(
          chunks
            .map((item: { ParameterValue: string }) => item.ParameterValue)
            .join(''),
          'ascii',
        );
        expect(reassembled.equals(crlBytes)).toBe(true);
        expect(values[74]).toEqual({
          ParameterKey: 'CertificateRevocationListSha256',
          ParameterValue: sha256(crlBytes),
        });
        expect(Buffer.byteLength(chunks[0].ParameterValue, 'ascii')).toBe(4096);
        if (size === 300_000) {
          expect(
            chunks
              .slice(0, 73)
              .every(
                (item: { ParameterValue: string }) =>
                  Buffer.byteLength(item.ParameterValue, 'ascii') === 4096,
              ),
          ).toBe(true);
          expect(Buffer.byteLength(chunks[73].ParameterValue, 'ascii')).toBe(992);
        } else {
          expect(Buffer.byteLength(chunks[1].ParameterValue, 'ascii')).toBe(1);
          expect(
            chunks
              .slice(2)
              .every(
                (item: { ParameterValue: string }) =>
                  item.ParameterValue.length === 0,
              ),
          ).toBe(true);
        }

        const proof = JSON.parse(readFileSync(evidence, 'utf8'));
        expect(proof).toMatchObject({
          schema: 'nexus.application-dr-crl-parameters.v1',
          operation: 'bootstrap',
          chunkCount: 74,
          maximumCrlBytes: 300_000,
          allChunkValuesExplicit: true,
          usePreviousValueForbidden: true,
          reassemblyVerified: true,
          crl: {
            bytes: size,
            sha256: sha256(crlBytes),
          },
        });
        expect(statSync(parameters).mode & 0o777).toBe(0o600);
        expect(statSync(evidence).mode & 0o777).toBe(0o600);

        const parametersBefore = readFileSync(parameters);
        const evidenceBefore = readFileSync(evidence);
        const overwrite = runHelper(
          generateArgs(ca, crl, parameters, evidence),
          testEnvironment(fakeOpenSsl),
        );
        expect(overwrite.status).not.toBe(0);
        expect(overwrite.stderr).toContain('already exists; refusing to overwrite');
        expect(readFileSync(parameters).equals(parametersBefore)).toBe(true);
        expect(readFileSync(evidence).equals(evidenceBefore)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('rejects a 300,001-byte CRL before creating outputs', () => {
    const { root, ca } = createFixtureRoot('nexus-crl-oversize-');
    try {
      const fakeOpenSsl = writeFakeOpenSsl(root);
      const crl = join(root, 'oversize.pem');
      const parameters = join(root, 'parameters.json');
      const evidence = join(root, 'evidence.json');
      writeGoverned(crl, exactCrl(300_001));

      const result = runHelper(
        generateArgs(ca, crl, parameters, evidence),
        testEnvironment(fakeOpenSsl),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CRL size must be from 1 through 300000 bytes');
      expect(existsSync(parameters)).toBe(false);
      expect(existsSync(evidence)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked, private-key-bearing, and non-ASCII CRL inputs', () => {
    const { root, ca } = createFixtureRoot('nexus-crl-hostile-');
    try {
      const fakeOpenSsl = writeFakeOpenSsl(root);
      const real = join(root, 'real.pem');
      const symlink = join(root, 'symlink.pem');
      writeGoverned(real, exactCrl(4097));
      symlinkSync(real, symlink);

      const privateKey = join(root, 'private-key.pem');
      writeGoverned(privateKey, exactCrl(4097, 'PRIVATE KEY'));

      const nonAscii = join(root, 'non-ascii.pem');
      const nonAsciiBytes = exactCrl(4097);
      nonAsciiBytes[100] = 0x80;
      writeGoverned(nonAscii, nonAsciiBytes);

      for (const [name, path, expected] of [
        ['symlink', symlink, 'path must be canonical and non-symlinked'],
        ['private', privateKey, 'must never contain private key material'],
        ['non-ascii', nonAscii, 'must contain only non-NUL ASCII bytes'],
      ] as const) {
        const result = runHelper(
          generateArgs(
            ca,
            path,
            join(root, `${name}-parameters.json`),
            join(root, `${name}-evidence.json`),
          ),
          testEnvironment(fakeOpenSsl),
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires rotation to increase the CRL number and preserve revoked serials', () => {
    const { root, ca } = createFixtureRoot('nexus-crl-rotation-');
    try {
      const fakeOpenSsl = writeFakeOpenSsl(root);
      const prior = join(root, 'prior.pem');
      const good = join(root, 'target-good.pem');
      const sameNumber = join(root, 'target-same-number.pem');
      const drops = join(root, 'target-drops.pem');
      for (const path of [prior, good, sameNumber, drops]) {
        writeGoverned(path, exactCrl(4097));
      }

      const success = runHelper(
        generateArgs(
          ca,
          good,
          join(root, 'good-parameters.json'),
          join(root, 'good-evidence.json'),
          'rotate',
          prior,
        ),
        testEnvironment(fakeOpenSsl),
      );
      expect(success.status, success.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(root, 'good-evidence.json'), 'utf8')),
      ).toMatchObject({
        operation: 'rotate',
        crl: {
          crlNumber: '0x2',
          revokedSerialCount: 3,
        },
        prior: {
          crlNumber: '0x1',
          revokedSerialCount: 2,
        },
      });

      const nonIncreasing = runHelper(
        generateArgs(
          ca,
          sameNumber,
          join(root, 'same-parameters.json'),
          join(root, 'same-evidence.json'),
          'rotate',
          prior,
        ),
        testEnvironment(fakeOpenSsl),
      );
      expect(nonIncreasing.status).not.toBe(0);
      expect(nonIncreasing.stderr).toContain('rotation CRL number must increase');

      const losesRevocation = runHelper(
        generateArgs(
          ca,
          drops,
          join(root, 'drops-parameters.json'),
          join(root, 'drops-evidence.json'),
          'rotate',
          prior,
        ),
        testEnvironment(fakeOpenSsl),
      );
      expect(losesRevocation.status).not.toBe(0);
      expect(losesRevocation.stderr).toContain(
        'rotation CRL must retain every previously revoked serial',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('verifies exact live identity, bytes, tag, and enabled state read-only', () => {
    const { root, ca } = createFixtureRoot('nexus-crl-live-');
    try {
      const fakeOpenSsl = writeFakeOpenSsl(root);
      const fakeAws = writeFakeAws(root);
      const crl = join(root, 'crl-live.pem');
      const parameters = join(root, 'parameters.json');
      const parameterEvidence = join(root, 'parameter-evidence.json');
      const awsLog = join(root, 'aws-commands.jsonl');
      writeGoverned(crl, exactCrl(4097));
      writeGoverned(awsLog, '');

      const generated = runHelper(
        generateArgs(ca, crl, parameters, parameterEvidence),
        testEnvironment(fakeOpenSsl),
      );
      expect(generated.status, generated.stderr).toBe(0);
      expect(lstatSync(parameterEvidence).mode & 0o777).toBe(0o600);

      const baseAwsEnvironment = testEnvironment(fakeOpenSsl, {
        NEXUS_APPLICATION_DR_CRL_AWS_BIN: fakeAws,
        FAKE_AWS_LOG: awsLog,
        FAKE_CA_PATH: ca,
        FAKE_CRL_PATH: crl,
        FAKE_ANCHOR_ARN: trustAnchorArn,
      });
      const liveEvidence = join(root, 'live-evidence.json');
      const verified = runHelper(
        verifyArgs(ca, crl, parameterEvidence, liveEvidence),
        baseAwsEnvironment,
      );
      expect(verified.status, verified.stderr).toBe(0);
      const value = JSON.parse(readFileSync(liveEvidence, 'utf8'));
      expect(value).toMatchObject({
        schema: 'nexus.application-dr-crl-live-verification.v1',
        region,
        accountId,
        trustAnchorArn,
        trustAnchorId,
        trustAnchorEnabled: true,
        backupProfileArn,
        backupProfileId,
        backupProfileEnabled: true,
        restoreProfileArn,
        restoreProfileId,
        restoreProfileEnabled: true,
        crlId,
        crlName,
        crlEnabled: true,
        crlSha256: sha256(readFileSync(crl)),
        crlBytes: 4097,
        exactBytesVerified: true,
        digestTagVerified: true,
      });
      expect(statSync(liveEvidence).mode & 0o777).toBe(0o600);
      expectReadOnlyAwsCommands(readAwsLog(awsLog));

      writeGoverned(awsLog, '');
      const disabledEvidence = join(root, 'disabled-live-evidence.json');
      const disabled = runHelper(
        verifyArgs(ca, crl, parameterEvidence, disabledEvidence, false),
        {
          ...baseAwsEnvironment,
          FAKE_RESPONSE_ANCHOR_ENABLED: 'false',
          FAKE_RESPONSE_BACKUP_PROFILE_ENABLED: 'false',
          FAKE_RESPONSE_RESTORE_PROFILE_ENABLED: 'false',
          FAKE_RESPONSE_ENABLED: 'false',
        },
      );
      expect(disabled.status, disabled.stderr).toBe(0);
      expect(JSON.parse(readFileSync(disabledEvidence, 'utf8'))).toMatchObject({
        trustAnchorEnabled: false,
        backupProfileEnabled: false,
        restoreProfileEnabled: false,
        crlEnabled: false,
      });
      expectReadOnlyAwsCommands(readAwsLog(awsLog));

      const evidenceBefore = readFileSync(liveEvidence);
      writeGoverned(awsLog, '');
      const overwrite = runHelper(
        verifyArgs(ca, crl, parameterEvidence, liveEvidence),
        baseAwsEnvironment,
      );
      expect(overwrite.status).not.toBe(0);
      expect(overwrite.stderr).toContain('already exists; refusing to overwrite');
      expect(readFileSync(liveEvidence).equals(evidenceBefore)).toBe(true);
      expectReadOnlyAwsCommands(readAwsLog(awsLog));

      const wrongBytes = join(root, 'wrong-live.pem');
      writeGoverned(wrongBytes, exactCrl(4098));
      const mismatches: Array<[string, NodeJS.ProcessEnv, string]> = [
        [
          'id',
          { FAKE_RESPONSE_CRL_ID: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' },
          'live CRL identity or enabled state is mismatched',
        ],
        [
          'anchor',
          {
            FAKE_RESPONSE_ANCHOR_ARN:
              `arn:aws:rolesanywhere:${region}:${accountId}:trust-anchor/`
              + '99999999-8888-7777-6666-555555555555',
          },
          'live trust anchor identity or enabled state is mismatched',
        ],
        [
          'anchor-enabled',
          { FAKE_RESPONSE_ANCHOR_ENABLED: 'false' },
          'live trust anchor identity or enabled state is mismatched',
        ],
        [
          'backup-profile-enabled',
          { FAKE_RESPONSE_BACKUP_PROFILE_ENABLED: 'false' },
          'live backup profile identity or enabled state is mismatched',
        ],
        [
          'restore-profile-enabled',
          { FAKE_RESPONSE_RESTORE_PROFILE_ENABLED: 'false' },
          'live restore profile identity or enabled state is mismatched',
        ],
        [
          'backup-profile-identity',
          {
            FAKE_RESPONSE_BACKUP_PROFILE_ID:
              '44444444-5555-6666-7777-888888888888',
          },
          'live backup profile identity or enabled state is mismatched',
        ],
        [
          'enabled',
          { FAKE_RESPONSE_ENABLED: 'false' },
          'live CRL identity or enabled state is mismatched',
        ],
        [
          'tag',
          { FAKE_TAG_DIGEST: 'f'.repeat(64) },
          'live CRL digest tag does not match the exact generated CRL',
        ],
        [
          'bytes',
          { FAKE_LIVE_CRL_PATH: wrongBytes },
          'live CRL bytes do not match the exact generated CRL',
        ],
      ];
      for (const [name, overrides, expected] of mismatches) {
        writeGoverned(awsLog, '');
        const result = runHelper(
          verifyArgs(
            ca,
            crl,
            parameterEvidence,
            join(root, `mismatch-${name}.json`),
          ),
          { ...baseAwsEnvironment, ...overrides },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expected);
        const commands = readAwsLog(awsLog);
        expect(
          commands.some((args) =>
            [
              'import-crl',
              'update-crl',
              'enable-crl',
              'disable-crl',
              'delete-crl',
              'tag-resource',
              'untag-resource',
            ].includes(args[1])),
        ).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
