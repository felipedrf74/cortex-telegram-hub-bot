#!/usr/bin/env npx tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 0/D3 benchmark harness for the ChatCoreV2 ultra-compact planner packet.
 *
 * This talks directly to Ollama and writes a JSON artifact under
 * data/chatcore-v2-planner-benchmarks/. It does not touch app databases,
 * env files, or chat runtime paths.
 *
 * Examples:
 *   npx tsx scripts/llm/chatcore-v2-planner-benchmark.ts --runs=10
 *   npx tsx scripts/llm/chatcore-v2-planner-benchmark.ts --suite=all --runs=100 --burst-size=10 --concurrency=5 --duration-ms=300000
 *   CHAT_CORE_V2_PLANNER_MODEL=qwen2.5:3b-instruct-q4_K_M \
 *     npx tsx scripts/llm/chatcore-v2-planner-benchmark.ts --suite=sequential --runs=100 --profile=tiny --target-p50-ms=2000 --target-p95-ms=5000
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_JSON_SCHEMA,
  CHAT_TURN_PLAN_MICRO_ATOM_JSON_SCHEMA,
  CHAT_TURN_PLAN_MICRO_MINI_JSON_SCHEMA,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
  CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS,
  CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA,
  buildUltraCompactPlannerPacket,
  parseAndValidateChatTurnPlanMicroJson,
  parseAndValidateChatTurnPlanMicroAtomJson,
  parseAndValidateChatTurnPlanMicroMiniJson,
  parseAndValidateChatTurnPlanMicroWireJson,
} from '../../src/services/chat-core-v2/plan-schema';

const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.CHAT_CORE_V2_PLANNER_MODEL
  || process.env.OLLAMA_CLASSIFIER_MODEL
  || 'qwen2.5:3b-instruct-q4_K_M';

type Profile = 'tiny' | 'stress';
// WP-11 (D3 latency gate): `burst5` is a fixed 5-concurrent-request phase with a
// dedicated p95 gate (CHAT_CORE_V2_BURST5_P95_MS, default 5000ms) used by
// scripts/bench-gate.sh. It is additive — the existing phases are unchanged.
type Suite = 'sequential' | 'burst' | 'burst5' | 'concurrent' | 'sustained' | 'all';
type OutputShape = 'atom' | 'mini' | 'wire' | 'full';
type OllamaEndpoint = 'chat' | 'generate';

// WP-11: fixed concurrency + p95 gate for the burst5 phase. The gate is applied
// in main() only when the selected suite is exactly `burst5`, so other phases
// keep their existing target-p50/target-p95 behavior untouched.
const BURST5_CONCURRENCY = 5;
const BURST5_P95_GATE_MS = parsePositiveInt(process.env.CHAT_CORE_V2_BURST5_P95_MS, 5000);

interface RunResult {
  phase: Exclude<Suite, 'all'>;
  run: number;
  ok: boolean;
  durationMs: number;
  schemaOk: boolean;
  error?: string;
  responseBytes?: number;
  rawContent?: string;
}

interface BenchmarkSummary {
  count: number;
  failures: number;
  schemaFailures: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value] as const;
}));

const suite = parseSuite(args.get('suite') ?? 'sequential');
const runs = parsePositiveInt(args.get('runs'), 10);
const profile = parseProfile(args.get('profile') ?? 'tiny');
const targetP50Ms = parsePositiveInt(args.get('target-p50-ms'), 2000);
const targetP95Ms = parsePositiveInt(args.get('target-p95-ms'), 5000);
const numCtx = parsePositiveInt(args.get('num-ctx'), CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.numCtx);
const numPredict = parsePositiveInt(args.get('num-predict'), CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.numPredict);
const burstSize = parsePositiveInt(args.get('burst-size'), 10);
const concurrency = parsePositiveInt(args.get('concurrency'), 5);
const durationMs = parsePositiveInt(args.get('duration-ms'), 300_000);
const timeoutMs = parsePositiveInt(args.get('timeout-ms'), 20_000);
const warmupRuns = parseNonNegativeInt(args.get('warmup-runs'), 0);
const noFail = args.get('no-fail') === 'true';
const outputShape = parseOutputShape(args.get('output') ?? 'atom');
const endpoint = parseEndpoint(args.get('endpoint') ?? 'chat');
const includeRaw = args.get('include-raw') === 'true';
const rawPrompt = args.get('raw-prompt') === 'true';

