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

import Anthropic from '@anthropic-ai/sdk';
import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext } from '../services/cross-agent-learning';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from '../services/gemini-provider';
import { getOwnerBootstrapTarget } from '../services/user-service';
import fs from 'fs';
import os from 'os';
import path from 'path';

const IDEAS_DIR = path.join(os.homedir(), 'Desktop', 'IDEAS', 'SCRIPTS');

const client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 2 });

const ANALYSIS_PROMPT = `You are analyzing the voice evolution of the authenticated content creator (resolved per request from the owner bootstrap target).

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
    const db = getDb();

    // ── Collect generated scripts (DB-first, file fallback) ──────
    //
    // Primary: read raw script text from content_scripts table (April 2026).
    // This is reliable — the full text is stored durably in SQLite.
    //
    // Fallback: if content_scripts is empty (pre-migration scripts),
    // try the old pipeline → file path approach. This gracefully degrades
    // for historical data while new scripts use the DB-backed store.
    const scripts: { topic: string; text: string }[] = [];

    try {
      const { getRecentScripts } = await import('../services/content-learning-store');
      const ownerTarget = getOwnerBootstrapTarget();
      if (ownerTarget?.tenantId) {
        const dbScripts = getRecentScripts(ownerTarget.tenantId, 30, 10);
        for (const s of dbScripts) {
          scripts.push({
            topic: s.topic,
            text: s.scriptText.slice(0, 3000),
          });
        }
        logger.info({ count: dbScripts.length, userId: ownerTarget.tenantId }, 'Voice agent: loaded scripts from DB');
      } else {
        logger.warn('Voice agent: owner bootstrap target unavailable, skipping DB script load');
      }
    } catch {
      logger.warn('Voice agent: content_scripts table not available, using file fallback');
    }

    // File fallback for pre-migration scripts (DOCX is unreadable, try .txt)
    if (scripts.length === 0 && fs.existsSync(IDEAS_DIR)) {
      const files = fs.readdirSync(IDEAS_DIR)
        .filter(f => f.endsWith('.txt'))
        .sort()
        .slice(-10);

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(IDEAS_DIR, file), 'utf-8');
          if (content.length > 100) {
            scripts.push({ topic: file, text: content.slice(0, 2000) });
          }
        } catch { /* skip */ }
      }
    }

    // Collect published video transcripts
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const transcripts = db.prepare(`
      SELECT title, full_text FROM video_transcripts
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(thirtyDaysAgo) as any[];

    // Consume channel DNA for reference
    const dnaSignals = readSignals('voice-evolution', ['channel_dna'], 20);
    signalsConsumed += dnaSignals.length;

    // Consume book knowledge — frameworks, vocabulary, techniques from books the authenticated creator reads
    const bookSignals = readSignals('voice-evolution', ['book_knowledge'], 10);
    signalsConsumed += bookSignals.length;

    // Cross-agent learning: consume performance data to focus on high-performing content
    const peerContext = buildAgentContext('voice-evolution');
    signalsConsumed += peerContext.signalsConsumed;

    // If we have neither scripts nor transcripts, graceful skip
    if (scripts.length === 0 && transcripts.length === 0) {
      logger.info('Voice Evolution: No scripts or transcripts from last 30 days. Skipping.');
      logAgentRun('voice-evolution', 'skipped', 0, signalsConsumed, Date.now() - start,
        'No scripts or transcripts available');
      return;
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
        const response = await trackedCreate(client, {
          model: config.anthropic.model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        }, 'voice_evolution');
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('');
      },
      { maxTokens: 4096, temperature: 0.3 },
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
    // in content_learned_patterns table so they accumulate over time
    // and survive signal expiry. The upsert increments frequency on
    // repeated detection instead of duplicating.
    // Voice evolution is an owner-scoped monthly agent learning the
    // owner's voice from their own scripts and transcripts. The pattern
    // rows MUST be written under the owner's real tenant id; a silent
    // fallback to userId=0 would leak system-scoped rows across tenants
    // on any future per-user visibility query. When the owner bootstrap
    // resolver returns null (pre-bootstrap install, misconfigured env)
    // the safe behavior is to skip this run's persistence entirely. A
    // missed monthly persist is recoverable; a corrupted tenant scope
    // is not.
    const ownerTarget = getOwnerBootstrapTarget();
    if (!ownerTarget) {
      logger.warn(
        { agent: 'voice-evolution', signalsProduced },
        'voice-evolution: owner bootstrap target unresolved; skipping pattern persist for this run',
      );
    } else {
      try {
        const { upsertLearnedPattern } = await import('../services/content-learning-store');
        const userId = ownerTarget.tenantId;

        for (const a of analysis.additions ?? []) {
          upsertLearnedPattern({
            category: 'voice_addition',
            patternText: a.pattern || String(a),
            examples: a.examples?.slice(0, 5) ?? [],
            confidence: a.frequency === 'often' ? 0.9 : a.frequency === 'sometimes' ? 0.7 : 0.5,
            sourceAgent: 'voice-evolution',
            userId,
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
          });
        }

        logger.info('Voice agent: persisted learned patterns to DB');
      } catch (err) {
        logger.warn({ err }, 'Voice agent: failed to persist patterns (non-fatal)');
      }
    }

    const summary = `Voice Evolution: analyzed ${scripts.length} scripts + ${transcripts.length} transcripts + ${bookSignals.length} book insights. ${signalsProduced} voice patterns detected.`;
    logAgentRun('voice-evolution', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info(summary);
  } catch (err: any) {
    logAgentRun('voice-evolution', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'Voice Evolution Agent failed');
    throw err;
  }
}
