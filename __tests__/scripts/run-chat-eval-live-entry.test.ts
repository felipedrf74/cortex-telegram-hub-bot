import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('run-chat-eval-live entry bootstrap', () => {
  it('arms verifier isolation before the runner import can parse a repository .env', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-eval-bootstrap-'));
    temporaryDirectories.push(directory);
    writeFileSync(
      path.join(directory, '.env'),
      'NEXUS_CHAT_EVAL_DOTENV_SENTINEL=loaded-from-dotenv\n',
      { mode: 0o600 },
    );
    symlinkSync(
      path.resolve(process.cwd(), 'config'),
      path.join(directory, 'config'),
      'dir',
    );
    symlinkSync(
      path.resolve(process.cwd(), 'src'),
      path.join(directory, 'src'),
      'dir',
    );

    const entryUrl = pathToFileURL(
      path.resolve(process.cwd(), 'scripts/run-chat-eval-live.ts'),
    ).href;
    const probe = `
      process.chdir(${JSON.stringify(directory)});
      delete process.env.NEXUS_CHAT_EVAL_DOTENV_SENTINEL;
      import(${JSON.stringify(entryUrl)}).then(async (entry) => {
        await entry.loadChatEvalLiveRunner(
          ['--mode', 'real_provider', '--budget-usd', '0.50'],
          process.env,
        );
        process.stdout.write(JSON.stringify({
          verifier: process.env.NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME,
          sentinel: process.env.NEXUS_CHAT_EVAL_DOTENV_SENTINEL || null,
        }));
      }).catch((error) => {
        process.stderr.write(String(error && error.stack ? error.stack : error));
        process.exitCode = 1;
      });
    `;
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--eval', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME: '',
        NEXUS_CHAT_EVAL_DOTENV_SENTINEL: '',
      },
    });

    expect(JSON.parse(stdout)).toEqual({
      verifier: '1',
      sentinel: null,
    });
  }, 30_000);
});