async function main(): Promise<void> {
  const warmupResults = warmupRuns > 0 ? await runWarmup(warmupRuns) : [];
  const selectedPhases = suite === 'all'
    ? ['sequential', 'burst', 'burst5', 'concurrent', 'sustained'] as const
    : [suite];
  const results: RunResult[] = [];

  for (const phase of selectedPhases) {
    const phaseResults = await runPhase(phase);
    results.push(...phaseResults);
  }

  const summary = summarize(results);
  const phaseSummaries = Object.fromEntries(selectedPhases.map((phase) => [
    phase,
    summarize(results.filter((result) => result.phase === phase)),
  ]));
  const artifact = {
    schemaVersion: 'chat_core_v2_planner_benchmark@1.0.0',
    createdAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    model: MODEL,
    suite,
    profile,
    runs,
    burstSize,
    concurrency,
    durationMs,
    timeoutMs,
    warmupRuns,
    targetP50Ms,
    targetP95Ms,
    outputShape,
    endpoint,
    includeRaw,
    rawPrompt,
    options: {
      ...CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS,
      numCtx,
      numPredict,
    },
    summary,
    phaseSummaries,
    warmupSummary: summarize(warmupResults),
    results,
  };

  const outDir = path.join(process.cwd(), 'data', 'chatcore-v2-planner-benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${artifact.createdAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ summary, phaseSummaries, artifact: outPath }));

  // WP-11: the `burst5` suite uses its own dedicated p95 gate (5 concurrent
  // requests, p95 ≤ CHAT_CORE_V2_BURST5_P95_MS). This is the gate bench-gate.sh
  // forwards. Every other suite keeps the existing target-p50/target-p95 gate.
  if (suite === 'burst5') {
    if (!noFail && (
      !summary.p95Ms
      || summary.p95Ms > BURST5_P95_GATE_MS
      || summary.failures > 0
      || summary.schemaFailures > 0
    )) {
      console.error(JSON.stringify({
        gate: 'burst5',
        result: 'fail',
        p95Ms: summary.p95Ms,
        gateMs: BURST5_P95_GATE_MS,
        failures: summary.failures,
        schemaFailures: summary.schemaFailures,
      }));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({
        gate: 'burst5',
        result: 'pass',
        p95Ms: summary.p95Ms,
        gateMs: BURST5_P95_GATE_MS,
      }));
    }
    return;
  }

  if (!noFail && (
    !summary.p50Ms
    || summary.p50Ms > targetP50Ms
    || !summary.p95Ms
    || summary.p95Ms > targetP95Ms
    || summary.failures > 0
    || summary.schemaFailures > 0
  )) {
    process.exitCode = 1;
  }
}

async function runWarmup(count: number): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < count; i++) {
    const result = await runOnce('sequential', i + 1, profile);
    results.push(result);
    console.log(JSON.stringify({ ...result, phase: 'warmup' }));
  }
  return results;
}

async function runPhase(phase: Exclude<Suite, 'all'>): Promise<RunResult[]> {
  if (phase === 'sequential') return runSequential(phase, runs);
  if (phase === 'burst') return runBurst(phase, burstSize);
  if (phase === 'burst5') return runBurst5(phase);
  if (phase === 'concurrent') return runConcurrent(phase, runs, concurrency);
  return runSustained(phase, durationMs, concurrency);
}

// WP-11: 5 concurrent requests fired together, the D3 latency gate's fixed
// shape. Concurrency is pinned to BURST5_CONCURRENCY regardless of --burst-size
// so the gate measures a known load.
async function runBurst5(phase: Exclude<Suite, 'all'>): Promise<RunResult[]> {
  const results = await Promise.all(
    Array.from({ length: BURST5_CONCURRENCY }, (_, index) => runOnce(phase, index + 1, profile)),
  );
  for (const result of results) console.log(JSON.stringify(result));
  return results;
}

