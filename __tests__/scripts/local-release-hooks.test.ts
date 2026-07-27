import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function cleanGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return { ...env, ...overrides };
}

function write(file: string, body: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

function fixture(): {
  head: string;
  hook: string;
  log: string;
  preCommit: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-local-hooks-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: cleanGitEnv(),
  }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Nexus Hook Fixture');
  git('config', 'user.email', 'hook-fixture@example.invalid');
  write(path.join(root, 'tracked.txt'), 'baseline\n');
  git('add', 'tracked.txt');
  git('commit', '--quiet', '-m', 'fixture baseline');

  const hook = path.join(root, '.husky/pre-push');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.copyFileSync('.husky/pre-push', hook);
  fs.chmodSync(hook, 0o755);
  const preCommit = path.join(root, '.husky/pre-commit');
  fs.copyFileSync('.husky/pre-commit', preCommit);
  fs.chmodSync(preCommit, 0o755);
  const receiptLogger = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(
  process.env.NEXUS_HOOK_LOG,
  \`\${JSON.stringify({ kind: 'receipt', args: process.argv.slice(2) })}\\n\`,
);
`;
  const riskLogger = `#!/usr/bin/env bash
node scripts/hook-risk-logger.mjs "$@"
`;
  const riskLoggerModule = `import fs from 'node:fs';
fs.appendFileSync(
  process.env.NEXUS_HOOK_LOG,
  \`\${JSON.stringify({ kind: 'risk', args: process.argv.slice(2) })}\\n\`,
);
`;
  const npmLogger = `#!/usr/bin/env bash
node scripts/hook-npm-logger.mjs "$@"
`;
  const npmLoggerModule = `import fs from 'node:fs';
fs.appendFileSync(
  process.env.NEXUS_HOOK_LOG,
  \`\${JSON.stringify({ kind: 'npm', args: process.argv.slice(2) })}\\n\`,
);
`;
  write(path.join(root, 'scripts/risk-gate.sh'), riskLogger, 0o755);
  write(path.join(root, 'scripts/hook-risk-logger.mjs'), riskLoggerModule);
  write(path.join(root, 'scripts/hook-npm-logger.mjs'), npmLoggerModule);
  write(path.join(root, 'scripts/local-full-vitest-receipt.mjs'), receiptLogger, 0o755);
  write(path.join(root, 'bin/npm'), npmLogger, 0o755);
  return {
    head: git('rev-parse', 'HEAD'),
    hook,
    log: path.join(root, 'hook.log'),
    preCommit,
    root,
  };
}

function invoke(root: string, hook: string, log: string, input: string) {
  return spawnSync('bash', [hook], {
    cwd: root,
    encoding: 'utf8',
    input,
    env: cleanGitEnv({
      NEXUS_HOOK_LOG: log,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    }),
  });
}

function records(log: string): Array<{ kind: string; args: string[] }> {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('local release Git hooks', () => {
  it('hands the exact staged index to the pre-commit risk gate', () => {
    const state = fixture();
    execFileSync('git', ['mv', 'tracked.txt', 'renamed.txt'], {
      cwd: state.root,
      env: cleanGitEnv(),
    });

    const result = spawnSync('bash', [state.preCommit], {
      cwd: state.root,
      encoding: 'utf8',
      env: cleanGitEnv({
        NEXUS_HOOK_LOG: state.log,
        NEXUS_PRECOMMIT_SKIP_IDENTITY_REFRESH: '1',
        NEXUS_PRECOMMIT_SKIP_SANDBOX_NUDGE: '1',
        NEXUS_PRECOMMIT_SKIP_SCIENCE_POLICY: '1',
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(records(state.log)).toEqual([{
      kind: 'risk',
      args: ['--staged', '--local-reuse-context', 'pre-commit'],
    }]);
  });

  it('binds branch, lightweight-tag, and annotated-tag pushes to the exact commit', () => {
    const state = fixture();
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: state.root,
      encoding: 'utf8',
      env: cleanGitEnv(),
    }).trim();
    const zero = '0'.repeat(40);

    const branch = invoke(
      state.root,
      state.hook,
      state.log,
      `refs/heads/main ${state.head} refs/heads/review ${zero}\n`,
    );
    expect(branch.status, branch.stderr).toBe(0);
    expect(records(state.log)).toEqual([
      {
        kind: 'receipt',
        args: ['check-pushed-candidate', '--pushed-sha', state.head],
      },
      {
        kind: 'risk',
        args: [
          '--base',
          'main',
          '--local-reuse-context',
          'pre-push',
          '--local-pushed-sha',
          state.head,
        ],
      },
      {
        kind: 'receipt',
        args: ['check-pushed-candidate', '--pushed-sha', state.head],
      },
    ]);

    fs.rmSync(state.log);
    const main = invoke(
      state.root,
      state.hook,
      state.log,
      `refs/heads/main ${state.head} refs/heads/main ${zero}\n`,
    );
    expect(main.status, main.stderr).toBe(0);
    expect(records(state.log)).toEqual([
      { kind: 'npm', args: ['run', 'build'] },
      {
        kind: 'receipt',
        args: ['check-pushed-candidate', '--pushed-sha', state.head],
      },
      {
        kind: 'risk',
        args: [
          '--base',
          'main',
          '--local-reuse-context',
          'pre-push',
          '--local-pushed-sha',
          state.head,
          '--skip-typecheck',
        ],
      },
      {
        kind: 'receipt',
        args: ['check-pushed-candidate', '--pushed-sha', state.head],
      },
    ]);

    fs.rmSync(state.log);
    git('tag', 'lightweight');
    const lightweight = invoke(
      state.root,
      state.hook,
      state.log,
      `refs/tags/lightweight ${state.head} refs/tags/lightweight ${zero}\n`,
    );
    expect(lightweight.status, lightweight.stderr).toBe(0);
    expect(records(state.log).find((record) => record.kind === 'risk')?.args)
      .toContain(state.head);

    fs.rmSync(state.log);
    git('tag', '-a', 'annotated', '-m', 'annotated fixture');
    const tagObject = git('rev-parse', 'refs/tags/annotated');
    const annotated = invoke(
      state.root,
      state.hook,
      state.log,
      `refs/tags/annotated ${tagObject} refs/tags/annotated ${zero}\n`,
    );
    expect(annotated.status, annotated.stderr).toBe(0);
    expect(records(state.log).find((record) => record.kind === 'risk')?.args)
      .toContain(state.head);
  });

  it('accepts an up-to-date retry and rejects ambiguous ref updates', () => {
    const state = fixture();
    const zero = '0'.repeat(40);

    const noOp = invoke(state.root, state.hook, state.log, '');
    expect(noOp.status, noOp.stderr).toBe(0);
    expect(noOp.stdout).toContain('already up to date');
    expect(records(state.log)).toEqual([]);

    const multi = invoke(
      state.root,
      state.hook,
      state.log,
      [
        `refs/heads/main ${state.head} refs/heads/one ${zero}`,
        `refs/heads/main ${state.head} refs/heads/two ${zero}`,
        '',
      ].join('\n'),
    );
    expect(multi.status).toBe(64);
    expect(multi.stderr).toContain('exactly one well-formed non-delete ref update');
    expect(records(state.log)).toEqual([]);

    const deletion = invoke(
      state.root,
      state.hook,
      state.log,
      `(delete) ${zero} refs/heads/review ${state.head}\n`,
    );
    expect(deletion.status).toBe(64);
    expect(deletion.stderr).toContain('exactly one well-formed non-delete ref update');

    const wrong = '1'.repeat(40);
    const mismatch = invoke(
      state.root,
      state.hook,
      state.log,
      `refs/heads/main ${wrong} refs/heads/review ${zero}\n`,
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('local ref does not match');
    expect(records(state.log)).toEqual([]);
  });
});
