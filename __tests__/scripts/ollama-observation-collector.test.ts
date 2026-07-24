import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OLLAMA_DELETE, OLLAMA_RETAINED } from './helpers/ollama-observation-fixture';

const COLLECTOR = path.resolve('scripts/ollama-observation-collector.mjs');
const PYTHON = '/usr/bin/python3';
const RUNTIME_SHA = '1'.repeat(40);
const CONTROL_REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const CONTROL_REQUEST_SHA256 = `sha256:${'e'.repeat(64)}`;
type RunResult = { status: number | string; stdout: string; stderr: string };

describe('Ollama observation collector host contract', () => {
  it('uses the canonical ServerDominguez PM2 executable for real observations', () => {
    const source = fs.readFileSync(COLLECTOR, 'utf8');
    expect(source).toContain(
      "const SERVERDOMINGUEZ_PM2 = '/home/dominguez/.npm-global/bin/pm2';",
    );
    expect(source).not.toContain("pm2Bin: '/usr/local/bin/pm2'");
  });
});

function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      resolveListen({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function runCollector(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [COLLECTOR, ...args], {
      cwd: process.cwd(), env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolveRun({ status: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('root one-shot Ollama observation collector', () => {
  let tempDir: string;
  let outputRoot: string;
  let procRoot: string;
  let database: string;
  let systemctl: string;
  let pm2: string;
  let journalctl: string;
  let servers: Server[];
  let ollamaOrigin: string;
  let backendOrigin: string;
  let contentOrigin: string;
  let uptimeTimer: NodeJS.Timeout;
  let uptimeStarted: number;

  function writeExecutable(file: string, source: string) {
    fs.writeFileSync(file, source, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }

  function writeProc(relative: string, value: string) {
    const file = path.join(procRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const candidate = `${file}.candidate`;
    fs.writeFileSync(candidate, value);
    fs.renameSync(candidate, file);
  }

  function createDatabase(localUnits = 1) {
    const requestTimestamp = new Date(Date.now() + 1000).toISOString();
    execFileSync(PYTHON, ['-c', `
import sqlite3, sys
db, ts, units = sys.argv[1], sys.argv[2], int(sys.argv[3])
connection = sqlite3.connect(db)
connection.execute("CREATE TABLE api_usage (id INTEGER PRIMARY KEY, ts TEXT, provider TEXT, model TEXT, pricing_status TEXT, local_request_units INTEGER)")
connection.execute("INSERT INTO api_usage (ts, provider, model, pricing_status, local_request_units) VALUES (?, 'ollama', ?, 'zero-cost', ?)", (ts, '${OLLAMA_RETAINED}', units))
connection.commit()
connection.close()
`, database, requestTimestamp, String(localUnits)]);
  }

  function args() {
    return [
      '--phase', 'staging',
      '--output-directory', outputRoot,
      '--expected-runtime-sha', RUNTIME_SHA,
      '--control-request-id', CONTROL_REQUEST_ID,
      '--control-request-sha256', CONTROL_REQUEST_SHA256,
      '--duration-seconds', '2',
      '--interval-seconds', '2',
      '--database', database,
      '--ollama-url', ollamaOrigin,
      '--backend-url', `${backendOrigin}/health`,
      '--content-url', `${contentOrigin}/health`,
      '--systemctl-bin', systemctl,
      '--pm2-bin', pm2,
      '--journalctl-bin', journalctl,
      '--python-bin', PYTHON,
      '--proc-root', procRoot,
    ];
  }

  function environment() {
    return { ...process.env, NEXUS_OLLAMA_COLLECTOR_TEST_MODE: '1' };
  }

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-collector-')));
    fs.chmodSync(tempDir, 0o700);
    outputRoot = path.join(tempDir, 'observations');
    procRoot = path.join(tempDir, 'proc');
    database = path.join(tempDir, 'bot.db');
    systemctl = path.join(tempDir, 'systemctl');
    pm2 = path.join(tempDir, 'pm2');
    journalctl = path.join(tempDir, 'journalctl');
    fs.mkdirSync(outputRoot, { mode: 0o700 });
    writeProc('sys/kernel/random/boot_id', '11111111-2222-3333-4444-555555555555\n');
    writeProc('loadavg', '0.10 0.20 0.30 1/100 123\n');
    writeProc('meminfo', 'MemTotal:       33554432 kB\nMemAvailable:   20971520 kB\n');
    writeProc('vmstat', 'pswpin 0\npswpout 0\n');
    writeProc('pressure/memory', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
    uptimeStarted = Date.now();
    const updateUptime = () => writeProc('uptime', `${1000 + Math.floor((Date.now() - uptimeStarted) / 1000)}.00 0.00\n`);
    updateUptime();
    uptimeTimer = setInterval(updateUptime, 100);

    writeExecutable(systemctl, `#!/usr/bin/env node
process.stdout.write([
  'ActiveState=active',
  'NRestarts=0',
  'Environment=OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_MAX_QUEUE=4 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1',
  'MemoryHigh=4294967296',
  'MemoryMax=6442450944',
  'MemorySwapMax=536870912',
  'CPUQuotaPerSecUSec=2s',
  '',
].join('\\n'));
`);
    writeExecutable(pm2, `#!/usr/bin/env node
process.stdout.write(JSON.stringify([
  { name: 'content-engine-staging', pm2_env: { status: 'online', restart_time: 0, NEXUS_RELEASE_SHA: '${RUNTIME_SHA}' } },
  { name: 'nexus-hub-staging', pm2_env: { status: 'online', restart_time: 0, NEXUS_RELEASE_SHA: '${RUNTIME_SHA}' } },
]));
`);
    writeExecutable(journalctl, '#!/bin/sh\nexit 0\n');

    const models = [OLLAMA_RETAINED, ...OLLAMA_DELETE].map((tag, index) => ({
      name: tag, model: tag, digest: String.fromCharCode(97 + index).repeat(64),
    }));
    const ollama = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') response.end(JSON.stringify({ models }));
      else if (request.url === '/api/ps') response.end(JSON.stringify({ models: [{ name: OLLAMA_RETAINED, model: OLLAMA_RETAINED }] }));
      else { response.statusCode = 404; response.end('{}'); }
    });
    const backend = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        status: 'healthy', server: { status: 'online', database: 'connected' }, database: 'connected',
      }));
    });
    const content = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    });
    servers = [ollama.server, backend.server, content.server];
    ollamaOrigin = ollama.origin;
    backendOrigin = backend.origin;
    contentOrigin = content.origin;
  });

  afterEach(async () => {
    clearInterval(uptimeTimer);
    await Promise.all((servers || []).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a validated same-boot hash chain and exact-window SQLite request evidence', async () => {
    createDatabase(1);
    const run = await runCollector(args(), environment());
    expect(run.status, run.stderr).toBe(0);
    const summary = JSON.parse(run.stdout);
    expect(summary).toMatchObject({ status: 'complete', phase: 'staging' });
    const result = JSON.parse(fs.readFileSync(summary.result, 'utf8'));
    expect(result.controlRequest).toEqual({
      requestId: CONTROL_REQUEST_ID,
      requestSha256: CONTROL_REQUEST_SHA256,
      runtimeSha: RUNTIME_SHA,
    });
    expect(result.sampling).toEqual({ intervalSeconds: 2, sampleCount: 2, maximumGapSeconds: 2 });
    expect(result.requestEvidence.path).toBe(path.join(path.dirname(summary.result), 'requests.json'));
    expect(fs.readdirSync(result.samples.directory)).toEqual(['000000.json', '000001.json']);
    const request = JSON.parse(fs.readFileSync(result.requestEvidence.path, 'utf8'));
    expect(request.controlRequest).toEqual(result.controlRequest);
    for (const samplePath of fs.readdirSync(result.samples.directory)) {
      const sample = JSON.parse(
        fs.readFileSync(path.join(result.samples.directory, samplePath), 'utf8'),
      );
      expect(sample.controlRequest).toEqual(result.controlRequest);
      expect(sample.application.pm2.every(
        (row: { releaseSha: string }) => row.releaseSha === RUNTIME_SHA,
      )).toBe(true);
    }
    expect(request.database).toMatchObject({ quickCheck: 'ok', invalidPersistenceRows: 0 });
    expect(request.rows).toEqual([{
      provider: 'ollama', model: OLLAMA_RETAINED, requests: 1, localRequestUnits: 1,
    }]);
    expect(request.totals).toEqual({ total: 1, retainedModel: 1, largeModels: 0, otherModels: 0 });
    expect(fs.statSync(summary.result).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(path.dirname(summary.result), 'result.candidate.json'))).toBe(false);
  }, 15_000);

  it('fails closed when api_usage does not persist one local request unit', async () => {
    createDatabase(0);
    const run = await runCollector(args(), environment());
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('fail-closed request-persistence contract');
    const runDirectories = fs.readdirSync(outputRoot);
    expect(runDirectories).toHaveLength(1);
    const runDirectory = path.join(outputRoot, runDirectories[0]);
    expect(fs.existsSync(path.join(runDirectory, 'failure.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDirectory, 'result.json'))).toBe(false);
  }, 15_000);

  it('rejects a full window whose PM2 samples are consistently on another SHA', async () => {
    createDatabase(1);
    writeExecutable(pm2, `#!/usr/bin/env node
process.stdout.write(JSON.stringify([
  { name: 'content-engine-staging', pm2_env: { status: 'online', restart_time: 0, NEXUS_RELEASE_SHA: '${'2'.repeat(40)}' } },
  { name: 'nexus-hub-staging', pm2_env: { status: 'online', restart_time: 0, NEXUS_RELEASE_SHA: '${'2'.repeat(40)}' } },
]));
`);
    const run = await runCollector(args(), environment());
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('every PM2 sample must equal the requested exact runtime SHA');
    const runDirectory = path.join(outputRoot, fs.readdirSync(outputRoot)[0]);
    expect(fs.existsSync(path.join(runDirectory, 'result.json'))).toBe(false);
  }, 15_000);

  it('invalidates the window when the boot identity changes', async () => {
    createDatabase(1);
    setTimeout(() => {
      writeProc('sys/kernel/random/boot_id', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n');
    }, 500);
    const run = await runCollector(args(), environment());
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('host rebooted during the observation');
    const runDirectory = path.join(outputRoot, fs.readdirSync(outputRoot)[0]);
    expect(fs.existsSync(path.join(runDirectory, 'failure.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDirectory, 'result.json'))).toBe(false);
  }, 15_000);
});
