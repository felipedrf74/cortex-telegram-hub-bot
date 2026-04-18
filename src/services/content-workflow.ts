// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
// grammy removed — Telegram adapters moved to src/adapters/telegram-content-adapter.ts
import { config } from '../config';
import { logger } from '../utils/logger';
import { now } from '../utils/date-parser';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from './gemini-provider';
import { getDb } from './database';
import { buildKnowledgePromptBlock } from '../state/content-references';
import { saveScriptAsDocx } from './video-study';
import { storeCallback } from '../utils/callback-store';
import { buildAngleDiversityBlock, isDuplicateIdea } from './content-dedup';
import { getWorkflowEligibleIdeas, markIdeaPromoted } from '../state/saved-ideas';
import { readSignals } from './intelligence-bus';
import { loadPromptWithConfig } from '../utils/prompt-loader';
import { getUserLanguage } from './user-service';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const IDEAS_DIR = path.join(os.homedir(), 'Desktop', 'IDEAS');

// ─── Types ──────────────────────────────────────────────────────────

export interface TopicCandidate {
  title: string;
  niche: string;
  whyNow: string;
  hookIdea: string;
  angleTag?: string;
}

// ─── Database helpers ───────────────────────────────────────────────

export function storeTopicCandidates(
  candidates: TopicCandidate[],
  format: 'reel' | 'youtube',
  sourceJob: string,
  userId: number = 0,
): number[] {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO content_topic_feedback (topic, niche, format, sentiment, source_job, hook_idea, why_now, angle_tag, user_id)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  );
  return candidates.map((c) => {
    const info = stmt.run(c.title, c.niche, format, sourceJob, c.hookIdea, c.whyNow, c.angleTag || null, userId);
    return Number(info.lastInsertRowid);
  });
}

export function updateFeedback(id: number, sentiment: 'approved' | 'skipped' | 'rejected'): void {
  getDb().prepare(`UPDATE content_topic_feedback SET sentiment = ? WHERE id = ?`).run(sentiment, id);
}

export function markScriptGenerated(id: number): void {
  getDb().prepare(`UPDATE content_topic_feedback SET script_generated = 1 WHERE id = ?`).run(id);
}

export function getTopicById(id: number): TopicCandidate & { format: string; sourceJob: string } | null {
  const row = getDb().prepare(
    `SELECT topic, niche, format, source_job, hook_idea, why_now FROM content_topic_feedback WHERE id = ?`,
  ).get(id) as any;
  if (!row) return null;
  return {
    title: row.topic,
    niche: row.niche || '',
    whyNow: row.why_now || '',
    hookIdea: row.hook_idea || '',
    format: row.format,
    sourceJob: row.source_job || '',
  };
}

// ─── Taste Profile ──────────────────────────────────────────────────

export function buildTasteProfileBlock(userId?: number): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT topic, niche, sentiment FROM content_topic_feedback
     WHERE sentiment IN ('approved', 'rejected')
       AND created_at > datetime('now', '-60 days')
       ${userId != null ? 'AND user_id = ?' : ''}
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all(...(userId != null ? [userId] : [])) as { topic: string; niche: string; sentiment: string }[];

  if (rows.length < 5) return '';

  const approved = rows.filter((r) => r.sentiment === 'approved');
  const rejected = rows.filter((r) => r.sentiment === 'rejected');

  let block = '\n\n[TASTE PROFILE — learned from past feedback]\n';
  block += 'Use this to suggest topics Felipe is more likely to approve.\n\n';

  if (approved.length > 0) {
    block += 'Topics Felipe APPROVED:\n';
    for (const r of approved.slice(0, 15)) {
      block += `  • "${r.topic}" (${r.niche || 'general'})\n`;
    }
  }

  if (rejected.length > 0) {
    block += '\nTopics Felipe REJECTED (avoid similar):\n';
    for (const r of rejected.slice(0, 15)) {
      block += `  • "${r.topic}" (${r.niche || 'general'})\n`;
    }
  }

  // Summary stats
  const approvedNiches = [...new Set(approved.map((r) => r.niche).filter(Boolean))];
  const rejectedNiches = [...new Set(rejected.map((r) => r.niche).filter(Boolean))];
  block += `\nPreferred pillars: ${approvedNiches.join(', ') || 'varied'}`;
  block += `\nAvoided pillars: ${rejectedNiches.join(', ') || 'none'}\n`;

  return block;
}

