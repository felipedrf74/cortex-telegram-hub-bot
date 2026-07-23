#!/usr/bin/env node
// Copyright (c) 2026 Felipe Dominguez. MIT License. See LICENSE.
//
// coach-local-eval.mjs — local-first eval for the daily coach analysis
// (local-LLM pilot, 2026-07-04).
//
// Feed it a payload captured by garmin-coach.ts with
// GARMIN_COACH_CAPTURE_PROMPT=true (JSON: {capturedAt, userId,
// systemPrompt, userPrompt, maxTokens} in .local/coach-payloads/) and it
// runs the prompt against:
//   (a) the LOCAL model by default via the Ollama HTTP API directly
//       (${OLLAMA_BASE_URL}/api/chat, stream:false, keep_alive:-1 — the
//       provider default residency), and, only when explicitly requested,
//   (b) the approved CLOUD reasoning provider selected by the engine's
//       quality/privacy gate loaded from compiled dist/. Captured Garmin
//       prompts are classified as private and never call a cloud provider
//       unless both the per-run operator authorization and configured raw
//       private-data policy approve the request.
//
// For each run it prints wall-clock, output length, and whether the
// COACH_RECS JSON block parses (marker + parse semantics replicated from
// src/services/garmin-coach.ts extractRecommendations), and writes the
// full outputs to files next to the payload.
//
// Usage:
//   node scripts/coach-local-eval.mjs --payload <file.json> [--local-only|--with-cloud|--cloud-only] [--operator-authorize-private-cloud] [--think] [--model <tag>]
//
// Notes:
//   - Operator-run only. NOT wired to any cron/scheduler. The default is
//     local-only; cloud access must be opted into on every invocation.
//   - Read-only with respect to the DB: the script never calls
//     initDatabase(), so the cloud provider's natural api_usage insert
//     warn-fails harmlessly (logGeminiUsage swallows DB errors). Nothing
//     is written to SQLite by this script.
//   - --think enables the model's reasoning mode for the local run
//     The small-only 3B runtime defaults to think:false for bounded latency.
//
// Exit codes: 0 all requested runs completed, 1 usage error, 2 run failure.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// ── Args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = {
    payload: null,
    localOnly: false,
    withCloud: false,
    cloudOnly: false,
    authorizePrivateCloud: false,
    think: false,
    model: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--payload') parsed.payload = argv[++i];
    else if (arg.startsWith('--payload=')) parsed.payload = arg.slice('--payload='.length);
    else if (arg === '--local-only') parsed.localOnly = true;
    else if (arg === '--with-cloud') parsed.withCloud = true;
    else if (arg === '--cloud-only') parsed.cloudOnly = true;
    else if (arg === '--operator-authorize-private-cloud') parsed.authorizePrivateCloud = true;
    else if (arg === '--think') parsed.think = true;
    else if (arg === '--model') parsed.model = argv[++i];
    else if (arg.startsWith('--model=')) parsed.model = arg.slice('--model='.length);
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      parsed.help = true;
    }
  }
  return parsed;
}

const USAGE = 'Usage: node scripts/coach-local-eval.mjs --payload <file.json> [--local-only|--with-cloud|--cloud-only] [--operator-authorize-private-cloud] [--think] [--model <tag>]';

// ── COACH_RECS extraction — replicated from garmin-coach.ts ─────────
// (extractRecommendations: exact markers + JSON.parse + array check)

const COACH_RECS_START = '<!-- COACH_RECS_START -->';
const COACH_RECS_END = '<!-- COACH_RECS_END -->';

function analyzeCoachRecs(text) {
  const startIdx = text.indexOf(COACH_RECS_START);
  const endIdx = text.indexOf(COACH_RECS_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { blockFound: false, parses: false, count: 0 };
  }
  const jsonStr = text.substring(startIdx + COACH_RECS_START.length, endIdx).trim();
  try {
    const raw = JSON.parse(jsonStr);
    if (!Array.isArray(raw)) return { blockFound: true, parses: false, count: 0 };
    const actionable = raw.filter((r) => r && r.eventId && r.action);
    return { blockFound: true, parses: true, count: actionable.length };
  } catch {
    return { blockFound: true, parses: false, count: 0 };
  }
}

