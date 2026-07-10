// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { now } from '../utils/date-parser';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback, completeOneShotWithSearch } from './gemini-provider';
import { completeOneShotWithWebSearch, isOpenAIConfigured } from './openai-provider';
import { getDb } from './database';
import { buildKnowledgePromptBlock, getAllKnowledge } from '../state/content-references';
import { saveScriptAsDocx } from './video-study';
import { storeCallback } from '../utils/callback-store';
import {
  buildAngleDiversityBlock,
  isDuplicateIdea,
  isDuplicateIdeaInBatch,
} from './content-dedup';
import { getWorkflowEligibleIdeas, markIdeaPromoted } from '../state/saved-ideas';
import { readSignals } from './intelligence-bus';
import { loadPromptWithConfig } from '../utils/prompt-loader';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import { getUserLanguage } from './user-service';
import { buildAuthorizedContentReferenceContext } from './content-reference-context';
import {
  contentScopeForInsert,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';
import { createLazyAnthropicClient } from './anthropic-lazy-client';
import { withAiBudgetReservation, type AiBudgetRequest } from './cost-guardrail';
import { isPaidAiCostControlsEnforcementEnabled } from './entitlement';
import { rethrowAiUsageFailClosedError } from './api-usage-fallback';

const client = createLazyAnthropicClient();

const IDEAS_DIR = path.join(os.homedir(), 'Desktop', 'IDEAS');
// At the largest scheduled Friday batch (1,832 output tokens), these exact
// prompt caps keep Gemini Flash's 125% concrete-call reservation below the
// Pro $0.012 automation ceiling without reducing required candidate counts.
const CONTENT_TOPIC_MODEL = 'gemini-2.5-flash';
const CONTENT_TOPIC_SYSTEM_PROMPT_MAX_CHARS = 6_500;
const CONTENT_TOPIC_USER_PROMPT_MAX_CHARS = 6_500;

function compactContentPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = '\n...[budget-safe compacted Content context]...\n';
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.65);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`;
}

function buildWorkflowVoiceMemory(userId: number): string | null {
  if (userId <= 0) return null;
  const preferredCategories = [
    'brand_voice',
    'voice_summary',
    'hook_style',
    'storytelling',
    'content_structure',
    'cta_pattern',
    'audience_engagement',
  ];
  try {
    const knowledge = getAllKnowledge(userId);
    const lines = preferredCategories.flatMap((category) => {
      const entry = knowledge.find((row) => row.category === category && row.synthesized_text?.trim());
      return entry ? [`[${category}] ${entry.synthesized_text.trim()}`] : [];
    });
    return lines.length > 0 ? lines.join('\n\n').slice(0, 6000) : null;
  } catch {
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export interface TopicCandidate {
  title: string;
  niche: string;
  whyNow: string;
  hookIdea: string;
  angleTag?: string;
}

export interface ScheduledInventoryRequest {
  format: 'reel' | 'youtube';
  sourceJob: string;
  targetCount: number;
  windowDays?: number;
}

export type ContentAiBudgetContext = Pick<
  AiBudgetRequest,
  'requestSource' | 'jobName' | 'runId' | 'estimatedCostUsd'
>;

// ─── Database helpers ───────────────────────────────────────────────

export function storeTopicCandidates(
  candidates: TopicCandidate[],
  format: 'reel' | 'youtube',
  sourceJob: string,
  userId: number = 0,
  tenantId: number = userId,
): number[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const stmt = db.prepare(
    `INSERT INTO content_topic_feedback (
       topic, niche, format, sentiment, source_job, hook_idea, why_now, angle_tag, user_id,
       tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
     )
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return candidates.map((c) => {
    const scope = contentScopeForInsert(userId, tenantId);
    const info = stmt.run(
      c.title,
      c.niche,
      format,
      sourceJob,
      c.hookIdea,
      c.whyNow,
      c.angleTag || null,
      userId,
      scope.tenantId,
      scope.ownerUserId,
      scope.visibilityScope,
      scope.lifecycleState,
      scope.scopeStatus,
      scope.createdBy,
      scope.updatedBy,
      scope.auditMetadataJson,
    );
    return Number(info.lastInsertRowid);
  });
}

export function updateFeedback(
  id: number,
  sentiment: 'approved' | 'skipped' | 'rejected',
  userId: number,
  tenantId: number,
): void {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  db.prepare(`
    UPDATE content_topic_feedback
       SET sentiment = ?,
           updated_by = ?
     WHERE id = ?
       AND ${contentScopePredicate()}
  `).run(sentiment, userId, id, ...contentScopeParams(userId, tenantId));
}

