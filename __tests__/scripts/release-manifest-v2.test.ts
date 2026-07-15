import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const script = path.resolve('scripts/release-manifest-v2.mjs');

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ReleaseManifestV2', () => {
  it('binds passing release tests, source identities, policy, artifact, and an Ed25519 signature', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-manifest-'));
    roots.push(temp);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'private.pem');
    const publicPath = path.join(temp, 'public.pem');
    const resultsPath = path.join(temp, 'results.json');
    const manifestPath = path.join(temp, 'manifest.json');
    fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }));
    fs.writeFileSync(resultsPath, JSON.stringify({ status: 'passed' }));

    execFileSync(process.execPath, [script, 'write',
      '--manifest', manifestPath,
      '--test-results', resultsPath,
      '--private-key', privatePath,
      '--key-id', 'test-key',
    ], { cwd: process.cwd() });
    const validated = JSON.parse(execFileSync(process.execPath, [script, 'validate',
      '--manifest', manifestPath,
      '--public-key', publicPath,
      '--allow-dirty',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }));
    const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(validated).toMatchObject({ ok: true, promotable: true });
    expect(envelope.schema).toBe('nexus.release-manifest.v2');
    expect(envelope.payload.runtimeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(envelope.payload.artifact.files.length).toBeGreaterThan(100);
    expect(envelope.payload.migration.latestId).toMatch(/^\d{3}_/);
    expect(envelope.payload.trainingCatalog.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.payload.testPolicy.results.status).toBe('passed');
  });
});
