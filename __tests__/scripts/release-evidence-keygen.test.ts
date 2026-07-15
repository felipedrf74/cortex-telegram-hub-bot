import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const keygen = path.resolve('scripts/release-evidence-keygen.mjs');

function filesBelow(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const file = path.join(root, name);
    return statSync(file).isDirectory() ? filesBelow(file) : [file];
  });
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-keygen-'));
  const bin = path.join(root, 'bin');
  const result = path.join(root, 'gh-result.json');
  mkdirSync(bin, { recursive: true });
  const fakeGh = path.join(bin, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] !== 'secret' || args[1] !== 'set') process.exit(64);
if (process.env.FAKE_GH_FAIL === '1') process.exit(23);
const privateBody = fs.readFileSync(0);
const publicPem = crypto.createPublicKey(crypto.createPrivateKey(privateBody))
  .export({ type: 'spki', format: 'pem' });
fs.writeFileSync(process.env.FAKE_GH_RESULT, JSON.stringify({ args, publicPem }));
`, { mode: 0o755 });
  chmodSync(fakeGh, 0o755);
  return { root, bin, result };
}

function runKeygen(
  state: ReturnType<typeof fixture>,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [
    keygen,
    '--root', state.root,
    '--repo', 'felipedrf74/cortex-telegram-hub-bot',
    '--force',
    ...extraArgs,
  ], {
    cwd: state.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      PATH: `${state.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_GH_RESULT: state.result,
    },
  });
}

describe('release evidence key rotation', () => {
  it('streams the private key only to the release-signing environment and persists only the public verifier', () => {
    const state = fixture();
    try {
      const run = runKeygen(state);
      expect(run.status, run.stderr).toBe(0);

      const publicPath = path.join(state.root, 'docs/release/evidence/release-evidence-public-key.pem');
      const call = JSON.parse(readFileSync(state.result, 'utf8')) as {
        args: string[];
        publicPem: string;
      };
      expect(call.args).toEqual([
        'secret',
        'set',
        'NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM',
        '--env',
        'release-signing',
        '--repo',
        'felipedrf74/cortex-telegram-hub-bot',
      ]);
      expect(readFileSync(publicPath, 'utf8')).toBe(call.publicPem);
      expect(run.stdout).toContain('No private signing key was persisted locally.');
      const privatePemHeader = `-----BEGIN ${'PRIVATE'} KEY-----`;
      expect(filesBelow(state.root).some((file) => (
        readFileSync(file, 'utf8').includes(privatePemHeader)
      ))).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('preserves the existing verifier when the environment secret update fails', () => {
    const state = fixture();
    try {
      const publicPath = path.join(state.root, 'docs/release/evidence/release-evidence-public-key.pem');
      mkdirSync(path.dirname(publicPath), { recursive: true });
      writeFileSync(publicPath, 'existing-public-verifier\n');

      const run = runKeygen(state, [], { FAKE_GH_FAIL: '1' });
      expect(run.status).toBe(1);
      expect(readFileSync(publicPath, 'utf8')).toBe('existing-public-verifier\n');
      expect(filesBelow(state.root).some((file) => file.includes('.next-'))).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('rejects the retired private-key file interface before invoking GitHub', () => {
    const state = fixture();
    try {
      const run = runKeygen(state, ['--private-key', '.local/private.pem']);
      expect(run.status).toBe(64);
      expect(run.stderr).toContain('Private-key file output is forbidden');
      expect(filesBelow(state.root).some((file) => file.endsWith('gh-result.json'))).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
