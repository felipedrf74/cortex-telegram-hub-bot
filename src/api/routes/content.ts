// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { buildQuotaExceededMessage, isUserOverDailyCap } from '../../services/cost-guardrail';

// ── Generation Mode + Metadata ────────────────────────────────────
//
// Auto-selected by endpoint intent, not by client. Consistent metadata
// object attached to all content-generation responses.
//
// Modes:
//   quick    — cache-first, no deep research, cheapest path (~$0.003)
//   standard — balanced: research + signals + Claude ($0.01)
//   deep     — extra research passes, longer timeout (~$0.02)
//
// The mode is chosen by the endpoint based on operation type.
// iOS does NOT send a mode — the backend selects automatically.

type GenerationMode = 'quick' | 'standard' | 'deep';

interface GenerationMetadata {
  mode: GenerationMode;
  cacheHit: boolean;
  provider?: string;
  durationMs?: number;
  researchUsed?: boolean;
}

/**
 * Build a generation metadata object from timing and mode info.
 * Attaches as `generation` field in the response — consistent across
 * all content-generation endpoints.
 */
function buildGenerationMeta(opts: {
  mode: GenerationMode;
  startMs: number;
  cacheHit?: boolean;
  provider?: string;
  researchUsed?: boolean;
}): GenerationMetadata {
  return {
    mode: opts.mode,
    cacheHit: opts.cacheHit ?? false,
    provider: opts.provider,
    durationMs: Date.now() - opts.startMs,
    researchUsed: opts.researchUsed ?? (opts.mode !== 'quick'),
  };
}
import {
  addTopic,
  getFilmingRecommendation,
  getTopics,
  getUpcomingTopicCount,
  updateTopic,
  deleteTopic,
  CONTENT_TOPIC_STATUSES,
  type ContentTopicStatus,
} from '../../services/content-scheduler';
import { getJobStatuses } from '../../portal/telemetry';
import { getKnowledgeStats, getVoiceDna } from '../../services/content-dashboard-service';
import { readSignals, type AgentSignal } from '../../services/intelligence-bus';
import { getUserLanguage } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';

