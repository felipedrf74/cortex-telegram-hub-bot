import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const OPERATOR = join(ROOT, 'scripts', 'release-operator.sh');
const ARTIFACT_SCHEMA = 'nexus.release-artifact-manifest.v1';
const RUNTIME_SHA = 'a'.repeat(40);

function sha256(body: string | Buffer) {
  return createHash('sha256').update(body).digest('hex');
}

function heredocBody(raw: string, label: string) {
  const opener = raw.indexOf(`<<'${label}'`);
  expect(opener, `missing ${label} opener`).toBeGreaterThan(-1);
  const bodyStart = raw.indexOf('\n', opener) + 1;
  const closer = raw.indexOf(`\n${label}\n`, bodyStart);
  expect(closer, `missing ${label} closer`).toBeGreaterThan(bodyStart);
  return raw.slice(bodyStart, closer);
}

function createBundle() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-staging-transfer-'));
  const bodies = new Map([
    ['dist/index.js', 'alpha\n'],
    ['package.json', '{"name":"fixture","version":"1.0.0"}\n'],
  ]);
  const files = [...bodies.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([relativePath, body]) => ({
      path: relativePath,
      size: Buffer.byteLength(body),
      sha256: sha256(body),
    }));
  for (const [relativePath, body] of bodies) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, body);
  }
  const digest = sha256(Buffer.from(JSON.stringify({ schema: ARTIFACT_SCHEMA, files })));
  writeFileSync(join(root, 'artifact-manifest.json'), JSON.stringify({
    schema: ARTIFACT_SCHEMA,
    git: { sha: RUNTIME_SHA },
    digest,
    fileCount: files.length,
    files,
  }));
  writeFileSync(join(root, '.complete.json'), JSON.stringify({
    schema: 'nexus.release-bundle.v1',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: digest,
    fileCount: files.length,
  }));
  return { root, digest };
}

function runTrustedVerifier(root: string, digest: string) {
  const verifier = heredocBody(readFileSync(OPERATOR, 'utf8'), 'REMOTE_VERIFY_BUNDLE');
  return spawnSync(process.execPath, ['-', root, RUNTIME_SHA, digest], {
    input: verifier,
    encoding: 'utf8',
  });
}

function uploadArtifactBlocks(raw: string) {
  const lines = raw.split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('uses: actions/upload-artifact@')) continue;
    const usesIndentation = lines[index].match(/^\s*/)?.[0].length ?? 0;
    const indentation = lines[index].trimStart().startsWith('- uses:')
      ? usesIndentation
      : Math.max(0, usesIndentation - 2);
    let end = index + 1;
    while (end < lines.length
      && !new RegExp(`^\\s{${indentation}}-\\s`).test(lines[end])) {
      end += 1;
    }
    blocks.push(lines.slice(index, end).join('\n'));
  }
  return blocks;
}

