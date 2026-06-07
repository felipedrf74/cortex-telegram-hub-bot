import { execFileSync } from 'node:child_process';
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

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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
      echo '{"ok":true,"evidence":{"commands":{"vitest":"success","pytest":"success","smoke":"success"}}}'
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
    echo 'fixture-digest'
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

describe('release deploy dry-run harness', () => {
  it('deploy.sh --dry-run skips npm verify when signed evidence gates pass', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog, npxLog } = installCommandStubs(root);
    createEvidenceFiles(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          NEXUS_RELEASE_MIN_CLEAN_RCS: '3',
          NEXUS_STAGING_PROD_MANIFEST_PARITY_OK: '1',
          NEXUS_STAGING_MANIFEST_DIGEST: 'fixture-digest',
          FAKE_RELEASE_EVIDENCE_OK: '1',
          FAKE_ROLLBACK_OK: '1',
        },
      });

      expect(output).toContain('signed evidence matches SHA + manifest digest + clean RC history');
      expect(output).toContain('Staging/prod manifest parity proof: fixture-digest');
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
        env: {
          ...process.env,
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          FAKE_RELEASE_EVIDENCE_OK: '0',
          FAKE_ROLLBACK_OK: '1',
        },
      });

      expect(output).toContain('no matching release evidence');
      expect(output).toContain('Running full validation');
      expect(output).toContain('DRY RUN');
      expect(readFileSync(npmLog, 'utf8')).toContain('npm run verify');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deploy.sh --dry-run falls back to npm verify when staging parity proof is missing', () => {
    const root = createReleaseHarnessRepo();
    const { binDir, npmLog } = installCommandStubs(root);
    createEvidenceFiles(root);

    try {
      const output = execFileSync('bash', ['scripts/deploy.sh', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: prependPath(binDir),
          NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
          NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
          NEXUS_RELEASE_MIN_CLEAN_RCS: '3',
          FAKE_RELEASE_EVIDENCE_OK: '1',
          FAKE_ROLLBACK_OK: '1',
        },
      });

      expect(output).toContain('Staging/prod manifest parity proof is missing');
      expect(output).toContain('Evidence reuse preconditions are not complete');
      expect(readFileSync(npmLog, 'utf8')).toContain('npm run verify');
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
          env: {
            ...process.env,
            PATH: prependPath(binDir),
            NEXUS_DEPLOY_ALLOW_DIRTY: '1',
            NEXUS_EMERGENCY_SKIP_REASON: 'dry-run-test',
            NEXUS_DEPLOY_SKIP_VERIFY: 'auto-when-staged',
            NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED: '1',
            FAKE_RELEASE_EVIDENCE_OK: '1',
            FAKE_ROLLBACK_OK: '1',
          },
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
        env: {
          ...process.env,
          PATH: prependPath(binDir),
          FAKE_RELEASE_EVIDENCE_OK: '1',
        },
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
