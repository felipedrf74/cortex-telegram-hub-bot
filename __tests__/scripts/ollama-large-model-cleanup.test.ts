import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createObservationFixture,
  OLLAMA_DELETE as TARGETS,
  OLLAMA_DIGESTS as DIGESTS,
  OLLAMA_RETAINED as RETAINED,
  writeMode600,
} from './helpers/ollama-observation-fixture';

const SCRIPT = path.resolve('scripts/ollama-large-model-cleanup.mjs');
const apiDigest = (tag: string) => DIGESTS.get(tag)!.slice('sha256:'.length);
type RunResult = { status: number | string; stdout: string; stderr: string };

function runGate(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      cwd: process.cwd(), env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15_000,
    }, (error, stdout, stderr) => {
      resolveRun({ status: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('Ollama exact-digest large-model cleanup gate', () => {
  let tempDir: string;
  let evidencePath: string;
  let fakeOllamaPath: string;
  let fakeLogPath: string;
  let server: Server;
  let origin: string;
  let inventory: Array<{ name: string; model: string; digest: string }>;
  let loaded: Array<{ name: string; model: string }>;

  function resetInventory() {
    inventory = [RETAINED, ...TARGETS].map((tag) => ({
      name: tag, model: tag, digest: apiDigest(tag),
    }));
    loaded = [{ name: RETAINED, model: RETAINED }];
  }

  function writeEvidence({
    stagingDurationSeconds = 24 * 60 * 60,
    productionCompletedHoursAgo = 0.3,
    productionSampleMutation,
    productionRequestRows,
    productionRequestMutation,
    productionResultMutation,
  }: {
    stagingDurationSeconds?: number;
    productionCompletedHoursAgo?: number;
    productionSampleMutation?: (sample: Record<string, any>, sequence: number) => void;
    productionRequestRows?: Array<{ provider: string; model: string; requests: number; localRequestUnits: number }>;
    productionRequestMutation?: (request: Record<string, any>) => void;
    productionResultMutation?: (result: Record<string, any>) => void;
  } = {}) {
    const now = Date.now();
    const productionStarted = now - (24 + productionCompletedHoursAgo) * 60 * 60 * 1000;
    const stagingCompleted = productionStarted - 10 * 60 * 1000;
    const staging = createObservationFixture({
      root: tempDir,
      phase: 'staging',
      startedAt: new Date(stagingCompleted - stagingDurationSeconds * 1000).toISOString(),
      durationSeconds: stagingDurationSeconds,
      intervalSeconds: 60 * 60,
    });
    const production = createObservationFixture({
      root: tempDir,
      phase: 'production',
      startedAt: new Date(productionStarted).toISOString(),
      intervalSeconds: 60 * 60,
      previousObservation: staging,
      requestRows: productionRequestRows,
      sampleMutation: productionSampleMutation,
      requestMutation: productionRequestMutation,
      resultMutation: productionResultMutation,
    });
    evidencePath = production.resultPath;
    return { staging, production };
  }

  function args(extra: string[] = []) {
    return [
      '--evidence', evidencePath,
      '--ollama-url', origin,
      '--ollama-bin', fakeOllamaPath,
      ...extra,
    ];
  }

  function environment() {
    return {
      ...process.env,
      NEXUS_OLLAMA_COLLECTOR_TEST_MODE: '1',
      FAKE_OLLAMA_LOG: fakeLogPath,
    };
  }

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-cleanup-')));
    fs.chmodSync(tempDir, 0o700);
    fakeOllamaPath = path.join(tempDir, 'ollama');
    fakeLogPath = path.join(tempDir, 'ollama.log');
    resetInventory();
    writeEvidence();

    server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/api/tags') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: inventory }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/ps') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: loaded }));
        return;
      }
      if (request.method === 'POST' && request.url === '/test/remove') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          const cliArgs = JSON.parse(body) as string[];
          if (cliArgs[0] !== 'rm' || JSON.stringify(cliArgs.slice(1)) !== JSON.stringify(TARGETS)) {
            response.statusCode = 422;
            response.end();
            return;
          }
          inventory = inventory.filter((entry) => !TARGETS.includes(entry.name));
          response.statusCode = 204;
          response.end();
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fake Ollama server did not bind');
    origin = `http://127.0.0.1:${address.port}`;

    fs.writeFileSync(fakeOllamaPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_OLLAMA_LOG, JSON.stringify(args) + '\\n');
