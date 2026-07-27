import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OLLAMA_RETAINED = 'qwen2.5:3b-instruct-q4_K_M';
export const OLLAMA_DELETE = [
  'gemma2:2b-instruct-q4_K_M',
  'qwen3.6:27b-q4_K_M',
  'qwen3.6:35b-a3b-q4_K_M',
];
export const OLLAMA_DIGESTS = new Map([
  [OLLAMA_RETAINED, `sha256:${'a'.repeat(64)}`],
  [OLLAMA_DELETE[0], `sha256:${'b'.repeat(64)}`],
  [OLLAMA_DELETE[1], `sha256:${'c'.repeat(64)}`],
  [OLLAMA_DELETE[2], `sha256:${'d'.repeat(64)}`],
]);

type Phase = 'staging' | 'production' | 'zero_swap';
type Reference = { path: string; sha256: string };
type RequestRow = { provider: string; model: string; requests: number; localRequestUnits: number };
export type ControlRequestBinding = {
  requestId: string;
  requestSha256: string;
  runtimeSha: string;
};

export type ObservationFixture = {
  phase: Phase;
  runDirectory: string;
  samplesDirectory: string;
  samplePaths: string[];
  requestPath: string;
  resultPath: string;
  resultDigest: string;
  result: Record<string, any>;
  controlRequest: ControlRequestBinding;
};

let sequence = 0;

export function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function writeMode600(file: string, value: unknown): Reference {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, raw, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { path: file, sha256: sha256(raw) };
}

