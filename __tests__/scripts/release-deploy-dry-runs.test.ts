import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function copyExecutable(from: string, to: string) {
  copyFileSync(from, to);
  chmodSync(to, 0o755);
}

function prependPath(binDir: string) {
  return `${binDir}:${process.env.PATH ?? ''}`;
}

function cleanGitEnv(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8' }).trim();
}

function createReleaseHarnessRepo() {
  const root = mkdtempSync(join(tmpdir(), 'release-dry-run-'));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'docs/release/evidence'), { recursive: true });

  copyExecutable(join(ROOT, 'scripts/deploy.sh'), join(root, 'scripts/deploy.sh'));
  copyExecutable(join(ROOT, 'scripts/promote-to-prod.sh'), join(root, 'scripts/promote-to-prod.sh'));
  copyFileSync(join(ROOT, 'scripts/lib/release-gates.sh'), join(root, 'scripts/lib/release-gates.sh'));
  copyFileSync(
    join(ROOT, 'docs/release/evidence/release-evidence-public-key.pem'),
    join(root, 'docs/release/evidence/release-evidence-public-key.pem'),
  );

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '4.14.205' }, null, 2));
  writeFileSync(join(root, '.gitignore'), ['.local/', 'bin/', 'dist/', 'node_modules/', '*.log'].join('\n'));

  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Release Dry Run Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);

  return root;
}

function createRealEvidenceHarnessRepo() {
  const root = mkdtempSync(join(tmpdir(), 'release-real-evidence-'));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'docs/release/evidence'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'migrations'), { recursive: true });
  mkdirSync(join(root, 'prompts'), { recursive: true });
  mkdirSync(join(root, 'content-engine/services'), { recursive: true });

  copyExecutable(join(ROOT, 'scripts/deploy.sh'), join(root, 'scripts/deploy.sh'));
  copyFileSync(join(ROOT, 'scripts/lib/release-gates.sh'), join(root, 'scripts/lib/release-gates.sh'));
  copyFileSync(join(ROOT, 'scripts/lib/freshness.mjs'), join(root, 'scripts/lib/freshness.mjs'));
  copyExecutable(join(ROOT, 'scripts/release-evidence.mjs'), join(root, 'scripts/release-evidence.mjs'));
  copyExecutable(join(ROOT, 'scripts/release-artifact-manifest.mjs'), join(root, 'scripts/release-artifact-manifest.mjs'));
  writeExecutable(
    join(root, 'scripts/rollback-drill-check.mjs'),
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, checks: ['fixture'] }) + "\\n");
`,
  );
  writeExecutable(
    join(root, 'scripts/migration-safety-check.mjs'),
    `#!/usr/bin/env node
process.stdout.write("migration safety fixture ok\\n");
`,
  );

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '4.14.205' }, null, 2));
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'dist/index.js'), 'console.log("fixture");\n');
  writeFileSync(join(root, 'migrations/001_init.sql'), 'CREATE TABLE fixture(id INTEGER);\n');
  writeFileSync(join(root, 'prompts/content.md'), 'prompt\n');
  writeFileSync(join(root, 'content-engine/requirements.txt'), 'fastapi\n');
  writeFileSync(join(root, 'content-engine/services/orchestrator.py'), 'VALUE = 1\n');
  writeFileSync(join(root, '.gitignore'), ['.local/', 'bin/', 'node_modules/', '*.log'].join('\n'));

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPath = join(root, '.local/release/private.pem');
  mkdirSync(join(root, '.local/release'), { recursive: true });
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(
    join(root, 'docs/release/evidence/release-evidence-public-key.pem'),
    publicKey.export({ type: 'spki', format: 'pem' }),
  );

  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Release Evidence Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);

  return { root, privateKeyPath };
}

function installNonNodeCommandStubs(root: string) {
  const binDir = join(root, 'bin');
  const npmLog = join(root, 'npm.log');
  const npxLog = join(root, 'npx.log');
  const sshLog = join(root, 'ssh.log');
  mkdirSync(binDir);

  writeExecutable(
    join(binDir, 'npm'),
    `#!/usr/bin/env bash
printf '%s\\n' "npm $*" >> "${npmLog}"
exit 0
`,
  );
  writeExecutable(
    join(binDir, 'npx'),
    `#!/usr/bin/env bash
printf '%s\\n' "npx $*" >> "${npxLog}"
exit 0
`,
  );
  writeExecutable(
    join(binDir, 'ssh'),
    `#!/usr/bin/env bash