export function contentRoutes(): Router {
  const router = Router();

  /** GET /api/v1/content/pipeline */
  router.get('/pipeline', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      const db = require('../../services/database').getDb();

      // Per-user content pipeline — each user only sees their own ideas
      const ideas = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'ideas' AND user_id = ? ORDER BY score DESC",
      ).all(userId) as any[];

      const scripted = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'scripted' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as any[];

      const filmed = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'filmed' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as any[];

      const editing = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'editing' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as any[];

      const published = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'published' AND user_id = ? ORDER BY created_at DESC LIMIT 10",
      ).all(userId) as any[];

      const formatIdea = (row: any) => ({
        id: row.id?.toString(), title: row.title,
        score: row.score || null, createdAt: row.created_at || null,
      });

      sendSuccess(res, {
        stages: {
          ideas: ideas.map(formatIdea),
          scripted: scripted.map(formatIdea),
          filmed: filmed.map(formatIdea),
          editing: editing.map(formatIdea),
          published: published.map(formatIdea),
        },
        stats: {
          totalIdeas: ideas.length + scripted.length + filmed.length + editing.length,
          publishedThisMonth: published.filter((p: any) => {
            const d = new Date(p.created_at);
            const now = new Date();
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
          }).length,
        },
      });
    } catch (err: any) {
      // Table may not exist — soft-fail with empty pipeline
      logger.debug({ err }, 'Content pipeline query failed (table may not exist)');
      sendSuccess(res, {
        stages: { ideas: [], scripted: [], filmed: [], editing: [], published: [] },
        stats: { totalIdeas: 0, publishedThisMonth: 0 },
      });
    }
  });

  /** GET /api/v1/content/ideas — list all content ideas */
  router.get('/ideas', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      const db = require('../../services/database').getDb();
      const ideas = db.prepare(
        'SELECT id, title, score, created_at, stage FROM content_ideas WHERE user_id = ? ORDER BY score DESC, created_at DESC',
      ).all(userId) as any[];

      sendSuccess(res, {
        ideas: ideas.map((row: any) => ({
          id: row.id?.toString(), title: row.title,
          score: row.score || null, createdAt: row.created_at || null,
          stage: row.stage || 'ideas',
        })),
      });
    } catch (err: any) {
      logger.debug({ err }, 'Content ideas query failed');
      sendSuccess(res, { ideas: [] });
    }
  });

  /** POST /api/v1/content/discover — trigger content discovery */
  router.post('/discover', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const startMs = Date.now();
    try {
      const { runContentDiscovery } = require('../../services/content-discovery');
      const result = await runContentDiscovery(userId);
      sendSuccess(res, {
        discovered: result?.count || 0,
        ideas: result?.ideas || [],
        message: `Discovered ${result?.count || 0} new content ideas.`,
        generation: buildGenerationMeta({
          mode: 'standard',
          startMs,
          provider: 'gemini-flash',
          researchUsed: true,
        }),
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/discover failed');
      sendError(res, 'DISCOVERY_UNAVAILABLE', err?.message || 'Content discovery not available.', 503);
    }
  });

  /** GET /api/v1/content/intelligence — backstage agent summary for iOS */
  router.get('/intelligence', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const language = getUserLanguage(userId);
    const jobs = new Map(getJobStatuses().map((job) => [job.name, job]));
    const reactionJob = jobs.get('reaction_radar');
    const performanceJob = jobs.get('performance_agent');
    const autoresearchJob = jobs.get('autoresearch');

    const discoverySignals = readSignals(
      'ios-content-intelligence',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      25,
      userId,
      7
    );
    const optimizationSignals = readSignals(
      'ios-content-intelligence',
      ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'content_formula'],
      25,
      userId,
      14
    );

    const voiceEntries = getVoiceDna(undefined, userId);
    const knowledgeStats = getKnowledgeStats(undefined, userId);
    const latestVoiceUpdate = voiceEntries
      .map((entry) => entry.updatedAt)
      .sort((a, b) => b.localeCompare(a))[0] ?? null;
    const sourceCount = new Set(
      voiceEntries.flatMap((entry) => entry.sources).filter((source) => source && source.trim().length > 0)
    ).size;

    sendSuccess(res, {
      discovery: {
        status: summarizeContentJobStatus(reactionJob?.lastResult, discoverySignals.length),
        cadenceHours: 4,
        activeCount: discoverySignals.length,
        lastRunAt: reactionJob?.lastRunAt ?? null,
        lastStatus: reactionJob?.lastResult ?? 'never',
      },
      script: {
        status: voiceEntries.length > 0 ? 'ready' : knowledgeStats.referenceChannels > 0 ? 'warming_up' : 'needs_setup',
        voicePatternCount: voiceEntries.length,
        referenceChannelCount: knowledgeStats.referenceChannels,
        sourceCount,
        hasBrandVoice: voiceEntries.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary'),
        lastUpdatedAt: latestVoiceUpdate,
      },
      optimization: {
        status: summarizeOptimizationStatus(performanceJob?.lastResult, autoresearchJob?.lastResult, optimizationSignals.length),
        cadence: 'weekly',
        activeInsightCount: optimizationSignals.length,
        performanceLastRunAt: performanceJob?.lastRunAt ?? null,
        performanceLastStatus: performanceJob?.lastResult ?? 'never',
        autoresearchLastRunAt: autoresearchJob?.lastRunAt ?? null,
        autoresearchLastStatus: autoresearchJob?.lastResult ?? 'never',
      },
      schedule: {
        status: 'ready',
      },
      localized: language.startsWith('pt')
        ? {
            discoveryLabel: 'Discovery',
            scriptLabel: 'Script',
            scheduleLabel: 'Schedule',
            optimizationLabel: 'Optimization',
          }
        : null,
    });
  }));

  /** GET /api/v1/content/intelligence/detail — deeper backstage view for iOS */
  router.get('/intelligence/detail', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const language = getUserLanguage(userId);
    const jobs = new Map(getJobStatuses().map((job) => [job.name, job]));
    const reactionJob = jobs.get('reaction_radar');
    const performanceJob = jobs.get('performance_agent');
    const autoresearchJob = jobs.get('autoresearch');

    const discoverySignals = readSignals(
      'ios-content-intelligence-detail',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      6,
      userId,
      7
    );
    const optimizationSignals = readSignals(
      'ios-content-intelligence-detail',
      ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'content_formula'],
      6,
      userId,
      14
    );

    const voiceEntries = getVoiceDna(undefined, userId);
    const knowledgeStats = getKnowledgeStats(undefined, userId);
    const latestVoiceUpdate = voiceEntries
      .map((entry) => entry.updatedAt)
      .sort((a, b) => b.localeCompare(a))[0] ?? null;
    const sourceCount = new Set(
      voiceEntries.flatMap((entry) => entry.sources).filter((source) => source && source.trim().length > 0)
    ).size;
    const filmingRecommendation = localizeFilmingRecommendation(await getFilmingRecommendation(userId), language);

    sendSuccess(res, {
      discovery: {
        status: summarizeContentJobStatus(reactionJob?.lastResult, discoverySignals.length),
        cadenceHours: 4,
        activeCount: discoverySignals.length,
        lastRunAt: reactionJob?.lastRunAt ?? null,
        lastStatus: reactionJob?.lastResult ?? 'never',
        recentSignals: discoverySignals.map((signal) => formatSignalDigest(signal, language)),
      },
      script: {
        status: voiceEntries.length > 0 ? 'ready' : knowledgeStats.referenceChannels > 0 ? 'warming_up' : 'needs_setup',
        voicePatternCount: voiceEntries.length,
        referenceChannelCount: knowledgeStats.referenceChannels,
        sourceCount,
        hasBrandVoice: voiceEntries.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary'),
        lastUpdatedAt: latestVoiceUpdate,
        entries: voiceEntries.slice(0, 6).map((entry) => ({
          category: entry.category,
          label: localizeVoiceEntryLabel(entry.label, language),
          excerpt: truncateText(entry.text, 200),
          sourceCount: entry.sources.length,
          sources: entry.sources,
          version: entry.version,
          updatedAt: entry.updatedAt,
        })),
        knowledgeCategories: knowledgeStats.categories.map((entry) => ({
          category: entry.category,
          label: localizeKnowledgeCategoryLabel(entry.category, voiceEntries, language),
          sourceCount: entry.sources,
          updatedAt: entry.updatedAt,
        })),
      },
      schedule: {
        status: filmingRecommendation ? 'ready' : 'warming_up',
        filmingRecommendation,
      },
      optimization: {
        status: summarizeOptimizationStatus(performanceJob?.lastResult, autoresearchJob?.lastResult, optimizationSignals.length),
        cadence: 'weekly',
        activeInsightCount: optimizationSignals.length,
        performanceLastRunAt: performanceJob?.lastRunAt ?? null,
        performanceLastStatus: performanceJob?.lastResult ?? 'never',
        autoresearchLastRunAt: autoresearchJob?.lastRunAt ?? null,
        autoresearchLastStatus: autoresearchJob?.lastResult ?? 'never',
        recentSignals: optimizationSignals.map((signal) => formatSignalDigest(signal, language)),
      },
    });
  }));

  /**
   * POST /api/v1/content/script — generate a structured script
   *
   * Uses the canonical script pipeline: content-engine Python backend
   * with deep research → Claude Sonnet → structured ScriptResponse.
   *
   * Body: {
   *   topic: string (required),
   *   niche?: string (default "general"),
   *   format?: "YouTube" | "Reel" (default "YouTube"),
   *   maxDurationMinutes?: number (default 8, range 1-30)
   * }
   *
   * Returns structured script data — iOS renders natively.
   *
   * NOTE: AI-using endpoint — script generation is a CONTENT GENERATION
   * operation, not a data lookup, so token cost is justified.
   */
  router.post('/script', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { topic, niche, format, maxDurationMinutes, mode, language, renderMode } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      sendError(res, 'VALIDATION', 'topic is required', 400);
      return;
    }

    // Mode: client can request quick/standard/deep. Default: standard.
    // Quick = cache-first, no signals, fast. Deep = skip cache, broader signal window.
    const validModes = ['quick', 'standard', 'deep'];
    const genMode: GenerationMode = (mode && validModes.includes(mode)) ? mode : 'standard';
    const validRenderModes = ['structured', 'chat'];
    const targetRenderMode = (typeof renderMode === 'string' && validRenderModes.includes(renderMode.trim().toLowerCase()))
      ? renderMode.trim().toLowerCase()
      : 'structured';
    const startMs = Date.now();

    const quota = isUserOverDailyCap(userId);
    if (quota.over) {
      sendError(
        res,
        'QUOTA_EXCEEDED',
        buildQuotaExceededMessage(quota),
        402,
        { plan: quota.plan, resetAt: quota.resetAt },
      );
      return;
    }

    try {
      // CONT-M4: load user's brand voice from content_knowledge table
      // and pass it to the script engine so the generated script
      // reflects the user's tone, style, and vocabulary preferences.
      let brandVoice: string | null = null;
      try {
        const db = require('../../services/database').getDb();
        const row = db.prepare(
          `SELECT synthesized_text FROM content_knowledge
           WHERE category = 'brand_voice' AND user_id IN (0, ?)
           ORDER BY user_id DESC LIMIT 1`
        ).get(userId);
        brandVoice = row?.synthesized_text || null;
      } catch { /* non-critical — generate without voice if DB fails */ }

      let targetLanguage = 'pt-BR';
      try {
        const { getUserLanguage } = require('../../services/user-service');
        targetLanguage = typeof language === 'string' && language.trim().length > 0
          ? language.trim()
          : (getUserLanguage?.(userId) || 'pt-BR');
      } catch {
        if (typeof language === 'string' && language.trim().length > 0) {
          targetLanguage = language.trim();
        }
      }

      const { getScript } = require('../../services/content-engine');
      const result = await getScript(
        topic.trim(),
        niche || 'general',
        maxDurationMinutes || (format === 'Reel' ? 1 : 8),
        format || 'YouTube',
        genMode,
        brandVoice,
        targetLanguage,
        targetRenderMode,
      );
      const elapsedMs = Date.now() - startMs;
      const cacheHit = elapsedMs < 500;

      sendSuccess(res, {
        topic: result.topic,
        script: result.script,
        hook: result.hook,
        titleOptions: result.title_options,
        // CONT-M1: defensive null check — Python may omit or null sources_used
        sourcesUsed: (result.sources_used || []).map((s: any) => ({
          title: s.title,
          url: s.url,
          sourceType: s.source_type,
          relevanceNote: s.relevance_note,
        })),
        estimatedDuration: result.estimated_duration,
        format: format || 'YouTube',
        renderMode: targetRenderMode,
        durationMs: result.duration_ms,
        // Creator-pack fields
        hashtags: result.hashtags ?? [],
        caption: result.caption ?? '',
        cta: result.cta ?? '',
        degraded: result.degraded ?? false,
        warnings: result.warnings ?? [],
        // Consistent generation metadata (same shape across all endpoints)
        generation: buildGenerationMeta({
          mode: genMode,
          startMs,
          cacheHit,
          provider: 'content-engine',
          researchUsed: !cacheHit,
        }),
        // Backward compat — keep old fields until iOS migrates
        generationMode: genMode,
        cacheHit,
        usageImpact: cacheHit ? 'none' : genMode === 'deep' ? 'high' : genMode,
      });
    } catch (err: any) {
      logger.error({ err, topic }, 'iOS content/script failed');
      sendError(res, 'INTERNAL', err?.message || 'Script generation failed', 500);
    }
  });

  /** POST /api/v1/content/pipeline/:id/advance — move idea to next stage */
  router.post('/pipeline/:id/advance', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    try {
      const db = require('../../services/database').getDb();
      const stageOrder = ['ideas', 'scripted', 'filmed', 'editing', 'published'];

      // Ownership check: only advance your own ideas
      const idea = db.prepare('SELECT stage, user_id FROM content_ideas WHERE id = ?').get(id) as { stage: string; user_id: number } | undefined;
      if (!idea) {
        sendError(res, 'NOT_FOUND', 'Idea not found', 404);
        return;
      }
      if (idea.user_id !== 0 && idea.user_id !== userId) {
        sendError(res, 'FORBIDDEN', 'Not your idea', 403);
        return;
      }

      const currentIdx = stageOrder.indexOf(idea.stage);
      if (currentIdx === -1 || currentIdx >= stageOrder.length - 1) {
        sendSuccess(res, { advanced: false, message: 'Already at final stage.' });
        return;
      }

      const nextStage = stageOrder[currentIdx + 1];
      // Strict ownership: only update rows the user owns. Legacy user_id=0
      // rows are readable but not mutable — they're system seed data.
      db.prepare('UPDATE content_ideas SET stage = ? WHERE id = ? AND user_id = ?').run(nextStage, id, userId);

      sendSuccess(res, { advanced: true, newStage: nextStage });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/advance failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to advance pipeline stage', 500);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Topic scheduler (TASK-14 Phase 2)
  //
  // User-created topics with optional publish dates. Distinct from
  // the AI-generated topic candidates that content-workflow.ts manages
  // — these are the user's OWN planned topics for the iOS Content
  // skill's Topic scheduler card.
  //
  // Routes are all scoped to req.userId via AuthenticatedRequest so
  // one user can never read/write another user's topics.
  // ────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/content/topics?status=&from=&to=&scheduledOnly=&limit=
   *
   * Returns the user's topics sorted with scheduled topics first
   * (by date ASC), unscheduled last (by updated_at DESC). Cancelled
   * topics are hidden unless the caller passes ?status=cancelled.
   */
  router.get('/topics', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;

    const status = typeof req.query.status === 'string'
      ? (req.query.status as ContentTopicStatus)
      : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const scheduledOnly = req.query.scheduledOnly === 'true';
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 100, 500)
      : 100;

    if (status && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }

    try {
      const topics = getTopics(userId, {
        status,
        from,
        to,
        scheduledOnly,
        includeTerminal: status === 'cancelled' || status === 'published',
        limit,
      });

      // Precompute the upcoming count so the iOS landing page card
      // can render a "N this week" subtitle without a second request.
      const [upcomingCount, filmingRecommendation] = await Promise.all([
        Promise.resolve(getUpcomingTopicCount(userId, 14)),
        getFilmingRecommendation(userId, topics),
      ]);
      const language = getUserLanguage(userId);

      sendSuccess(res, {
        topics,
        count: topics.length,
        upcomingCount,
        filmingRecommendation: localizeFilmingRecommendation(filmingRecommendation, language),
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS content topics list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch topics', 500);
    }
  }));

  /**
   * POST /api/v1/content/topics
   * Body: { title, notes?, scheduledDate?, status? }
   *
   * Creates a new topic. `scheduledDate` is nullable — unscheduled
   * topics go in the "later" bucket in the iOS UI. `status` defaults
   * to 'planned' server-side.
   */
  router.post('/topics', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { title, notes, scheduledDate, status } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      sendError(res, 'BAD_REQUEST', 'title is required and must be non-empty');
      return;
    }
    if (status !== undefined && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }
    if (scheduledDate !== undefined && scheduledDate !== null) {
      // Light validation — expect YYYY-MM-DD.
      if (typeof scheduledDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
        sendError(res, 'BAD_REQUEST', 'scheduledDate must be YYYY-MM-DD or null');
        return;
      }
    }

    try {
      const topic = addTopic(userId, title.trim(), {
        notes: notes ?? null,
        scheduledDate: scheduledDate ?? null,
        status: status ?? 'planned',
      });
      sendSuccess(res, { topic }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS content topic create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to create topic', 500);
    }
  }));

  /**
   * PATCH /api/v1/content/topics/:id
   * Body: { title?, notes?, scheduledDate?, status? }
   *
   * Partial update — only the fields present in the body are modified.
   * `scheduledDate` and `notes` accept explicit null to clear.
   */
  router.patch('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseInt(req.params.id, 10);
    const { title, notes, scheduledDate, status } = req.body;

    if (Number.isNaN(topicId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    if (title === undefined && notes === undefined && scheduledDate === undefined && status === undefined) {
      sendError(res, 'BAD_REQUEST', 'At least one of title, notes, scheduledDate, or status must be provided');
      return;
    }

    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      sendError(res, 'BAD_REQUEST', 'title must be a non-empty string when provided');
      return;
    }
    if (status !== undefined && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }
    if (scheduledDate !== undefined && scheduledDate !== null) {
      if (typeof scheduledDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
        sendError(res, 'BAD_REQUEST', 'scheduledDate must be YYYY-MM-DD or null');
        return;
      }
    }

    try {
      const updated = updateTopic(userId, topicId, {
        title: title !== undefined ? title.trim() : undefined,
        notes: notes !== undefined ? (notes === null ? null : String(notes)) : undefined,
        scheduled_date: scheduledDate !== undefined ? scheduledDate : undefined,
        status,
      });
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { topic: updated });
    } catch (err: any) {
      logger.error({ err, userId, topicId }, 'iOS content topic update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update topic', 500);
    }
  }));

  /**
   * DELETE /api/v1/content/topics/:id
   * Hard-delete. UIs that want to preserve history can PATCH
   * status='cancelled' instead.
   */
  router.delete('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseInt(req.params.id, 10);

    if (Number.isNaN(topicId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const deleted = deleteTopic(userId, topicId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { deleted: true, id: topicId });
    } catch (err: any) {
      logger.error({ err, userId, topicId }, 'iOS content topic delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete topic', 500);
    }
  }));

  // ═══════════════════════════════════════════════════════════════════
  // BOOKS — per-user book library (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/books — user's book library (own + global) */
  router.get('/books', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const db = require('../../services/database').getDb();
    const books = db.prepare(
      'SELECT id, title, author, core_thesis, extraction_status, personal_notes FROM book_library WHERE user_id IN (0, ?) ORDER BY title ASC'
    ).all(userId);
    sendSuccess(res, { books });
  }));

  /** POST /api/v1/content/books — add a book to user's library */
  router.post('/books', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { title, author } = req.body;
    if (!title || !author) { sendError(res, 'VALIDATION', 'title and author required', 400); return; }
    const db = require('../../services/database').getDb();
    const result = db.prepare(
      'INSERT OR IGNORE INTO book_library (title, author, extraction_status, user_id) VALUES (?, ?, ?, ?)'
    ).run(title.trim(), author.trim(), 'pending', userId);
    sendSuccess(res, { id: result.lastInsertRowid, title: title.trim() }, { status: 201 });
  }));

  /** DELETE /api/v1/content/books/:id */
  router.delete('/books/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const id = parseInt(String(req.params.id), 10);
    const db = require('../../services/database').getDb();
    // Users can only delete their own books (not global ones)
    const info = db.prepare('DELETE FROM book_library WHERE id = ? AND user_id = ?').run(id, userId);
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Book not found or not owned by you', 404); return; }
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CHANNELS — per-user YouTube reference channels (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/channels — user's channels (own + global) */
  router.get('/channels', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { getAllChannels } = require('../../state/content-references');
    const channels = getAllChannels(userId);
    sendSuccess(res, { channels });
  }));

  /** POST /api/v1/content/channels — add a channel */
  router.post('/channels', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { url } = req.body;
    if (!url) { sendError(res, 'VALIDATION', 'url required', 400); return; }
    const { addChannel } = require('../../state/content-references');
    const channel = addChannel(url.trim(), 'ios', userId);
    sendSuccess(res, { channel: { id: channel.id, url: channel.channel_url, name: channel.channel_name } }, { status: 201 });
  }));

  /** DELETE /api/v1/content/channels/:id */
  router.delete('/channels/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const id = parseInt(String(req.params.id), 10);
    const db = require('../../services/database').getDb();
    const info = db.prepare('DELETE FROM content_ref_channels WHERE id = ? AND user_id = ?').run(id, userId);
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Channel not found or not owned by you', 404); return; }
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // VOICE DNA — per-user brand voice (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/voice-dna — user's voice DNA entries */
  router.get('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const db = require('../../services/database').getDb();
    const entries = db.prepare(
      `SELECT
         id,
         category,
         category as label,
         synthesized_text as payload,
         source_channels,
         version,
         updated_at
       FROM content_knowledge
       WHERE user_id IN (0, ?)
       ORDER BY user_id DESC, category ASC`
    ).all(userId);
    sendSuccess(res, { entries });
  }));

  /** POST /api/v1/content/voice-dna — upsert a voice DNA entry */
  router.post('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { category, payload } = req.body;
    if (!category || !payload) { sendError(res, 'VALIDATION', 'category and payload required', 400); return; }
    const db = require('../../services/database').getDb();
    const normalizedPayload = typeof payload === 'string' ? payload.trim() : JSON.stringify(payload);
    if (!normalizedPayload) {
      sendError(res, 'VALIDATION', 'payload must be non-empty', 400);
      return;
    }
    db.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, version)
      VALUES (?, ?, '[]', ?, 1)
      ON CONFLICT(user_id, category) DO UPDATE SET
        synthesized_text = excluded.synthesized_text,
        updated_at = datetime('now'),
        version = content_knowledge.version + 1
    `).run(category, normalizedPayload, userId);
    sendSuccess(res, { upserted: true });
  }));

  // ════════════════════════════════════════════════════════════════════
  // Transport-agnostic content orchestrators (iOS-first)
  //
  // These return structured JSON (TopicCandidateResult, WeeklyPackageResult)
  // that the iOS app renders natively. They call the same service-layer
  // functions the scheduler and Telegram handlers use, but never produce
  // Telegram HTML or InlineKeyboard markup.
  //
  // This is the canonical iOS content workflow:
  //   1. POST /topics/generate → structured topic candidates with feedbackIds
  //   2. POST /topics/:feedbackId/feedback → approve/skip/reject
  //   3. POST /weekly-package → weekly content bundle
  //   4. GET  /topics/pending → pending topics awaiting feedback
  // ════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/content/topics/generate
   *
   * Generate topic candidates and store them in the DB.
   * Returns structured data the iOS app renders as native approval cards.
   *
   * Body: { format: "reel" | "youtube", sourceJob?: string }
   */
  router.post('/topics/generate', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { format = 'reel', sourceJob = 'manual' } = req.body;

    if (!['reel', 'youtube'].includes(format)) {
      sendError(res, 'VALIDATION', 'format must be "reel" or "youtube"', 400);
      return;
    }

    const startMs = Date.now();
    const { generateAndStoreTopicCandidates } = require('../../services/content-workflow');
    const result = await generateAndStoreTopicCandidates(userId, format, sourceJob);

    // CONT-M2: defensive null checks — result or candidates may be null
    const candidates = result?.candidates || [];
    sendSuccess(res, {
      format: result?.format || format,
      sourceJob: result?.sourceJob || sourceJob,
      dayLabel: result?.dayLabel || null,
      count: candidates.length,
      candidates: candidates.map((c: any) => ({
        feedbackId: c.feedbackId,
        title: c.title,
        niche: c.niche,
        hookIdea: c.hookIdea,
        whyNow: c.whyNow,
        angleTag: c.angleTag || null,
      })),
      generation: buildGenerationMeta({
        mode: 'standard',
        startMs,
        provider: 'gemini-flash',
        researchUsed: false,
      }),
    });
  }));

  /**
   * POST /api/v1/content/topics/:feedbackId/feedback
   *
   * Record approval/skip/reject for a topic candidate.
   * Body: { sentiment: "approved" | "skipped" | "rejected" }
   */
  router.post('/topics/:feedbackId/feedback', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { feedbackId } = req.params;
    const { sentiment } = req.body;

    const validSentiments = ['approved', 'skipped', 'rejected'];
    if (!sentiment || !validSentiments.includes(sentiment)) {
      sendError(res, 'VALIDATION', `sentiment must be one of: ${validSentiments.join(', ')}`, 400);
      return;
    }

    const { updateFeedback, getTopicById } = require('../../services/content-workflow');
    const id = parseInt(feedbackId, 10);

    // Ownership check — verify the topic belongs to this user
    const db = require('../../services/database').getDb();
    const topicRow = db.prepare(
      'SELECT id, topic, user_id FROM content_topic_feedback WHERE id = ?'
    ).get(id) as { id: number; topic: string; user_id: number } | undefined;

    if (!topicRow) {
      sendError(res, 'NOT_FOUND', 'Topic not found', 404);
      return;
    }
    if (topicRow.user_id !== 0 && topicRow.user_id !== userId) {
      sendError(res, 'FORBIDDEN', 'Not your topic', 403);
      return;
    }

    updateFeedback(id, sentiment);
    sendSuccess(res, { feedbackId: id, sentiment, title: topicRow.topic });
  }));

  /**
   * GET /api/v1/content/topics/pending
   *
   * List pending topic candidates awaiting user feedback.
   */
  router.get('/topics/pending', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const db = require('../../services/database').getDb();

    const rows = db.prepare(`
      SELECT id, topic, niche, format, hook_idea, why_now, angle_tag, source_job, created_at
      FROM content_topic_feedback
      WHERE sentiment = 'pending' AND user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(userId) as any[];

    sendSuccess(res, {
      count: rows.length,
      topics: rows.map((r: any) => ({
        feedbackId: r.id,
        title: r.topic,
        niche: r.niche,
        format: r.format,
        hookIdea: r.hook_idea,
        whyNow: r.why_now,
        angleTag: r.angle_tag,
        sourceJob: r.source_job,
        createdAt: r.created_at,
      })),
    });
  }));

  /**
   * POST /api/v1/content/weekly-package
   *
   * Generate the full weekly content package (2 YT + 4 reels).
   * Returns structured data — iOS renders as a grouped approval UI.
   */
  router.post('/weekly-package', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const startMs = Date.now();

    const { generateWeeklyPackage } = require('../../services/content-workflow');
    const result = await generateWeeklyPackage(userId);

    const mapCandidate = (c: any) => ({
      feedbackId: c.feedbackId,
      title: c.title,
      niche: c.niche,
      hookIdea: c.hookIdea,
      whyNow: c.whyNow,
      angleTag: c.angleTag || null,
    });

    sendSuccess(res, {
      youtube: {
        count: result.youtube.length,
        candidates: result.youtube.map(mapCandidate),
      },
      reels: {
        count: result.reels.length,
        candidates: result.reels.map(mapCandidate),
      },
      generation: buildGenerationMeta({
        mode: 'standard',
        startMs,
        provider: 'gemini-flash',
        researchUsed: false,
      }),
    });
  }));

  /**
   * GET /api/v1/content/taste-profile
   *
   * Returns the user's content taste profile built from feedback history.
   * The iOS app uses this for the "Your Content DNA" card in the Content tab.
   */
  router.get('/taste-profile', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const db = require('../../services/database').getDb();

    const rows = db.prepare(`
      SELECT topic, niche, sentiment, created_at
      FROM content_topic_feedback
      WHERE sentiment IN ('approved', 'rejected')
        AND created_at > datetime('now', '-60 days')
        AND user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(userId) as { topic: string; niche: string; sentiment: string; created_at: string }[];

    const approved = rows.filter(r => r.sentiment === 'approved');
    const rejected = rows.filter(r => r.sentiment === 'rejected');

    // Niche breakdown
    const nicheMap: Record<string, { approved: number; rejected: number }> = {};
    for (const r of rows) {
      const n = r.niche || 'general';
      if (!nicheMap[n]) nicheMap[n] = { approved: 0, rejected: 0 };
      nicheMap[n][r.sentiment as 'approved' | 'rejected']++;
    }

    sendSuccess(res, {
      totalFeedback: rows.length,
      approved: approved.length,
      rejected: rejected.length,
      approvalRate: rows.length > 0 ? Math.round((approved.length / rows.length) * 100) : 0,
      nicheBreakdown: nicheMap,
      recentApproved: approved.slice(0, 5).map(r => ({ title: r.topic, niche: r.niche })),
      recentRejected: rejected.slice(0, 5).map(r => ({ title: r.topic, niche: r.niche })),
    });
  }));

  // ════════════════════════════════════════════════════════════════════
  // Content Learning Store — DB-backed learning data (iOS + portal)
  //
  // These endpoints expose the canonical learning model:
  //   - Performance feedback for published videos
  //   - Learned voice/content patterns (durable, survive signal expiry)
  //   - Full artifact chain tracing (idea → script → publish → feedback)
  // ════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/content/performance
   *
   * Log performance feedback for a published video.
   * Replaces the Python content-engine feedback.json file.
   *
   * Body: { pipelineId?, videoUrl?, views, retentionPct, likes?,
   *         comments?, subsGained?, hookUsed?, notes? }
   */
  router.post('/performance', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { pipelineId, videoUrl, views, retentionPct, likes, comments, subsGained, hookUsed, notes } = req.body;

    if (views === undefined || retentionPct === undefined) {
      sendError(res, 'VALIDATION', 'views and retentionPct are required', 400);
      return;
    }

    const { logPerformanceFeedback } = require('../../services/content-learning-store');
    const id = logPerformanceFeedback({
      pipelineId, videoUrl, views, retentionPct,
      likes, comments, subsGained, hookUsed, notes,
      userId,
    });

    sendSuccess(res, { feedbackId: id });
  }));

  /**
   * GET /api/v1/content/performance
   *
   * Get performance summary for the authenticated user.
   * Query: ?days=30 (default 30)
   */
  router.get('/performance', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const days = parseInt(String(req.query.days || '30'), 10);

    const { getPerformanceSummary } = require('../../services/content-learning-store');
    const summary = getPerformanceSummary(userId, days);

    sendSuccess(res, summary);
  }));

  /**
   * GET /api/v1/content/learned-patterns
   *
   * Get durable learned voice/content patterns.
   * Query: ?category=voice_addition (optional filter)
   */
  router.get('/learned-patterns', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const category = req.query.category as string | undefined;

    const { getLearnedPatterns } = require('../../services/content-learning-store');
    const patterns = getLearnedPatterns(userId, category);

    sendSuccess(res, {
      count: patterns.length,
      patterns: patterns.map((p: any) => ({
        id: p.id,
        category: p.category,
        pattern: p.patternText,
        examples: p.examples,
        confidence: p.confidence,
        frequency: p.frequency,
        sourceAgent: p.sourceAgent,
        firstDetected: p.firstDetectedAt,
        lastSeen: p.lastSeenAt,
      })),
    });
  }));

  /**
   * GET /api/v1/content/artifact-chain/:pipelineId
   *
   * Trace the full artifact chain for a pipeline entry:
   * idea → topic feedback → pipeline → script → performance → patterns
   *
   * Ownership-gated: the pipeline must belong to the authenticated user.
   */
  router.get('/artifact-chain/:pipelineId', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const pipelineId = parseInt(req.params.pipelineId, 10);

    if (Number.isNaN(pipelineId)) {
      sendError(res, 'BAD_REQUEST', 'pipelineId must be a number', 400);
      return;
    }

    // Ownership check — verify the pipeline belongs to this user
    const db = require('../../services/database').getDb();
    const row = db.prepare(
      'SELECT user_id FROM content_pipeline WHERE id = ?'
    ).get(pipelineId) as { user_id: number } | undefined;

    if (!row) {
      sendError(res, 'NOT_FOUND', 'Pipeline entry not found', 404);
      return;
    }
    if (row.user_id !== 0 && row.user_id !== userId) {
      sendError(res, 'FORBIDDEN', 'Not your pipeline entry', 403);
      return;
    }

    const { getArtifactChain } = require('../../services/content-learning-store');
    const chain = getArtifactChain(pipelineId);

    sendSuccess(res, chain);
  }));

  /**
   * GET /api/v1/content/scripts/recent
   *
   * Get recent generated scripts (raw text).
   * Used by iOS content review UI and portal script inspector.
   * Query: ?days=30&limit=10
   */
  router.get('/scripts/recent', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const days = parseInt(String(req.query.days || '30'), 10);
    const limit = parseInt(String(req.query.limit || '10'), 10);

    const { getRecentScripts } = require('../../services/content-learning-store');
    const scripts = getRecentScripts(userId, days, limit);

    sendSuccess(res, {
      count: scripts.length,
      scripts: scripts.map((s: any) => ({
        id: s.id,
        topic: s.topic,
        format: s.format,
        hook: s.hook,
        titleOptions: s.titleOptions,
        estimatedDuration: s.estimatedDuration,
        niche: s.niche,
        createdAt: s.createdAt,
        // Script text truncated for list view — full text via artifact-chain
        preview: s.scriptText?.slice(0, 300) ?? null,
      })),
    });
  }));

  return router;
}

function summarizeContentJobStatus(
  lastResult: 'success' | 'failed' | 'running' | 'never' | undefined,
  signalCount: number,
): 'ready' | 'degraded' | 'syncing' | 'warming_up' {
  if (lastResult === 'failed') return 'degraded';
  if (lastResult === 'running') return 'syncing';
  if (signalCount > 0 || lastResult === 'success') return 'ready';
  return 'warming_up';
}

function summarizeOptimizationStatus(
  performanceResult: 'success' | 'failed' | 'running' | 'never' | undefined,
  autoresearchResult: 'success' | 'failed' | 'running' | 'never' | undefined,
  insightCount: number,
): 'ready' | 'degraded' | 'syncing' | 'warming_up' {
  if (performanceResult === 'failed' || autoresearchResult === 'failed') return 'degraded';
  if (performanceResult === 'running' || autoresearchResult === 'running') return 'syncing';
  if (insightCount > 0 || performanceResult === 'success' || autoresearchResult === 'success') return 'ready';
  return 'warming_up';
}

function formatSignalDigest(signal: AgentSignal, language: Lang): {
  id: number;
  type: string;
  title: string;
  summary: string;
  priority: string;
  createdAt: string;
} {
  return {
    id: signal.id,
    type: signal.signal_type,
    title: buildSignalTitle(signal, language),
    summary: buildSignalSummary(signal, language),
    priority: signal.priority,
    createdAt: signal.created_at,
  };
}

function buildSignalTitle(signal: AgentSignal, language: Lang): string {
  const titleLike = firstText(
    signal.payload.title,
    signal.payload.topic,
    signal.payload.keyword,
    signal.payload.channel,
    signal.payload.pillar,
    signal.payload.summary,
  );
  if (titleLike) {
    return language.startsWith('pt') ? localizeSignalTitle(titleLike, signal.signal_type, language) : titleLike;
  }

  const fallbackTitles: Record<string, { en: string; pt: string }> = {
    reaction_opportunity: { en: 'Reaction opportunity', pt: 'Janela de reação' },
    trending_spike: { en: 'Trending spike', pt: 'Subida de tendência' },
    competitor_upload: { en: 'Competitor move', pt: 'Movimento da concorrência' },
    hook_effectiveness: { en: 'Hook performance', pt: 'Performance dos hooks' },
    pillar_performance: { en: 'Pillar performance', pt: 'Performance do pilar' },
    learning_digest: { en: 'Weekly learning', pt: 'Aprendizagem semanal' },
    content_formula: { en: 'Winning format', pt: 'Formato vencedor' },
  };
  const fallback = fallbackTitles[signal.signal_type];
  return fallback ? (language.startsWith('pt') ? fallback.pt : fallback.en) : humanizeSignalType(signal.signal_type);
}

function buildSignalSummary(signal: AgentSignal, language: Lang): string {
  const summary = firstText(
    signal.payload.summary,
    signal.payload.reason,
    signal.payload.description,
    signal.payload.observation,
    signal.payload.note,
  );
  if (summary) {
    return language.startsWith('pt') ? localizeSignalSummary(summary, signal.signal_type, signal.payload, language) : summary;
  }

  switch (signal.signal_type) {
    case 'reaction_opportunity':
      return language.startsWith('pt')
        ? 'Há uma janela curta para reagir com velocidade e contexto.'
        : 'There is a short reaction window worth moving on quickly.';
    case 'trending_spike':
      return language.startsWith('pt')
        ? 'O tema está a ganhar velocidade e merece atenção.'
        : 'This topic is accelerating and deserves attention.';
    case 'competitor_upload':
      return language.startsWith('pt')
        ? 'Um canal comparável publicou agora, o que pode abrir espaço para resposta.'
        : 'A comparable channel just published, which may open a response angle.';
    case 'hook_effectiveness':
      return language.startsWith('pt')
        ? 'Há um padrão recente sobre o que está a segurar melhor a audiência.'
        : 'There is a recent pattern in what is holding attention better.';
    case 'pillar_performance':
      return language.startsWith('pt')
        ? 'Um dos teus pilares está a ganhar mais tração do que os restantes.'
        : 'One of your pillars is outperforming the rest right now.';
    case 'learning_digest':
      return language.startsWith('pt')
        ? 'Há uma síntese recente do que está a funcionar e do que precisa de ajuste.'
        : 'There is a recent summary of what is working and what needs adjustment.';
    case 'content_formula':
      return language.startsWith('pt')
        ? 'Um formato repetível está a emergir nos teus resultados recentes.'
        : 'A repeatable format is emerging from recent results.';
    default:
      return language.startsWith('pt')
        ? 'Sinal recente do teu sistema de conteúdo.'
        : 'Recent signal from your content system.';
  }
}

function localizeSignalTitle(title: string, signalType: string, language: Lang): string {
  if (!language.startsWith('pt')) return title;
  const trimmed = title.trim();
  switch (signalType) {
    case 'pillar_performance':
      return /^training$/i.test(trimmed) ? 'Treino' : trimmed;
    default:
      return trimmed;
  }
}

function localizeSignalSummary(summary: string, signalType: string, payload: Record<string, any>, language: Lang): string {
  if (!language.startsWith('pt')) return summary;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return trimmed;

  switch (signalType) {
    case 'reaction_opportunity':
      return `Janela de reação ativa: ${trimmed}`;
    case 'trending_spike':
      return `Sinal de tendência: ${trimmed}`;
    case 'competitor_upload':
      return `Movimento recente da concorrência: ${trimmed}`;
    case 'hook_effectiveness':
      return `Lição de hook: ${trimmed}`;
    case 'pillar_performance': {
      const pillar = firstText(payload.pillar) ?? 'este pilar';
      const localizedPillar = /^training$/i.test(pillar) ? 'Treino' : pillar;
      return `Performance de ${localizedPillar}: ${trimmed}`;
    }
    case 'learning_digest':
      return `Aprendizagem recente: ${trimmed}`;
    case 'content_formula':
      return `Formato a repetir: ${trimmed}`;
    default:
      return trimmed;
  }
}

function localizeVoiceEntryLabel(label: string, language: Lang): string {
  if (!language.startsWith('pt')) return label;

  const labels: Record<string, string> = {
    'Hook Styles': 'Estilos de hook',
    'Title Patterns': 'Padrões de título',
    'Content Structure': 'Estrutura de conteúdo',
    'Editing Style': 'Estilo de edição',
    'Storytelling': 'Storytelling',
    'CTA Patterns': 'Padrões de CTA',
    'Audience Engagement': 'Envolvimento da audiência',
    'Visual Branding': 'Marca visual',
    'Brand Voice': 'Voz da marca',
    'Additions (Voice Evolution)': 'Adições (Evolução de voz)',
    'Removals (Voice Evolution)': 'Remoções (Evolução de voz)',
    'Rephrasings (Voice Evolution)': 'Reformulações (Evolução de voz)',
    'Book Influence': 'Influência de livros',
    'Voice Summary': 'Resumo da voz',
  };
  return labels[label] ?? label;
}

function localizeKnowledgeCategoryLabel(
  category: string,
  voiceEntries: Array<{ category: string; label: string }>,
  language: Lang,
): string {
  const matchingEntry = voiceEntries.find((entry) => entry.category === category);
  if (matchingEntry) {
    return localizeVoiceEntryLabel(matchingEntry.label, language);
  }
  return localizeVoiceEntryLabel(humanizeSignalType(category), language);
}

function humanizeSignalType(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function firstText(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function localizeFilmingRecommendation<T extends {
  reason: string;
  reasons: string[];
  calendarReservationMessage?: string | null;
} | null>(
  recommendation: T,
  language: Lang,
): T {
  if (!recommendation || !language.startsWith('pt')) {
    return recommendation;
  }

  const localizedReasons = recommendation.reasons.map(localizeFilmingRecommendationText);
  return {
    ...recommendation,
    reason: localizeFilmingRecommendationText(recommendation.reason),
    reasons: localizedReasons,
    calendarReservationMessage: recommendation.calendarReservationMessage
      ? localizeFilmingRecommendationText(recommendation.calendarReservationMessage)
      : recommendation.calendarReservationMessage,
  };
}

function localizeFilmingRecommendationText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;

  const numericPattern = /(\d+)\/100/g;

  switch (trimmed) {
    case 'No hard training is scheduled today.':
      return 'Hoje não há treino duro planeado.';
    case 'No hard training is planned for this day.':
      return 'Não há treino duro planeado para este dia.';
    case 'There is a hard training session planned, so filming would compete with your best energy.':
      return 'Há um treino duro planeado, por isso filmar iria competir com a tua melhor energia.';
    case 'Training is planned, but it looks manageable around a filming block.':
      return 'Há treino planeado, mas parece compatível com um bloco de filmagem.';
    case 'Only light training is planned, so it should be easier to film well.':
      return 'Só há treino leve planeado, por isso deve ser mais fácil filmar bem.';
    case 'Your calendar is clear, so you have room to film without collisions.':
      return 'O teu calendário está livre, por isso tens espaço para filmar sem conflitos.';
    case 'Your calendar is busy that day, so filming would likely fragment or run late.':
      return 'O teu calendário está carregado nesse dia, por isso filmar iria fragmentar-se ou atrasar-se.';
    case 'You have a few calendar commitments, but there is still some room to film.':
      return 'Tens alguns compromissos no calendário, mas ainda há margem para filmar.';
    case 'The calendar looks light, which is good for a focused filming block.':
      return 'O calendário parece leve, o que é bom para um bloco de filmagem focado.';
    case 'You already have a content deadline on this date.':
      return 'Já tens um prazo de conteúdo nesta data.';
    case 'Giving yourself one more recovery day should improve filming quality.':
      return 'Dar a ti próprio mais um dia de recuperação deve melhorar a qualidade da filmagem.';
    case 'Recent recovery signals suggest protecting today rather than stacking filming on top.':
      return 'Os sinais recentes de recuperação sugerem proteger o dia de hoje em vez de acumular filmagem por cima.';
    case 'This gives your current recovery dip a little more room to settle.':
      return 'Isto dá mais espaço para a tua quebra atual de recuperação estabilizar.';
    case 'Connect Google Calendar or Outlook in Settings to reserve this filming block.':
      return 'Liga o Google Calendar ou o Outlook nas Definições para reservar este bloco de filmagem.';
    case 'This day has the cleanest mix of energy and calendar space for filming.':
      return 'Este dia tem a melhor combinação de energia e espaço no calendário para filmar.';
    default:
      break;
  }

  if (trimmed.startsWith("Today's readiness is only ")) {
    return trimmed.replace(
      /^Today's readiness is only (\d+)\/100, so filming tomorrow or later is safer\.$/,
      'A prontidão de hoje é só $1/100, por isso é mais seguro filmar amanhã ou mais tarde.',
    );
  }

  if (trimmed.startsWith('Readiness looks solid at ')) {
    return trimmed.replace(
      /^Readiness looks solid at (\d+)\/100, which supports a focused filming block\.$/,
      'A prontidão está sólida em $1/100, o que ajuda um bloco de filmagem focado.',
    );
  }

  return trimmed.replace(numericPattern, '$1/100');
}
