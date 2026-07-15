// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Voice Evolution Agent — compares AI-generated scripts against
 * actual published video transcripts to learn the authenticated
 * creator's true voice.
 *
 * Schedule: Monthly, 1st of month at 04:00
 *
 * Consumes: channel_dna, book_knowledge, pillar_performance (cross-agent), retention_pattern (cross-agent)
 * Produces: voice_pattern, voice_phrase_trend
 */

import type Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext } from '../services/cross-agent-learning';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from '../services/gemini-provider';
import { getActiveUserTargets, type UserTarget } from '../services/user-service';
import { contentScopeParams, contentScopePredicate, ensureContentTenantScopeColumns } from '../services/content-tenant-scope';
import { createLazyAnthropicClient } from '../services/anthropic-lazy-client';
import {
  recordAiAutomationEligibilitySkip,
  resolveAiAutomationEligibility,
} from '../services/ai-automation-policy';
import { AiBudgetError, withAiBudgetReservation } from '../services/cost-guardrail';

const client = createLazyAnthropicClient({ maxRetries: 2 });
const VOICE_EVOLUTION_FINGERPRINT_VERSION = 'voice-evolution-input-v1';
const MAX_ANALYSIS_ITEMS = 20;
const MAX_EXAMPLES_PER_ITEM = 10;
const MAX_ANALYSIS_FIELD_LENGTH = 1_000;
const MAX_VOICE_SUMMARY_LENGTH = 2_000;

class VoiceEvolutionFingerprintReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceEvolutionFingerprintReadError';
  }
}

class VoiceEvolutionProviderSchemaError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceEvolutionProviderSchemaError';
    this.cause = cause;
  }
}

class VoiceEvolutionProviderCallError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'VoiceEvolutionProviderCallError';
    this.cause = cause;
  }
}

class VoiceEvolutionPersistenceError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'VoiceEvolutionPersistenceError';
    this.cause = cause;
  }
}

// Both cron and manual execution call runVoiceEvolutionAgent directly. Keep
// one module-level claim per tenant so two overlapping invocations cannot both
// observe a missing fingerprint and reserve/provider-call for the same input.
const tenantRunTails = new Map<number, Promise<void>>();

async function withVoiceEvolutionTenantClaim<T>(tenantId: number, work: () => Promise<T>): Promise<T> {
  const predecessor = tenantRunTails.get(tenantId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  tenantRunTails.set(tenantId, tail);

  await predecessor;
  try {
    return await work();
  } finally {
    release();
    if (tenantRunTails.get(tenantId) === tail) {
      tenantRunTails.delete(tenantId);
    }
  }
}

type AdditionFrequency = 'often' | 'sometimes' | 'rare';
type AdditionCategory = 'anecdote' | 'argument' | 'humor' | 'data' | 'reference' | 'transition';
type RemovalCategory = 'filler' | 'formal' | 'repetitive' | 'off_brand';
type AdoptionLevel = 'integrated' | 'emerging' | 'absent';

interface VoiceEvolutionAnalysis {
  additions: Array<{
    pattern: string;
    examples: string[];
    frequency: AdditionFrequency;
    category: AdditionCategory;
  }>;
  removals: Array<{
    pattern: string;
    examples: string[];
    category: RemovalCategory;
  }>;
  rephrasing: Array<{
    original: string;
    creator_version: string;
    insight: string;
  }>;
  recurring_phrases: Array<{
    phrase: string;
    context: string;
    count: number;
  }>;
  book_influences: Array<{
    book_or_concept: string;
    how_it_appears: string;
    adoption_level: AdoptionLevel;
  }>;
  voice_summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new VoiceEvolutionProviderSchemaError(
      `Voice Evolution provider schema invalid at ${path}: `
      + `missing=[${missing.join(',')}], unexpected=[${unexpected.join(',')}]`,
    );
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new VoiceEvolutionProviderSchemaError(`Voice Evolution provider schema invalid at ${path}: expected object`);
  }
  return value;
}

