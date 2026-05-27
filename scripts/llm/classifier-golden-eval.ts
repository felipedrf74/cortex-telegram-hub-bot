#!/usr/bin/env npx tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * scripts/llm/classifier-golden-eval.ts
 *
 * Option 3 — offline golden-set evaluator for the dedicated small
 * classifier model. Runs the model against `data/classifier-golden-set.json`
 * and prints precision/recall per domain + tool-domain recall.
 *
 * Per O3-A24, the golden set's `domain` field is reviewer-decided
 * ground truth (NOT Gemini output). The acceptance bar:
 *
 *   - Overall agreement ≥ 92%.
 *   - Per-domain precision ≥ 85%.
 *   - Tool-domain (secretary, triathlon) recall ≥ 95%.
 *   - Ambiguous (id starts with 'ambig-') agreement ≥ 70%.
 *   - Follow-up (id starts with 'followup-') agreement ≥ 90%.
 *   - p95 ollama_duration_ms ≤ 3000.
 *
 * Talks directly to the Ollama daemon — does NOT route through the
 * OllamaProvider class (so this script can be run before/without
 * nexus-hub bot config). Uses the same compact prompt
 * (`OLLAMA_CLASSIFIER_PROMPT_VERSION=v1`) the production path uses.
 *
 * Usage:
 *   npx tsx scripts/llm/classifier-golden-eval.ts
 *   OLLAMA_CLASSIFIER_MODEL=gemma2:2b-instruct-q4_K_M npx tsx scripts/llm/classifier-golden-eval.ts
 *
 * Exit 0 if all gates pass. Exit 1 otherwise.
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_CLASSIFIER_MODEL || 'qwen2.5:3b-instruct-q4_K_M';
const PROMPT_VERSION = process.env.OLLAMA_CLASSIFIER_PROMPT_VERSION || 'v1';

// Eval prompts inlined here (rather than importing from
// services/anthropic.ts) to keep the script standalone — no need to
// pull the whole bot dependency graph just to run an offline eval.
// Keep these in sync with `getOllamaClassifierSystemPromptCompact`.
const COMPACT_PROMPT_V1 = [
  'Classify the user message into exactly one Nexus Hub domain.',
  '',
  'Reply JSON only matching this schema:',
  '{"domain":<one of: secretary, triathlon, content, finance, cooking>, "confidence":<0..1>}',
  '',
  'Domain meanings:',
  '- secretary = scheduling, calendar, email, reminders, tasks, todos, contacts',
  '- triathlon = training plans, workouts, recovery, gym/run/bike/swim sessions, athletic coaching',
  '- content = video/social-media drafts, scripts, hooks, captions, posts, reels, content ideas',
  '- finance = money, expenses, budget, invoices, taxes, payments, categorization',
  '- cooking = recipes, meals, food, ingredients, meal planning',
  '',
  'Prefer secretary or triathlon when the message asks for scheduling, an',
  'action that creates a calendar event, persistence of a training plan, or',
  'tool-bearing intent. Confidence ≥ 0.80 required for tool domains.',
  '',
  'Examples (ambiguous cases — common Portuguese failure modes):',
  '- "Devo treinar hoje ou descansar?" → triathlon (athletic coaching question)',
  '- "Cria uma receita de kibe" → cooking (recipe request, not creative content)',
  '',
  'Reply JSON only. No extra text, no thinking, no preamble.',
].join('\n');