printf '%s\\n' "ssh $*" >> "${sshLog}"
exit 0
`,
  );

  return { binDir, npmLog, npxLog, sshLog };
}

function writeSignedEvidenceFiles(root: string, privateKeyPath: string) {
  const sha = git(root, ['rev-parse', 'HEAD']);
  const evidenceDir = join(root, '.local/release/evidence');
  mkdirSync(evidenceDir, { recursive: true });
  for (const runId of ['1001', '1002', '1003']) {
    execFileSync(
      process.execPath,
      [
        'scripts/release-evidence.mjs',
        'write',
        '--evidence',
        join(evidenceDir, `release-evidence-${sha}-${runId}-1.json`),
      ],
      {
        cwd: root,
        env: cleanGitEnv({
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
          NEXUS_RELEASE_RUN_ID: runId,
          NEXUS_RELEASE_RUN_ATTEMPT: '1',
        }),
      },
    );
  }
  copyFileSync(join(evidenceDir, `release-evidence-${sha}-1003-1.json`), join(evidenceDir, 'latest-release-evidence.json'));
}

function installCommandStubs(root: string) {
  const binDir = join(root, 'bin');
  const npmLog = join(root, 'npm.log');
  const npxLog = join(root, 'npx.log');
  mkdirSync(binDir);

  writeExecutable(
    join(binDir, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  -p)
    echo "4.14.205"
    exit 0
    ;;
  -e)
    exit 0
    ;;
esac
target="\${1:-}"
case "$target" in
	  *scripts/release-evidence.mjs)
	    if [ "\${FAKE_RELEASE_EVIDENCE_OK:-0}" = "1" ]; then
	      evidence_path=""
	      previous=""
	      for arg in "$@"; do
	        if [ "$previous" = "--evidence" ]; then
	          evidence_path="$arg"
	          break
	        fi
	        previous="$arg"
	      done
	      evidence_base="$(basename "$evidence_path")"
	      run_id="fixture-run"
	      if [[ "$evidence_base" =~ release-evidence-[0-9a-f]+-([0-9]+)(-[0-9]+)?\\.json ]]; then
	        run_id="\${BASH_REMATCH[1]}"
	      fi
	      echo "{\\"ok\\":true,\\"evidence\\":{\\"runId\\":\\"$run_id\\",\\"runAttempt\\":\\"1\\",\\"manifestDigest\\":\\"\${FAKE_RELEASE_EVIDENCE_DIGEST:-fixture-digest}\\",\\"commands\\":{\\"vitest\\":\\"success\\",\\"pytest\\":\\"success\\",\\"smoke\\":\\"success\\"}}}"
	      exit 0
	    fi
	    echo '{"ok":false,"reasons":["fixture_missing_evidence"]}'
    exit 1
    ;;
  *scripts/rollback-drill-check.mjs)
    if [ "\${FAKE_ROLLBACK_OK:-0}" = "1" ]; then
      echo '{"ok":true,"checks":["fixture"]}'
      exit 0
    fi
    echo '{"ok":false,"reasons":["fixture_missing_rollback"]}'
    exit 1
    ;;
  *scripts/migration-safety-check.mjs)
    echo 'migration safety fixture ok'
    exit 0
    ;;
	  *scripts/release-artifact-manifest.mjs)
	    echo "\${FAKE_ARTIFACT_DIGEST:-fixture-digest}"
	    exit 0
	    ;;
esac
exit 0
`,
  );

  writeExecutable(
    join(binDir, 'npm'),
    `#!/usr/bin/env bash
printf '%s\\n' "npm $*" >> "${npmLog}"
exit 0
`,
  );

  writeExecutable(
    join(binDir, 'npx'),
    `#!/usr/bin/env bash
printf '%s\\n' "npx $*" >> "${npxLog}"
exit 0
`,
  );

  writeExecutable(
    join(binDir, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
cmd="\${*: -1}"
case "$cmd" in
  *"[ -d "*)
    echo yes
    ;;
  *release-artifact-manifest.mjs*)
    echo fixture-digest
    ;;
  *"git rev-parse --short HEAD"*)
    echo fixture-sha
    ;;
  *package.json*)
    echo 4.14.205
    ;;
  *)
    echo yes
    ;;
