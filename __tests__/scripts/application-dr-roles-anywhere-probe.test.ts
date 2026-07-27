import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const probe = path.resolve('scripts/application-dr-roles-anywhere-probe.py');
const boundarySource = path.resolve('scripts/aws-credential-process-boundary.py');
const systemPython = [
  process.env.CONTENT_ENGINE_PYTHON,
  '/usr/bin/python3',
  '/opt/homebrew/bin/python3',
].find((candidate): candidate is string => (
  typeof candidate === 'string' && fs.existsSync(candidate)
));

function digest(body: Buffer | string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function writeTrusted(file: string, body: string, mode: number): void {
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

interface Fixture {
  root: string;
  output: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  positiveConfig: string;
  revokedConfig: string;
}

function makeFixture(options: {
  revokedMessage?: string;
  revokedTrustAnchor?: string;
  localRevocationMissing?: boolean;
  liveCrlEnabled?: boolean;
} = {}): Fixture {
  if (!systemPython) throw new Error('Python 3 is required');
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ra-probe-')),
  );
  fs.chmodSync(root, 0o700);
  const tools = path.join(root, 'tools');
  const config = path.join(root, 'config');
  const evidence = path.join(root, 'evidence');
  fs.mkdirSync(tools, { mode: 0o700 });
  fs.mkdirSync(config, { mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });

  const pythonWrapper = path.join(tools, 'python3');
  const aws = path.join(tools, 'aws');
  const helper = path.join(tools, 'aws_signing_helper');
  const openssl = path.join(tools, 'openssl');
  const boundary = path.join(tools, 'aws-credential-process-boundary.py');
  const caCertificate = path.join(config, 'ca-certificate.pem');
  const crl = path.join(config, 'certificate-revocation-list.pem');
  const liveCrlEvidence = path.join(config, 'live-crl-evidence.json');
  const positiveCertificate = path.join(config, 'positive-certificate.pem');
  const positiveKey = path.join(config, 'positive-private-key.pem');
  const revokedCertificate = path.join(config, 'revoked-certificate.pem');
  const revokedKey = path.join(config, 'revoked-private-key.pem');
  const positiveConfig = path.join(config, 'positive-aws-config');
  const revokedConfig = path.join(config, 'revoked-aws-config');
  const output = path.join(evidence, 'probe.json');

  writeTrusted(
    pythonWrapper,
    `#!/bin/sh\nexec "${systemPython}" "$@"\n`,
    0o700,
  );
  writeTrusted(helper, '#!/bin/sh\nexit 70\n', 0o700);
  fs.copyFileSync(boundarySource, boundary);
  fs.chmodSync(boundary, 0o644);
  writeTrusted(positiveCertificate, 'positive-public-certificate\n', 0o600);
  writeTrusted(positiveKey, 'positive-private-key-fixture\n', 0o600);
  writeTrusted(revokedCertificate, 'reviewed-revoked-public-certificate\n', 0o600);
  writeTrusted(revokedKey, 'revoked-private-key-fixture\n', 0o600);
  writeTrusted(caCertificate, 'reviewed-ca-public-certificate\n', 0o644);
  writeTrusted(crl, 'reviewed-live-certificate-revocation-list\n', 0o644);

  const account = '123456789012';
  const roleArn = `arn:aws:iam::${account}:role/nexus/application-dr/BackupRole`;
  const trustAnchor = `arn:aws:rolesanywhere:eu-west-1:${account}:trust-anchor/11111111-1111-1111-1111-111111111111`;
  const revokedTrustAnchor = options.revokedTrustAnchor ?? trustAnchor;
  const profileArn = `arn:aws:rolesanywhere:eu-west-1:${account}:profile/22222222-2222-2222-2222-222222222222`;
  const processLine = (
    certificate: string,
    key: string,
    selectedTrustAnchor: string,
  ) => (
    `${helper} credential-process`
    + ` --certificate ${certificate}`
    + ` --private-key ${key}`
    + ` --trust-anchor-arn ${selectedTrustAnchor}`
    + ` --profile-arn ${profileArn}`
    + ` --role-arn ${roleArn}`
    + ' --session-duration 900'
    + ' --region eu-west-1'
  );
  writeTrusted(
    positiveConfig,
    '[profile nexus-application-dr-positive]\n'
    + 'region = eu-west-1\n'
    + `credential_process = ${processLine(
      positiveCertificate,
      positiveKey,
      trustAnchor,
    )}\n`,
    0o600,
  );
  writeTrusted(
    revokedConfig,
    '[profile nexus-application-dr-revoked]\n'
    + 'region = eu-west-1\n'
    + `credential_process = ${processLine(
      revokedCertificate,
      revokedKey,
      revokedTrustAnchor,
    )}\n`,
    0o600,
  );
  writeTrusted(
    aws,
    '#!/bin/sh\n'
    + 'if [ -n "${AWS_ENDPOINT_URL:-}" ]'
    + ' || [ -n "${HTTPS_PROXY:-}" ]'
    + ' || [ -n "${PYTHONPATH:-}" ]; then\n'
    + '  printf \'unsafe inherited environment\\n\' >&2\n'
    + '  exit 88\n'
    + 'fi\n'
    + 'if [ "$AWS_PROFILE" = "nexus-application-dr-positive" ]'
    + ' && [ "$1" = "sts" ]; then\n'
    + `  printf '%s\\n' '{"Account":"${account}",`
    + `"Arn":"arn:aws:sts::${account}:assumed-role/BackupRole/probe-session",`
    + '"UserId":"AROATEST:probe-session"}\'\n'
    + '  exit 0\n'
    + 'fi\n'
    + 'if [ "$AWS_PROFILE" = "nexus-application-dr-positive" ]'
    + ' && [ "$1" = "s3api" ]; then\n'
    + '  printf \'%s\\n\' \'{"Versions":[],"DeleteMarkers":[]}\'\n'
    + '  exit 0\n'
    + 'fi\n'
    + 'if [ "$AWS_PROFILE" = "nexus-application-dr-revoked" ]; then\n'
    + `  printf '%s\\n' '${options.revokedMessage ?? 'certificate has been revoked'}' >&2\n`
    + '  exit 254\n'
    + 'fi\n'
    + 'exit 64\n',
    0o700,
  );
  const positivePublicKey = '-----BEGIN PUBLIC KEY-----\\nPOSITIVE\\n-----END PUBLIC KEY-----';
  const revokedPublicKey = '-----BEGIN PUBLIC KEY-----\\nREVOKED\\n-----END PUBLIC KEY-----';
  writeTrusted(
    openssl,
    '#!/bin/sh\n'
    + 'case "$1" in\n'
    + '  crl) exit 0 ;;\n'
    + '  verify)\n'
    + '    case " $* " in\n'
    + '      *" -crl_check "*"revoked-certificate.pem"*) '
    + `exit ${options.localRevocationMissing ? '0' : '2'} ;;\n`
    + '      *) exit 0 ;;\n'
    + '    esac\n'
    + '    ;;\n'
    + '  x509)\n'
    + '    case " $* " in\n'
    + `      *"positive-certificate.pem"*) printf '%b\\n' '${positivePublicKey}' ;;\n`
    + `      *) printf '%b\\n' '${revokedPublicKey}' ;;\n`
    + '    esac\n'
    + '    ;;\n'
    + '  pkey)\n'
    + '    case " $* " in\n'
    + `      *"positive-private-key.pem"*) printf '%b\\n' '${positivePublicKey}' ;;\n`
    + `      *) printf '%b\\n' '${revokedPublicKey}' ;;\n`
    + '    esac\n'
    + '    ;;\n'
    + '  *) exit 64 ;;\n'
    + 'esac\n',
    0o700,
  );
  const now = Date.now();
  writeTrusted(
    liveCrlEvidence,
    `${JSON.stringify({
      schema: 'nexus.application-dr-crl-live-verification.v1',
      verifiedAt: new Date(now).toISOString(),
      region: 'eu-west-1',
      trustAnchorArn: trustAnchor,
      trustAnchorEnabled: true,
      caCertificateSha256: digest(fs.readFileSync(caCertificate)),
      backupProfileArn: profileArn,
      backupProfileEnabled: true,
      crlEnabled: options.liveCrlEnabled ?? true,
      crlSha256: digest(fs.readFileSync(crl)),
      lastUpdate: new Date(now - 60_000).toISOString(),
      nextUpdate: new Date(now + 86_400_000).toISOString(),
      exactBytesVerified: true,
      digestTagVerified: true,
    })}\n`,
    0o600,
  );

  const args = [
    probe,
    '--positive-config', positiveConfig,
    '--positive-profile', 'nexus-application-dr-positive',
    '--revoked-config', revokedConfig,
    '--revoked-profile', 'nexus-application-dr-revoked',
    '--region', 'eu-west-1',
    '--expected-role-arn', roleArn,
    '--expected-trust-anchor-arn', trustAnchor,
    '--expected-profile-arn', profileArn,
    '--expected-bucket', 'nexus-application-dr-fixture',
    '--expected-prefix', 'nexus-hub/application',
    '--expected-positive-certificate-sha256',
    digest(fs.readFileSync(positiveCertificate)),
    '--expected-revoked-certificate-sha256',
    digest(fs.readFileSync(revokedCertificate)),
    '--ca-certificate', caCertificate,
    '--crl', crl,
    '--live-crl-evidence', liveCrlEvidence,
    '--aws-bin', aws,
    '--openssl-bin', openssl,
    '--python-bin', pythonWrapper,
    '--boundary-helper', boundary,
    '--signing-helper', helper,
    '--signing-helper-sha256', digest(fs.readFileSync(helper)),
    '--output', output,
    '--expected-owner-uid', String(process.getuid?.() ?? 0),
    '--trust-boundary', root,
    '--test-mode',
  ];
  const env = { ...process.env };
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_CREDENTIAL_FILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  ]) {
    delete env[key];
  }
  return {
    root,
    output,
    args,
    env,
    positiveConfig,
    revokedConfig,
  };
}