export function markScriptGenerated(id: number, userId: number, tenantId: number): void {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  db.prepare(`
    UPDATE content_topic_feedback
       SET script_generated = 1,
           updated_by = ?
     WHERE id = ?
       AND ${contentScopePredicate()}
  `).run(userId, id, ...contentScopeParams(userId, tenantId));
}

export function getTopicById(id: number, userId: number, tenantId: number): TopicCandidate & { format: string; sourceJob: string } | null {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const row = db.prepare(
    `SELECT topic, niche, format, source_job, hook_idea, why_now FROM content_topic_feedback
      WHERE id = ?
        AND ${contentScopePredicate()}`,
  ).get(id, ...contentScopeParams(userId, tenantId)) as any;
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

/**
 * Return only the missing portion of a scheduled inventory target. Pending
 * candidates inside the rolling window are reusable inventory, so cron retries
 * and the following week's run do not pay to recreate work the user has not
 * consumed yet.
 */
export function getMissingScheduledInventoryCount(
  userId: number,
  request: ScheduledInventoryRequest,
  tenantId: number = userId,
): number {
  const targetCount = Math.max(0, Math.floor(request.targetCount));
  if (targetCount === 0) return 0;

  const windowDays = Math.max(1, Math.min(30, Math.floor(request.windowDays ?? 7)));
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const row = db.prepare(`
    SELECT COUNT(*) AS pending_count
      FROM content_topic_feedback
     WHERE sentiment = 'pending'
       AND format = ?
       AND source_job = ?
       AND created_at >= datetime('now', ?)
       AND ${contentScopePredicate()}
  `).get(
    request.format,
    request.sourceJob,
    `-${windowDays} days`,
    ...contentScopeParams(userId, tenantId),
  ) as { pending_count: number };

  return Math.max(0, targetCount - Number(row.pending_count || 0));
}

// ─── Taste Profile ──────────────────────────────────────────────────

export function buildTasteProfileBlock(userId: number, tenantId: number): string {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const rows = db.prepare(
    `SELECT topic, niche, sentiment FROM content_topic_feedback
     WHERE sentiment IN ('approved', 'rejected')
       AND created_at > datetime('now', '-60 days')
       AND ${contentScopePredicate()}
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all(...contentScopeParams(userId, tenantId)) as { topic: string; niche: string; sentiment: string }[];

  if (rows.length < 5) return '';

  const approved = rows.filter((r) => r.sentiment === 'approved');
  const rejected = rows.filter((r) => r.sentiment === 'rejected');

  let block = '\n\n[TASTE PROFILE — learned from past feedback]\n';
  block += 'Use this to suggest topics the authenticated creator is more likely to approve.\n\n';

  if (approved.length > 0) {
    block += 'Topics the authenticated creator APPROVED:\n';
    for (const r of approved.slice(0, 15)) {
      block += `  • ${sanitizeForPromptInterpolation(r.topic)} (${sanitizeForPromptInterpolation(r.niche || 'general')})\n`;
    }
  }

  if (rejected.length > 0) {
    block += '\nTopics the authenticated creator REJECTED (avoid similar):\n';
    for (const r of rejected.slice(0, 15)) {
      block += `  • ${sanitizeForPromptInterpolation(r.topic)} (${sanitizeForPromptInterpolation(r.niche || 'general')})\n`;
    }
  }

  // Summary stats
  const approvedNiches = [...new Set(approved.map((r) => r.niche).filter(Boolean))];
  const rejectedNiches = [...new Set(rejected.map((r) => r.niche).filter(Boolean))];
  block += `\nPreferred pillars: ${approvedNiches.map((niche) => sanitizeForPromptInterpolation(niche)).join(', ') || 'varied'}`;
  block += `\nAvoided pillars: ${rejectedNiches.map((niche) => sanitizeForPromptInterpolation(niche)).join(', ') || 'none'}\n`;

  return block;
}

// ─── Topic Generation ───────────────────────────────────────────────

function buildTopicSystemPrompt(format: 'reel' | 'youtube', isTrending: boolean, userId: number, tenantId: number): string {
  const formatDesc = format === 'reel'
    ? 'Instagram Reels / YouTube Shorts (30-60 seconds each)'
    : 'YouTube videos (8-15 minutes each)';

  const trendingInstr = isTrending
    ? 'Focus on what is trending RIGHT NOW — viral debates, breaking news, hot takes from the last 24-48h. Every topic must be tied to something CURRENT.'
    : 'Focus on EVERGREEN topics — timeless ideas that will be relevant months from now. Personal growth frameworks, fitness principles, life lessons.';

  // userId passed explicitly — no more AsyncLocalStorage dependency.
  // This makes personalization stable across transports (iOS, Telegram, scheduler).
  const knowledgeBlock = userId > 0 ? buildKnowledgePromptBlock(userId, tenantId) : '';
  const tasteBlock = buildTasteProfileBlock(userId, tenantId);

  return loadPromptWithConfig('topic-generation', {
    FORMAT_DESC: formatDesc,
    TRENDING_INSTRUCTION: trendingInstr,
    KNOWLEDGE_BLOCK: knowledgeBlock ? knowledgeBlock + '\n' : '',
    TASTE_PROFILE: tasteBlock ? tasteBlock + '\n' : '',
  });
}

function buildWeeklyPackageSystemPrompt(userId: number, tenantId: number): string {
  const knowledgeBlock = userId > 0 ? buildKnowledgePromptBlock(userId, tenantId) : '';
  const tasteBlock = buildTasteProfileBlock(userId, tenantId);
  const basePrompt = loadPromptWithConfig('topic-generation', {
    FORMAT_DESC: 'one weekly package containing YouTube videos (8-15 minutes) and Instagram Reels / YouTube Shorts (30-60 seconds)',
    TRENDING_INSTRUCTION: 'Focus on EVERGREEN topics that remain useful for months. The package must contain distinct ideas across its long-form and short-form sections.',
    KNOWLEDGE_BLOCK: knowledgeBlock ? knowledgeBlock + '\n' : '',
    TASTE_PROFILE: tasteBlock ? tasteBlock + '\n' : '',
  });
  const responseContractStart = basePrompt.indexOf('RESPOND ONLY');
  const instructions = responseContractStart >= 0
    ? basePrompt.slice(0, responseContractStart).trimEnd()
    : basePrompt;
  return `${instructions}\n\nRESPOND ONLY with one valid JSON object containing "youtube" and "reels" arrays. No markdown fences or surrounding text. Every candidate in either array must use the live fields: title, niche, whyNow, hookIdea, angle_tag, pillar_emoji, and time_sensitivity.`;
}

function buildTopicEnrichment(userId: number, tenantId: number): {
  text: string;
  promotedDiscoveryIdeaIds: number[];
  hasFreshSignals: boolean;
} {
  const angleDiversity = buildAngleDiversityBlock(userId, tenantId);

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
  } catch { /* non-critical enrichment */ }

  let discoveryBlock = '';
  let promotedDiscoveryIdeaIds: number[] = [];
  try {
    const eligible = getWorkflowEligibleIdeas(userId);
    if (eligible.length > 0) {
      const promotedIdeas = eligible.slice(0, 5);
      promotedDiscoveryIdeaIds = promotedIdeas.map((idea) => idea.id);
      const ideasList = promotedIdeas.map((idea) => `- ${idea.title}`).join('\n');
      discoveryBlock = `\n## Pre-Researched Ideas from Daily Discovery\nThese high-scoring ideas were found by the daily trend scanner. Consider including, modifying, or building on them:\n${ideasList}\n`;
    }
  } catch { /* non-critical enrichment */ }

  let radarBlock = '';
  let hasFreshRadarSignals = false;
  try {
    const radarSignals = readSignals(
      'content-workflow',
      ['trending_spike', 'competitor_upload', 'reaction_opportunity'],
      20,
      userId,
      2,
      tenantId,
    );
    if (radarSignals.length > 0) {
      hasFreshRadarSignals = true;
      const radarLines = radarSignals.slice(0, 5).map((signal: any) => {
        const payload = signal.payload ?? {};
        const title = payload.title ?? payload.video_title ?? payload.topic ?? payload.summary ?? 'Content Radar signal';
        const reason = payload.reason ?? payload.why_now ?? payload.opportunity ?? '';
        return `- ${sanitizeForPromptInterpolation(String(title))}${reason ? ` — ${sanitizeForPromptInterpolation(String(reason))}` : ''}`;
      });
      radarBlock = `\n## Fresh Content Radar Signals\nReuse these tenant-scoped signals before requesting another paid search:\n${radarLines.join('\n')}\n`;
    }
  } catch { /* non-critical enrichment */ }

  return {
    text: `${angleDiversity}${bookBlock}${discoveryBlock}${radarBlock}`,
    promotedDiscoveryIdeaIds,
    hasFreshSignals: promotedDiscoveryIdeaIds.length > 0 || hasFreshRadarSignals,
  };
}