// ─── Topic Generation ───────────────────────────────────────────────

function buildTopicSystemPrompt(format: 'reel' | 'youtube', isTrending: boolean, userId?: number): string {
  const formatDesc = format === 'reel'
    ? 'Instagram Reels / YouTube Shorts (30-60 seconds each)'
    : 'YouTube videos (8-15 minutes each)';

  const trendingInstr = isTrending
    ? 'Focus on what is trending RIGHT NOW — viral debates, breaking news, hot takes from the last 24-48h. Every topic must be tied to something CURRENT.'
    : 'Focus on EVERGREEN topics — timeless ideas that will be relevant months from now. Personal growth frameworks, fitness principles, life lessons.';

  // userId passed explicitly — no more AsyncLocalStorage dependency.
  // This makes personalization stable across transports (iOS, Telegram, scheduler).
  const knowledgeBlock = buildKnowledgePromptBlock(userId);
  const tasteBlock = buildTasteProfileBlock(userId);

  return loadPromptWithConfig('topic-generation', {
    FORMAT_DESC: formatDesc,
    TRENDING_INSTRUCTION: trendingInstr,
    KNOWLEDGE_BLOCK: knowledgeBlock ? knowledgeBlock + '\n' : '',
    TASTE_PROFILE: tasteBlock ? tasteBlock + '\n' : '',
  });
}