describe('staging transfer integrity', () => {
  it('runs trusted verification before candidate execution, then seals and attests through root control', () => {
    const operator = readFileSync(OPERATOR, 'utf8');
    const stagingStart = operator.indexOf('  staging)');
    const stagingEnd = operator.indexOf('  promote)', stagingStart);
    const staging = operator.slice(stagingStart, stagingEnd);
    const rootPrepare = staging.indexOf('prepare-staging-runtime-target');
    const transfer = staging.indexOf('rsync -az --delete', rootPrepare);
    const verifier = staging.indexOf("<<'REMOTE_VERIFY_BUNDLE'", transfer);
    const installShell = staging.indexOf("<<'REMOTE_INSTALL'", verifier);
    const firstLink = staging.indexOf('ln -sfn', installShell);
    const firstCandidateScript = staging.indexOf('scripts/release-runtime-dependencies.mjs install', installShell);
    const rootSeal = staging.indexOf('seal-staging-runtime', firstCandidateScript);
    const rootAttest = staging.indexOf('attest-staging-runtime', rootSeal);
    const evidenceParser = staging.indexOf('node - "$ROOT_STAGING_EVIDENCE"', rootAttest);
    const stagingRequest = staging.indexOf('release-staging-attestation.mjs request', evidenceParser);
    const trustedVerifier = heredocBody(operator, 'REMOTE_VERIFY_BUNDLE');

    expect(stagingStart).toBeGreaterThan(-1);
    expect(stagingEnd).toBeGreaterThan(stagingStart);
    expect(rootPrepare).toBeGreaterThan(-1);
    expect(transfer).toBeGreaterThan(-1);
    expect(transfer).toBeGreaterThan(rootPrepare);
    expect(verifier).toBeGreaterThan(transfer);
    expect(installShell).toBeGreaterThan(verifier);
    expect(firstLink).toBeGreaterThan(installShell);
    expect(firstCandidateScript).toBeGreaterThan(installShell);
    expect(rootSeal).toBeGreaterThan(firstCandidateScript);
    expect(rootAttest).toBeGreaterThan(rootSeal);
    expect(evidenceParser).toBeGreaterThan(rootAttest);
    expect(stagingRequest).toBeGreaterThan(evidenceParser);
    expect(trustedVerifier).toContain('remote release artifact runtime SHA mismatch');
    expect(trustedVerifier).toContain('remote release artifact file list is not strictly sorted');
    expect(trustedVerifier).toContain('remote release bundle contains a symbolic link');
    expect(trustedVerifier).toContain('remote release bundle contains an unsupported entry');
    expect(trustedVerifier).not.toContain('$RELEASE_DIR/scripts/');
    expect(trustedVerifier).not.toContain('release-artifact-manifest.mjs');
    expect(staging.slice(evidenceParser, stagingRequest))
      .toContain("record.schema!=='nexus.root-staging-attestation-evidence.v1'");
    expect(staging.slice(evidenceParser, stagingRequest))
      .toContain('record.outputDigests?.bindingSha256');
    expect(staging.slice(evidenceParser, stagingRequest))
      .toContain('record.outputDigests?.readinessSha256');
  });

  it('accepts an exact transferred bundle and rejects changed-size tampering', () => {
    const fixture = createBundle();
    try {
      const accepted = runTrustedVerifier(fixture.root, fixture.digest);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        ok: true,
        runtimeSha: RUNTIME_SHA,
        artifactDigest: fixture.digest,
        fileCount: 2,
      });

      writeFileSync(join(fixture.root, 'dist/index.js'), 'alpha-tampered\n');
      const rejected = runTrustedVerifier(fixture.root, fixture.digest);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('remote release artifact byte identity mismatch: dist/index.js');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects same-size byte drift', () => {
    const fixture = createBundle();
    try {
      writeFileSync(join(fixture.root, 'dist/index.js'), 'omega\n');
      const rejected = runTrustedVerifier(fixture.root, fixture.digest);

      expect(Buffer.byteLength('omega\n')).toBe(Buffer.byteLength('alpha\n'));
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('remote release artifact byte identity mismatch: dist/index.js');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects an undeclared transferred file', () => {
    const fixture = createBundle();
    try {
      writeFileSync(join(fixture.root, 'undeclared-runtime.js'), 'do not execute\n');
      const rejected = runTrustedVerifier(fixture.root, fixture.digest);

      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('remote release bundle contains undeclared or missing files');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('includes hidden files for every workflow artifact uploaded from .local', () => {
    const workflowRoot = join(ROOT, '.github', 'workflows');
    const offenders: string[] = [];
    for (const name of readdirSync(workflowRoot).filter((entry) => /\.ya?ml$/.test(entry))) {
      const raw = readFileSync(join(workflowRoot, name), 'utf8');
      for (const block of uploadArtifactBlocks(raw)) {
        if (block.includes('.local/') && !block.includes('include-hidden-files: true')) {
          offenders.push(name);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