function requireString(
  value: unknown,
  path: string,
  maxLength = MAX_ANALYSIS_FIELD_LENGTH,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new VoiceEvolutionProviderSchemaError(`Voice Evolution provider schema invalid at ${path}: expected non-empty string`);
  }
  if (value.length > maxLength) {
    throw new VoiceEvolutionProviderSchemaError(
      `Voice Evolution provider schema invalid at ${path}: exceeds ${maxLength} characters`,
    );
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new VoiceEvolutionProviderSchemaError(
      `Voice Evolution provider schema invalid at ${path}: expected string array`,
    );
  }
  if (value.length > MAX_EXAMPLES_PER_ITEM) {
    throw new VoiceEvolutionProviderSchemaError(
      `Voice Evolution provider schema invalid at ${path}: exceeds ${MAX_EXAMPLES_PER_ITEM} items`,
    );
  }
  return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new VoiceEvolutionProviderSchemaError(
      `Voice Evolution provider schema invalid at ${path}: unsupported value`,
    );
  }
  return value as T;
}

function requireObjectArray<T>(
  value: unknown,
  path: string,
  parseEntry: (entry: Record<string, unknown>, entryPath: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new VoiceEvolutionProviderSchemaError(`Voice Evolution provider schema invalid at ${path}: expected array`);
  }
  if (value.length > MAX_ANALYSIS_ITEMS) {
    throw new VoiceEvolutionProviderSchemaError(
      `Voice Evolution provider schema invalid at ${path}: exceeds ${MAX_ANALYSIS_ITEMS} items`,
    );
  }
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    return parseEntry(requireRecord(entry, entryPath), entryPath);
  });
}

function parseVoiceEvolutionAnalysis(providerText: string): VoiceEvolutionAnalysis {
  const normalized = providerText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    throw new VoiceEvolutionProviderSchemaError('Voice Evolution provider result is not valid JSON', error);
  }

  const root = requireRecord(parsed, '$');
  assertExactKeys(root, [
    'additions',
    'removals',
    'rephrasing',
    'recurring_phrases',
    'book_influences',
    'voice_summary',
  ], '$');

  const additions = requireObjectArray(root.additions, '$.additions', (entry, path) => {
    assertExactKeys(entry, ['pattern', 'examples', 'frequency', 'category'], path);
    return {
      pattern: requireString(entry.pattern, `${path}.pattern`),
      examples: requireStringArray(entry.examples, `${path}.examples`),
      frequency: requireEnum(entry.frequency, ['often', 'sometimes', 'rare'], `${path}.frequency`),
      category: requireEnum(
        entry.category,
        ['anecdote', 'argument', 'humor', 'data', 'reference', 'transition'],
        `${path}.category`,
      ),
    };
  });
  const removals = requireObjectArray(root.removals, '$.removals', (entry, path) => {
    assertExactKeys(entry, ['pattern', 'examples', 'category'], path);
    return {
      pattern: requireString(entry.pattern, `${path}.pattern`),
      examples: requireStringArray(entry.examples, `${path}.examples`),
      category: requireEnum(entry.category, ['filler', 'formal', 'repetitive', 'off_brand'], `${path}.category`),
    };
  });
  const rephrasing = requireObjectArray(root.rephrasing, '$.rephrasing', (entry, path) => {
    assertExactKeys(entry, ['original', 'creator_version', 'insight'], path);
    return {
      original: requireString(entry.original, `${path}.original`),
      creator_version: requireString(entry.creator_version, `${path}.creator_version`),
      insight: requireString(entry.insight, `${path}.insight`),
    };
  });
  const recurringPhrases = requireObjectArray(root.recurring_phrases, '$.recurring_phrases', (entry, path) => {
    assertExactKeys(entry, ['phrase', 'context', 'count'], path);
    if (!Number.isSafeInteger(entry.count) || Number(entry.count) < 1) {
      throw new VoiceEvolutionProviderSchemaError(
        `Voice Evolution provider schema invalid at ${path}.count: expected positive integer`,
      );
    }
    return {
      phrase: requireString(entry.phrase, `${path}.phrase`),
      context: requireString(entry.context, `${path}.context`),
      count: Number(entry.count),
    };
  });
  const bookInfluences = requireObjectArray(root.book_influences, '$.book_influences', (entry, path) => {
    assertExactKeys(entry, ['book_or_concept', 'how_it_appears', 'adoption_level'], path);
    return {
      book_or_concept: requireString(entry.book_or_concept, `${path}.book_or_concept`),
      how_it_appears: requireString(entry.how_it_appears, `${path}.how_it_appears`),
      adoption_level: requireEnum(
        entry.adoption_level,
        ['integrated', 'emerging', 'absent'],
        `${path}.adoption_level`,
      ),
    };
  });

  return {
    additions,
    removals,
    rephrasing,
    recurring_phrases: recurringPhrases,
    book_influences: bookInfluences,
    voice_summary: requireString(root.voice_summary, '$.voice_summary', MAX_VOICE_SUMMARY_LENGTH),
  };
}

