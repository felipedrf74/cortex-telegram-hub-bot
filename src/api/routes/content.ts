// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { acquireCostLock, buildQuotaExceededMessage, isUserOverDailyCap } from '../../services/cost-guardrail';
import { invalidatePlanningCaches } from '../../services/plan-cache-invalidator';
import { buildScreenContractMeta } from '../../services/screen-contract-meta';

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

const YOUTUBE_SCRIPT_PRESET_SECONDS = [480, 600, 900] as const;
const SHORT_SCRIPT_PRESET_SECONDS = [15, 30, 45, 60] as const;

function parseOptionalPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return null;
}

function normalizeScriptFormat(value: unknown): 'YouTube' | 'Reel' | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'YouTube';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'youtube') return 'YouTube';
  if (['reel', 'short', 'shorts', 'instagram', 'instagram short', 'instagram shorts'].includes(normalized)) {
    return 'Reel';
  }
  return null;
}

function resolveScriptDurationPreset(
  format: 'YouTube' | 'Reel',
  rawMaxDurationMinutes: unknown,
  rawTargetDurationSeconds: unknown,
): { maxDurationMinutes: number; targetDurationSeconds: number } | { error: string } {
  const parsedTargetDurationSeconds = parseOptionalPositiveInt(rawTargetDurationSeconds);
  const parsedMaxDurationMinutes = parseOptionalPositiveInt(rawMaxDurationMinutes);

  if (format === 'Reel') {
    if (parsedTargetDurationSeconds != null) {
      if (!SHORT_SCRIPT_PRESET_SECONDS.includes(parsedTargetDurationSeconds as (typeof SHORT_SCRIPT_PRESET_SECONDS)[number])) {
        return { error: 'Reel duration must be one of 15, 30, 45, or 60 seconds' };
      }
      return { maxDurationMinutes: 1, targetDurationSeconds: parsedTargetDurationSeconds };
    }
    if (parsedMaxDurationMinutes != null && parsedMaxDurationMinutes !== 1) {
      return { error: 'Reel maxDurationMinutes must stay at 1 minute; use targetDurationSeconds for 15/30/45/60-second presets' };
    }
    return { maxDurationMinutes: 1, targetDurationSeconds: 60 };
  }

  if (parsedTargetDurationSeconds != null) {
    if (!YOUTUBE_SCRIPT_PRESET_SECONDS.includes(parsedTargetDurationSeconds as (typeof YOUTUBE_SCRIPT_PRESET_SECONDS)[number])) {
      return { error: 'YouTube duration must be one of 8, 10, or 15 minutes' };
    }
    return { maxDurationMinutes: Math.round(parsedTargetDurationSeconds / 60), targetDurationSeconds: parsedTargetDurationSeconds };
  }

  if (parsedMaxDurationMinutes != null) {
    if (![8, 10, 15].includes(parsedMaxDurationMinutes)) {
      return { error: 'YouTube maxDurationMinutes must be one of 8, 10, or 15' };
    }
    return { maxDurationMinutes: parsedMaxDurationMinutes, targetDurationSeconds: parsedMaxDurationMinutes * 60 };
  }

  return { maxDurationMinutes: 8, targetDurationSeconds: 8 * 60 };
}

function invalidScriptFormatMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o formato deve ser YouTube ou Reel';
  if (language.startsWith('pt')) return 'o formato tem de ser YouTube ou Reel';
  return 'format must be YouTube or Reel';
}

function invalidTopicGeneratorFormatMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o formato deve ser "reel" ou "youtube"';
  if (language.startsWith('pt')) return 'o formato tem de ser "reel" ou "youtube"';
  return 'format must be "reel" or "youtube"';
}