async function runSequential(phase: Exclude<Suite, 'all'>, count: number): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < count; i++) {
    const result = await runOnce(phase, i + 1, profile);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  return results;
}

async function runBurst(phase: Exclude<Suite, 'all'>, count: number): Promise<RunResult[]> {
  const results = await Promise.all(Array.from({ length: count }, (_, index) => runOnce(phase, index + 1, profile)));
  for (const result of results) console.log(JSON.stringify(result));
  return results;
}

async function runConcurrent(
  phase: Exclude<Suite, 'all'>,
  count: number,
  workerCount: number,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let nextRun = 1;
  async function worker(): Promise<void> {
    while (nextRun <= count) {
      const run = nextRun++;
      const result = await runOnce(phase, run, profile);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, count) }, worker));
  return results.sort((left, right) => left.run - right.run);
}

async function runSustained(
  phase: Exclude<Suite, 'all'>,
  duration: number,
  workerCount: number,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const stopAt = Date.now() + duration;
  let nextRun = 1;
  async function worker(): Promise<void> {
    while (Date.now() < stopAt) {
      const run = nextRun++;
      const result = await runOnce(phase, run, profile);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.sort((left, right) => left.run - right.run);
}

async function runOnce(phase: Exclude<Suite, 'all'>, run: number, profile: Profile): Promise<RunResult> {
  const packet = buildPacket(run, profile);
  const format = outputShape === 'atom'
    ? CHAT_TURN_PLAN_MICRO_ATOM_JSON_SCHEMA
    : outputShape === 'mini'
      ? CHAT_TURN_PLAN_MICRO_MINI_JSON_SCHEMA
      : outputShape === 'wire'
        ? CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA
        : CHAT_TURN_PLAN_MICRO_JSON_SCHEMA;
  const systemPrompt = outputShape === 'atom'
    ? buildAtomSystemPrompt()
    : outputShape === 'mini'
      ? buildMiniSystemPrompt()
      : outputShape === 'wire'
        ? buildWireSystemPrompt()
        : buildFullSystemPrompt();
  const options = {
    num_ctx: numCtx,
    num_predict: numPredict,
    temperature: CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.temperature,
    seed: 42,
  };
  const chatBody = {
    model: MODEL,
    think: false,
    stream: false,
    keep_alive: -1,
    format,
    options,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: JSON.stringify(packet),
      },
    ],
  };
  const generateBody = {
    model: MODEL,
    stream: false,
    keep_alive: -1,
    format,
    raw: rawPrompt,
    options,
    ...(rawPrompt
      ? { prompt: `${systemPrompt}\n${JSON.stringify(packet)}` }
      : { system: systemPrompt, prompt: JSON.stringify(packet) }),
  };

  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(endpoint === 'chat' ? chatBody : generateBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return { phase, run, ok: false, schemaOk: false, durationMs, error: `${response.status}: ${text.slice(0, 300)}` };
    }
    const parsed = JSON.parse(text) as { message?: { content?: string }; response?: string };
    const content = endpoint === 'chat' ? (parsed.message?.content ?? '') : (parsed.response ?? '');
    const validation = outputShape === 'atom'
      ? parseAndValidateChatTurnPlanMicroAtomJson(content, packet)
      : outputShape === 'mini'
        ? parseAndValidateChatTurnPlanMicroMiniJson(content, packet)
        : outputShape === 'wire'
          ? parseAndValidateChatTurnPlanMicroWireJson(content, packet)
          : parseAndValidateChatTurnPlanMicroJson(content, packet.contextHash);
    return {
      phase,
      run,
      ok: true,
      schemaOk: validation.ok,
      durationMs,
      responseBytes: text.length,
      rawContent: includeRaw ? content : undefined,
      error: validation.ok ? undefined : validation.issues.map((issue) => `${issue.path}:${issue.code}`).join(','),
    };
  } catch (err) {
    return {
      phase,
      run,
      ok: false,
      schemaOk: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildPacket(run: number, profile: Profile) {
  const messageSummary = profile === 'stress'
    ? 'user asks what to do today with training, tasks, and calendar context'
    : 'today?';
  return {
    ...buildUltraCompactPlannerPacket({
      locale: run % 3 === 0 ? 'pt-PT' : 'en',
      candidateCapabilityIds: ['training.session_explain', 'tasks.today_summary', 'clarify_reference'],
      riskSignals: run % 5 === 0 ? ['health_adjacent'] : [],
      messageSummary,
      contextHash: `ctx-bench-${profile}-${run}`,
    }),
    expectedShape: {
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    },
  };
}

function buildAtomSystemPrompt(): string {
  return [
    'JSON only: {"p":"r191"}. No spaces.',
    'p= intent + candidate + confidence + complexity.',
    'Intent: a answer, r read, w write, c clarify, u unsupported, e escalate.',
    'Candidate is 0-7 from candidates, or _ if none.',
    'For today/status/what/check/show/list return {"p":"r191"}.',
    'Use w only for create/mark/move/delete/write/send; write atom is w + candidate + risk(A/B/C) + scores, e.g. {"p":"w0A91"}.',
  ].join(' ');
}

function buildMiniSystemPrompt(): string {
  return [
    'Minified JSON only, no spaces.',
    'Required fields: i intent, c candidate index string, s two digits confidence+complexity.',
    'Intent i: a answer, r read, w write_preview, c clarify, u unsupported, e escalate.',
    'Use indexes from candidates: c="1"; for multiple use c="01".',
    'Always include c; use c="" only if no capability applies.',
    'If msg is status/today/what/check/show/list, MUST use i="r".',
    'If msg does not ask to change state, NEVER use i="w".',
    'For msg "today?": {"i":"r","c":"1","s":"91"}.',
    'Use i="w" only for create/mark/move/delete/write/send; write form w="0A".',
    'No prose.',
  ].join(' ');
}

function buildWireSystemPrompt(): string {
  return [
    'Return compact JSON only.',
    'Intent code i: a=answer r=read w=write_preview c=clarify u=unsupported e=escalate.',
    'Use c/r as 0-based indexes into candidates; w as [{"c":index,"k":"A"}].',
    'Omit empty c/r/w arrays.',
    'If msg asks status/today/what, use i=r and omit w.',
    'Never set w unless msg asks create/mark/move/delete.',
    'Use cf/x decimals 0.0..1.0.',
    'No prose.',
  ].join(' ');
}

function buildFullSystemPrompt(): string {
  return [
    `Return JSON only for ${CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION}.`,
    'Choose intent only from: answer, read, write_preview, clarify, unsupported, escalate.',
    'Use confidence and complexityScore as numbers from 0 to 1.',
    `Use promptVersion ${CHAT_TURN_PLAN_MICRO_PROMPT_VERSION}.`,
    'No markdown. No prose. No extra keys.',
  ].join(' ');
}

function summarize(results: RunResult[]): BenchmarkSummary {
  const durations = results
    .filter((result) => result.ok)
    .map((result) => result.durationMs)
    .sort((left, right) => left - right);
  return {
    count: durations.length,
    failures: results.filter((result) => !result.ok).length,
    schemaFailures: results.filter((result) => !result.schemaOk).length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    minMs: durations[0] ?? null,
    maxMs: durations[durations.length - 1] ?? null,
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[index];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseProfile(raw: string): Profile {
  return raw === 'stress' ? 'stress' : 'tiny';
}

function parseSuite(raw: string): Suite {
  return raw === 'burst' || raw === 'burst5' || raw === 'concurrent' || raw === 'sustained' || raw === 'all'
    ? raw
    : 'sequential';
}

function parseOutputShape(raw: string): OutputShape {
  if (raw === 'full') return 'full';
  if (raw === 'wire') return 'wire';
  if (raw === 'mini') return 'mini';
  return 'atom';
}

function parseEndpoint(raw: string): OllamaEndpoint {
  return raw === 'generate' ? 'generate' : 'chat';
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