function readPriorInputFingerprint(
  db: ReturnType<typeof getDb>,
  userId: number,
  tenantId: number,
): string | null {
  let row: { payload: string } | undefined;
  try {
    row = db.prepare(`
      SELECT payload
      FROM agent_signals
      WHERE source_agent = 'voice-evolution'
        AND signal_type = 'voice_analysis_fingerprint'
        AND status = 'active'
        AND user_id = ?
        AND tenant_id = ?
        AND created_at > datetime('now', '-370 days')
      ORDER BY id DESC
      LIMIT 1
    `).get(userId, tenantId) as { payload: string } | undefined;
  } catch {
    throw new VoiceEvolutionFingerprintReadError('Voice Evolution fingerprint read failed; provider call blocked');
  }

  if (!row) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new VoiceEvolutionFingerprintReadError('Voice Evolution fingerprint payload is invalid; provider call blocked');
  }
  if (!isRecord(payload) || typeof payload.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(payload.fingerprint)) {
    throw new VoiceEvolutionFingerprintReadError('Voice Evolution fingerprint payload is invalid; provider call blocked');
  }
  return payload.fingerprint;
}

function requireSignalWrite(signalId: number, signalType: string): void {
  if (signalId < 0) {
    throw new Error(`Voice Evolution failed to persist ${signalType} output`);
  }
}

const ANALYSIS_PROMPT = `You are analyzing the voice evolution of the authenticated content creator (resolved from the active user/tenant target).

Compare these AI-GENERATED scripts against the creator's ACTUAL published video transcripts.

AI-GENERATED SCRIPTS:
{scripts}

PUBLISHED VIDEO TRANSCRIPTS:
{transcripts}

BOOK KNOWLEDGE (extracted from books the creator reads — frameworks, vocabulary, and techniques):
{book_knowledge}

Analyze and return a JSON object with:
{{
  "additions": [
    {{
      "pattern": "Short description of what the creator adds",
      "examples": ["Specific text added"],
      "frequency": "often|sometimes|rare",
      "category": "anecdote|argument|humor|data|reference|transition"
    }}
  ],
  "removals": [
    {{
      "pattern": "What the creator consistently removes/shortens",
      "examples": ["Original text cut"],
      "category": "filler|formal|repetitive|off_brand"
    }}
  ],
  "rephrasing": [
    {{
      "original": "How the AI wrote it",
      "creator_version": "How the creator actually said it",
      "insight": "What this tells us about the creator's voice"
    }}
  ],
  "recurring_phrases": [
    {{
      "phrase": "Exact phrase the creator repeats",
      "context": "When it is used",
      "count": 3
    }}
  ],
  "book_influences": [
    {{
      "book_or_concept": "Name of book or concept from book knowledge",
      "how_it_appears": "How this concept shows up in the creator's scripts or transcripts",
      "adoption_level": "integrated|emerging|absent"
    }}
  ],
  "voice_summary": "2-3 sentences describing the creator's actual voice vs the AI-generated voice, including any book influences detected"
}}

If transcripts are limited, analyze the scripts against the creator profile instead and note what's missing.
If book knowledge is available, identify which concepts the creator has integrated into his/her natural voice vs. which remain absent.
Return ONLY valid JSON, no markdown.`;

// ── Main Agent Runner ────────────────────────────────────────────────