export async function generateTopicCandidates(
  format: 'reel' | 'youtube',
  count: number,
  isTrending = true,
  userId?: number,
): Promise<TopicCandidate[]> {
  const systemPrompt = buildTopicSystemPrompt(format, isTrending, userId);
  const today = now();

  // Build enrichment blocks
  const angleDiversity = buildAngleDiversityBlock();

  // Book knowledge injection (Sprint 3.2)
  let bookBlock = '';
  try {
    const bookSignals = readSignals('content-workflow', ['book_knowledge'], 20, userId);
    if (bookSignals.length > 0) {
      const bookLines = bookSignals.slice(0, 5).map((s: any) => {
        const p = s.payload as any;
        const fwNames = (p.key_frameworks || []).map((f: any) => f.name).join(', ');
        return `- "${p.title}" by ${p.author}: ${fwNames}`;
      });
      bookBlock = `\n## Book Frameworks Available\nThese intellectual frameworks from your library could seed compelling topics:\n${bookLines.join('\n')}\nConsider generating 1-2 topics that apply these frameworks to current events. Use angle_tag "framework" for these.\n`;
    }
  } catch { /* non-critical */ }

  // Discovery cross-pollination (Sprint 2.4)
  let discoveryBlock = '';
  try {
    const eligible = getWorkflowEligibleIdeas(userId);
    if (eligible.length > 0) {
      const ideasList = eligible.slice(0, 5).map(i => `- ${i.title}`).join('\n');
      discoveryBlock = `\n## Pre-Researched Ideas from Daily Discovery\nThese high-scoring ideas were found by the daily trend scanner. Consider including, modifying, or building on them:\n${ideasList}\n`;
      // Mark promoted
      for (const idea of eligible.slice(0, 5)) {
        markIdeaPromoted(idea.id);
      }
    }
  } catch { /* non-critical */ }

  const enrichment = `${angleDiversity}${bookBlock}${discoveryBlock}`;

  const userMessage = isTrending
    ? `Today is ${today.toFormat('cccc, LLLL dd, yyyy')}. Generate ${count} trending ${format} topic candidates for The Operator brand. Search for what's hot right now across all pillars (🤖 AI/Tech, 🎤 Commentary, 🏋️ Training, 🎮 Gaming, 🃏 Wild Card). Don't force quotas — follow what's genuinely interesting and timely.${enrichment}\n\nRespond with a JSON array. Each object must have: "title", "niche" (one of: ai-tech, commentary, training, gaming, wild-card), "whyNow", "hookIdea", "angle_tag", "pillar_emoji", "time_sensitivity".`
    : `Generate ${count} evergreen ${format} topic candidates for The Operator brand. Timeless topics across any pillar (🤖 AI/Tech, 🎤 Commentary, 🏋️ Training, 🎮 Gaming, 🃏 Wild Card). Follow genuine interest, not quotas.${enrichment}\n\nRespond with a JSON array. Each object must have: "title", "niche" (one of: ai-tech, commentary, training, gaming, wild-card), "whyNow", "hookIdea", "angle_tag", "pillar_emoji", "time_sensitivity".`;

  // Gemini-first routing for cost reduction (cost-optimization pass).
  // Topic generation is a JSON-output task that doesn't need Anthropic-specific
  // features like web_search; gemini-2.5-flash handles structured output well.
  // For trending topics we DO need web search though, which Gemini doesn't
  // support natively in the same way — so trending topics fall back to
  // Anthropic Haiku via the wrapper's fallback path.
  //
  // The wrapper logs the call to api_usage with the correct provider so the
  // cost dashboard reflects reality.
  const tools = isTrending
    ? [{ type: 'web_search_20250305' as any, name: 'web_search', max_uses: 5 } as any]
    : undefined;

  const cachedSystem: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const { text: textContent, provider: usedProvider } = await completeOneShotWithFallback(
    systemPrompt,
    userMessage,
    `content_workflow_${format}`,
    // Anthropic fallback — preserves the existing pause_turn handling for
    // trending mode (web search calls can pause and need a continuation).
    async () => {
      const response = await trackedCreate(client, {
        model: config.anthropic.classifierModel, // Haiku
        max_tokens: 4096,
        system: cachedSystem,
        messages: [{ role: 'user', content: userMessage }],
        ...(tools ? { tools } : {}),
      } as any, `content_workflow_${format}`);

      let finalResponse = response;
      if (response.stop_reason === 'pause_turn') {
        logger.info({ format }, 'Content workflow topic generation paused, continuing...');
        finalResponse = await trackedCreate(client, {
          model: config.anthropic.classifierModel,
          max_tokens: 4096,
          system: cachedSystem,
          messages: [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: response.content as any },
          ],
          ...(tools ? { tools } : {}),
        } as any, `content_workflow_${format}_continuation`);
      }

      return finalResponse.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    },
    { maxTokens: 4096 },
  );

  // For trending topics with web search, we MUST use Anthropic — Gemini's
  // search grounding is a different shape. The wrapper tries Gemini first
  // anyway because the JSON output may still be useful, but if we're
  // trending and got Gemini back without web grounding, log a hint.
  if (isTrending && usedProvider === 'gemini') {
    logger.info({ format }, 'Content workflow trending topic generated via Gemini (no web grounding)');
  }

  // Extract JSON array from response
  const jsonMatch = textContent.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn({ format, textContent: textContent.slice(0, 500) }, 'Could not find JSON array in topic response');
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as any[];
    // Normalize: map angle_tag from various field names Claude might use
    const candidates: TopicCandidate[] = parsed.slice(0, count).map(c => ({
      title: c.title || '',
      niche: c.niche || '',
      whyNow: c.whyNow || c.why_now || '',
      hookIdea: c.hookIdea || c.hook_idea || c.hook || '',
      angleTag: c.angleTag || c.angle_tag || undefined,
    }));

    // Run dedup on each candidate
    const deduped: TopicCandidate[] = [];
    for (const c of candidates) {
      try {
        const dup = await isDuplicateIdea(c.title, c.angleTag);
        if (dup.isDuplicate && dup.confidence > 0.8) {
          logger.info({ title: c.title, similarTo: dup.similarTo }, 'Workflow topic skipped (duplicate)');
          continue;
        }
      } catch { /* allow through on error */ }
      deduped.push(c);
    }

    return deduped;
  } catch (err) {
    logger.error({ err, format }, 'Failed to parse topic candidates JSON');
    return [];
  }
}

