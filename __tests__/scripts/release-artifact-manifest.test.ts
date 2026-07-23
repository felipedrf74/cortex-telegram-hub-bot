import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  releaseArtifactDigest,
  sha256,
  verifyReleaseBundle,
} from '../../scripts/lib/release-artifact-manifest.mjs';

const script = path.resolve('scripts/release-artifact-manifest.mjs');
const evidenceScript = path.resolve('scripts/release-evidence.mjs');

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[key];
  }
  return env;
}

describe('release-artifact-manifest', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-artifact-manifest-'));
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'catalog/training/exercise-media/v1'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src/services'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'content-engine/services'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts/lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dist/index.js'), 'console.log("one");\n');
    fs.writeFileSync(
      path.join(tmp, 'catalog/training/exercise-media/v1/compiled-manifest.json'),
      '{"packageHash":"one"}\n',
    );
    fs.writeFileSync(path.join(tmp, 'migrations/001_init.sql'), 'CREATE TABLE x(id INTEGER);\n');
    fs.writeFileSync(path.join(tmp, 'prompts/content.md'), 'prompt one\n');
    fs.writeFileSync(
      path.join(tmp, 'config/capability-manifest.json'),
      `${JSON.stringify({
        schemaReferences: {
          'nexus.chat-turn.input.v1': { path: 'src/services/chat-turn-contract.ts' },
          'nexus.chat-turn.output.v1': { path: 'src/services/chat-turn-contract.ts' },
        },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(tmp, 'config/production-migration-lineages.json'),
      '{"schema":"nexus.production-migration-lineages.v1","lineages":[]}\n',
    );
    fs.writeFileSync(
      path.join(tmp, 'src/services/chat-turn-contract.ts'),
      'export interface ChatTurnContractInput { message: string }\n',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/requirements.txt'), 'fastapi\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/services/orchestrator.py'), 'VALUE = 1\n');
    fs.writeFileSync(path.join(tmp, 'scripts/promote-exact-release.sh'), '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(path.join(tmp, 'scripts/remote-production-shape-migration-rehearsal.sh'), '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(
      path.join(tmp, 'scripts/production-shape-migration-rehearsal.mjs'),
      [
        "import './lib/production-shape-migration-rehearsal-evidence.mjs';",
        "import './lib/irreversible-migration-policy.mjs';",
        "import './lib/production-migration-lineage.mjs';",
        'export {};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmp, 'scripts/validate-production-shape-migration-rehearsal.mjs'),
      "import './lib/production-shape-migration-rehearsal-evidence.mjs';\nexport {};\n",
    );
    fs.writeFileSync(path.join(tmp, 'scripts/lib/irreversible-migration-policy.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(tmp, 'scripts/lib/production-migration-lineage.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(tmp, 'scripts/lib/production-shape-migration-rehearsal-evidence.mjs'), 'export {};\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function digest() {
    return execFileSync('node', [script, '--root', tmp, '--digest'], { encoding: 'utf8' }).trim();
  }

  it.each([
    ['migration', 'migrations/001_init.sql'],
    ['prompt', 'prompts/content.md'],
    ['package-lock', 'package-lock.json'],
    ['python source', 'content-engine/services/orchestrator.py'],
    ['dist', 'dist/index.js'],
    ['runtime catalog', 'catalog/training/exercise-media/v1/compiled-manifest.json'],
    ['capability schema source', 'src/services/chat-turn-contract.ts'],
    ['production promotion tooling', 'scripts/promote-exact-release.sh'],
    ['production-shape migration rehearsal', 'scripts/production-shape-migration-rehearsal.mjs'],
    ['irreversible migration policy runtime', 'scripts/lib/irreversible-migration-policy.mjs'],
    ['retired migration lineage policy', 'config/production-migration-lineages.json'],
    ['retired migration lineage runtime', 'scripts/lib/production-migration-lineage.mjs'],
    ['production-shape rehearsal evidence', 'scripts/lib/production-shape-migration-rehearsal-evidence.mjs'],
  ])('changes digest when %s changes', (_label, relativePath) => {
    const before = digest();
    fs.appendFileSync(path.join(tmp, relativePath), 'changed\n');
    const after = digest();

    expect(after).not.toBe(before);
  });

  it('includes every capability schema source required during runtime startup', () => {
    const manifest = JSON.parse(execFileSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    ));

    expect(manifest.files.map((entry: { path: string }) => entry.path)).toContain(
      'src/services/chat-turn-contract.ts',
    );
  });

  it('includes every declared dependency of the production-shape rehearsal', () => {
    const manifest = JSON.parse(execFileSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    ));

    expect(manifest.files.map((entry: { path: string }) => entry.path)).toEqual(
      expect.arrayContaining([
        'scripts/production-shape-migration-rehearsal.mjs',
        'scripts/lib/irreversible-migration-policy.mjs',
        'scripts/lib/production-migration-lineage.mjs',
        'scripts/lib/production-shape-migration-rehearsal-evidence.mjs',
      ]),
    );
  });

  it('fails closed when a bundled release script dependency is missing', () => {
    fs.unlinkSync(path.join(tmp, 'scripts/lib/irreversible-migration-policy.mjs'));

    const failed = spawnSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'release runtime dependency is missing: scripts/production-shape-migration-rehearsal.mjs -> ./lib/irreversible-migration-policy.mjs',
    );
  });

  it('fails closed when a bundled release script dependency is not allowlisted', () => {
    fs.writeFileSync(path.join(tmp, 'scripts/lib/undeclared-runtime.mjs'), 'export {};\n');
    fs.appendFileSync(
      path.join(tmp, 'scripts/production-shape-migration-rehearsal.mjs'),
      "import './lib/undeclared-runtime.mjs';\n",
    );

    const failed = spawnSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'release runtime dependency is not declared: scripts/production-shape-migration-rehearsal.mjs -> scripts/lib/undeclared-runtime.mjs',
    );
  });

  it.each([
    ["import /* closure */ './lib/missing-commented.mjs';", './lib/missing-commented.mjs'],
    ["export { value } from './lib/missing-export.mjs';", './lib/missing-export.mjs'],
    ["import value from\n  './lib/missing-multiline.mjs';", './lib/missing-multiline.mjs'],
    ["import data from './lib/missing-attributes.json' with { type: 'json' };", './lib/missing-attributes.json'],
  ])('parses static ESM dependency syntax with the Node runtime parser: %s', (statement, specifier) => {
    fs.appendFileSync(
      path.join(tmp, 'scripts/production-shape-migration-rehearsal.mjs'),
      `${statement}\n`,
    );

    const failed = spawnSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      `release runtime dependency is missing: scripts/production-shape-migration-rehearsal.mjs -> ${specifier}`,
    );
  });

  it('does not treat comments or string contents as runtime dependencies', () => {
    fs.appendFileSync(
      path.join(tmp, 'scripts/production-shape-migration-rehearsal.mjs'),
      [
        "// import './lib/comment-only.mjs';",
        "const example = \"require('./lib/string-only.cjs')\";",
        '',
      ].join('\n'),
    );

    expect(() => digest()).not.toThrow();
  });

  it.each(['/private/host-only.mjs', 'file:///private/host-only.mjs', 'https://example.invalid/remote.mjs'])(
    'rejects unsafe static ESM runtime dependency %s',
    (specifier) => {
      fs.appendFileSync(
        path.join(tmp, 'scripts/production-shape-migration-rehearsal.mjs'),
        `import ${JSON.stringify(specifier)};\n`,
      );

      const failed = spawnSync(
        'node',
        [script, '--root', tmp, '--format', 'json'],
        { encoding: 'utf8' },
      );

      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        `release runtime dependency is unsafe: scripts/production-shape-migration-rehearsal.mjs -> ${specifier}`,
      );
    },
  );

  it('revalidates dependency closure from sealed bundle bytes', () => {
    const bundle = path.join(tmp, 'sealed-bundle');
    const entryPath = 'scripts/entry.mjs';
    const entryBody = Buffer.from("import './lib/omitted.mjs';\n");
    fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(bundle, entryPath), entryBody);
    const files = [{ path: entryPath, size: entryBody.length, sha256: sha256(entryBody) }];
    const artifactDigest = releaseArtifactDigest(files);
    fs.writeFileSync(path.join(bundle, 'artifact-manifest.json'), `${JSON.stringify({
      schema: 'nexus.release-artifact-manifest.v1',
      digest: artifactDigest,
      fileCount: files.length,
      files,
    })}\n`);
    fs.writeFileSync(path.join(bundle, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha: 'a'.repeat(40),
      artifactDigest,
      fileCount: files.length,
    })}\n`);

    expect(() => verifyReleaseBundle(bundle, 'a'.repeat(40))).toThrow(
      'release runtime dependency is missing: scripts/entry.mjs -> ./lib/omitted.mjs',
    );
  });

  it('verifies an exact downloaded bundle against the recorded runtime SHA and digest', () => {
    const bundle = path.join(tmp, 'downloaded-runtime-bundle');
    const runtimeSha = 'a'.repeat(40);
    const entryPath = 'dist/index.js';
    const entryBody = Buffer.from('console.log("sealed");\n');
    fs.mkdirSync(path.join(bundle, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(bundle, entryPath), entryBody);
    const files = [{ path: entryPath, size: entryBody.length, sha256: sha256(entryBody) }];
    const artifactDigest = releaseArtifactDigest(files);
    fs.writeFileSync(path.join(bundle, 'artifact-manifest.json'), `${JSON.stringify({
      schema: 'nexus.release-artifact-manifest.v1',
      digest: artifactDigest,
      fileCount: files.length,
      files,
    })}\n`);
    fs.writeFileSync(path.join(bundle, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha,
      artifactDigest,
      fileCount: files.length,
    })}\n`);

    const verified = JSON.parse(execFileSync(process.execPath, [
      script,
      '--verify-bundle', bundle,
      '--expected-runtime-sha', runtimeSha,
      '--expected-digest', artifactDigest,
    ], { encoding: 'utf8' }));
    expect(verified).toMatchObject({
      schema: 'nexus.release-bundle-verification.v1',
      status: 'passed',
      runtimeSha,
      artifactDigest,
      fileCount: 1,
    });

    const rejected = spawnSync(process.execPath, [
      script,
      '--verify-bundle', bundle,
      '--expected-runtime-sha', runtimeSha,
      '--expected-digest', 'f'.repeat(64),
    ], { encoding: 'utf8' });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('does not match --expected-digest');
  });

  it('verifies bundle paths with locale-independent code-unit ordering', () => {
    const bundle = path.join(tmp, 'code-unit-ordered-bundle');
    const runtimeSha = 'a'.repeat(40);
    const entries = [
      ['dist/runtime-dependencies/fastapi-0.whl', Buffer.from('hyphen\n')],
      ['dist/runtime-dependencies/fastapi_0.whl', Buffer.from('underscore\n')],
    ] as const;
    const files = entries.map(([entryPath, body]) => ({
      path: entryPath,
      size: body.length,
      sha256: sha256(body),
    }));
    for (const [entryPath, body] of entries) {
      fs.mkdirSync(path.dirname(path.join(bundle, entryPath)), { recursive: true });
      fs.writeFileSync(path.join(bundle, entryPath), body);
    }
    const artifactDigest = releaseArtifactDigest(files);
    fs.writeFileSync(path.join(bundle, 'artifact-manifest.json'), `${JSON.stringify({
      schema: 'nexus.release-artifact-manifest.v1',
      digest: artifactDigest,
      fileCount: files.length,
      files,
    })}\n`);
    fs.writeFileSync(path.join(bundle, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha,
      artifactDigest,
      fileCount: files.length,
    })}\n`);

    expect(files.map((entry) => entry.path)).toEqual([
      'dist/runtime-dependencies/fastapi-0.whl',
      'dist/runtime-dependencies/fastapi_0.whl',
    ]);
    expect(() => verifyReleaseBundle(bundle, runtimeSha)).not.toThrow();
  });

  it('revalidates sealed bundle closure without installed package dependencies', () => {
    const bundle = path.join(tmp, 'isolated-bundle');
    const verifierRoot = path.join(tmp, 'isolated-verifier');
    const verifierPath = path.join(verifierRoot, 'release-artifact-manifest.mjs');
    const entryPath = 'scripts/entry.mjs';
    const entryBody = Buffer.from("import './lib/omitted.mjs';\n");
    fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
    fs.mkdirSync(verifierRoot, { recursive: true });
    fs.copyFileSync(
      path.resolve('scripts/lib/release-artifact-manifest.mjs'),
      verifierPath,
    );
    fs.writeFileSync(path.join(bundle, entryPath), entryBody);
    const files = [{ path: entryPath, size: entryBody.length, sha256: sha256(entryBody) }];
    const artifactDigest = releaseArtifactDigest(files);
    fs.writeFileSync(path.join(bundle, 'artifact-manifest.json'), `${JSON.stringify({
      schema: 'nexus.release-artifact-manifest.v1',
      digest: artifactDigest,
      fileCount: files.length,
      files,
    })}\n`);
    fs.writeFileSync(path.join(bundle, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha: 'a'.repeat(40),
      artifactDigest,
      fileCount: files.length,
    })}\n`);
    const check = [
      `import(${JSON.stringify(pathToFileURL(verifierPath).href)}).then(({ verifyReleaseBundle }) => {`,
      '  try {',
      `    verifyReleaseBundle(${JSON.stringify(bundle)}, '${'a'.repeat(40)}');`,
      '    process.exitCode = 2;',
      '  } catch (error) {',
      "    if (!String(error.message).includes('scripts/entry.mjs -> ./lib/omitted.mjs')) process.exitCode = 3;",
      '  }',
      '});',
    ].join('\n');

    const isolated = spawnSync(process.execPath, ['--input-type=module', '-e', check], {
      cwd: verifierRoot,
      encoding: 'utf8',
      env: {
        HOME: verifierRoot,
        PATH: process.env.PATH || '',
        TMPDIR: os.tmpdir(),
      },
    });

    expect(isolated.status, `${isolated.stdout}${isolated.stderr}`).toBe(0);
  });

  it('fails closed when a declared capability schema source is missing', () => {
    fs.unlinkSync(path.join(tmp, 'src/services/chat-turn-contract.ts'));

    const failed = spawnSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'capability schema source is missing from release input: nexus.chat-turn.input.v1/src/services/chat-turn-contract.ts',
    );
  });

  it('rejects capability schema sources that escape the release root', () => {
    fs.writeFileSync(
      path.join(tmp, 'config/capability-manifest.json'),
      `${JSON.stringify({
        schemaReferences: {
          'nexus.chat-turn.input.v1': { path: '../outside.ts' },
        },
      })}\n`,
    );

    const failed = spawnSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'unsafe capability schema reference path: nexus.chat-turn.input.v1/../outside.ts',
    );
  });

  it('rejects symlinked capability schema sources', () => {
    fs.unlinkSync(path.join(tmp, 'src/services/chat-turn-contract.ts'));
    fs.symlinkSync(
      path.join(tmp, 'prompts/content.md'),
      path.join(tmp, 'src/services/chat-turn-contract.ts'),
    );

    const failed = spawnSync(
      'node',
      [script, '--root', tmp, '--format', 'json'],
      { encoding: 'utf8' },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'capability schema source is not a regular file: nexus.chat-turn.input.v1/src/services/chat-turn-contract.ts',
    );
  });
});

describe('release-evidence', () => {
  let tmp: string;
  let gitEnv: NodeJS.ProcessEnv;
  let privateKeyPath: string;
  let publicKeyPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-evidence-'));
    gitEnv = cleanGitEnv();
    fs.mkdirSync(path.join(tmp, 'scripts/lib'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'content-engine/services'), { recursive: true });
    fs.copyFileSync(script, path.join(tmp, 'scripts/release-artifact-manifest.mjs'));
    fs.copyFileSync(
      path.resolve('scripts/lib/release-artifact-manifest.mjs'),
      path.join(tmp, 'scripts/lib/release-artifact-manifest.mjs'),
    );
    fs.writeFileSync(path.join(tmp, 'dist/index.js'), 'console.log("one");\n');
    fs.writeFileSync(path.join(tmp, 'migrations/001_init.sql'), 'CREATE TABLE x(id INTEGER);\n');
    fs.writeFileSync(path.join(tmp, 'prompts/content.md'), 'prompt one\n');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/requirements.txt'), 'fastapi\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/services/orchestrator.py'), 'VALUE = 1\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['add', '.'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, env: gitEnv });

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    privateKeyPath = path.join(tmp, 'private.pem');
    publicKeyPath = path.join(tmp, 'public.pem');
    fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts matching evidence and rejects digest drift', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '12000',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '7',
        NEXUS_RELEASE_RUN_ID: '12345',
        NEXUS_RELEASE_RUN_ATTEMPT: '1',
      },
    });

    const ok = execFileSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );
    const okPayload = JSON.parse(ok);
    expect(okPayload.ok).toBe(true);
    expect(okPayload.evidence.runId).toBe('12345');
    expect(okPayload.evidence.runAttempt).toBe('1');

    fs.appendFileSync(path.join(tmp, 'prompts/content.md'), 'changed\n');
    const failed = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('manifest_digest_mismatch')]),
    );
  });

  it('rejects evidence with nonzero counts below suite floors', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '8999',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '5',
      },
    });

    const failed = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );

    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).reasons).toEqual(expect.arrayContaining([
      'test_count_below_floor:vitest:8999<9000',
      'test_count_below_floor:pytest:5<6',
    ]));
  });

  it('rejects unsigned evidence, short-SHA evidence, and zero test counts', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '12000',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '7',
      },
    });
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.signature = null;
    evidence.payload.engine.sha = evidence.payload.engine.sha.slice(0, 8);
    evidence.payload.testCounts.vitest = 0;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const failed = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );

    expect(failed.status).toBe(1);
    const payload = JSON.parse(failed.stdout);
    expect(payload.reasons).toEqual(expect.arrayContaining([
      'signature_missing',
      expect.stringContaining('engine_sha_invalid'),
      'test_count_invalid:vitest:0',
    ]));
  });

  it('ignores verifier public-key env overrides during validation', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    const attackerKeys = generateKeyPairSync('ed25519');
    const attackerPrivatePath = path.join(tmp, 'attacker-private.pem');
    const attackerPublicPath = path.join(tmp, 'attacker-public.pem');
    fs.writeFileSync(attackerPrivatePath, attackerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(attackerPublicPath, attackerKeys.publicKey.export({ type: 'spki', format: 'pem' }));

    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: attackerPrivatePath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '99999',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '99999',
      },
    });

    const failed = spawnSync('node', [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--json'], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PUBLIC_KEY_PATH: attackerPublicPath,
      },
    });

    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).reasons).toContain('public_key_missing');
  });

  it('rejects self-attested command omissions', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '12000',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '7',
      },
    });

    const failed = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );

    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).reasons).toContain('command_not_passing:sciencePolicy:missing');
  });

  it('rejects evidence that lacks sandbox smoke proof', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '12000',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '7',
      },
    });

    const failed = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );

    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).reasons).toContain('command_not_passing:smoke:not_run');
  });

  it('rejects stale, expired, and future-dated signed evidence', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '12000',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '7',
      },
    });

    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.payload.generatedAt = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();
    evidence.payload.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    execFileSync('node', [evidenceScript, 'sign', '--root', tmp, '--evidence', evidencePath, '--private-key', privateKeyPath], {
      env: gitEnv,
    });

    const stale = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout).reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('evidence_stale'),
      expect.stringContaining('evidence_expired'),
    ]));

    const futureEvidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    futureEvidence.payload.generatedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    futureEvidence.payload.expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(evidencePath, `${JSON.stringify(futureEvidence, null, 2)}\n`);
    execFileSync('node', [evidenceScript, 'sign', '--root', tmp, '--evidence', evidencePath, '--private-key', privateKeyPath], {
      env: gitEnv,
    });

    const future = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );
    expect(future.status).toBe(1);
    expect(JSON.parse(future.stdout).reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('generated_at_in_future'),
    ]));
  });

  it('does not let max-age env values disable stale evidence checks', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '12000',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '7',
      },
    });

    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.payload.generatedAt = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();
    evidence.payload.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    execFileSync('node', [evidenceScript, 'sign', '--root', tmp, '--evidence', evidencePath, '--private-key', privateKeyPath], {
      env: gitEnv,
    });

    for (const value of ['0', 'NaN', '99999']) {
      const failed = spawnSync(
        'node',
        [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
        { encoding: 'utf8', env: { ...gitEnv, NEXUS_RELEASE_EVIDENCE_MAX_AGE_S: value } },
      );
      expect(failed.status).toBe(1);
      expect(JSON.parse(failed.stdout).reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('evidence_stale'),
      ]));
    }
  });

  it('fails closed when the current engine SHA is not resolvable', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
      env: {
        ...gitEnv,
        NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_TYPECHECK_RESULT: 'passed',
        NEXUS_RELEASE_BUILD_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_RESULT: 'passed',
        NEXUS_RELEASE_PYTEST_RESULT: 'passed',
        NEXUS_RELEASE_SCIENCE_POLICY_RESULT: 'passed',
        NEXUS_RELEASE_MIGRATIONS_RESULT: 'passed',
        NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT: 'passed',
        NEXUS_RELEASE_SMOKE_RESULT: 'passed',
        NEXUS_RELEASE_VITEST_TEST_COUNT: '12000',
        NEXUS_RELEASE_PYTEST_TEST_COUNT: '7',
      },
    });
    fs.renameSync(path.join(tmp, '.git'), path.join(tmp, '.git-hidden'));

    const failed = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--public-key', publicKeyPath, '--json'],
      { encoding: 'utf8', env: gitEnv },
    );

    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).reasons).toContain('engine_sha_unverifiable:missing');
  });
});