fetch(process.env.OLLAMA_HOST + '/test/remove', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
}).then((response) => process.exit(response.ok ? 0 : 2), () => process.exit(3));
`, { mode: 0o755 });
    fs.chmodSync(fakeOllamaPath, 0o755);
  });

  afterEach(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('dry-runs without mutation, then removes only three exact targets after explicit acknowledgment', async () => {
    const dryRun = await runGate(args(['--dry-run']), environment());
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const plan = JSON.parse(dryRun.stdout);
    expect(plan).toMatchObject({ mode: 'dry-run', mutationAttempted: false });
    expect(plan.ackPlan).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.retained).toEqual({ tag: RETAINED, digest: DIGESTS.get(RETAINED) });
    expect(plan.delete.map((entry: { tag: string }) => entry.tag)).toEqual(TARGETS);
    expect(fs.existsSync(fakeLogPath)).toBe(false);

    const resultPath = path.join(tempDir, 'cleanup-result.json');
    const apply = await runGate(args([
      '--apply', '--owner-authorized', '--ack-plan', plan.ackPlan, '--result', resultPath,
    ]), environment());
    expect(apply.status, apply.stderr).toBe(0);
    expect(fs.readFileSync(fakeLogPath, 'utf8').trim()).toBe(JSON.stringify(['rm', ...TARGETS]));
    expect(inventory).toEqual([{ name: RETAINED, model: RETAINED, digest: apiDigest(RETAINED) }]);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'complete',
      finalInventory: [{ tag: RETAINED, digest: DIGESTS.get(RETAINED) }],
      retainedDigestVerifiedBeforeAndAfter: true,
    });
    expect(fs.statSync(resultPath).mode & 0o777).toBe(0o600);
  });

  it('requires explicit owner authorization and the exact fresh plan token', async () => {
    const dryRun = await runGate(args(), environment());
    const token = JSON.parse(dryRun.stdout).ackPlan;
    const resultPath = path.join(tempDir, 'cleanup-result.json');
    const noOwner = await runGate(args(['--apply', '--ack-plan', token, '--result', resultPath]), environment());
    expect(noOwner.status).not.toBe(0);
    expect(noOwner.stderr).toContain('--owner-authorized is required');
    const wrong = await runGate(args([
      '--apply', '--owner-authorized', '--ack-plan', `sha256:${'f'.repeat(64)}`, '--result', resultPath,
    ]), environment());
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('acknowledgment does not match');
    expect(fs.existsSync(fakeLogPath)).toBe(false);
  });

  it('fails closed on short, stale, unhealthy, or large-model-request collector evidence', async () => {
    let fixtures = writeEvidence({ stagingDurationSeconds: 23 * 60 * 60 });
    let result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('at least 24 hours');

    fixtures = writeEvidence({ productionCompletedHoursAgo: 25 });
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('evidence is stale');

    fixtures = writeEvidence({
      productionSampleMutation(sample, sampleSequence) {
        if (sampleSequence === 1) sample.application.backendHealthy = false;
      },
    });
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unhealthy application service');

    fixtures = writeEvidence({
      productionRequestRows: [
        { provider: 'ollama', model: RETAINED, requests: 12, localRequestUnits: 12 },
        { provider: 'ollama', model: TARGETS[1], requests: 1, localRequestUnits: 1 },
      ],
    });
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('zero large-model and unapproved-model requests');
    expect(fixtures.production.resultPath).toBe(evidencePath);
    expect(fs.existsSync(fakeLogPath)).toBe(false);
  });

  it('rejects PM2 SHA drift and every tampered control-request binding', async () => {
    let fixtures = writeEvidence({
      productionSampleMutation(sample, sampleSequence) {
        if (sampleSequence === 1) {
          sample.application.pm2[0].releaseSha = '9'.repeat(40);
        }
      },
    });
    let result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requested exact runtime SHA');

    fixtures = writeEvidence({
      productionSampleMutation(sample, sampleSequence) {
        if (sampleSequence === 1) {
          sample.controlRequest.requestSha256 = `sha256:${'9'.repeat(64)}`;
        }
      },
    });
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('control request identity mismatch');

    fixtures = writeEvidence({
      productionRequestMutation(request) {
        request.controlRequest.requestId = '99999999-2222-4333-8444-555555555555';
      },
    });
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('request evidence control request identity mismatch');

    fixtures = writeEvidence({
      productionResultMutation(observation) {
        observation.previousControlRequest.requestSha256 = `sha256:${'8'.repeat(64)}`;
      },
    });
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('prior staging control request');
    expect(fixtures.production.resultPath).toBe(evidencePath);
    expect(fs.existsSync(fakeLogPath)).toBe(false);
  });

  it('rejects unexpected runtime inventory, digest mismatch, and loaded deletion targets', async () => {
    inventory.push({ name: 'unexpected:latest', model: 'unexpected:latest', digest: 'e'.repeat(64) });
    let result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpected tag');
    resetInventory();
    inventory.find((entry) => entry.name === TARGETS[1])!.digest = 'e'.repeat(64);
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`digest mismatch for ${TARGETS[1]}`);
    resetInventory();
    loaded.push({ name: TARGETS[2], model: TARGETS[2] });
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`deletion target is still loaded: ${TARGETS[2]}`);
  });

  it('requires the root-collector schema, protected raw hash chain, and mode-0600 files', async () => {
    let fixtures = writeEvidence();
    fs.appendFileSync(fixtures.production.samplePaths[1], ' ');
    let result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hash chain is broken');

    fixtures = writeEvidence();
    fs.chmodSync(fixtures.production.samplePaths[0], 0o640);
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('mode 0600');

    fixtures = writeEvidence();
    fs.chmodSync(fixtures.production.resultPath, 0o644);
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('mode 0600');

    const copiedAggregate = path.join(tempDir, 'copied-aggregate.json');
    writeMode600(copiedAggregate, {
      schema: 'nexus.ollama-large-model-cleanup-evidence.v2',
      host: 'serverdominguez',
      generatedAt: new Date().toISOString(),
      soaks: { staging: { healthy: true }, production: { healthy: true } },
    });
    evidencePath = copiedAggregate;
    result = await runGate(args(), environment());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('governed schema');
    expect(fs.existsSync(fakeLogPath)).toBe(false);
  });

  it('documents a manual one-shot collector and never accepts template-authored authorization', () => {
    const runbook = fs.readFileSync('ops/ollama/LARGE_MODEL_CLEANUP.md', 'utf8');
    expect(runbook).toContain('nexus-ollama-observation-collector.mjs');
    expect(runbook).toContain('foreground');
    expect(runbook).toContain('--owner-authorized');
    expect(runbook).toContain('api_usage');
    expect(runbook).not.toContain('large-model-cleanup-evidence.example.json');
  });
});