// ─── Script Generation (canonical pipeline) ───────────────────────
//
// All script generation now routes through `getScript()` in
// content-engine.ts, which calls the Python backend. That backend
// does deep research → Claude Sonnet → structured ScriptResponse.
//
// The old `generateReelScript` / `generateYouTubeScript` functions
// had a critical bug: they called `handleContent(prompt, 4096)`
// where 4096 was silently consumed as the `userId` parameter —
// not a token limit. The scripts ran under a phantom user context.
//
// Fixed in April 2026: both functions now call `getScript()` and
// return a structured `ScriptResponse` instead of raw text.

import type { ScriptResponse } from './content-engine';

/**
 * Generate a script for a topic candidate via the canonical
 * content-engine pipeline (Python backend with research grounding).
 *
 * This is the ONE path for script generation. All surfaces — iOS,
 * portal, Telegram, and the workflow approval flow — call this.
 *
 * @param topic - The topic candidate with title, niche, hookIdea, whyNow
 * @param format - 'reel' (30-60s short) or 'youtube' (8-15min long)
 * @returns Structured ScriptResponse with script, hook, title options,
 *          sources, estimated duration, and format metadata.
 */
export async function generateScript(
  topic: TopicCandidate & { feedbackId?: number },
  format: 'reel' | 'youtube' = 'youtube',
  userId: number = 0,
): Promise<ScriptResponse> {
  const { getScript } = await import('./content-engine');
  const maxDuration = format === 'reel' ? 1 : 8;
  const engineFormat = format === 'reel' ? 'Reel' : 'YouTube';
  const targetLanguage = userId > 0 ? getUserLanguage(userId) : 'pt-BR';

  const result = await getScript(
    topic.title,
    topic.niche || 'general',
    maxDuration,
    engineFormat,
    'standard',
    null,
    targetLanguage,
    'structured',
    userId,
    undefined,
    {
      topicFeedbackId: topic.feedbackId ?? null,
      niche: topic.niche || 'general',
      hookIdea: topic.hookIdea || null,
      whyNow: topic.whyNow || null,
      angleTag: topic.angleTag || null,
    },
  );

  // ── Durable script storage (April 2026) ──
  // Persist raw script text in the DB so voice-evolution-agent can
  // read it without parsing DOCX files. The DOCX export still happens
  // downstream for teleprompter use, but the DB is the canonical store.
  try {
    const { storeScript } = await import('./content-learning-store');
    storeScript({
      topicFeedbackId: topic.feedbackId,
      topic: topic.title,
      format,
      scriptText: result.script,
      hook: result.hook,
      titleOptions: result.title_options,
      sourcesUsed: result.sources_used,
      estimatedDuration: result.estimated_duration,
      hashtags: result.hashtags,
      caption: result.caption,
      cta: result.cta,
      niche: topic.niche || 'general',
      generationDurationMs: result.duration_ms,
      userId,
    });
  } catch (err) {
    // Non-fatal — script generation succeeded, just storage failed.
    // The script is still returned to the caller and saved as DOCX.
    logger.warn({ err, topic: topic.title }, 'Failed to store script text in DB (non-fatal)');
  }

  return result;
}

/**
 * @deprecated Use `generateScript(topic, 'reel')` instead.
 * Kept for backward compatibility with Telegram handler imports.
 * Returns just the script text (old contract).
 */
export async function generateReelScript(topic: TopicCandidate): Promise<string> {
  const result = await generateScript(topic, 'reel');
  return formatScriptToText(result);
}

/**
 * @deprecated Use `generateScript(topic, 'youtube')` instead.
 * Kept for backward compatibility with Telegram handler imports.
 * Returns just the script text (old contract).
 */
export async function generateYouTubeScript(topic: TopicCandidate): Promise<string> {
  const result = await generateScript(topic, 'youtube');
  return formatScriptToText(result);
}

/**
 * Convert a structured ScriptResponse to plain text for contexts
 * that expect a text string (legacy handlers, DOCX export, etc.).
 */
export function formatScriptToText(res: ScriptResponse): string {
  let text = '';

  if (res.title_options.length > 0) {
    text += 'TITLE OPTIONS:\n';
    res.title_options.forEach((t, i) => { text += `  ${i + 1}. ${t}\n`; });
    text += '\n';
  }

  text += `HOOK:\n${res.hook}\n\n`;
  text += `SCRIPT:\n${res.script}\n`;

  if (res.sources_used.length > 0) {
    text += '\nFONTES VERIFICADAS:\n';
    res.sources_used.forEach((s) => {
      text += `• ${s.title}${s.url ? ` — ${s.url}` : ''}\n`;
    });
  }

  if (res.estimated_duration) {
    text += `\nDuração estimada: ${res.estimated_duration}\n`;
  }

  return text;
}