export function shouldAttachTrendingWebSearch(isTrending: boolean, hasFreshSignals: boolean): boolean {
  return isTrending && !hasFreshSignals;
}

async function completeTopicGeneration(
  systemPrompt: string,
  userMessage: string,
  category: string,
  userId: number,
  tenantId: number,
  tools?: any[],
  budgetContext: ContentAiBudgetContext = { requestSource: 'interactive' },
  generationOptions: {
    maxTokens?: number;
    ungroundedFallbackUserMessage?: string;
  } = {},
): Promise<{ text: string; provider: string; grounded: boolean }> {
  const maxTokens = Math.max(512, Math.min(4096, generationOptions.maxTokens ?? 2048));
  const boundedSystemPrompt = compactContentPrompt(systemPrompt, CONTENT_TOPIC_SYSTEM_PROMPT_MAX_CHARS);
  const boundedUserMessage = compactContentPrompt(userMessage, CONTENT_TOPIC_USER_PROMPT_MAX_CHARS);
  const boundedFallbackUserMessage = generationOptions.ungroundedFallbackUserMessage
    ? compactContentPrompt(generationOptions.ungroundedFallbackUserMessage, CONTENT_TOPIC_USER_PROMPT_MAX_CHARS)
    : undefined;
  const cachedSystem: Anthropic.TextBlockParam[] = [
    { type: 'text', text: boundedSystemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const completeWithAnthropic = async (
    prompt: string = boundedUserMessage,
    searchTools: any[] | undefined = tools,
  ): Promise<string> => {
    const boundedPrompt = compactContentPrompt(prompt, CONTENT_TOPIC_USER_PROMPT_MAX_CHARS);
    const response = await trackedCreate(client.get(), {
      model: config.anthropic.classifierModel,
      max_tokens: maxTokens,
      system: cachedSystem,
      messages: [{ role: 'user', content: boundedPrompt }],
      ...(searchTools ? { tools: searchTools } : {}),
    } as any, category, { userId, tenantId });
    let webSearchRequests = Number(
      (response as any).usage?.server_tool_use?.web_search_requests ?? 0,
    );

    let finalResponse = response;
    if (response.stop_reason === 'pause_turn') {
      logger.info({ category }, 'Content workflow generation paused, continuing');
      finalResponse = await trackedCreate(client.get(), {
        model: config.anthropic.classifierModel,
        max_tokens: maxTokens,
        system: cachedSystem,
        messages: [
          { role: 'user', content: boundedPrompt },
          { role: 'assistant', content: response.content as any },
        ],
        ...(searchTools ? { tools: searchTools } : {}),
      } as any, `${category}_continuation`, { userId, tenantId });
      webSearchRequests += Number(
        (finalResponse as any).usage?.server_tool_use?.web_search_requests ?? 0,
      );
    }

    if (searchTools && webSearchRequests <= 0) {
      throw new Error('Anthropic topic generation returned without executing required web search grounding');
    }

    return finalResponse.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  };

  return withAiBudgetReservation({
    userId,
    requestSource: budgetContext.requestSource,
    baseCategory: category,
    jobName: budgetContext.jobName ?? category,
    runId: budgetContext.runId ?? null,
    estimatedCostUsd: budgetContext.estimatedCostUsd,
    automationPriority: 'content',
  }, async () => {
    if (tools) {
      const completeWithOpenAiSearch = async (): Promise<{ text: string; provider: string; grounded: boolean }> => {
        const grounded = await completeOneShotWithWebSearch(
          boundedSystemPrompt,
          boundedUserMessage,
          `${category}_openai_web_search`,
          { maxTokens, userId, tenantId },
        );
        if (grounded.sources.length === 0) {
          throw new Error('OpenAI topic generation returned without grounding sources');
        }
        return { text: grounded.text, provider: 'openai', grounded: true };
      };
      const enforcementEnabled = isPaidAiCostControlsEnforcementEnabled();

      // Provider-hosted search has no exact injected-context token ceiling.
      // Under enforcement, background work must therefore use the validated
      // non-current prompt before any search network call. The ordinary model
      // call still performs its own all-in hard maximum check.
      if (enforcementEnabled && budgetContext.requestSource !== 'interactive') {
        const fallbackPrompt = boundedFallbackUserMessage;
        if (!fallbackPrompt) {
          throw new Error('BACKGROUND_GROUNDED_SEARCH_REQUIRES_EVERGREEN_FALLBACK');
        }
        logger.info(
          { category, requestSource: budgetContext.requestSource },
          'Background Content generation is using quality-safe evergreen context instead of unbounded provider search',
        );
        const generated = await completeOneShotWithFallback(
          boundedSystemPrompt,
          fallbackPrompt,
          category,
          () => completeWithAnthropic(fallbackPrompt, undefined),
          { model: CONTENT_TOPIC_MODEL, maxTokens, userId, tenantId },
        );
        return { ...generated, grounded: false };
      }

      // During enforcement, start interactive research with the provider-
      // capped one-call OpenAI route. Interactive usage retains the specified
      // 125% rolling-p95 reservation and records actual token + tool cost.
      if (enforcementEnabled && isOpenAIConfigured()) {
        try {
          return await completeWithOpenAiSearch();
        } catch (openAiError) {
          rethrowAiUsageFailClosedError(openAiError);
          logger.warn(
            { err: openAiError, category },
            'Bounded OpenAI topic search failed; trying Gemini grounding',
          );
        }
      }

      // A successful ordinary Gemini completion is not web-grounded. When
      // fresh tenant-scoped Discovery/Radar signals are absent, explicitly
      // invoke Gemini's Google Search tool.
      try {
        const grounded = await completeOneShotWithSearch(
          boundedSystemPrompt,
          boundedUserMessage,
          category,
          { maxTokens, userId, tenantId },
        );
        if (grounded.sources.length === 0) {
          throw new Error('Gemini topic generation returned without grounding sources');
        }
        return { text: grounded.text, provider: 'gemini', grounded: true };
      } catch (err) {
        // In observe-only mode Gemini remains primary. Keep the bounded OpenAI
        // route as the lower-cost provider fallback before Anthropic.
        if (!enforcementEnabled && isOpenAIConfigured()) {
          try {
            return await completeWithOpenAiSearch();
          } catch (openAiError) {
            rethrowAiUsageFailClosedError(openAiError);
            logger.warn(
              { err: openAiError, category },
              'Bounded OpenAI topic search failed; evaluating Anthropic fallback',
            );
          }
        }
        // Budget denials and usage-persistence failures are not provider
        // availability failures. Never spend on another provider after either.
        rethrowAiUsageFailClosedError(err);
        logger.warn({ err, category }, 'Grounded Gemini topic generation failed; using Anthropic web search');
        return { text: await completeWithAnthropic(), provider: 'anthropic', grounded: true };
      }
    }

    const generated = await completeOneShotWithFallback(
      boundedSystemPrompt,
      boundedUserMessage,
      category,
      completeWithAnthropic,
      { model: CONTENT_TOPIC_MODEL, maxTokens, userId, tenantId },
    );
    return { ...generated, grounded: false };
  });
}

function normalizeTopicCandidate(value: any): TopicCandidate {
  return {
    title: typeof value?.title === 'string' ? value.title.trim() : '',
    niche: typeof value?.niche === 'string' ? value.niche.trim() : '',
    whyNow: typeof value?.whyNow === 'string' ? value.whyNow.trim()
      : typeof value?.why_now === 'string' ? value.why_now.trim() : '',
    hookIdea: typeof value?.hookIdea === 'string' ? value.hookIdea.trim()
      : typeof value?.hook_idea === 'string' ? value.hook_idea.trim()
        : typeof value?.hook === 'string' ? value.hook.trim() : '',
    angleTag: typeof value?.angleTag === 'string' ? value.angleTag.trim()
      : typeof value?.angle_tag === 'string' ? value.angle_tag.trim() : undefined,
  };
}

function hasValidLiveTopicFields(value: any): boolean {
  const nonEmpty = (field: unknown): field is string => typeof field === 'string' && field.trim().length > 0;
  const angleTags = new Set([
    'opinion', 'reaction', 'how-to', 'story', 'myth-bust', 'comparison',
    'data', 'framework', 'listicle', 'trending-take', 'build-log', 'review',
  ]);
  return nonEmpty(value?.title)
    && nonEmpty(value?.niche)
    && nonEmpty(value?.whyNow)
    && nonEmpty(value?.hookIdea)
    && nonEmpty(value?.angle_tag)
    && angleTags.has(value.angle_tag)
    // An empty pillar emoji is explicitly valid when the creator has not
    // configured one; it must still be present and type-correct.
    && typeof value?.pillar_emoji === 'string'
    && nonEmpty(value?.time_sensitivity)
    && /^(?:evergreen|react-today|\d+d)$/.test(value.time_sensitivity);
}

async function deduplicateTopicCandidates(
  candidates: TopicCandidate[],
  userId: number,
  tenantId: number,
  acceptedSeed: readonly TopicCandidate[] = [],
  options: { allowDifferentAngles?: boolean } = {},
): Promise<TopicCandidate[]> {
  const deduped: TopicCandidate[] = [];
  const accepted: TopicCandidate[] = [...acceptedSeed];
  for (const candidate of candidates) {
    if (!candidate.title || !candidate.hookIdea || !candidate.whyNow) continue;
    const inBatchDuplicate = isDuplicateIdeaInBatch(
      candidate.title,
      candidate.angleTag,
      accepted,
      options,
    );
    if (inBatchDuplicate.isDuplicate && inBatchDuplicate.confidence > 0.8) {
      logger.info(
        { title: candidate.title, similarTo: inBatchDuplicate.similarTo },
        'Workflow topic skipped (same provider batch duplicate)',
      );
      continue;
    }
    try {
      const duplicate = await isDuplicateIdea(candidate.title, candidate.angleTag, userId, tenantId);
      if (duplicate.isDuplicate && duplicate.confidence > 0.8) {
        logger.info({ title: candidate.title, similarTo: duplicate.similarTo }, 'Workflow topic skipped (duplicate)');
        continue;
      }
    } catch { /* deterministic de-dup failure must not erase usable output */ }
    deduped.push(candidate);
    accepted.push(candidate);
  }
  return deduped;
}

function markPromotedDiscoveryIdeas(ideaIds: number[], generatedCount: number, userId: number): void {
  if (generatedCount === 0) return;
  for (const ideaId of ideaIds) {
    try {
      markIdeaPromoted(ideaId, userId);
    } catch (err) {
      logger.warn({ err, ideaId, userId }, 'Generated topic stored but Discovery promotion marker failed');
    }
  }
}

interface GeneratedTopicCandidateBatch {
  candidates: TopicCandidate[];
  promotedDiscoveryIdeaIds: number[];
}

async function generateTopicCandidateBatch(
  format: 'reel' | 'youtube',
  count: number,
  isTrending = true,
  userId: number = 0,
  tenantId: number = userId,
  budgetContext: ContentAiBudgetContext = { requestSource: 'interactive' },
): Promise<GeneratedTopicCandidateBatch> {
  const systemPrompt = buildTopicSystemPrompt(format, isTrending, userId, tenantId);
  const today = now();
  const enrichment = buildTopicEnrichment(userId, tenantId);

  // Identity-safety: the niche/pillar enum is no longer hardcoded in the
  // user-message prompt. The system prompt (prompts/topic-generation.md)
  // now instructs the model to draw the `niche` value from the
  // authenticated creator's saved pillars in the knowledge block. The
  // founder-shaped enum ("ai-tech, commentary, training, gaming,
  // wild-card") was removed in v4.14.126 closed-beta hardening; it
  // biased every authenticated user's topics into the founder's pillars
  // and made `pillar_emoji` carry founder-shaped emojis (🤖, 🎤, 🏋️,
  // 🎮, 🃏) regardless of who authenticated.
  const responseShape = `Respond with a JSON array. Each object must have: "title", "niche" (use one of the creator's saved pillars from the knowledge block above; if none exist yet, use "uncategorized"), "whyNow", "hookIdea", "angle_tag", "pillar_emoji" (the emoji the creator has saved for that pillar; empty string if none), "time_sensitivity".`;

  const userMessage = isTrending
    ? `Today is ${today.toFormat('cccc, LLLL dd, yyyy')}. Generate ${count} trending ${format} topic candidates for the authenticated creator/brand. Search for what's hot right now across the authorized pillars, references, taste profile, and knowledge block. Don't force quotas — follow what's genuinely interesting and timely.${enrichment.text}\n\n${responseShape}`
    : `Generate ${count} evergreen ${format} topic candidates for the authenticated creator/brand. Use authorized pillars, references, taste profile, and knowledge block. Follow genuine interest, not quotas.${enrichment.text}\n\n${responseShape}`;
  const ungroundedFallbackUserMessage = `Today is ${today.toFormat('cccc, LLLL dd, yyyy')}. Generate ${count} durable, high-quality ${format} topic candidates for the authenticated creator/brand without live web search. Use the authorized pillars, references, taste profile, and knowledge block. Do not claim that a topic is currently trending or cite a recent event unless that fact appears in the supplied context. Prefer evergreen or seasonally relevant audience needs and explain "whyNow" without inventing recency.${enrichment.text}\n\n${responseShape}`;

  // Fresh tenant signals make ordinary Gemini JSON generation sufficient and
  // avoid another paid search. Without them, `tools` selects the explicitly
  // grounded Gemini path with Anthropic web-search fallback.
  const tools = shouldAttachTrendingWebSearch(isTrending, enrichment.hasFreshSignals)
    ? [{ type: 'web_search_20250305' as any, name: 'web_search', max_uses: 5 } as any]
    : undefined;

  const { text: textContent, provider: usedProvider, grounded: usedGrounding } = await completeTopicGeneration(
    systemPrompt,
    userMessage,
    `content_workflow_${format}`,
    userId,
    tenantId,
    tools,
    budgetContext,
    {
      maxTokens: Math.min(3072, Math.max(1024, count * 220 + 512)),
      ungroundedFallbackUserMessage,
    },
  );

  if (isTrending && usedProvider === 'gemini') {
    logger.info(
      { format, groundedSearch: usedGrounding },
      usedGrounding
        ? 'Content workflow trending topic generated via grounded Gemini search'
        : 'Content workflow topic generated without another paid search',
    );
  }

  // Extract JSON array from response
  const jsonMatch = textContent.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn({
      format,
      responseChars: textContent.length,
    }, 'Could not find JSON array in topic response');
    return { candidates: [], promotedDiscoveryIdeaIds: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('Topic response root must be an array');
    const candidates = parsed.slice(0, count).map(normalizeTopicCandidate);
    const deduped = await deduplicateTopicCandidates(candidates, userId, tenantId);
    return {
      candidates: deduped,
      promotedDiscoveryIdeaIds: deduped.length > 0 ? enrichment.promotedDiscoveryIdeaIds : [],
    };
  } catch (err) {
    logger.error({ err, format }, 'Failed to parse topic candidates JSON');
    return { candidates: [], promotedDiscoveryIdeaIds: [] };
  }
}

/**
 * Generate candidates without consuming Discovery promotion markers. The
 * storage orchestrator owns that side effect so a provider result that is
 * merely previewed, empty after dedup, or fails to persist never consumes the
 * source idea. The public return shape remains the original candidate array.
 */
export async function generateTopicCandidates(
  format: 'reel' | 'youtube',
  count: number,
  isTrending = true,
  userId: number = 0,
  tenantId: number = userId,
  budgetContext: ContentAiBudgetContext = { requestSource: 'interactive' },
): Promise<TopicCandidate[]> {
  const generated = await generateTopicCandidateBatch(
    format,
    count,
    isTrending,
    userId,
    tenantId,
    budgetContext,
  );
  return generated.candidates;
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
  const voiceMemory = buildWorkflowVoiceMemory(userId);
  assertUsableReferencesForScriptGeneration(userId, format);

  const result = await getScript(
    topic.title,
    topic.niche || 'general',
    maxDuration,
    engineFormat,
    'standard',
    voiceMemory,
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
    'detailed',
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

function assertUsableReferencesForScriptGeneration(userId: number, format: 'reel' | 'youtube'): void {
  if (userId <= 0) return;
  const requiresSourcing = format === 'youtube' || format === 'reel';
  if (!requiresSourcing) return;
  const context = buildAuthorizedContentReferenceContext(userId, userId);
  const groundedReferences = context.references.filter((reference) => !reference.needsReview);
  if (groundedReferences.length > 0) return;
  const err = new Error(
    'CONTENT_GENERATION_REFUSED_NO_REFERENCES: Add at least one indexed, trusted Content reference before generating sourced scripts.',
  );
  (err as Error & { code?: string }).code = 'CONTENT_GENERATION_REFUSED_NO_REFERENCES';
  throw err;
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
  tenantId: number = userId,
  count: number = 5,
  budgetContext: ContentAiBudgetContext = { requestSource: 'interactive' },
): Promise<TopicCandidateResult> {
  const boundedCount = Math.max(0, Math.min(10, Math.floor(count)));
  const isTrending = sourceJob !== 'friday_weekly';
  const dayLabel = sourceJob === 'tuesday_reels' ? 'Terça-feira'
    : sourceJob === 'thursday_youtube' ? 'Quinta-feira'
    : 'Sexta-feira';

  const generated = boundedCount > 0
    ? await generateTopicCandidateBatch(format, boundedCount, isTrending, userId, tenantId, budgetContext)
    : { candidates: [], promotedDiscoveryIdeaIds: [] };
  const candidates = generated.candidates;
  let feedbackIds: number[] = [];
  if (candidates.length > 0) {
    getDb().transaction(() => {
      feedbackIds = storeTopicCandidates(candidates, format, sourceJob, userId, tenantId);
    })();
  }
  // Inserts throw on failure. Reaching this point proves every returned
  // candidate has durable feedback inventory before source ideas are marked.
  markPromotedDiscoveryIdeas(generated.promotedDiscoveryIdeaIds, feedbackIds.length, userId);

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
  tenantId: number = userId,
  requested: { youtube?: number; reels?: number } = {},
  budgetContext: ContentAiBudgetContext = { requestSource: 'interactive' },
): Promise<WeeklyPackageResult> {
  const youtubeCount = Math.max(0, Math.min(5, Math.floor(requested.youtube ?? 2)));
  const reelCount = Math.max(0, Math.min(10, Math.floor(requested.reels ?? 4)));
  if (youtubeCount === 0 && reelCount === 0) return { youtube: [], reels: [] };

  const systemPrompt = buildWeeklyPackageSystemPrompt(userId, tenantId);
  const enrichment = buildTopicEnrichment(userId, tenantId);
  const responseShape = `Return ONLY one valid JSON object with exactly two arrays: "youtube" and "reels". Every candidate must contain "title", "niche", "whyNow", "hookIdea", "angle_tag", "pillar_emoji", and "time_sensitivity". Return ${youtubeCount} YouTube candidates and ${reelCount} Reel candidates; use an empty array when a requested count is zero.`;
  const userMessage = `Generate the missing portion of the authenticated creator's evergreen weekly content package: ${youtubeCount} YouTube candidates and ${reelCount} Reel candidates. Use authorized pillars, references, taste profile, and knowledge. Do not repeat the same idea across formats.${enrichment.text}\n\n${responseShape}`;

  const { text } = await completeTopicGeneration(
    systemPrompt,
    userMessage,
    'content_workflow_weekly',
    userId,
    tenantId,
    undefined,
    budgetContext,
    { maxTokens: Math.min(2560, Math.max(1024, (youtubeCount + reelCount) * 220 + 512)) },
  );

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateJson = fenceMatch?.[1]?.trim() ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed: { youtube?: unknown; reels?: unknown };
  try {
    parsed = JSON.parse(candidateJson);
  } catch (err) {
    logger.error({ err, responseChars: text.length }, 'Failed to parse weekly content package JSON');
    return { youtube: [], reels: [] };
  }
  if (!Array.isArray(parsed.youtube) || !Array.isArray(parsed.reels)) {
    logger.warn({ responseChars: text.length }, 'Weekly content package did not contain both required arrays');
    return { youtube: [], reels: [] };
  }
  if (
    parsed.youtube.length !== youtubeCount
    || parsed.reels.length !== reelCount
    || !parsed.youtube.every(hasValidLiveTopicFields)
    || !parsed.reels.every(hasValidLiveTopicFields)
  ) {
    logger.warn(
      {
        expectedYoutube: youtubeCount,
        expectedReels: reelCount,
        actualYoutube: parsed.youtube.length,
        actualReels: parsed.reels.length,
      },
      'Weekly content package failed atomic live-contract validation; nothing persisted',
    );
    return { youtube: [], reels: [] };
  }

  const ytTopics = await deduplicateTopicCandidates(
    parsed.youtube.slice(0, youtubeCount).map(normalizeTopicCandidate),
    userId,
    tenantId,
    [],
    { allowDifferentAngles: false },
  );
  const reelTopics = await deduplicateTopicCandidates(
    parsed.reels.slice(0, reelCount).map(normalizeTopicCandidate),
    userId,
    tenantId,
    ytTopics,
    { allowDifferentAngles: false },
  );
  if (ytTopics.length !== youtubeCount || reelTopics.length !== reelCount) {
    logger.info(
      { youtubeCount, reelCount, dedupedYoutube: ytTopics.length, dedupedReels: reelTopics.length },
      'Weekly content package aborted atomically after deterministic duplicate filtering',
    );
    return { youtube: [], reels: [] };
  }
  let ytIds: number[] = [];
  let reelIds: number[] = [];
  getDb().transaction(() => {
    ytIds = ytTopics.length > 0
      ? storeTopicCandidates(ytTopics, 'youtube', 'friday_weekly', userId, tenantId)
      : [];
    reelIds = reelTopics.length > 0
      ? storeTopicCandidates(reelTopics, 'reel', 'friday_weekly', userId, tenantId)
      : [];
  })();
  markPromotedDiscoveryIdeas(
    enrichment.promotedDiscoveryIdeaIds,
    ytTopics.length + reelTopics.length,
    userId,
  );

  return {
    youtube: ytTopics.map((c, i) => ({ ...c, feedbackId: ytIds[i] ?? 0 })),
    reels: reelTopics.map((c, i) => ({ ...c, feedbackId: reelIds[i] ?? 0 })),
  };
}

// ─── Telegram adapters REMOVED ─────────────────────────────────────
//
// The legacy sendTopicCandidates() / sendWeeklyPackage() Telegram delivery
// adapters were deleted with the Telegram legacy delivery path (2026-07).
// Callers use:
//   1. generateAndStoreTopicCandidates() / generateWeeklyPackage()
//      (transport-agnostic orchestrators above)
//   2. createNotificationIntent() from notification-orchestrator.ts
//      (durable inbox + APNs delivery; the legacy content-notification-store
//      bridge was retired 2026-07-04)
