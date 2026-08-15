#!/usr/bin/env npx tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * scripts/llm/local-llm-smoke.ts
 *
 * Real (NOT mocked) end-to-end smoke against the live local Ollama daemon
 * on 127.0.0.1:11434. Validates the assumptions the OllamaProvider relies
 * on (think:false JSON schema returns valid JSON; think:true with format
 * keeps thinking separate from content; metrics fields are populated).
 *
 * Writes per-run JSON to data/local-llm-smoke-runs/<ts>.json so a human
 * can diff results over time as the model or daemon version changes.
 *
 * Usage:
 *   npx tsx scripts/llm/local-llm-smoke.ts
 *
 * Exit code:
 *   0 if all 11 cases passed (5 classify + 3 scriptGen-shape + 3 localReasoning)
 *   1 if any case failed
 *
 * This script does NOT touch the api_usage table or invoke the
 * OllamaProvider class — it talks to the daemon directly. The provider
 * adds its own queue / metering / rate-limit on top; this smoke is for
 * proving the underlying daemon + model is behaving.
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const LOCAL_MODEL_MANIFEST = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'config/local-model-manifest.json'), 'utf8'),
) as { activeModelId?: string; models?: Array<{ id?: string; ollamaTag?: string }> };
const ACTIVE_MODEL = LOCAL_MODEL_MANIFEST.models
  ?.find((entry) => entry.id === LOCAL_MODEL_MANIFEST.activeModelId)?.ollamaTag;
if (!ACTIVE_MODEL) throw new Error('signed local-model manifest has no active Ollama tag');
const MODEL = process.env.OLLAMA_MODEL || ACTIVE_MODEL;
if (MODEL !== ACTIVE_MODEL) {
  throw new Error(`signed-manifest policy rejects OLLAMA_MODEL=${MODEL}; expected ${ACTIVE_MODEL}`);
}

interface SmokeCase {
  label: string;
  body: Record<string, unknown>;
  validate: (resp: any) => string | null; // returns error string or null on pass
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string', enum: ['secretary', 'triathlon', 'content', 'finance', 'cooking'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['domain', 'confidence'],
} as const;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'array', items: { type: 'string' }, minItems: 1 },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['plan', 'risk_level'],
} as const;

const REASONING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer', 'confidence'],
} as const;

// v1.1: mirror the OllamaProvider's CLASSIFY_HARDENING_SUFFIX so the smoke
// validates the live model with the same prompt the production provider
// will use. Without this, the smoke and provider drift.
const CLASSIFY_HARDENING_SUFFIX = [
  'CRITICAL OUTPUT CONTRACT — NON-NEGOTIABLE:',
  '',
  'The "domain" field MUST be EXACTLY one of these 5 strings, character-for-character:',
  '  - "secretary"   — calendar, tasks, email, reminders, notifications',
  '  - "triathlon"   — running, cycling, swimming, gym, recovery, readiness, workouts',
  '  - "content"     — youtube, linkedin, instagram, tiktok, scripts, posts, captions',
  '  - "finance"     — invoices, expenses, budget, subscriptions, fiscal',
  '  - "cooking"     — meals, recipes, grocery, food prep, nutrition fueling',
  '',
  'DO NOT invent any other domain string (e.g., NOT "sports_fitness", NOT "social_media",',
  'NOT "fitness_tracking", NOT "Health & Fitness", NOT capitalized or hyphenated variants).',
  'If a request fits none of the 5 above, return "secretary" with a low confidence (< 0.5).',
  '',
  'The "confidence" field is REQUIRED and must be a number between 0 and 1.',
  '',
  'Return ONLY the JSON object. No prose, no markdown, no backticks.',
].join('\n');

function buildClassifyCase(label: string, message: string, expectedDomain: string): SmokeCase {
  return {
    label,
    body: {
      model: MODEL,
      messages: [
        { role: 'system', content: `You are a domain classifier for Nexus Hub. Return JSON only matching the schema.\n\n${CLASSIFY_HARDENING_SUFFIX}` },
        { role: 'user', content: message },
      ],
      think: false,
      format: CLASSIFY_SCHEMA,
      stream: false,
      keep_alive: -1,
      options: { num_ctx: 4096, num_predict: 128, temperature: 0 },
    },
    validate: (resp) => {
      if (!resp?.message?.content) return 'no content';
      try {
        const parsed = JSON.parse(resp.message.content);
        if (!CLASSIFY_SCHEMA.properties.domain.enum.includes(parsed.domain)) return `domain not in enum: ${parsed.domain}`;
        if (typeof parsed.confidence !== 'number') return 'confidence not number';
        if (parsed.domain !== expectedDomain) return `wrong domain: got ${parsed.domain} expected ${expectedDomain}`;
        return null;
      } catch (e) {
        return `JSON parse failed: ${String(e)}`;
      }
    },
  };
}

function buildPlanCase(label: string, task: string): SmokeCase {
  return {
    label,
    body: {
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are an engineer. Produce a JSON plan matching the schema exactly. Return JSON only.' },
        { role: 'user', content: task },
      ],
      think: true,
      format: PLAN_SCHEMA,
      stream: false,
      keep_alive: -1,
      // v1.1: bumped num_predict 800→3000 after the first smoke (2026-05-26)
      // showed 5/6 think:true cases truncating before they could emit JSON.
      options: { num_ctx: 4096, num_predict: 3000, temperature: 0.2 },
    },
    validate: (resp) => {
      // Thinking must be SEPARATE from content (in message.thinking or absent
      // from content). Content must be parseable JSON without <think> blocks.
      const content = resp?.message?.content ?? '';
      if (/<think>/i.test(content)) return 'content contains <think> block';
      try {
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed.plan) || parsed.plan.length < 1) return 'plan missing or empty';
        if (!['low', 'medium', 'high'].includes(parsed.risk_level)) return 'risk_level invalid';
        return null;
      } catch (e) {
        return `JSON parse failed: ${String(e)}`;
      }
    },
  };
}