function runFixture(fixture: Fixture, env = fixture.env) {
  if (!systemPython) throw new Error('Python 3 is required');
  return spawnSync(systemPython, fixture.args, {
    encoding: 'utf8',
    env,
  });
}

describe.runIf(systemPython !== undefined)(
  'application DR IAM Roles Anywhere positive/revoked probe',
  () => {
    it('writes immutable probe evidence with a complete-write loop', () => {
      const source = fs.readFileSync(probe, 'utf8');
      expect(source).toContain('while offset < len(body):');
      expect(source).toContain(
        'written = os.write(descriptor, body[offset:])',
      );
      expect(source).toContain('could not write complete probe evidence');
      expect(source).toContain(
        'os.link(temporary, path, follow_symlinks=False)',
      );
    });

    it('binds a working exact role and a distinct reviewed revoked certificate', () => {
      const fixture = makeFixture();
      try {
        const result = runFixture(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const summary = JSON.parse(result.stdout);
        const evidence = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));

        expect(summary).toMatchObject({
          ok: true,
          schemaVersion: 'NexusApplicationDrRolesAnywhereProbeV1',
          status: 'passed',
        });
        expect(evidence).toMatchObject({
          schemaVersion: 'NexusApplicationDrRolesAnywhereProbeV1',
          status: 'passed',
          positive: {
            prefixListAuthorized: true,
          },
          revoked: {
            credentialIssuanceDenied: true,
            localCrlRevocationVerified: true,
          },
          credentialsPersisted: false,
          longLivedCredentialsAccepted: false,
        });
        const raw = fs.readFileSync(fixture.output, 'utf8');
        expect(raw).not.toContain('123456789012');
        expect(raw).not.toContain('AccessKey');
        expect(raw).not.toContain('Secret');
        expect(fs.statSync(fixture.output).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('does not depend on machine-specific AWS revocation error wording', () => {
      const fixture = makeFixture({ revokedMessage: 'network unavailable' });
      try {
        const result = runFixture(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const evidence = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));
        expect(evidence.revoked).toMatchObject({
          credentialIssuanceDenied: true,
          localCrlRevocationVerified: true,
        });
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects denial when the exact local CRL does not revoke the certificate', () => {
      const fixture = makeFixture({ localRevocationMissing: true });
      try {
        const result = runFixture(fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'reviewed revoked certificate is not revoked by the exact live CRL',
        );
        expect(fs.existsSync(fixture.output)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects live CRL evidence that is not enabled', () => {
      const fixture = makeFixture({ liveCrlEnabled: false });
      try {
        const result = runFixture(fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'live CRL evidence differs at crlEnabled',
        );
        expect(fs.existsSync(fixture.output)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects identity drift between the working and revoked profiles', () => {
      const fixture = makeFixture({
        revokedTrustAnchor:
          'arn:aws:rolesanywhere:eu-west-1:123456789012:trust-anchor/33333333-3333-3333-3333-333333333333',
      });
      try {
        const result = runFixture(fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'revoked profile changes immutable identity option --trust-anchor-arn',
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('fails closed when alternate long-lived AWS credentials are present', () => {
      const fixture = makeFixture();
      try {
        const result = runFixture(fixture, {
          ...fixture.env,
          AWS_ACCESS_KEY_ID: 'fixture-long-lived-key',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'alternate or long-lived AWS credential environment is forbidden',
        );
        expect(fs.existsSync(fixture.output)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('does not pass endpoint, proxy, or Python loader overrides to AWS', () => {
      const fixture = makeFixture();
      try {
        const result = runFixture(fixture, {
          ...fixture.env,
          AWS_ENDPOINT_URL: 'https://attacker.invalid',
          HTTPS_PROXY: 'https://attacker.invalid',
          PYTHONPATH: '/tmp/attacker',
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('accepts a root-boundary-owned AWS CLI symlink to a trusted target', () => {
      const fixture = makeFixture();
      try {
        const awsIndex = fixture.args.indexOf('--aws-bin') + 1;
        const awsLink = fixture.args[awsIndex];
        const awsTarget = `${awsLink}-resolved`;
        fs.renameSync(awsLink, awsTarget);
        fs.symlinkSync(path.basename(awsTarget), awsLink);
        const result = runFixture(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('refuses to overwrite existing evidence', () => {
      const fixture = makeFixture();
      try {
        fs.writeFileSync(fixture.output, 'existing\n', { mode: 0o600 });
        const result = runFixture(fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('evidence output already exists');
        expect(fs.readFileSync(fixture.output, 'utf8')).toBe('existing\n');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  },
);
