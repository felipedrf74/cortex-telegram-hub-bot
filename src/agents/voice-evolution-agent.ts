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

const client = createLazyAnthropicClient({ maxRetries: 2 });

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

  try {
    const targets = getActiveUserTargets();
    if (targets.length === 0) {
      logAgentRun('voice-evolution', 'skipped', 0, 0, Date.now() - start, 'No active users available');
      logger.info('Voice Evolution: no active users available. Skipping.');
      return;
    }

    for (const target of targets) {
      const result = await runVoiceEvolutionForTarget(target);
      signalsProduced += result.signalsProduced;
      signalsConsumed += result.signalsConsumed;
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

    // Gemini-first deep analysis with Sonnet fallback. This is a low-frequency
    // call (~weekly) but each invocation is large (~4K output tokens). Voice
    // pattern extraction works well on gemini-2.5-flash for this prompt shape.
    const { text: voiceText } = await completeOneShotWithFallback(
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
    );

    let text = voiceText;

    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let analysis: any;
    try {
      analysis = JSON.parse(text);
    } catch {
      logger.warn('Voice Evolution: Claude returned non-JSON, writing raw observation');
      analysis = { voice_summary: text.slice(0, 500), additions: [], removals: [], rephrasing: [], recurring_phrases: [] };
    }

    // Write voice_pattern signals
    if (analysis.additions?.length > 0) {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        user_id: userId,
        tenant_id: tenantId,
        payload: {
          observation: 'content_additions',
          description: `creator adds ${analysis.additions.length} types of content not in generated scripts`,
          patterns: analysis.additions,
          strength: analysis.additions.filter((a: any) => a.frequency === 'often').length / Math.max(1, analysis.additions.length),
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'addition_pattern',
        },
      });
      signalsProduced++;
    }

    if (analysis.removals?.length > 0) {
      writeSignal({
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
      });
      signalsProduced++;
    }

    if (analysis.rephrasing?.length > 0) {
      writeSignal({
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
      });
      signalsProduced++;
    }

    // Write recurring phrases as voice_phrase_trend
    if (analysis.recurring_phrases?.length > 0) {
      for (const phrase of analysis.recurring_phrases.slice(0, 5)) {
        writeSignal({
          source_agent: 'voice-evolution',
          signal_type: 'voice_phrase_trend',
          user_id: userId,
          tenant_id: tenantId,
          payload: {
            phrase: phrase.phrase,
            context: phrase.context,
            frequency: phrase.count || 1,
            detected_at: new Date().toISOString(),
          },
        });
        signalsProduced++;
      }
    }

    // Write book influence signals (tracks how book concepts enter the authenticated creator's voice)
    if (analysis.book_influences?.length > 0) {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        user_id: userId,
        tenant_id: tenantId,
        payload: {
          observation: 'book_voice_influence',
          description: `${analysis.book_influences.filter((b: any) => b.adoption_level === 'integrated').length} book concepts integrated into voice`,
          influences: analysis.book_influences,
          strength: analysis.book_influences.filter((b: any) => b.adoption_level === 'integrated').length / Math.max(1, analysis.book_influences.length),
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'book_influence',
        },
      });
      signalsProduced++;
    }

    // Voice summary signal
    if (analysis.voice_summary) {
      writeSignal({
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
      });
      signalsProduced++;
    }

    // ── Persist learned patterns durably (April 2026) ──────────────
    //
    // Bus signals expire (voice_pattern: 90-day TTL). Store patterns
    // in content_learned_patterns table per active tenant so each creator's
    // voice memory accumulates without entering a global founder-shaped pool.
    try {
      const { upsertLearnedPattern } = await import('../services/content-learning-store');

        for (const a of analysis.additions ?? []) {
          upsertLearnedPattern({
            category: 'voice_addition',
            patternText: a.pattern || String(a),
            examples: a.examples?.slice(0, 5) ?? [],
            confidence: a.frequency === 'often' ? 0.9 : a.frequency === 'sometimes' ? 0.7 : 0.5,
            sourceAgent: 'voice-evolution',
            userId,
            tenantId,
          });
        }
        for (const r of analysis.removals ?? []) {
          upsertLearnedPattern({
            category: 'voice_removal',
            patternText: r.pattern || String(r),
            examples: r.examples?.slice(0, 5) ?? [],
            confidence: 0.7,
            sourceAgent: 'voice-evolution',
            userId,
            tenantId,
          });
        }
        for (const rp of analysis.rephrasing ?? []) {
          // The analysis prompt produces `creator_version` (line 64 of the
          // ANALYSIS_PROMPT template). Earlier code read the legacy
          // field name which silently dropped the rephrased example to
          // `undefined` and rendered patternText as
          // `<original> → undefined`. Closed-beta-readiness-hardening
          // (2026-05-03): align reader with the prompt schema and fall
          // back to the legacy field name ONLY for rows persisted before
          // the rename so already-stored patterns continue to render.
          // nx-allow-identity-scan: intentional backward-compat read
          const creatorVersion = (rp as any).creator_version ?? (rp as any).felipe_version ?? '';
          upsertLearnedPattern({
            category: 'voice_rephrasing',
            patternText: rp.insight || `${rp.original} → ${creatorVersion}`,
            examples: [rp.original, creatorVersion].filter(Boolean),
            confidence: 0.8,
            sourceAgent: 'voice-evolution',
            userId,
            tenantId,
          });
        }
        for (const bi of analysis.book_influences ?? []) {
          upsertLearnedPattern({
            category: 'book_influence',
            patternText: bi.book_or_concept || String(bi),
            examples: [bi.how_it_appears].filter(Boolean),
            confidence: bi.adoption_level === 'integrated' ? 0.9 : 0.5,
            sourceAgent: 'voice-evolution',
            userId,
            tenantId,
          });
        }

      logger.info({ userId, tenantId }, 'Voice agent: persisted learned patterns to scoped DB');
    } catch (err) {
      logger.warn({ err, userId, tenantId }, 'Voice agent: failed to persist scoped patterns (non-fatal)');
    }

    const summary = `Voice Evolution: analyzed ${scripts.length} scripts + ${transcripts.length} transcripts + ${bookSignals.length} book insights. ${signalsProduced} voice patterns detected.`;
    logger.info({ userId, tenantId, durationMs: Date.now() - start }, summary);
    return { signalsProduced, signalsConsumed };
  } catch (err: any) {
    logger.error({ err, userId, tenantId }, 'Voice Evolution tenant run failed');
    throw err;
  }
}