const COMPACT_PROMPT_V2 = [
  'Classify the user message into exactly one Nexus Hub domain.',
  '',
  'Reply JSON only matching this schema:',
  '{"domain":<one of: secretary, triathlon, content, finance, cooking>, "confidence":<0..1>}',
  '',
  'Domain meanings:',
  '- secretary = scheduling, calendar, email, reminders, TASKS/todos, contacts.',
  '  Any message that asks to ADD A TASK, REMIND ME, MARK AS DONE,',
  '  CANCEL/MOVE/EDIT a task or appointment, or NOTE something to act',
  '  on later is secretary — REGARDLESS of the topic of the task.',
  '- triathlon = training plans, workouts, recovery, gym/run/bike/swim',
  '  sessions, athletic coaching, AND athlete nutrition / dietary',
  '  guidance for training. Garmin device questions are triathlon.',
  '- content = video/social-media drafts, scripts, hooks, captions,',
  '  posts, reels, content ideas, channel strategy.',
  '- finance = MANAGING the user\'s OWN money — categorizing their',
  '  expenses, paying their invoices, tracking their budget,',
  '  calculating their taxes, organizing receipts. Finance is about',
  '  the user\'s financial RECORDS, not about the cost of things in',
  '  the world.',
  '- cooking = recipes, meals, food, ingredients, meal planning,',
  '  ingredient substitutions, ingredient prices.',
  '',
  'IMPORTANT DISAMBIGUATION:',
  '1. "Add a task to ..." or "Mark X as done" is SECRETARY even when',
  '   the task topic is financial ("budget review", "pay invoice").',
  '   The user is requesting task management, not financial action.',
  '2. "How much does X cost?" / "Quanto custa X?" is COOKING when X',
  '   is an ingredient ("quilo de carne"), TRIATHLON when X is a',
  '   training tool ("relógio Garmin"), and FINANCE only when X is',
  '   the user\'s own expense/bill ("minha conta de luz", "meu IRPF").',
  '3. "Should I stop eating X?" / "Preciso parar de comer X?" is',
  '   TRIATHLON when framed as an athlete (training/recovery/diet),',
  '   COOKING when framed as a meal choice without athletic context.',
  '4. Side-effect verbs (publish, schedule, post) inside a content',
  '   request are still CONTENT if the user is asking for the draft,',
  '   but SECRETARY if the user is asking to schedule the publishing',
  '   ("posta no Instagram amanhã às 14h" → secretary, the time is',
  '   the action; "escreve um post sobre X" → content, the draft is',
  '   the action).',
  '',
  'Prefer secretary or triathlon when the message asks for scheduling,',
  'an action that creates a calendar event, persistence of a training',
  'plan, or tool-bearing intent. Confidence ≥ 0.80 required for tool',
  'domains.',
  '',
  'Examples (real Portuguese ambiguous cases):',
  '- "Devo treinar hoje ou descansar?" → triathlon (coaching question)',
  '- "Cria uma receita de kibe" → cooking (recipe, not content)',
  '- "Add a task to review the budget by Thursday" → secretary',
  '  (task creation, not financial analysis)',
  '- "Anota: ligar para o contador amanhã" → secretary',
  '  (note-taking, even though the topic is financial)',
  '- "Quanto custa um quilo de carne moída?" → cooking',
  '  (ingredient price, not personal finance)',
  '- "Quanto custa um relógio Garmin?" → triathlon',
  '  (training-tool research, not personal finance)',
  '- "Preciso parar de comer pão?" → triathlon',
  '  (athlete diet question; cooking only if no athletic context)',
  '',
  'Reply JSON only. No extra text, no thinking, no preamble.',
].join('\n');

const COMPACT_PROMPT_V3 = [
  'Classify the user message into exactly one Nexus Hub domain.',
  '',
  'Reply JSON only: {"domain":<secretary|triathlon|content|finance|cooking>,"confidence":<0..1>}',
  '',
  'Domains:',
  '- secretary: scheduling, calendar, email, reminders, TASKS, todos, contacts.',
  '  Task-creation verbs (add a task, remind me, mark done, anota, lembra-me,',
  '  cancela, move) = secretary even when topic is financial or other.',
  '- triathlon: training, workouts, recovery, gym/run/bike/swim, athletic coaching,',
  '  athlete nutrition, Garmin device questions.',
  '- content: video/social drafts, scripts, hooks, captions, posts, reels.',
  '- finance: managing user\'s OWN money — categorize expenses, pay invoices,',
  '  track budget, calculate taxes, organize receipts. NOT cost-of-things.',
  '- cooking: recipes, meals, food, ingredients (incl. ingredient prices).',
  '',
  'Disambiguation rules:',
  '1. "Add a task / mark done / anota" → secretary (regardless of topic).',
  '2. "Quanto custa X?" → cooking if X is ingredient, triathlon if X is training',
  '   tool (Garmin), finance ONLY if X is user\'s own bill.',
  '3. "Preciso parar de comer X?" → triathlon (athlete diet); cooking only if',
  '   no athletic context.',
  '4. "Posta no Instagram amanhã às 14h" → secretary (scheduled action);',
  '   "escreve um post sobre X" → content (draft request).',
  '',
  'Prefer secretary/triathlon for scheduling, calendar events, training-plan',
  'persistence, or tool-bearing intent. Confidence ≥ 0.80 for tool domains.',
  '',
  'Reply JSON only. No extra text.',
].join('\n');

