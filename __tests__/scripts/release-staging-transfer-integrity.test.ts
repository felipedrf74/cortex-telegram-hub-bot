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
  it('runs trusted operator verification after transfer and before candidate execution or links', () => {
    const operator = readFileSync(OPERATOR, 'utf8');
    const transfer = operator.indexOf('rsync -az --delete');
    const verifier = operator.indexOf("<<'REMOTE_VERIFY_BUNDLE'", transfer);
    const candidateShell = operator.indexOf("<<'REMOTE'", verifier);
    const firstLink = operator.indexOf('ln -sfn', verifier);
    const firstCandidateScript = operator.indexOf('scripts/release-runtime-dependencies.mjs install', verifier);

    expect(transfer).toBeGreaterThan(-1);
    expect(verifier).toBeGreaterThan(transfer);
    expect(candidateShell).toBeGreaterThan(verifier);
    expect(firstLink).toBeGreaterThan(candidateShell);
    expect(firstCandidateScript).toBeGreaterThan(candidateShell);
    expect(operator.slice(verifier, candidateShell)).toContain('remote release artifact runtime SHA mismatch');
    expect(operator.slice(verifier, candidateShell)).toContain('remote release artifact file list is not strictly sorted');
    expect(operator.slice(verifier, candidateShell)).toContain('remote release bundle contains a symbolic link');
    expect(operator.slice(verifier, candidateShell)).toContain('remote release bundle contains an unsupported entry');
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