function modelsFor(phase: Phase) {
  const tags = phase === 'zero_swap' ? [OLLAMA_RETAINED] : [OLLAMA_RETAINED, ...OLLAMA_DELETE];
  return tags.map((tag) => ({ tag, digest: OLLAMA_DIGESTS.get(tag)! }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

function pm2For(phase: Phase, runtimeSha: string) {
  const names = phase === 'staging'
    ? ['content-engine-staging', 'nexus-hub-staging']
    : ['content-engine', 'nexus-hub'];
  return names.map((name) => ({
    name,
    status: 'online',
    restartCount: 0,
    releaseSha: runtimeSha,
  }));
}

export function createObservationFixture({
  root,
  phase,
  startedAt,
  durationSeconds = 24 * 60 * 60,
  intervalSeconds = 60 * 60,
  previousObservation = null,
  subject = null,
  requestRows = null,
  sampleMutation,
  requestMutation,
  resultMutation,
}: {
  root: string;
  phase: Phase;
  startedAt: string;
  durationSeconds?: number;
  intervalSeconds?: number;
  previousObservation?: ObservationFixture | null;
  subject?: Reference | null;
  requestRows?: RequestRow[] | null;
  sampleMutation?: (sample: Record<string, any>, sampleSequence: number) => void;
  requestMutation?: (request: Record<string, any>) => void;
  resultMutation?: (result: Record<string, any>) => void;
}): ObservationFixture {
  if (durationSeconds % intervalSeconds !== 0) throw new Error('fixture duration must divide by interval');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  sequence += 1;
  const runId = `${phase}-20260722T120000Z-${sequence.toString(16).padStart(12, '0')}`;
  let previousControlRequest: ControlRequestBinding | null =
    previousObservation?.controlRequest ?? null;
  if (!previousControlRequest && subject) {
    const cleanup = JSON.parse(fs.readFileSync(subject.path, 'utf8'));
    previousControlRequest = cleanup.plan?.observationControl?.production ?? null;
  }
  const runtimeSha = previousControlRequest?.runtimeSha ?? '1'.repeat(40);
  const controlRequest: ControlRequestBinding = {
    requestId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`,
    requestSha256: sha256(JSON.stringify({ runId, runtimeSha, sequence })),
    runtimeSha,
  };
  const runDirectory = path.join(root, runId);
  const samplesDirectory = path.join(runDirectory, 'samples');
  fs.mkdirSync(samplesDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(runDirectory, 0o700);
  fs.chmodSync(samplesDirectory, 0o700);

  const collectorPath = fs.realpathSync(path.resolve('scripts/ollama-observation-collector.mjs'));
  const collectorSourceSha256 = sha256(fs.readFileSync(collectorPath));
  const bootId = '11111111-2222-3333-4444-555555555555';
  const inventory = modelsFor(phase);
  const startedMs = Date.parse(startedAt);
  const startedMonotonicSeconds = 100_000 + sequence * 100_000;
  const sampleCount = durationSeconds / intervalSeconds + 1;
  const samplePaths: string[] = [];
  let previousSampleSha256: string | null = null;
  let firstSha256 = '';

  for (let sampleSequence = 0; sampleSequence < sampleCount; sampleSequence += 1) {
    const sample = {
      schema: 'nexus.ollama-observation-sample.v1',
      runId,
      phase,
      sequence: sampleSequence,
      capturedAt: new Date(startedMs + sampleSequence * intervalSeconds * 1000).toISOString(),
      bootId,
      monotonicSeconds: startedMonotonicSeconds + sampleSequence * intervalSeconds,
      previousSampleSha256,
      controlRequest: { ...controlRequest },
      ollama: {
        healthy: true,
        inventory,
        loaded: [OLLAMA_RETAINED],
      },
      application: {
        backendHealthy: true,
        contentHealthy: true,
        pm2: pm2For(phase, runtimeSha),
      },
      service: {
        activeState: 'active',
        restartCount: 0,
        envelope: {
          contextLength: 4096,
          maxQueue: 4,
          numParallel: 1,
          maxLoadedModels: 1,
          memoryHighBytes: 4 * 1024 * 1024 * 1024,
          memoryMaxBytes: 6 * 1024 * 1024 * 1024,
          memorySwapMaxBytes: 512 * 1024 * 1024,
          cpuQuotaUsecPerSec: 2_000_000,
        },
      },
      host: {
        load15Milli: 1000,
        memAvailableKiB: 20 * 1024 * 1024,
        swapInPages: 0,
        swapOutPages: 0,
        memoryPressureTotalMicros: 0,
        kernelOomEventsSinceBoot: 0,
      },
    };
    sampleMutation?.(sample, sampleSequence);
    const samplePath = path.join(samplesDirectory, `${String(sampleSequence).padStart(6, '0')}.json`);
    const written = writeMode600(samplePath, sample);
    if (sampleSequence === 0) firstSha256 = written.sha256;
    previousSampleSha256 = written.sha256;
    samplePaths.push(samplePath);
  }

  const rows = (requestRows ?? [{
    provider: 'ollama', model: OLLAMA_RETAINED, requests: 12, localRequestUnits: 12,
  }]).sort((left, right) => left.model.localeCompare(right.model));
  const totals = { total: 0, retainedModel: 0, largeModels: 0, otherModels: 0 };
  for (const row of rows) {
    totals.total += row.requests;
    if (row.model === OLLAMA_RETAINED) totals.retainedModel += row.requests;
    else if (OLLAMA_DELETE.includes(row.model)) totals.largeModels += row.requests;
    else totals.otherModels += row.requests;
  }
  const completedAt = new Date(startedMs + durationSeconds * 1000).toISOString();
  const request = {
    schema: 'nexus.ollama-observation-requests.v1',
    runId,
    phase,
    host: 'serverdominguez',
    bootId,
    startedAt,
    completedAt,
    collectorSourceSha256,
    lastSampleSha256: previousSampleSha256,
    controlRequest: { ...controlRequest },
    database: {
      path: path.join(root, `${phase}-api-usage.db`),
      columns: ['id', 'ts', 'provider', 'model', 'pricing_status', 'local_request_units'],
      quickCheck: 'ok',
      invalidPersistenceRows: 0,
    },
    rows,
    totals,
  };
  requestMutation?.(request);
  const requestPath = path.join(runDirectory, 'requests.json');
  const requestReference = writeMode600(requestPath, request);

  const result: Record<string, any> = {
    schema: 'nexus.ollama-observation-collector-result.v1',
    status: 'complete',
    host: 'serverdominguez',
    phase,
    runId,
    collector: {
      executablePath: collectorPath,
      sourceSha256: collectorSourceSha256,
      executionUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    },
    bootId,
    startedAt,
    completedAt,
    startedMonotonicSeconds,
    completedMonotonicSeconds: startedMonotonicSeconds + durationSeconds,
    sampling: {
      intervalSeconds,
      sampleCount,
      maximumGapSeconds: intervalSeconds,
    },
    controlRequest: { ...controlRequest },
    previousControlRequest: previousControlRequest ? { ...previousControlRequest } : null,
    retainedModel: { tag: OLLAMA_RETAINED, digest: OLLAMA_DIGESTS.get(OLLAMA_RETAINED)! },
    inventory,
    samples: {
      directory: samplesDirectory,
      firstSha256,
      lastSha256: previousSampleSha256,
    },
    requestEvidence: requestReference,
    previousObservation: previousObservation
      ? { path: previousObservation.resultPath, sha256: previousObservation.resultDigest }
      : null,
    subject,
  };
  resultMutation?.(result);
  const resultPath = path.join(runDirectory, 'result.json');
  const resultReference = writeMode600(resultPath, result);
  return {
    phase,
    runDirectory,
    samplesDirectory,
    samplePaths,
    requestPath,
    resultPath,
    resultDigest: resultReference.sha256,
    result,
    controlRequest,
  };
}