const COMPACT_PROMPT =
  PROMPT_VERSION === 'v3' ? COMPACT_PROMPT_V3 :
  PROMPT_VERSION === 'v2' ? COMPACT_PROMPT_V2 :
  COMPACT_PROMPT_V1;

const FORMAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string', enum: ['secretary', 'triathlon', 'content', 'finance', 'cooking'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['domain', 'confidence'],
};

interface GoldenExample {
  id: string;
  domain: string;
  message: string;
  activeContext?: { domain: string; lastAssistantMessage: string };
  note?: string;
}

interface EvalResult {
  id: string;
  truth: string;
  predicted: string | null;
  confidence: number | null;
  durationMs: number;
  agree: boolean;
  error?: string;
}

async function classifyOnce(example: GoldenExample): Promise<EvalResult> {
  const systemContent = example.activeContext
    ? `${COMPACT_PROMPT}\n\nThe user is in an active "${example.activeContext.domain}" conversation. The last assistant message was: "${example.activeContext.lastAssistantMessage.slice(0, 200)}". Use this context only when the new message is itself ambiguous.`
    : COMPACT_PROMPT;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: example.message },
    ],
    stream: false,
    think: false,
    keep_alive: -1,
    format: FORMAT_SCHEMA,
    options: { num_ctx: 2048, num_predict: 32, temperature: 0 },
  };
  const t0 = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const durationMs = Date.now() - t0;
    if (!resp.ok) {
      return { id: example.id, truth: example.domain, predicted: null, confidence: null, durationMs, agree: false, error: `HTTP ${resp.status}` };
    }
    const j = await resp.json() as { message?: { content?: string } };
    const content = (j.message?.content || '').trim();
    let parsed: { domain?: string; confidence?: number };
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return { id: example.id, truth: example.domain, predicted: null, confidence: null, durationMs, agree: false, error: `invalid_json: ${content.slice(0, 80)}` };
    }
    const predicted = typeof parsed.domain === 'string' ? parsed.domain : null;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
    return {
      id: example.id,
      truth: example.domain,
      predicted,
      confidence,
      durationMs,
      agree: predicted === example.domain,
    };
  } catch (err) {
    return { id: example.id, truth: example.domain, predicted: null, confidence: null, durationMs: Date.now() - t0, agree: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function pct(num: number, denom: number): number {
  return denom === 0 ? 0 : Math.round((num / denom) * 1000) / 10;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main() {
  const goldenPath = path.resolve(__dirname, '../../data/classifier-golden-set.json');
  const raw = fs.readFileSync(goldenPath, 'utf-8');
  const data = JSON.parse(raw) as { examples: GoldenExample[]; _meta?: unknown };
  const examples = data.examples;
  console.log(`Loaded ${examples.length} golden examples from ${goldenPath}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Prompt version: ${PROMPT_VERSION}`);
  console.log(`BaseURL: ${BASE_URL}`);
  console.log('Warming model with one throwaway call...');
  await classifyOnce({ id: 'warm', domain: 'secretary', message: 'warm up' });

  // Run sequentially — OLLAMA_NUM_PARALLEL=1, no benefit from concurrency.
  const results: EvalResult[] = [];
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];
    process.stdout.write(`[${i + 1}/${examples.length}] ${ex.id} ... `);
    const r = await classifyOnce(ex);
    results.push(r);
    console.log(`predicted=${r.predicted ?? 'null'} truth=${r.truth} ${r.agree ? '✓' : '✗'} ${r.durationMs}ms${r.error ? ' err=' + r.error : ''}`);
  }

  // ── Aggregate ──
  const total = results.length;
  const agree = results.filter((r) => r.agree).length;
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const overallPct = pct(agree, total);
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);

  console.log('');
  console.log('────────────────────────────────────────');
  console.log(`Total           : ${total}`);
  console.log(`Overall agree   : ${agree}/${total} = ${overallPct}%`);
  console.log(`Latency p50/p95/p99: ${p50}/${p95}/${p99} ms`);
  console.log('');

  // Per-domain precision and recall (against reviewer-decided truth).
  const domains = ['secretary', 'triathlon', 'content', 'finance', 'cooking'] as const;
  for (const d of domains) {
    const truthSet = results.filter((r) => r.truth === d);
    const predSet = results.filter((r) => r.predicted === d);
    const tp = truthSet.filter((r) => r.predicted === d).length;
    const fn = truthSet.length - tp;
    const fp = predSet.length - tp;
    const precision = predSet.length === 0 ? 0 : pct(tp, predSet.length);
    const recall = truthSet.length === 0 ? 0 : pct(tp, truthSet.length);
    console.log(`${d.padEnd(10)} truth=${truthSet.length}  tp=${tp}  fn=${fn}  fp=${fp}  precision=${precision}%  recall=${recall}%`);
  }
  console.log('');

  // Ambiguous + follow-up subsets.
  const ambig = results.filter((r) => r.id.startsWith('ambig-'));
  const followup = results.filter((r) => r.id.startsWith('followup-'));
  const ambigAgree = ambig.filter((r) => r.agree).length;
  const fuAgree = followup.filter((r) => r.agree).length;
  console.log(`Ambiguous (${ambig.length})   : ${ambigAgree}/${ambig.length} = ${pct(ambigAgree, ambig.length)}%`);
  console.log(`Follow-up (${followup.length}): ${fuAgree}/${followup.length} = ${pct(fuAgree, followup.length)}%`);
  console.log('');

  // Confusion table for failures.
  const failures = results.filter((r) => !r.agree);
  if (failures.length > 0) {
    console.log(`Failures (${failures.length}):`);
    for (const f of failures) {
      console.log(`  ${f.id.padEnd(20)} truth=${f.truth.padEnd(10)} predicted=${(f.predicted ?? 'null').padEnd(10)} ${f.error ?? ''}`);
    }
    console.log('');
  }

  // ── Gates ──
  let pass = true;
  const gates: { name: string; passed: boolean; detail: string }[] = [];

  function gate(name: string, condition: boolean, detail: string) {
    gates.push({ name, passed: condition, detail });
    if (!condition) pass = false;
  }

  gate('Overall agree ≥ 92%', overallPct >= 92, `${overallPct}%`);

  for (const d of domains) {
    const truthSet = results.filter((r) => r.truth === d);
    const predSet = results.filter((r) => r.predicted === d);
    const tp = truthSet.filter((r) => r.predicted === d).length;
    const precision = predSet.length === 0 ? 0 : pct(tp, predSet.length);
    const recall = truthSet.length === 0 ? 0 : pct(tp, truthSet.length);
    gate(`${d} precision ≥ 85%`, precision >= 85, `${precision}%`);
    if (d === 'secretary' || d === 'triathlon') {
      gate(`${d} recall ≥ 95% (tool-domain)`, recall >= 95, `${recall}%`);
    }
  }

  if (ambig.length > 0) gate('Ambiguous agree ≥ 70%', pct(ambigAgree, ambig.length) >= 70, `${pct(ambigAgree, ambig.length)}%`);
  if (followup.length > 0) gate('Follow-up agree ≥ 90%', pct(fuAgree, followup.length) >= 90, `${pct(fuAgree, followup.length)}%`);
  gate('p95 ≤ 3000ms', p95 <= 3000, `${p95}ms`);

  console.log('Acceptance gates:');
  for (const g of gates) {
    console.log(`  [${g.passed ? '✓' : '✗'}] ${g.name} (${g.detail})`);
  }
  console.log('');

  // Persist run for diff-over-time.
  const outDir = path.resolve(__dirname, '../../data/classifier-golden-runs');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    ts,
    model: MODEL,
    base_url: BASE_URL,
    prompt_version: PROMPT_VERSION,
    total,
    agree,
    overall_pct: overallPct,
    p50_ms: p50,
    p95_ms: p95,
    p99_ms: p99,
    gates,
    results,
  }, null, 2));
  console.log(`Run saved: ${outFile}`);

  if (pass) {
    console.log('\nGOLDEN SET: PASS ✓');
    process.exit(0);
  } else {
    console.log('\nGOLDEN SET: FAIL ✗');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