export async function runVoiceEvolutionAgent(): Promise<void> {
  const start = Date.now();
  let signalsProduced = 0;
  let signalsConsumed = 0;
  const tenantFailures: Error[] = [];

  try {
    const targets = getActiveUserTargets();
    if (targets.length === 0) {
      logAgentRun('voice-evolution', 'skipped', 0, 0, Date.now() - start, 'No active users available');
      logger.info('Voice Evolution: no active users available. Skipping.');
      return;
    }

    for (const target of targets) {
      const eligibility = resolveAiAutomationEligibility(target.tenantId, 'content');
      if (!eligibility.allowed) {
        recordAiAutomationEligibilitySkip(target.tenantId, eligibility, {
          jobName: 'voice_evolution',
          baseCategory: 'voice_evolution',
        });
        logger.debug(
          {
            userId: target.tenantId,
            reason: eligibility.reason,
            entitlementSource: eligibility.entitlement.source,
          },
          'Voice Evolution skipped before tenant data/provider work: Content automation is not eligible',
        );
        continue;
      }
      try {
        const result = await withVoiceEvolutionTenantClaim(
          target.tenantId,
          () => runVoiceEvolutionForTarget(target),
        );
        signalsProduced += result.signalsProduced;
        signalsConsumed += result.signalsConsumed;
      } catch (err) {
        if (err instanceof AiBudgetError) {
          logger.info(
            { userId: target.tenantId, code: err.decision.code, window: err.decision.window },
            'Voice Evolution deferred by the user automation budget',
          );
          continue;
        }
        // A fingerprint query/payload failure means the idempotency system is
        // not trustworthy globally. Preserve the fail-closed behavior and do
        // not make provider calls for later tenants in this invocation.
        if (
          err instanceof VoiceEvolutionFingerprintReadError
          || err instanceof VoiceEvolutionPersistenceError
        ) throw err;

        // Only failures proven to be tenant-local may be isolated. Unknown
        // errors retain fail-closed behavior rather than being mislabeled as a
        // safe partial failure.
        if (
          !(err instanceof VoiceEvolutionProviderCallError)
          && !(err instanceof VoiceEvolutionProviderSchemaError)
        ) throw err;

        tenantFailures.push(err);
        logger.error(
          { err, userId: target.tenantId, tenantId: target.tenantId },
          'Voice Evolution tenant failed; continuing with remaining tenants',
        );
      }
    }

    if (tenantFailures.length > 0) {
      throw new AggregateError(
        tenantFailures,
        `Voice Evolution partial failure after all targets were attempted (${tenantFailures.length}/${targets.length})`,
      );
    }

    logAgentRun('voice-evolution', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info({ targetCount: targets.length, signalsProduced, signalsConsumed }, 'Voice Evolution complete for active tenants');
  } catch (err: any) {
    logAgentRun('voice-evolution', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'Voice Evolution Agent failed');
    throw err;
  }
}

async function runVoiceEvolutionForTarget(target: UserTarget): Promise<{ signalsProduced: number; signalsConsumed: number }> {
  const start = Date.now();
  let signalsProduced = 0;
  let signalsConsumed = 0;
  const userId = target.tenantId;
  const tenantId = target.tenantId;

  try {
    const db = getDb();
    ensureContentTenantScopeColumns(db);

    // ── Collect generated scripts from the authenticated tenant ───
    //
    // Primary: read raw script text from content_scripts table (April 2026).
    // This is reliable — the full text is stored durably in SQLite.
    const scripts: { topic: string; text: string }[] = [];

    try {
      const { getRecentScripts } = await import('../services/content-learning-store');
      const dbScripts = getRecentScripts(userId, 30, 10, tenantId);
      for (const s of dbScripts) {
        scripts.push({
          topic: s.topic,
          text: s.scriptText.slice(0, 3000),
        });
      }
      logger.info({ count: dbScripts.length, userId, tenantId }, 'Voice agent: loaded scripts from scoped DB');
    } catch (err) {
      logger.warn({ err, userId, tenantId }, 'Voice agent: content_scripts table not available; skipping tenant script load');
    }

    // Collect published video transcripts
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const transcripts = db.prepare(`
      SELECT title, full_text FROM video_transcripts
      WHERE user_id = ?
        AND ${contentScopePredicate()}
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(userId, ...contentScopeParams(userId, tenantId), thirtyDaysAgo) as any[];

    // Consume channel DNA for reference
    const dnaSignals = readSignals('voice-evolution', ['channel_dna'], 20, userId, undefined, tenantId);
    signalsConsumed += dnaSignals.length;

    // Consume book knowledge — frameworks, vocabulary, techniques from books the authenticated creator reads
    const bookSignals = readSignals('voice-evolution', ['book_knowledge'], 10, userId, undefined, tenantId);
    signalsConsumed += bookSignals.length;

    // Cross-agent learning: consume performance data to focus on high-performing content
    const peerContext = buildAgentContext('voice-evolution', userId, tenantId);
    signalsConsumed += peerContext.signalsConsumed;

    // If we have neither scripts nor transcripts, graceful skip
    if (scripts.length === 0 && transcripts.length === 0) {
      logger.info({ userId, tenantId }, 'Voice Evolution: no scripts or transcripts from last 30 days. Skipping tenant.');
      return { signalsProduced, signalsConsumed };
    }

    // Build context for Claude analysis
    const scriptsBlock = scripts.length > 0
      ? scripts.map(s => `=== ${s.topic} ===\n${s.text}`).join('\n\n')
      : 'No generated scripts available for this period.';

    const transcriptsBlock = transcripts.length > 0
      ? transcripts.map((t: any) => `=== ${t.title} ===\n${(t.full_text || '').slice(0, 2000)}`).join('\n\n')
      : 'No published transcripts available for this period. Analyze scripts against the creator profile instead.';

    // Build book knowledge context
    const bookKnowledgeBlock = bookSignals.length > 0
      ? bookSignals.map(s => {
          const p = s.payload as any;
          const title = p.book_title || p.title || 'Unknown';
          const concepts = p.key_concepts || p.frameworks || p.techniques || [];
          const summary = p.summary || p.description || '';
          return `=== ${title} ===\n${summary}\nKey concepts: ${Array.isArray(concepts) ? concepts.join(', ') : concepts}`;
        }).join('\n\n')
      : 'No book knowledge available. Skip the book_influences section.';

    const prompt = ANALYSIS_PROMPT
      .replace('{scripts}', scriptsBlock)
      .replace('{transcripts}', transcriptsBlock)
      .replace('{book_knowledge}', bookKnowledgeBlock);

    // The fingerprint contains no raw creator data. It is tenant-scoped and
    // checked before budget reservation or provider routing so an unchanged
    // monthly input results in zero model calls for that tenant.
    const inputFingerprint = createHash('sha256')
      .update(JSON.stringify({ version: VOICE_EVOLUTION_FINGERPRINT_VERSION, prompt }))
      .digest('hex');
    // Intelligence-bus reads intentionally degrade to an empty array when the
    // bus is unavailable. That behavior is appropriate for optional context,
    // but not for a provider-call idempotency gate: an unavailable read must
    // never be mistaken for "no prior fingerprint". Read this governed marker
    // directly and fail closed on query or payload corruption.
    const priorFingerprint = readPriorInputFingerprint(db, userId, tenantId);
    if (priorFingerprint === inputFingerprint) {
      logger.info(
        { userId, tenantId, fingerprintVersion: VOICE_EVOLUTION_FINGERPRINT_VERSION },
        'Voice Evolution: unchanged tenant input; skipped before budget/provider work',
      );
      return { signalsProduced, signalsConsumed };
    }

    // Gemini-first deep analysis with Sonnet fallback. This is a low-frequency
    // call (~monthly per eligible tenant) but each invocation is large (~4K output tokens). Voice
    // pattern extraction works well on gemini-2.5-flash for this prompt shape.
    let voiceText: string;
    try {
      const providerResult = await withAiBudgetReservation({
        userId,
        requestSource: 'automation',
        baseCategory: 'voice_evolution',
        jobName: 'voice_evolution',
        // Voice learning is useful, but it is not one of the scheduled Content
        // delivery slots. Keep it below Coach and scheduled topic inventory so
        // it cannot consume the allowance those user-visible artifacts need.
        automationPriority: 'other',
      }, () => completeOneShotWithFallback(
        '',  // no system prompt — instructions are in the user prompt
        prompt,
        'voice_evolution',
        async () => {
          const response = await trackedCreate(client.get(), {
            model: config.anthropic.model,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
          }, 'voice_evolution', { userId, tenantId });
          return response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('');
        },
        { maxTokens: 4096, temperature: 0.3, userId, tenantId },
      ));
      if (typeof providerResult?.text !== 'string') {
        throw new VoiceEvolutionProviderSchemaError(
          'Voice Evolution provider schema invalid at $.text: expected string',
        );
      }
      voiceText = providerResult.text;
    } catch (error) {
      if (error instanceof AiBudgetError) throw error;
      if (error instanceof VoiceEvolutionProviderSchemaError) throw error;
      throw new VoiceEvolutionProviderCallError('Voice Evolution provider call failed for tenant', error);
    }

    // Provider output is untrusted even when it is syntactically valid JSON.
    // Validate the complete contract before any signal or learned-pattern
    // mutation, then persist all governed outputs atomically. The fingerprint
    // is deliberately the final write: a failed output must remain retryable.
    const analysis = parseVoiceEvolutionAnalysis(voiceText);
    let upsertLearnedPattern: typeof import('../services/content-learning-store').upsertLearnedPattern;
    try {
      ({ upsertLearnedPattern } = await import('../services/content-learning-store'));
    } catch (error) {
      throw new VoiceEvolutionPersistenceError(
        'Voice Evolution governed output dependency failed to load',
        error,
      );
    }

    try {
      db.transaction(() => {
      // Write voice_pattern signals
      if (analysis.additions.length > 0) {
        requireSignalWrite(writeSignal({
          source_agent: 'voice-evolution',
          signal_type: 'voice_pattern',
          user_id: userId,
          tenant_id: tenantId,
          payload: {
            observation: 'content_additions',
            description: `creator adds ${analysis.additions.length} types of content not in generated scripts`,
            patterns: analysis.additions,
            strength: analysis.additions.filter((addition) => addition.frequency === 'often').length / Math.max(1, analysis.additions.length),
            first_detected: new Date().toISOString().slice(0, 10),
            category: 'addition_pattern',
          },
        }), 'voice_pattern');
        signalsProduced++;
      }

      if (analysis.removals.length > 0) {
        requireSignalWrite(writeSignal({
          source_agent: 'voice-evolution',
          signal_type: 'voice_pattern',
          user_id: userId,
          tenant_id: tenantId,
          payload: {
            observation: 'content_removals',
            description: `creator removes ${analysis.removals.length} types of content from generated scripts`,
            patterns: analysis.removals,
            strength: 0.7,
            first_detected: new Date().toISOString().slice(0, 10),
            category: 'removal_pattern',
          },
        }), 'voice_pattern');
        signalsProduced++;
      }

      if (analysis.rephrasing.length > 0) {
        requireSignalWrite(writeSignal({
          source_agent: 'voice-evolution',
          signal_type: 'voice_pattern',
          user_id: userId,
          tenant_id: tenantId,
          payload: {
            observation: 'voice_rephrasing',
            description: 'How the creator rephrases AI-generated text to match their voice',
            examples: analysis.rephrasing.slice(0, 5),
            strength: 0.8,
            first_detected: new Date().toISOString().slice(0, 10),
            category: 'rephrasing_pattern',
          },
        }), 'voice_pattern');
        signalsProduced++;
      }

      // Write recurring phrases as voice_phrase_trend
      for (const phrase of analysis.recurring_phrases.slice(0, 5)) {
        requireSignalWrite(writeSignal({
          source_agent: 'voice-evolution',
          signal_type: 'voice_phrase_trend',
          user_id: userId,
          tenant_id: tenantId,
          payload: {
            phrase: phrase.phrase,
            context: phrase.context,
            frequency: phrase.count,
            detected_at: new Date().toISOString(),
          },
        }), 'voice_phrase_trend');
        signalsProduced++;
      }

      // Write book influence signals (tracks how book concepts enter the authenticated creator's voice)
      if (analysis.book_influences.length > 0) {
        const integratedCount = analysis.book_influences
          .filter((influence) => influence.adoption_level === 'integrated').length;
        requireSignalWrite(writeSignal({
          source_agent: 'voice-evolution',
          signal_type: 'voice_pattern',
          user_id: userId,
          tenant_id: tenantId,
          payload: {
            observation: 'book_voice_influence',
            description: `${integratedCount} book concepts integrated into voice`,
            influences: analysis.book_influences,
            strength: integratedCount / Math.max(1, analysis.book_influences.length),
            first_detected: new Date().toISOString().slice(0, 10),
            category: 'book_influence',
          },
        }), 'voice_pattern');
        signalsProduced++;
      }

        requireSignalWrite(writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        user_id: userId,
        tenant_id: tenantId,
        payload: {
          observation: 'monthly_voice_summary',
          description: analysis.voice_summary,
          strength: 0.9,
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'voice_summary',
        },
      }), 'voice_pattern');
      signalsProduced++;

      // Bus signals expire (voice_pattern: 90-day TTL). Store patterns
      // durably per active tenant so a creator's voice memory never enters a
      // global founder-shaped pool.
      for (const addition of analysis.additions) {
        upsertLearnedPattern({
          category: 'voice_addition',
          patternText: addition.pattern,
          examples: addition.examples.slice(0, 5),
          confidence: addition.frequency === 'often' ? 0.9 : addition.frequency === 'sometimes' ? 0.7 : 0.5,
          sourceAgent: 'voice-evolution',
          userId,
          tenantId,
        });
      }
      for (const removal of analysis.removals) {
        upsertLearnedPattern({
          category: 'voice_removal',
          patternText: removal.pattern,
          examples: removal.examples.slice(0, 5),
          confidence: 0.7,
          sourceAgent: 'voice-evolution',
          userId,
          tenantId,
        });
      }
      for (const rephrase of analysis.rephrasing) {
        upsertLearnedPattern({
          category: 'voice_rephrasing',
          patternText: rephrase.insight,
          examples: [rephrase.original, rephrase.creator_version],
          confidence: 0.8,
          sourceAgent: 'voice-evolution',
          userId,
          tenantId,
        });
      }
      for (const influence of analysis.book_influences) {
        upsertLearnedPattern({
          category: 'book_influence',
          patternText: influence.book_or_concept,
          examples: [influence.how_it_appears],
          confidence: influence.adoption_level === 'integrated' ? 0.9 : 0.5,
          sourceAgent: 'voice-evolution',
          userId,
          tenantId,
        });
      }

      requireSignalWrite(writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_analysis_fingerprint',
        user_id: userId,
        tenant_id: tenantId,
        priority: 'background',
        confidence: 1,
        payload: {
          fingerprint: inputFingerprint,
          fingerprintVersion: VOICE_EVOLUTION_FINGERPRINT_VERSION,
        },
        provenance: {
          producerVersion: VOICE_EVOLUTION_FINGERPRINT_VERSION,
          source: 'runtime',
          observedAt: new Date().toISOString(),
        },
        }), 'voice_analysis_fingerprint');
      })();
    } catch (error) {
      throw new VoiceEvolutionPersistenceError(
        'Voice Evolution governed output transaction failed',
        error,
      );
    }

    logger.info({ userId, tenantId }, 'Voice agent: persisted governed outputs to scoped DB');

    const summary = `Voice Evolution: analyzed ${scripts.length} scripts + ${transcripts.length} transcripts + ${bookSignals.length} book insights. ${signalsProduced} voice patterns detected.`;
    logger.info({ userId, tenantId, durationMs: Date.now() - start }, summary);
    return { signalsProduced, signalsConsumed };
  } catch (err: any) {
    logger.error({ err, userId, tenantId }, 'Voice Evolution tenant run failed');
    throw err;
  }
}
