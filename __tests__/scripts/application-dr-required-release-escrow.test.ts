import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const backupScript = path.resolve('scripts/application-dr-backup.sh');
const python = process.env.NEXUS_TEST_PYTHON ?? 'python3';
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dr-required-release-')),
  );
  fs.chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

function confirmationVerifier(source: string) {
  const functionStart = source.indexOf(
    'confirm_required_release_after_retention() {',
  );
  expect(functionStart).toBeGreaterThan(-1);
  const heredocMarker = "<<'PY'\n";
  const verifierStart = source.indexOf(heredocMarker, functionStart);
  expect(verifierStart).toBeGreaterThan(functionStart);
  const bodyStart = verifierStart + heredocMarker.length;
  const bodyEnd = source.indexOf('\nPY\n)"', bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, bodyEnd);
}

function iso(epoch: number) {
  return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
}

function runConfirmation({
  provider = 'aws-s3',
  controlMode = 'versioned-s3',
  versionId = '--opaque-✓-%2F?generation=1|part',
  mutateHead,
  mutateEncrypted,
}: {
  provider?: 'aws-s3' | 'cloudflare-r2';
  controlMode?: 'versioned-s3' | 'r2-approved-variance';
  versionId?: string;
  mutateHead?: (head: Record<string, unknown>) => void;
  mutateEncrypted?: (content: Buffer) => Buffer;
} = {}) {
  const source = fs.readFileSync(backupScript, 'utf8');
  const root = privateRoot();
  const encrypted = Buffer.from('exact-encrypted-release-payload');
  const expectedEncryptedSha = createHash('sha256').update(encrypted).digest('hex');
  const expectedPlaintextSha = 'a'.repeat(64);
  const expectedOriginalName = 'v4.15.0.tar.gz';
  const expectedCreatedEpoch = 1_785_000_000;
  const confirmedEpoch = expectedCreatedEpoch + 30;
  const expectedVersionId = provider === 'aws-s3' ? versionId : '';
  const expectedRetainUntil = provider === 'aws-s3'
    ? iso(confirmedEpoch + 90 * 86_400 + 3_600)
    : '';
  const head: Record<string, unknown> = {
    Metadata: {
      'schema-version': 'NexusReleaseRollbackEscrowV1',
      'encrypted-sha256': expectedEncryptedSha,
      'plaintext-sha256': expectedPlaintextSha,
      'original-name': expectedOriginalName,
      'created-epoch': String(expectedCreatedEpoch),
    },
    ContentLength: encrypted.length,
  };
  if (provider === 'aws-s3') {
    Object.assign(head, {
      ChecksumSHA256: createHash('sha256').update(encrypted).digest('base64'),
      VersionId: expectedVersionId,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: expectedRetainUntil,
    });
  }
  mutateHead?.(head);
  const headPath = path.join(root, 'head.json');
  const encryptedPath = path.join(root, 'release.age');
  fs.writeFileSync(headPath, JSON.stringify(head), { mode: 0o600 });
  fs.writeFileSync(
    encryptedPath,
    mutateEncrypted?.(encrypted) ?? encrypted,
    { mode: 0o600 },
  );
  const result = spawnSync(
    python,
    [
      '-',
      headPath,
      encryptedPath,
      provider,
      controlMode,
      expectedVersionId,
      expectedRetainUntil,
      expectedEncryptedSha,
      expectedPlaintextSha,
      expectedOriginalName,
      String(encrypted.length),
      String(expectedCreatedEpoch),
      String(confirmedEpoch),
    ],
    {
      encoding: 'utf8',
      input: confirmationVerifier(source),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  return {
    result,
    confirmedAt: iso(confirmedEpoch),
    expectedRetainUntil,
  };
}

describe('required release exact escrow confirmation', () => {
  it('keeps the backup script syntactically valid and protects both exact escrows', () => {
    const syntax = spawnSync('bash', ['-n', backupScript], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const source = fs.readFileSync(backupScript, 'utf8');
    expect(source).toContain(
      'local protected_key_one="${1:-}" protected_key_two="${2:-}"',
    );
    expect(source).not.toContain('protected_version_ids');
    expect(source).toContain(
      '"$required_release_key" "$required_release_version_id" \\\n'
      + '  "$required_recovery_key" "$required_recovery_version_id"',
    );
    expect(source).toContain(
      '"--version-id=$required_release_version_id"',
    );
    expect(source).toContain(
      '"--version-id=$required_release_version_id"',
    );
    expect(source).toContain(
      '+rollback-escrow-${RECOVERY_ESCROW_ID}+phase-${RECOVERY_ESCROW_PHASE}.tar.gz',
    );
    expect(source).toContain(
      'required release escrow must be bound to a complete promotion recovery transaction',
    );
    const prune = source.lastIndexOf('\nprune_release_age \\\n');
    const confirm = source.lastIndexOf(
      '\n  confirm_required_release_after_retention\n',
    );
    expect(prune).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(prune);
  });

  it('re-reads an exact retained AWS version and verifies its downloaded bytes', () => {
    const { result, confirmedAt, expectedRetainUntil } = runConfirmation();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${confirmedAt}|${expectedRetainUntil}`);

    const tampered = runConfirmation({
      mutateEncrypted: (content) => Buffer.from(
        content.toString().replace('payload', 'payloae'),
      ),
    });
    expect(tampered.result.status).not.toBe(0);
    expect(tampered.result.stderr).toContain(
      'post-retention required release encrypted digest changed',
    );
  });

  it('rejects an AWS version swap or retention shorter than confirmation plus 90 days', () => {
    const swapped = runConfirmation({
      mutateHead: (head) => {
        head.VersionId = 'different-version';
      },
    });
    expect(swapped.result.status).not.toBe(0);
    expect(swapped.result.stderr).toContain(
      'post-retention required release VersionId changed',
    );

    const shortRetention = runConfirmation({
      mutateHead: (head) => {
        const metadata = head.Metadata as Record<string, string>;
        const confirmedEpoch = Number(metadata['created-epoch']) + 30;
        head.ObjectLockRetainUntilDate = iso(confirmedEpoch + 90 * 86_400 - 1);
      },
    });
    expect(shortRetention.result.status).not.toBe(0);
    expect(shortRetention.result.stderr).toContain(
      'post-retention required release deadline does not cover confirmation',
    );
  });

  it('uses the UTF-8 byte limit and rejects unsafe opaque AWS VersionIds', () => {
    const exactLimit = runConfirmation({ versionId: 'é'.repeat(512) });
    expect(exactLimit.result.status, exactLimit.result.stderr).toBe(0);

    for (const versionId of [
      'null',
      'unsafe\nversion',
      'unsafe\u007fversion',
      `${'é'.repeat(512)}a`,
    ]) {
      const invalid = runConfirmation({ versionId });
      expect(invalid.result.status).not.toBe(0);
      expect(invalid.result.stderr).toContain(
        'post-retention required release VersionId changed',
      );
    }

    const jsonNull = runConfirmation({
      mutateHead: (head) => {
        head.VersionId = null;
      },
    });
    expect(jsonNull.result.status).not.toBe(0);
    expect(jsonNull.result.stderr).toContain(
      'post-retention required release VersionId changed',
    );
  });

  it('accepts only the explicit unversioned R2 variance', () => {
    const { result, confirmedAt } = runConfirmation({
      provider: 'cloudflare-r2',
      controlMode: 'r2-approved-variance',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${confirmedAt}|`);

    const fakeVersion = runConfirmation({
      provider: 'cloudflare-r2',
      controlMode: 'r2-approved-variance',
      mutateHead: (head) => {
        head.VersionId = 'unexpected-version';
      },
    });
    expect(fakeVersion.result.status).not.toBe(0);
    expect(fakeVersion.result.stderr).toContain(
      'post-retention required release R2 variance changed',
    );
  });

  it('emits provider-discriminated confirmation evidence only after confirmation', () => {
    const source = fs.readFileSync(backupScript, 'utf8');
    expect(source).toContain('"confirmedAt": release_confirmed_at');
    expect(source).toContain('"retainUntil": release_retain_until or None');
    expect(source).toContain('"objectVersionId": release_version_id or None');
    expect(source).toContain(
      '"approvedUnversionedVariance": provider == "cloudflare-r2"',
    );
    expect(source).toContain('release_confirmed == "true"');
    expect(source).toContain(
      'required_release_confirmed=true',
    );
  });
});