function buildReasoningCase(label: string, question: string): SmokeCase {
  return {
    label,
    body: {
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are an expert reasoning assistant. Return JSON only.' },
        { role: 'user', content: question },
      ],
      think: true,
      format: REASONING_SCHEMA,
      stream: false,
      keep_alive: -1,
      // v1.1: bumped num_predict 600→2500 — see plan smoke above.
      options: { num_ctx: 4096, num_predict: 2500, temperature: 0.2 },
    },
    validate: (resp) => {
      const content = resp?.message?.content ?? '';
      if (/<think>/i.test(content)) return 'content contains <think> block';
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed.answer !== 'string' || parsed.answer.length === 0) return 'answer empty';
        if (typeof parsed.confidence !== 'number') return 'confidence not number';
        return null;
      } catch (e) {
        return `JSON parse failed: ${String(e)}`;
      }
    },
  };
}

const CASES: SmokeCase[] = [
  buildClassifyCase('classify_content_1', 'write me a youtube hook about triathlon training', 'content'),
  buildClassifyCase('classify_content_2', 'draft a linkedin post about nexus hub', 'content'),
  buildClassifyCase('classify_triathlon',  'how was my run today', 'triathlon'),
  buildClassifyCase('classify_finance',    'log this invoice from Stripe for 49 euros', 'finance'),
  buildClassifyCase('classify_cooking',    'plan a high-protein meal for tomorrow', 'cooking'),

  buildPlanCase('script_plan_1', 'Write a shell script that prints the system time and exits.'),
  buildPlanCase('script_plan_2', 'Generate a small TypeScript helper that hashes a string with SHA-256.'),
  buildPlanCase('script_plan_3', 'Plan a SQL migration that adds a "deleted_at" timestamp column to a "users" table.'),

  buildReasoningCase('reason_1', 'A bat and a ball cost $1.10. The bat costs $1.00 more than the ball. How much does the ball cost?'),
  buildReasoningCase('reason_2', 'If a server has 30 GB RAM and a 24 GB model weight + 2 GB KV cache + 2 GB system overhead, is there enough headroom for a 1 GB request burst?'),
  buildReasoningCase('reason_3', 'Why should a CPU-only local inference service use a bounded queue and one loaded model?'),
];

async function runCase(c: SmokeCase) {
  const t0 = Date.now();
  let response: any = null;
  let error: string | null = null;
  // v1.2: explicit AbortController so think:true cases aren't capped by
  // Node's default ~300 s fetch timeout. The 2026-05-26 v1.1 smoke had
  // 5/6 think:true cases die at exactly 300_800 ms = Node default; the
  // model itself could have finished given more time. 600s ceiling here
  // is generous for evaluation; production OllamaProvider uses
  // config.ollama.timeoutMs (default 360s) for live calls.
  const ctrl = new AbortController();
  const tHandle = setTimeout(() => ctrl.abort(), 600_000);
  try {
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c.body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      error = `HTTP ${resp.status}`;
    } else {
      response = await resp.json();
    }
  } catch (e) {
    error = String(e);
  } finally {
    clearTimeout(tHandle);
  }
  const elapsedMs = Date.now() - t0;
  const validationError = error || c.validate(response);
  const metrics = response ? {
    total_duration_ns: response.total_duration,
    load_duration_ns:  response.load_duration,
    prompt_eval_count: response.prompt_eval_count,
    eval_count:        response.eval_count,
    prompt_tokens_per_sec: response.prompt_eval_count && response.prompt_eval_duration
      ? Math.round(response.prompt_eval_count / (response.prompt_eval_duration / 1e9))
      : null,
    generation_tokens_per_sec: response.eval_count && response.eval_duration
      ? Math.round(response.eval_count / (response.eval_duration / 1e9))
      : null,
    is_cold_load: response.load_duration ? response.load_duration > 1e9 : null,
  } : null;
  return {
    label: c.label,
    ok: !validationError,
    error: validationError,
    elapsed_ms: elapsedMs,
    metrics,
    response_text: response?.message?.content?.slice(0, 300) ?? null,
  };
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(process.cwd(), 'data', 'local-llm-smoke-runs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ts}.json`);

  console.log(`→ local-llm-smoke: ${BASE_URL} · ${MODEL}`);
  console.log(`→ ${CASES.length} cases · output: ${outPath}\n`);

  const results: Array<Awaited<ReturnType<typeof runCase>>> = [];
  for (const c of CASES) {
    process.stdout.write(`  • ${c.label.padEnd(22)} `);
    const r = await runCase(c);
    results.push(r);
    if (r.ok) {
      const gtps = r.metrics?.generation_tokens_per_sec ?? '?';
      const cold = r.metrics?.is_cold_load ? ' (cold)' : '';
      console.log(`✓ ${r.elapsed_ms}ms · ${gtps} gen tok/s${cold}`);
    } else {
      console.log(`✗ ${r.error}`);
    }
  }

  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  fs.writeFileSync(outPath, JSON.stringify({
    ts,
    base_url: BASE_URL,
    model: MODEL,
    pass, fail,
    results,
  }, null, 2));
  console.log(`\n──────────────────────────────────────`);
  console.log(`PASS: ${pass}  FAIL: ${fail}  · ${outPath}`);
  console.log(`──────────────────────────────────────`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('local-llm-smoke crashed:', e);
  process.exit(2);
});