function parseOptionalPositiveId(value: unknown): number | null {
  const parsed = parseOptionalPositiveInt(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function parseOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveScriptTopicContext(
  userId: number,
  raw: Record<string, unknown>,
): ScriptTopicContext | null {
  const db = getDb();
  const context: ScriptTopicContext = {};

  const pipelineId = parseOptionalPositiveId(raw.pipelineId);
  const topicFeedbackId = parseOptionalPositiveId(raw.topicFeedbackId);
  const ideaId = parseOptionalPositiveId(raw.ideaId);

  if (pipelineId != null) {
    try {
      const row = db.prepare(`
        SELECT p.id AS pipeline_id,
               p.user_id AS pipeline_user_id,
               p.niche AS pipeline_niche,
               tf.id AS topic_feedback_id,
               tf.niche AS feedback_niche,
               tf.hook_idea,
               tf.why_now,
               tf.angle_tag,
               tf.source_job
        FROM content_pipeline p
        LEFT JOIN content_topic_feedback tf ON tf.id = p.topic_feedback_id
        WHERE p.id = ?
        LIMIT 1
      `).get(pipelineId) as any;

      if (row && row.pipeline_user_id === userId) {
        context.pipelineId = row.pipeline_id;
        context.topicFeedbackId = row.topic_feedback_id ?? context.topicFeedbackId;
        context.niche = row.feedback_niche || row.pipeline_niche || context.niche;
        context.hookIdea = row.hook_idea || context.hookIdea;
        context.whyNow = row.why_now || context.whyNow;
        context.angleTag = row.angle_tag || context.angleTag;
        context.sourceJob = row.source_job || context.sourceJob;
      }
    } catch {
      // Older isolated tests may not expose every content_pipeline column yet.
    }
  }

  if (topicFeedbackId != null) {
    const row = db.prepare(`
      SELECT id, niche, hook_idea, why_now, angle_tag, source_job
      FROM content_topic_feedback
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(topicFeedbackId, userId) as any;

    if (row) {
      context.topicFeedbackId = row.id;
      context.niche = row.niche || context.niche;
      context.hookIdea = row.hook_idea || context.hookIdea;
      context.whyNow = row.why_now || context.whyNow;
      context.angleTag = row.angle_tag || context.angleTag;
      context.sourceJob = row.source_job || context.sourceJob;
    }
  }

  if (ideaId != null) {
    const row = db.prepare(`
      SELECT id, niche, hook_idea, why_now, angle_tag, source
      FROM saved_ideas
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(ideaId, userId) as any;

    if (row) {
      context.ideaId = row.id;
      context.niche = row.niche || context.niche;
      context.hookIdea = row.hook_idea || context.hookIdea;
      context.whyNow = row.why_now || context.whyNow;
      context.angleTag = row.angle_tag || context.angleTag;
      context.sourceJob = row.source || context.sourceJob;
    }
  }

  const explicitNiche = parseOptionalText(raw.niche);
  const explicitHookIdea = parseOptionalText(raw.hookIdea);
  const explicitWhyNow = parseOptionalText(raw.whyNow);
  const explicitAngleTag = parseOptionalText(raw.angleTag);

  if (pipelineId != null) context.pipelineId = pipelineId;
  if (topicFeedbackId != null) context.topicFeedbackId = topicFeedbackId;
  if (ideaId != null) context.ideaId = ideaId;
  if (explicitNiche) context.niche = explicitNiche;
  if (explicitHookIdea) context.hookIdea = explicitHookIdea;
  if (explicitWhyNow) context.whyNow = explicitWhyNow;
  if (explicitAngleTag) context.angleTag = explicitAngleTag;

  return Object.values(context).some((value) => value != null && value !== '')
    ? context
    : null;
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
import {
  getActiveContentPillars,
  getContentDeskItems,
  localizeFilmingRecommendation,
} from '../../services/content-intelligence';
import {
  buildRadarTopicSummaries,
  filterSignalsForRadarPreferences,
  getContentRadarPreferences,
  setContentRadarPreferences,
} from '../../services/content-radar-preferences';
import { getDb } from '../../services/database';
import { getJobStatuses } from '../../portal/telemetry';
import { getKnowledgeStats, getVoiceDna } from '../../services/content-dashboard-service';
import { readSignals, type AgentSignal } from '../../services/intelligence-bus';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguage } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';
import { buildContentHomeViewState } from '../../services/content-home-view-state';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import type { ScriptTopicContext } from '../../services/content-engine';

const CONTENT_OWNER_SCOPE_SQL = "COALESCE(owner_scope, CASE WHEN user_id = 0 THEN 'system' ELSE 'user' END)";

function dedupeContentBooks(rows: any[], userId: number): any[] {
  const deduped = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.title}::${row.author}`;
    const existing = deduped.get(key);
    const rowIsUser = row.user_id === userId && (row.owner_scope === 'user' || (row.owner_scope == null && row.user_id !== 0));
    const existingIsUser = existing && existing.user_id === userId
      && (existing.owner_scope === 'user' || (existing.owner_scope == null && existing.user_id !== 0));
    if (!existing || (rowIsUser && !existingIsUser)) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
}

export function contentRoutes(): Router {
  const router = Router();

  function ensureValidContentRouteScope(
    res: Response,
    userId: number | undefined,
    operation: string,
    details?: Record<string, unknown>,
  ): userId is number {
    if (isValidTenantUserId(userId)) return true;
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation,
      reason: 'invalid_user_scope',
      userId: typeof userId === 'number' ? userId : null,
      details,
    });
    sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
    return false;
  }

  /** GET /api/v1/content/pipeline */
  router.get('/pipeline', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      const db = getDb();

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
      const db = getDb();
      const ideas = db.prepare(
        'SELECT id, title, score, created_at, stage FROM content_ideas WHERE user_id = ? ORDER BY score DESC, created_at DESC',
      ).all(userId) as any[];

      sendSuccess(res, {
        ideas: ideas.map((row: any) => ({
          id: row.id?.toString(), title: row.title,
          score: row.score || null, createdAt: row.created_at || null,
          stage: row.stage || 'ideas',
        })),
        count: ideas.length,
      });
    } catch (err: any) {
      logger.debug({ err }, 'Content ideas query failed');
      sendSuccess(res, { ideas: [], count: 0 });
    }
  });

  /** GET /api/v1/content/home — render-ready landing view state for iOS */
  router.get('/home', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_home')) return;

    const db = getDb();
    const language = resolveContentLanguage(req, userId);

    let pipeline = null as null | {
      stages: {
        ideas: Array<{ title: string }>;
        scripted: Array<{ title: string }>;
        filmed: Array<{ title: string }>;
        editing: Array<{ title: string }>;
        published: Array<{ title: string }>;
      };
    };
    let ideas: Array<{ title: string }> = [];
    let topics = [] as Array<{ status: 'planned' | 'drafting' | 'ready' | 'published' | 'cancelled'; scheduledDate: string | null }>;
    let lastLoadError: string | null = null;
    const reasonCodes: string[] = [];

    try {
      pipeline = readContentHomePipeline(db, userId);
    } catch (err: any) {
      logger.debug({ err, userId }, 'content/home pipeline digest failed');
      lastLoadError = err?.message || 'pipeline_unavailable';
      reasonCodes.push('PIPELINE_UNAVAILABLE');
    }

    try {
      ideas = readContentHomeIdeas(db, userId);
    } catch (err: any) {
      logger.debug({ err, userId }, 'content/home ideas digest failed');
      lastLoadError = lastLoadError ?? (err?.message || 'ideas_unavailable');
      reasonCodes.push('IDEAS_UNAVAILABLE');
    }

    try {
      topics = getTopics(userId, {
        includeTerminal: false,
        limit: 100,
      }).map((topic) => ({
        status: topic.status,
        scheduledDate: topic.scheduled_date ?? null,
      }));
    } catch (err: any) {
      logger.debug({ err, userId }, 'content/home topics digest failed');
      lastLoadError = lastLoadError ?? (err?.message || 'topics_unavailable');
      reasonCodes.push('TOPICS_UNAVAILABLE');
    }

    const allDiscoverySignals = readSignals(
      'ios-content-home',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      6,
      userId,
      7,
    );
    const radarPreferences = getContentRadarPreferences(userId);
    const discoverySignals = filterSignalsForRadarPreferences(allDiscoverySignals, radarPreferences.topics);
    const optimizationSignals = readSignals(
      'ios-content-home',
      ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'content_formula'],
      6,
      userId,
      14,
    );
    const monitoredPillars = radarPreferences.topics.length > 0
      ? buildRadarTopicSummaries(radarPreferences.topics, discoverySignals)
      : getActiveContentPillars(userId);
    const deskItems = getContentDeskItems(userId, 3);
    const voiceEntries = getVoiceDna(undefined, userId);
    const knowledgeStats = getKnowledgeStats(undefined, userId);
    const filmingRecommendation = localizeFilmingRecommendation(await getFilmingRecommendation(userId), language);

    sendSuccess(res, buildContentHomeViewState({
      pipeline,
      ideas,
      topics,
      discovery: {
        activeCount: discoverySignals.length,
        deskReadyCount: deskItems.length,
        deskItems: deskItems.map((item) => ({
          title: item.title,
          body: item.body,
        })),
        monitoredPillars: monitoredPillars.map((pillar) => ({
          name: pillar.name,
        })),
      },
      script: {
        voicePatternCount: voiceEntries.length,
        hasBrandVoice: voiceEntries.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary')
          || knowledgeStats.categories.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary'),
      },
      optimization: {
        activeInsightCount: optimizationSignals.length,
        recentSignals: optimizationSignals.map((signal) => ({
          title: buildSignalTitle(signal, language),
          summary: buildSignalSummary(signal, language),
        })),
      },
      filmingRecommendation: filmingRecommendation
        ? {
            date: filmingRecommendation.date,
            confidence: filmingRecommendation.confidence,
            localizedReason: filmingRecommendation.reason,
            localizedConfidenceLabel: language.startsWith('pt')
              ? filmingRecommendation.confidence === 'high'
                ? 'Alta confiança'
                : filmingRecommendation.confidence === 'medium'
                  ? 'Confiança média'
                  : 'Baixa confiança'
              : filmingRecommendation.confidence === 'high'
                ? 'High confidence'
                : filmingRecommendation.confidence === 'medium'
                  ? 'Medium confidence'
                  : 'Low confidence',
          }
        : null,
      hasAttemptedLoad: true,
      lastLoadError,
      meta: buildScreenContractMeta({
        source: 'server',
        isFallback: reasonCodes.length > 0,
        isPartial: reasonCodes.length > 0,
        isStale: false,
        generatedAt: new Date().toISOString(),
        reasonCodes,
      }),
    }, language));
  }));

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

  /** GET /api/v1/content/radar-preferences — creator topics for Reaction Radar */
  router.get('/radar-preferences', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    sendSuccess(res, getContentRadarPreferences(userId));
  }));

  /** PUT /api/v1/content/radar-preferences — replace creator topics for Reaction Radar */
  router.put('/radar-preferences', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const topics = Array.isArray(req.body?.topics) ? req.body.topics : null;

    if (!topics || topics.some((topic: unknown) => typeof topic !== 'string')) {
      sendError(res, 'BAD_REQUEST', 'topics must be an array of strings', 400);
      return;
    }

    sendSuccess(res, setContentRadarPreferences(userId, topics));
  }));

  /** GET /api/v1/content/intelligence — backstage agent summary for iOS */
  router.get('/intelligence', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_intelligence_summary')) return;
    const language = resolveContentLanguage(req, userId);
    const jobs = new Map(getJobStatuses().map((job) => [job.name, job]));
    const reactionJob = jobs.get('reaction_radar');
    const performanceJob = jobs.get('performance_agent');
    const autoresearchJob = jobs.get('autoresearch');

    const allDiscoverySignals = readSignals(
      'ios-content-intelligence',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      25,
      userId,
      7
    );
    const radarPreferences = getContentRadarPreferences(userId);
    const discoverySignals = filterSignalsForRadarPreferences(allDiscoverySignals, radarPreferences.topics);
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
    if (!ensureValidContentRouteScope(res, userId, 'content_route_intelligence_detail')) return;
    const language = resolveContentLanguage(req, userId);
    const jobs = new Map(getJobStatuses().map((job) => [job.name, job]));
    const reactionJob = jobs.get('reaction_radar');
    const performanceJob = jobs.get('performance_agent');
    const autoresearchJob = jobs.get('autoresearch');

    const allDiscoverySignals = readSignals(
      'ios-content-intelligence-detail',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      6,
      userId,
      7
    );
    const radarPreferences = getContentRadarPreferences(userId);
    const discoverySignals = filterSignalsForRadarPreferences(allDiscoverySignals, radarPreferences.topics);
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
    const monitoredPillars = radarPreferences.topics.length > 0
      ? buildRadarTopicSummaries(radarPreferences.topics, discoverySignals)
      : getActiveContentPillars(userId);
    const deskItems = getContentDeskItems(userId, 3);

    sendSuccess(res, {
      discovery: {
        status: summarizeContentJobStatus(reactionJob?.lastResult, discoverySignals.length),
        cadenceHours: 4,
        activeCount: discoverySignals.length,
        lastRunAt: reactionJob?.lastRunAt ?? null,
        lastStatus: reactionJob?.lastResult ?? 'never',
        deskReadyCount: deskItems.length,
        deskItems,
        preferredTopics: radarPreferences.topics,
        monitoredPillars,
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
    const requestLanguage = resolveContentLanguage(req as AuthenticatedRequest, userId);
    const { topic, niche, format, maxDurationMinutes, targetDurationSeconds, mode, language, renderMode } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      sendError(res, 'VALIDATION', 'topic is required', 400);
      return;
    }

    const normalizedFormat = normalizeScriptFormat(format);
    if (!normalizedFormat) {
      sendError(res, 'VALIDATION', invalidScriptFormatMessage(requestLanguage), 400);
      return;
    }

    const durationPreset = resolveScriptDurationPreset(
      normalizedFormat,
      maxDurationMinutes,
      targetDurationSeconds,
    );
    if ('error' in durationPreset) {
      sendError(res, 'VALIDATION', durationPreset.error, 400);
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

    // TOCTOU-safe cost window — serialize check + AI + api_usage row
    // per user. See acquireCostLock docs in services/cost-guardrail.ts.
    const releaseCostLock = await acquireCostLock(userId);
    const quota = isUserOverDailyCap(userId);
    if (quota.over) {
      releaseCostLock();
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
        const { getKnowledgeByCategory } = require('../../state/content-references');
        const row = getKnowledgeByCategory('brand_voice', userId);
        brandVoice = row?.synthesized_text || null;
      } catch { /* non-critical — generate without voice if DB fails */ }

      const scriptTopicContext = resolveScriptTopicContext(userId, req.body || {});

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
        scriptTopicContext?.niche || niche || 'general',
        durationPreset.maxDurationMinutes,
        normalizedFormat,
        genMode,
        brandVoice,
        targetLanguage,
        targetRenderMode,
        userId,
        durationPreset.targetDurationSeconds,
        scriptTopicContext,
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
        format: normalizedFormat,
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
          researchUsed: genMode !== 'quick' && !cacheHit,
        }),
        // Backward compat — keep old fields until iOS migrates
        generationMode: genMode,
        cacheHit,
        usageImpact: cacheHit ? 'none' : genMode === 'deep' ? 'high' : genMode,
      });
    } catch (err: any) {
      logger.error({ err, topic }, 'iOS content/script failed');
      sendError(res, 'INTERNAL', err?.message || 'Script generation failed', 500);
    } finally {
      releaseCostLock();
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
      invalidatePlanningCaches(userId);

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
      const language = resolveContentLanguage(req, userId);

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
      invalidatePlanningCaches(userId);
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
      invalidatePlanningCaches(userId);
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
      invalidatePlanningCaches(userId);
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
    const rows = db.prepare(
      `SELECT id, title, author, core_thesis, extraction_status, personal_notes, user_id, owner_scope
         FROM book_library
        WHERE ${CONTENT_OWNER_SCOPE_SQL} = 'system'
           OR (${CONTENT_OWNER_SCOPE_SQL} = 'user' AND user_id = ?)
        ORDER BY CASE WHEN ${CONTENT_OWNER_SCOPE_SQL} = 'user' AND user_id = ? THEN 0 ELSE 1 END,
                 title ASC`
    ).all(userId, userId);
    const books = dedupeContentBooks(rows, userId).map(({ user_id, owner_scope, ...row }) => row);
    sendSuccess(res, { books });
  }));

  /** POST /api/v1/content/books — add a book to user's library */
  router.post('/books', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { title, author } = req.body;
    if (!title || !author) { sendError(res, 'VALIDATION', 'title and author required', 400); return; }
    const db = require('../../services/database').getDb();
    const result = db.prepare(
      'INSERT OR IGNORE INTO book_library (title, author, extraction_status, user_id, owner_scope) VALUES (?, ?, ?, ?, ?)'
    ).run(title.trim(), author.trim(), 'pending', userId, 'user');
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
    const entries = getVoiceDna(undefined, userId).map((entry) => ({
      id: entry.id,
      category: entry.category,
      label: entry.label,
      payload: entry.text,
      source_channels: JSON.stringify(entry.sources),
      version: entry.version,
      updated_at: entry.updatedAt,
    }));
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
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, owner_scope, version)
      VALUES (?, ?, '[]', ?, 'user', 1)
      ON CONFLICT(user_id, category) DO UPDATE SET
        synthesized_text = excluded.synthesized_text,
        owner_scope = excluded.owner_scope,
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
    const requestLanguage = resolveContentLanguage(req as AuthenticatedRequest, userId);
    const { format = 'reel', sourceJob = 'manual' } = req.body;

    if (!['reel', 'youtube'].includes(format)) {
      sendError(res, 'VALIDATION', invalidTopicGeneratorFormatMessage(requestLanguage), 400);
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
   *         comments?, subsGained?, hookUsed?, selectedTitle?,
   *         finalCaption?, finalCta?, finalScriptVariant?, publishedHashtags?, notes? }
   */
  router.post('/performance', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const {
      pipelineId,
      videoUrl,
      views,
      retentionPct,
      likes,
      comments,
      subsGained,
      hookUsed,
      selectedTitle,
      finalCaption,
      finalCta,
      finalScriptVariant,
      publishedHashtags,
      notes,
    } = req.body;

    if (views === undefined || retentionPct === undefined) {
      sendError(res, 'VALIDATION', 'views and retentionPct are required', 400);
      return;
    }

    const { logPerformanceFeedback } = require('../../services/content-learning-store');
    const id = logPerformanceFeedback({
      pipelineId, videoUrl, views, retentionPct,
      likes, comments, subsGained, hookUsed, selectedTitle,
      finalCaption, finalCta, finalScriptVariant, publishedHashtags, notes,
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

function readContentHomePipeline(db: ReturnType<typeof getDb>, userId: number): {
  stages: {
    ideas: Array<{ title: string }>;
    scripted: Array<{ title: string }>;
    filmed: Array<{ title: string }>;
    editing: Array<{ title: string }>;
    published: Array<{ title: string }>;
  };
} {
  const readStage = (stage: 'ideas' | 'scripted' | 'filmed' | 'editing' | 'published') => (
    db.prepare(
      `SELECT title
         FROM content_ideas
        WHERE stage = ? AND user_id = ?
        ORDER BY COALESCE(score, 0) DESC, created_at DESC
        LIMIT 20`,
    ).all(stage, userId) as Array<{ title: string }>
  ).map((row) => ({ title: row.title }));

  return {
    stages: {
      ideas: readStage('ideas'),
      scripted: readStage('scripted'),
      filmed: readStage('filmed'),
      editing: readStage('editing'),
      published: readStage('published'),
    },
  };
}

function readContentHomeIdeas(
  db: ReturnType<typeof getDb>,
  userId: number,
): Array<{ title: string }> {
  return (
    db.prepare(`
      SELECT title
      FROM content_ideas
      WHERE user_id = ?
      ORDER BY COALESCE(score, 0) DESC, created_at DESC
      LIMIT 30
    `).all(userId) as Array<{ title: string }>
  ).map((row) => ({ title: row.title }));
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

function resolveContentLanguage(req: Pick<AuthenticatedRequest, 'header'>, userId: number): Lang {
  // `normalizeLangHeader` always returns a value ('pt-BR' default) for
  // backwards-compat with callers that want a string no matter what.
  // That means checking its return is NEVER falsy and would silently
  // override the user's stored preference on every request that didn't
  // send an x-language header. Check the raw header for presence first.
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
  return getUserLanguage(userId);
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
    return localizeSignalTitle(titleLike, signal.signal_type, language);
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
    return localizeSignalSummary(summary, signal.signal_type, signal.payload, language);
  }

  switch (signal.signal_type) {
    case 'reaction_opportunity':
      return localizePortugueseVariant(
        language,
        'Há uma janela curta para reagir com velocidade e contexto.',
        'Há uma janela curta para reagir com velocidade e contexto.',
        'There is a short reaction window worth moving on quickly.',
      );
    case 'trending_spike':
      return localizePortugueseVariant(
        language,
        'O tema está a ganhar velocidade e merece atenção.',
        'O tema está ganhando velocidade e merece atenção.',
        'This topic is accelerating and deserves attention.',
      );
    case 'competitor_upload':
      return localizePortugueseVariant(
        language,
        'Um canal comparável publicou agora, o que pode abrir espaço para resposta.',
        'Um canal comparável publicou agora, o que pode abrir espaço para resposta.',
        'A comparable channel just published, which may open a response angle.',
      );
    case 'hook_effectiveness':
      return localizePortugueseVariant(
        language,
        'Há um padrão recente sobre o que está a segurar melhor a audiência.',
        'Há um padrão recente sobre o que está segurando melhor a audiência.',
        'There is a recent pattern in what is holding attention better.',
      );
    case 'pillar_performance':
      return localizePortugueseVariant(
        language,
        'Um dos teus pilares está a ganhar mais tração do que os restantes.',
        'Um dos seus pilares está ganhando mais tração do que os demais.',
        'One of your pillars is outperforming the rest right now.',
      );
    case 'learning_digest':
      return localizePortugueseVariant(
        language,
        'Há uma síntese recente do que está a funcionar e do que precisa de ajuste.',
        'Há uma síntese recente do que está funcionando e do que precisa de ajuste.',
        'There is a recent summary of what is working and what needs adjustment.',
      );
    case 'content_formula':
      return localizePortugueseVariant(
        language,
        'Um formato repetível está a emergir nos teus resultados recentes.',
        'Um formato repetível está surgindo nos seus resultados recentes.',
        'A repeatable format is emerging from recent results.',
      );
    default:
      return localizePortugueseVariant(
        language,
        'Sinal recente do teu sistema de conteúdo.',
        'Sinal recente do seu sistema de conteúdo.',
        'Recent signal from your content system.',
      );
  }
}

function localizePortugueseVariant(language: Lang, portugal: string, brazil: string, english: string): string {
  if (language === 'pt-BR') return brazil;
  if (language.startsWith('pt')) return portugal;
  return english;
}

function localizeSignalTitle(title: string, signalType: string, language: Lang): string {
  const trimmed = title.trim();
  if (!language.startsWith('pt')) {
    const englishMap: Record<string, string> = {
      'Performance dos hooks': 'Hook performance',
      'Performance do pilar': 'Pillar performance',
      'Aprendizagem semanal': 'Weekly learning',
      'Formato vencedor': 'Winning format',
      'Janela de reação': 'Reaction opportunity',
      'Subida de tendência': 'Trending spike',
      'Movimento da concorrência': 'Competitor move',
      'Treino': 'Training',
      'Recuperação': 'Recovery',
    };
    if (/^(training|fitness)$/i.test(trimmed)) {
      return signalType === 'content_formula' ? 'Winning format' : 'Training';
    }
    return englishMap[trimmed] ?? trimmed;
  }
  switch (signalType) {
    case 'pillar_performance':
      return /^(training|fitness)$/i.test(trimmed) ? 'Treino' : trimmed;
    case 'content_formula':
      return /^fitness$/i.test(trimmed) ? 'Formato vencedor' : trimmed;
    default:
      return trimmed;
  }
}

function localizeSignalSummary(summary: string, signalType: string, payload: Record<string, any>, language: Lang): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return trimmed;

  if (!language.startsWith('pt')) {
    switch (signalType) {
      case 'reaction_opportunity':
        return trimmed.replace(/^Janela de reação ativa:\s*/i, 'Reaction window: ');
      case 'trending_spike':
        return trimmed.replace(/^Sinal de tendência:\s*/i, 'Trending signal: ');
      case 'competitor_upload':
        return trimmed.replace(/^Movimento recente da concorrência:\s*/i, 'Competitor move: ');
      case 'hook_effectiveness':
        return trimmed.replace(/^Lição de hook:\s*/i, 'Hook learning: ');
      case 'pillar_performance':
        return trimmed
          .replace(/^Performance de\s+/i, 'Performance for ')
          .replace(/^Performance do\s+/i, 'Performance for ');
      case 'learning_digest':
        return trimmed.replace(/^Aprendizagem recente:\s*/i, 'Recent learning: ');
      case 'content_formula':
        return trimmed.replace(/^Formato a repetir:\s*/i, 'Repeatable format: ');
      default:
        return trimmed;
    }
  }

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