esac
`,
  );

  return { binDir, npmLog, npxLog };
}

function createEvidenceFiles(root: string) {
  const sha = git(root, ['rev-parse', 'HEAD']);
  const evidenceDir = join(root, '.local/release/evidence');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'latest-release-evidence.json'), '{"ok":true}');
  for (const attempt of [1, 2, 3]) {
    writeFileSync(join(evidenceDir, `release-evidence-${sha}-${attempt}.json`), '{"ok":true}');
  }
}

function createDuplicateRunIdEvidenceFiles(root: string) {
  const sha = git(root, ['rev-parse', 'HEAD']);
  const evidenceDir = join(root, '.local/release/evidence');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'latest-release-evidence.json'), '{"ok":true}');
  for (const name of [
    `release-evidence-${sha}-1-1.json`,
    `release-evidence-${sha}-1-2.json`,
    `release-evidence-${sha}-2-1.json`,
    `release-evidence-${sha}-3-1.json`,
  ]) {
    writeFileSync(join(evidenceDir, name), '{"ok":true}');
  }
}

describe('release deploy dry-run harness', () => {
  function expectFullVerifyOnly(npmLog: string) {
    const log = readFileSync(npmLog, 'utf8');
    expect(log).toContain('npm run verify');
    expect(log).not.toContain('release:focused');
    expect(log).not.toContain('release:verify');
  }

  it('deploy.sh --dry-run skips npm verify when signed evidence gates pass', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog, npxLog } = installCommandStubs(root);
    createEvidenceFiles(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          NEXUS_RELEASE_MIN_CLEAN_RCS: '3',
          FAKE_RELEASE_EVIDENCE_OK: '1',
          FAKE_ROLLBACK_OK: '1',
        }),
      });

      expect(output).toContain('signed evidence matches SHA + manifest digest + clean RC history + rollback drill');
      expect(output).toContain('TYPECHECK PASSED');
      expect(output).toContain('DRY RUN');
      expect(() => readFileSync(npmLog, 'utf8')).toThrow();
      expect(readFileSync(npxLog, 'utf8')).toContain('npx tsc --noEmit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run falls back to npm verify when evidence is missing', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog } = installCommandStubs(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          FAKE_RELEASE_EVIDENCE_OK: '0',
          FAKE_ROLLBACK_OK: '1',
        }),
      });

      expect(output).toContain('no matching release evidence');
      expect(output).toContain('Running full validation');
      expect(output).toContain('DRY RUN');
      expectFullVerifyOnly(npmLog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run falls back to npm verify when rollback drill evidence is missing', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog } = installCommandStubs(root);
    createEvidenceFiles(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          NEXUS_RELEASE_MIN_CLEAN_RCS: '3',
          FAKE_RELEASE_EVIDENCE_OK: '1',
          FAKE_ROLLBACK_OK: '0',
        }),
      });

      expect(output).toContain('Checking current rollback drill evidence');
      expect(output).toContain('Evidence reuse preconditions are not complete');
      expectFullVerifyOnly(npmLog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run counts distinct signed run IDs rather than evidence filenames', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog } = installCommandStubs(root);
    createDuplicateRunIdEvidenceFiles(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          NEXUS_RELEASE_MIN_CLEAN_RCS: '4',
          FAKE_RELEASE_EVIDENCE_OK: '1',
          FAKE_ROLLBACK_OK: '1',
        }),
      });

      expect(output).toContain('Duplicate signed RC run ID ignored: 1');
      expect(output).toContain('Distinct clean signed RC evidence run count is 3/4');
      expectFullVerifyOnly(npmLog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run keeps shadow auto-when-staged on the full verify path', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog } = installCommandStubs(root);
    createEvidenceFiles(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '0',
          FAKE_RELEASE_EVIDENCE_OK: '1',
          FAKE_ROLLBACK_OK: '1',
        }),
      });

      expect(output).toContain('evidence reuse is still in shadow');
      expectFullVerifyOnly(npmLog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run uses full verify for unknown skip modes', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog } = installCommandStubs(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'unknown-mode',
          FAKE_RELEASE_EVIDENCE_OK: '1',
          FAKE_ROLLBACK_OK: '1',
        }),
      });

      expect(output).toContain("Unrecognized NEXUS_DEPLOY_SKIP_VERIFY='unknown-mode'");
      expectFullVerifyOnly(npmLog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh non-dry-run exits before remote mutation when post-build digest drifts from signed evidence', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog } = installCommandStubs(root);
    createEvidenceFiles(root);

    try {
      let combined = '';
      let status: number | undefined;
      try {
        execFileSync('bash', ['scripts/deploy.sh'], {
          cwd: root,
          env: cleanGitEnv({
            PATH: prependPath(binDir),
            NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
            NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
            NEXUS_RELEASE_MIN_CLEAN_RCS: '3',
            NEXUS_DEPLOY_ALLOW_TEMP_CHECKOUT: '1',
            NEXUS_EMERGENCY_SKIP_REASON: 'fixture temp checkout exercises pre-mutation digest guard',
            FAKE_RELEASE_EVIDENCE_OK: '1',
            FAKE_RELEASE_EVIDENCE_DIGEST: 'evidence-digest',
            FAKE_ARTIFACT_DIGEST: 'post-build-digest',
            FAKE_ROLLBACK_OK: '1',
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        status = failure.status;
        combined = `${String(failure.stdout ?? '')}\n${String(failure.stderr ?? '')}`;
      }

      expect(status).toBe(1);
      expect(combined).toContain('Post-build artifact digest no longer matches the signed release evidence');
      expect(readFileSync(npmLog, 'utf8')).toContain('npm run build');
      expect(combined).not.toContain('Validating production .env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh non-dry-run refuses temporary checkouts without an audited override', () => {
    const root = createReleaseHarnessRepo();
    const { binDir } = installCommandStubs(root);

    try {
      let combined = '';
      let status: number | undefined;
      try {
        execFileSync('bash', ['scripts/deploy.sh'], {
          cwd: root,
          env: cleanGitEnv({
            PATH: prependPath(binDir),
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        status = failure.status;
        combined = `${String(failure.stdout ?? '')}\n${String(failure.stderr ?? '')}`;
      }

      expect(status).toBeGreaterThan(0);
      expect(combined).toContain('Refusing production deploy from temporary checkout');
      expect(combined).toContain('uncommitted release work cannot be silently left behind');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run reuses real signed evidence bound to the fixture HEAD', () => {
    const { root, privateKeyPath } = createRealEvidenceHarnessRepo();
    const { binDir, npmLog, npxLog, sshLog } = installNonNodeCommandStubs(root);
    writeSignedEvidenceFiles(root, privateKeyPath);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          NEXUS_RELEASE_MIN_CLEAN_RCS: '3',
        }),
      });

      expect(output).toContain('signed evidence matches SHA + manifest digest + clean RC history + rollback drill');
      expect(output).toContain('"runId": "1003"');
      expect(output).toContain('TYPECHECK PASSED');
      expect(() => readFileSync(npmLog, 'utf8')).toThrow();
      expect(readFileSync(npxLog, 'utf8')).toContain('npx tsc --noEmit');
      expect(() => readFileSync(sshLog, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run falls back to full verify when real signed evidence is tampered', () => {
    const { root, privateKeyPath } = createRealEvidenceHarnessRepo();
    const { binDir, npmLog } = installNonNodeCommandStubs(root);
    writeSignedEvidenceFiles(root, privateKeyPath);
    const latestEvidencePath = join(root, '.local/release/evidence/latest-release-evidence.json');
    const evidence = JSON.parse(readFileSync(latestEvidencePath, 'utf8'));
    evidence.payload.verdict = 'passed';
    evidence.signature = 'tampered';
    writeFileSync(latestEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          NEXUS_RELEASE_MIN_CLEAN_RCS: '3',
        }),
      });

      expect(output).toContain('no matching release evidence');
      expect(output).toContain('signature');
      expectFullVerifyOnly(npmLog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dirty deploy dry-run refuses evidence reuse instead of skipping full verify', () => {
    const root = createReleaseHarnessRepo();
    const { binDir } = installCommandStubs(root);
    createEvidenceFiles(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '4.14.206' }, null, 2));

    try {
      let combined = '';
      try {
        execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
          cwd: root,
          env: cleanGitEnv({
            PATH: prependPath(binDir),
            NEXUS_DEPLOY_ALLOW_DIRTY: '1',
            NEXUS_EMERGENCY_SKIP_REASON: 'dry-run-test',
            NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
            NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
            FAKE_RELEASE_EVIDENCE_OK: '1',
            FAKE_ROLLBACK_OK: '1',
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        throw new Error('expected dirty deploy evidence reuse to fail');
      } catch (error) {
        const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string };
        combined = `${String(failure.stdout ?? '')}\n${String(failure.stderr ?? '')}`;
      }

      expect(combined).toContain('Dirty production deploys cannot reuse evidence or skip full verification');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('promote-to-prod.sh --dry-run exercises staging gates without invoking deploy.sh', () => {
    const root = createReleaseHarnessRepo();
    const { binDir } = installCommandStubs(root);
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/index.js'), '');
    writeExecutable(
      join(root, 'scripts/env-parity-check.sh'),
      `#!/usr/bin/env bash
echo env_parity_ok
`,
    );
    writeExecutable(
      join(root, 'scripts/staging-smoke.sh'),
      `#!/usr/bin/env bash
echo staging_smoke_ok
`,
    );

    try {
      const output = execFileSync('bash', ['scripts/promote-to-prod.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        input: 'YES\n',
        env: cleanGitEnv({
          PATH: prependPath(binDir),
          FAKE_RELEASE_EVIDENCE_OK: '1',
        }),
      });

      expect(output).toContain('Staging install present');
      expect(output).toContain('Local and staging artifact manifests match');
      expect(output).toContain('staging_smoke_ok');
      expect(output).toContain('[DRY RUN] Would now run ./scripts/deploy.sh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