// ── Thinking-trace strip — replicated from ollama-provider.ts ───────
// (stripThinkBlocks: case-insensitive depth parser, fail-closed)

const THINK_OPEN_RE = /^<think\b[^>]*>/i;
const THINK_CLOSE_RE = /^<\/think\s*>/i;

function stripThinkBlocks(text) {
  if (!text) return '';
  const src = String(text);
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const open = rest.match(THINK_OPEN_RE);
    if (open) { depth++; i += open[0].length; continue; }
    const close = rest.match(THINK_CLOSE_RE);
    if (close) { if (depth > 0) depth--; i += close[0].length; continue; }
    if (depth === 0) out += src[i];
    i++;
  }
  return out.trim();
}

// ── Config defaults (compiled dist if present, env otherwise) ───────

function loadEngineConfig() {
  try {
    // Same convention as staging-fixture-probes.mjs: require compiled dist.
    // dist/config runs dotenv itself, so .env values apply.
    return require(path.join(ENGINE_ROOT, 'dist', 'config')).config;
  } catch (err) {
    console.error(`[warn] Could not load dist/config (${err.message}); using env/base defaults for the local run.`);
    return null;
  }
}

// ── Local run (direct Ollama HTTP API) ──────────────────────────────

async function runLocal(payload, opts) {
  const cfg = opts.engineConfig?.ollama;
  const baseUrl = process.env.OLLAMA_BASE_URL || cfg?.baseUrl || 'http://127.0.0.1:11434';
  const smallOnlyModel = 'qwen2.5:3b-instruct-q4_K_M';
  const model = opts.model || process.env.OLLAMA_MODEL || cfg?.model || smallOnlyModel;
  if (model !== smallOnlyModel) {
    throw new Error(`small-only policy rejects model=${model}`);
  }
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || cfg?.timeoutMs || 360000);
  const maxTokens = Number(payload.maxTokens) > 0 ? Number(payload.maxTokens) : 2500;

  const body = {
    model,
    messages: [
      { role: 'system', content: payload.systemPrompt },
      { role: 'user', content: payload.userPrompt },
    ],
    think: opts.think,
    stream: false,
    // keep_alive -1 = stay resident, matching the OllamaProvider default.
    keep_alive: -1,
    options: {
      num_ctx: 4096,
      num_predict: maxTokens,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 20,
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const wallMs = Date.now() - start;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Ollama HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const json = await resp.json();
    const text = stripThinkBlocks(json?.message?.content);
    return {
      label: `local (${model}${opts.think ? ', think:true' : ''})`,
      wallMs,
      text,
      meta: {
        evalCount: json?.eval_count,
        promptEvalCount: json?.prompt_eval_count,
        doneReason: json?.done_reason,
      },
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Local run timed out after ${timeoutMs}ms (model ${model})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Cloud run (engine dist: approved quality/privacy gate) ─────────

async function runCloud(payload, opts) {
  let selectApprovedCloudReasoningProvider;
  let getProvider;
  try {
    ({ selectApprovedCloudReasoningProvider } = require(
      path.join(ENGINE_ROOT, 'dist', 'services', 'cloud-reasoning-gate'),
    ));
    ({ getProvider } = require(path.join(ENGINE_ROOT, 'dist', 'services', 'provider-registry')));
  } catch (err) {
    throw new Error(
      `Could not load the compiled cloud reasoning gate/provider registry (${err.message}). ` +
      'Run `npm run build` first — the cloud leg must use the engine privacy gate.',
    );
  }

  if (opts.authorizePrivateCloud !== true) {
    throw new Error('private cloud evaluation lacks explicit operator authorization');
  }

  const maxTokens = Number(payload.maxTokens) > 0 ? Number(payload.maxTokens) : 2500;
  const userId = Number(payload.userId) > 0 ? Number(payload.userId) : 0;
  const privacyRequest = {
    prompt: `${payload.systemPrompt}\n\n${payload.userPrompt}`,
    containsPrivateData: true,
    allowCloudEscalation: true,
    redactionRequired: true,
  };
  const selection = await selectApprovedCloudReasoningProvider(
    privacyRequest,
    getProvider,
    null,
  );
  if (selection.rejected) {
    throw new Error(`cloud reasoning gate rejected captured private prompt: ${selection.reason}`);
  }

  const start = Date.now();
  const result = await selection.provider.callDomain(
    'triathlon',
    [],
    payload.userPrompt,
    payload.systemPrompt,
    {
      maxTokensOverride: maxTokens,
      userId,
      tenantId: userId,
      modelOverride: selection.model,
      containsPrivateData: privacyRequest.containsPrivateData,
      allowCloudEscalation: privacyRequest.allowCloudEscalation,
      redactionRequired: privacyRequest.redactionRequired,
    },
  );
  const providerUsed = selection.provider.name;
  return {
    label: `cloud (${providerUsed}/${selection.model}; ${selection.privacyAction})`,
    wallMs: Date.now() - start,
    text: result.text,
    meta: {
      providerUsed,
      modelUsed: selection.model,
      privacyAction: selection.privacyAction,
    },
  };
}

// ── Reporting ───────────────────────────────────────────────────────

function report(run, payloadPath, suffix) {
  const recs = analyzeCoachRecs(run.text);
  const outPath = payloadPath.replace(/\.json$/i, '') + `.${suffix}-output.txt`;
  fs.writeFileSync(outPath, run.text);
  console.log(`\n── ${run.label} ──`);
  console.log(`  wall-clock:       ${(run.wallMs / 1000).toFixed(1)}s`);
  console.log(`  output length:    ${run.text.length} chars`);
  console.log(`  COACH_RECS block: ${recs.blockFound ? 'found' : 'MISSING'}`);
  console.log(`  COACH_RECS JSON:  ${recs.parses ? `parses (${recs.count} actionable rec(s))` : 'DOES NOT PARSE'}`);
  if (run.meta && Object.keys(run.meta).length > 0) {
    console.log(`  meta:             ${JSON.stringify(run.meta)}`);
  }
  console.log(`  full output:      ${outPath}`);
  return { ...recs, outPath };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.payload) {
    console.error(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const cloudRequested = args.withCloud || args.cloudOnly;
  if ((args.localOnly && cloudRequested) || (args.withCloud && args.cloudOnly)) {
    console.error('--local-only, --with-cloud, and --cloud-only are mutually exclusive.\n' + USAGE);
    process.exit(1);
  }
  if (cloudRequested && !args.authorizePrivateCloud) {
    console.error(
      'Cloud evaluation of a captured Garmin prompt requires the per-run ' +
      '--operator-authorize-private-cloud acknowledgement.\n' + USAGE,
    );
    process.exit(1);
  }
  if (!cloudRequested && args.authorizePrivateCloud) {
    console.error('--operator-authorize-private-cloud is valid only with --with-cloud or --cloud-only.\n' + USAGE);
    process.exit(1);
  }

  const payloadPath = path.resolve(args.payload);
  if (!fs.existsSync(payloadPath)) {
    console.error(`Payload file not found: ${payloadPath}`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  if (!payload.systemPrompt || !payload.userPrompt) {
    console.error('Payload is missing systemPrompt/userPrompt — was it captured with GARMIN_COACH_CAPTURE_PROMPT=true?');
    process.exit(1);
  }

  console.log(`Payload: ${payloadPath}`);
  console.log(`  capturedAt: ${payload.capturedAt ?? 'unknown'} | userId: ${payload.userId ?? 'unknown'} | maxTokens: ${payload.maxTokens ?? 2500}`);
  console.log(`  systemPrompt: ${payload.systemPrompt.length} chars | userPrompt: ${payload.userPrompt.length} chars`);

  const engineConfig = loadEngineConfig();
  let failures = 0;

  if (!args.cloudOnly) {
    try {
      const localRun = await runLocal(payload, { engineConfig, think: args.think, model: args.model });
      report(localRun, payloadPath, 'local');
    } catch (err) {
      failures += 1;
      console.error(`\n── local run FAILED ──\n  ${err.message}`);
    }
  }

  if (cloudRequested) {
    try {
      const cloudRun = await runCloud(payload, { authorizePrivateCloud: args.authorizePrivateCloud });
      report(cloudRun, payloadPath, 'cloud');
    } catch (err) {
      failures += 1;
      console.error(`\n── cloud run FAILED ──\n  ${err.message}`);
    }
  }

  process.exit(failures > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