// ─── Orchestrators (transport-agnostic) ────────────────────────────
//
// These return structured data. Telegram/iOS/portal callers format
// the result for their own transport. The old sendTopicCandidates /
// sendWeeklyPackage functions that called bot.api.sendMessage directly
// are replaced by these pure orchestrators + thin Telegram adapters
// in the handler layer.

/** Structured result from topic generation — no formatting, no transport. */
export interface TopicCandidateResult {
  format: 'reel' | 'youtube';
  sourceJob: string;
  /** Day label for display: "Terça-feira", "Quinta-feira", "Sexta-feira" */
  dayLabel: string;
  candidates: Array<TopicCandidate & { feedbackId: number }>;
}

/**
 * Generate topic candidates AND store them in the DB.
 * Returns structured data — caller decides how to present it.
 *
 * Called by:
 *   - iOS API (POST /api/v1/content/topics/generate)
 *   - Telegram handler (via sendTopicCandidatesTelegram adapter)
 *   - Scheduler (via the same adapter)
 */
export async function generateAndStoreTopicCandidates(
  userId: number,
  format: 'reel' | 'youtube',
  sourceJob: string,
): Promise<TopicCandidateResult> {
  const count = 5;
  const isTrending = sourceJob !== 'friday_weekly';
  const dayLabel = sourceJob === 'tuesday_reels' ? 'Terça-feira'
    : sourceJob === 'thursday_youtube' ? 'Quinta-feira'
    : 'Sexta-feira';

  const candidates = await generateTopicCandidates(format, count, isTrending, userId);
  const feedbackIds = candidates.length > 0
    ? storeTopicCandidates(candidates, format, sourceJob, userId)
    : [];

  return {
    format,
    sourceJob,
    dayLabel,
    candidates: candidates.map((c, i) => ({
      ...c,
      feedbackId: feedbackIds[i] ?? 0,
    })),
  };
}

/** Structured result from weekly package generation. */
export interface WeeklyPackageResult {
  youtube: Array<TopicCandidate & { feedbackId: number }>;
  reels: Array<TopicCandidate & { feedbackId: number }>;
}

/**
 * Generate the weekly content package (2 YT + 4 reels, evergreen).
 * Returns structured data — caller decides how to present it.
 */
export async function generateWeeklyPackage(
  userId: number,
): Promise<WeeklyPackageResult> {
  const [ytTopics, reelTopics] = await Promise.all([
    generateTopicCandidates('youtube', 2, false, userId),
    generateTopicCandidates('reel', 4, false, userId),
  ]);

  const ytIds = ytTopics.length > 0 ? storeTopicCandidates(ytTopics, 'youtube', 'friday_weekly', userId) : [];
  const reelIds = reelTopics.length > 0 ? storeTopicCandidates(reelTopics, 'reel', 'friday_weekly', userId) : [];

  return {
    youtube: ytTopics.map((c, i) => ({ ...c, feedbackId: ytIds[i] ?? 0 })),
    reels: reelTopics.map((c, i) => ({ ...c, feedbackId: reelIds[i] ?? 0 })),
  };
}

// ─── Telegram adapters REMOVED ─────────────────────────────────────
//
// sendTopicCandidates() and sendWeeklyPackage() (which took a grammy
// Bot parameter) have been moved to:
//   src/adapters/telegram-content-adapter.ts
//
// New callers should use:
//   1. generateAndStoreTopicCandidates() / generateWeeklyPackage()
//      (transport-agnostic orchestrators above)
//   2. createAndPushNotification() from content-notification-store.ts
//      (durable inbox + APNs delivery)
//
// Re-exports for backward compatibility with existing imports:
export { sendTopicCandidatesTelegram as sendTopicCandidates } from '../adapters/telegram-content-adapter';
export { sendWeeklyPackageTelegram as sendWeeklyPackage } from '../adapters/telegram-content-adapter';
