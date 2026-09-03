// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content Dashboard API — restoration of the admin portal's Content
 * section (commands, books, YouTube research, agent mesh graph,
 * content triggers/crons, voice DNA, reaction radar, pipeline).
 *
 * This is an ADMIN endpoint — NOT an iOS route. It is mounted under
 * `/api/v1/admin/content-dashboard` inside the iOS api router so that:
 *
 *   1. The portal-token middleware in `src/portal/server.ts` skips it
 *      (everything under `/v1/*` is excluded from that middleware).
 *   2. We can attach our OWN portal-token verification here, which means
 *      the admin portal (which sends a portal read or full-access bearer token)
 *      and nothing else can reach it.
 *
 * This route must be mounted BEFORE the iOS JWT `authMiddleware` in
 * `src/api/router.ts` so it never tries to parse a JWT.
 *
 * The response is a single JSON blob with every content subsection — the
 * portal UI only needs one request to render the whole tab. Every field
 * is live data from the SQLite database + in-process telemetry; nothing
 * goes through the AI pipeline.
 */

import { Router, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { getJobStatuses } from '../../portal/telemetry';
import { getPipelineStats } from '../../agents/pipeline-agent';
import { getBooks, getVoiceDna, getPipelineRecent, getKnowledgeStats } from '../../services/content-dashboard-service';
import {
  getAgentStats,
  getSignalLog,
  getActiveSignalCount,
} from '../../services/intelligence-bus';
import {
  filterActiveContentAgentSignals,
  isPausedContentAgent,
  PAUSED_CONTENT_AGENT_IDS,
} from '../../services/content-agent-lifecycle';
import { CronExpressionParser } from 'cron-parser';
import { sendInternalError } from '../response-helpers';
import { requirePortalToken } from '../secret-guards';
import { getOwnerBootstrapTarget } from '../../services/user-service';
import type { ContentWorkspaceScope } from '../../services/content-workspace';
import { extractClientIp } from '../rate-limiter';
import { platformContentScopePredicate } from '../../services/content-tenant-scope';

export const CONTENT_DASHBOARD_RATE_LIMIT_PER_MINUTE = 30;

// ─── Static registries ──────────────────────────────────────────────

/**
 * Content operations registry — all content actions available through
 * the iOS app, portal, or legacy Telegram handler. Each entry maps to
 * a content-engine endpoint or workflow function.
 *
 * The `name` is the operation identifier (matches api_usage category).
 * The `label` is the display name for the portal dashboard.
 * Call counts come from the `api_usage` table, matching `category`
 * strings that include the operation name.
 */
interface CommandRegistryRow {
  name: string;
  label: string;
  group: 'discover' | 'ideate' | 'script' | 'visuals' | 'analysis' | 'library' | 'seo' | 'pipeline' | 'research';
  description: string;
}

const CONTENT_COMMANDS: CommandRegistryRow[] = [
  // ── Discovery & research ────────────────────────────────────────────
  { name: 'discover',     label: 'Discover',      group: 'discover', description: 'Autopilot content discovery — web + YouTube trends.' },
  { name: 'deepsearch',   label: 'Deep Search',   group: 'discover', description: 'Deep research brief for a topic.' },
  { name: 'sources',      label: 'Sources',       group: 'discover', description: 'List sources from the last deep search.' },
  { name: 'hotnews',      label: 'Hot News',      group: 'discover', description: 'Ranked hot news in your niches.' },
  { name: 'trending',     label: 'Trending',      group: 'discover', description: 'YouTube trending by pillar.' },
  { name: 'transcribe',   label: 'Transcribe',    group: 'research', description: 'Fetch and store a YouTube transcript.' },
  { name: 'studyvideo',   label: 'Study Video',   group: 'research', description: 'Deep study a YouTube video (hook, structure, reel cuts).' },
  { name: 'learnfrom',    label: 'Learn From',    group: 'research', description: 'Register a YouTube channel as a reference and analyze it.' },
  { name: 'references',   label: 'References',    group: 'research', description: 'List all registered reference channels.' },
  { name: 'relearn',      label: 'Re-learn',      group: 'research', description: 'Re-run channel learner across all references.' },
  // ── Ideation ────────────────────────────────────────────────────────
  { name: 'ideas',        label: 'Ideas',         group: 'ideate',   description: 'Generate new content ideas for a pillar.' },
  { name: 'hooks',        label: 'Hooks',         group: 'ideate',   description: 'Hook ideas for a given topic.' },
  { name: 'titles',       label: 'Titles',        group: 'ideate',   description: 'Title variants for a topic.' },
  { name: 'reaction',     label: 'Reaction',      group: 'ideate',   description: 'Build a reaction-video brief from a URL.' },
  { name: 'contenttopic', label: 'Topic Gen',     group: 'ideate',   description: 'Suggest the next topic using approved taste profile.' },
  { name: 'contentretro', label: 'Retro',         group: 'ideate',   description: 'Retrospective on last week of topic feedback.' },
  // ── Scripting ───────────────────────────────────────────────────────
  { name: 'script',       label: 'Script',        group: 'script',   description: 'Generate a script from a topic.' },
  { name: 'genscript',    label: 'Full Script',   group: 'script',   description: 'Generate a production-ready long-form script.' },
  { name: 'buildscript',  label: 'Build Script',  group: 'script',   description: 'Assemble a script from approved sections.' },
  { name: 'reel',         label: 'Reel Script',   group: 'script',   description: 'Short-form reel script.' },
  { name: 'repurpose',    label: 'Repurpose',     group: 'script',   description: 'Repurpose long-form content into reels.' },
  // ── Visuals ─────────────────────────────────────────────────────────
  { name: 'genthumbnail', label: 'Thumbnail',     group: 'visuals',  description: 'Generate thumbnail copy + concept.' },
  { name: 'gencaption',   label: 'Caption',       group: 'visuals',  description: 'Generate captions and on-screen text.' },
  // ── Analysis ────────────────────────────────────────────────────────
  { name: 'competitor',   label: 'Competitor',    group: 'analysis', description: 'Competitive intel brief for a channel or niche.' },
  { name: 'gaps',         label: 'Gaps',          group: 'analysis', description: 'Content gap analysis for a pillar.' },
  { name: 'brandcheck',   label: 'Brand Check',   group: 'analysis', description: 'Check a draft against the brand voice guidelines.' },
  { name: 'feedback',     label: 'Feedback',      group: 'analysis', description: 'Log human feedback on a piece of content.' },
  { name: 'report',       label: 'Report',        group: 'analysis', description: 'Generate a performance report.' },
  // ── Book knowledge ─────────────────────────────────────────────────
  { name: 'addbook',      label: 'Add Book',      group: 'library',  description: 'Add a book and extract its knowledge.' },
  { name: 'booknote',     label: 'Book Note',     group: 'library',  description: 'Attach a personal note to a book.' },
  { name: 'books',        label: 'Books',         group: 'library',  description: 'List books in the library with extraction status.' },
  { name: 'bookidea',     label: 'Book Idea',     group: 'library',  description: 'Generate a content idea grounded in a book framework.' },
  // ── SEO ─────────────────────────────────────────────────────────────
  { name: 'seo',          label: 'SEO',           group: 'seo',      description: 'Full SEO brief for a topic.' },
  { name: 'seokeyword',   label: 'SEO Keyword',   group: 'seo',      description: 'Paused until keyword rank storage is tenant-user scoped; does not save keywords.' },
  { name: 'seorank',      label: 'SEO Rank',       group: 'seo',      description: 'Paused until keyword rank storage is tenant-user scoped; no global ranks are exposed.' },
  // ── Pipeline ────────────────────────────────────────────────────────
  { name: 'pipeline',     label: 'Pipeline',      group: 'pipeline', description: 'Pipeline status summary (all stages).' },
  { name: 'autoresearch', label: 'Auto-Research', group: 'pipeline', description: 'Kick off a prompt-optimization experiment.' },
  { name: 'evalscore',    label: 'Eval Score',    group: 'pipeline', description: 'Score a completed autoresearch run.' },
  { name: 'calendar',     label: 'Work Plan',     group: 'pipeline', description: 'Private Content deadlines and confirmed Secretary work blocks.' },
];

/**
 * Static description of the content agent mesh — this is the fallback
 * graph that always renders correctly even when `agent_runs` is empty.
 * Nodes and edges describe the real wiring documented in the agent
 * source files (`src/agents/*`) and the `intelligence-bus` signal
 * types.
 */
interface AgentNode {
  id: string;
  label: string;
  /** Short description of the agent's job. */
  role: string;
  lifecycle: 'active' | 'paused';
  /** Which signal types this agent emits. */
  emits: string[];
  /** Which signal types this agent consumes. */
  consumes: string[];
  /** Which cron job triggers this agent, if any. */
  cron: string | null;
}

interface AgentEdge {
  from: string;
  to: string;
  /** The signal type carried on this edge. */
  signal: string;
}

const AGENT_GRAPH_NODES: AgentNode[] = [
  {
    id: 'channel_learner',
    label: 'Channel Learner',
    role: 'Analyzes registered YouTube channels and extracts creator DNA (hook, title, structure, voice).',
    lifecycle: 'active',
    emits: ['channel_dna'],
    consumes: [],
    cron: 'channel_relearn',
  },
  {
    id: 'book_extractor',
    label: 'Book Extractor',
    role: 'Extracts thesis, frameworks, quotes and pillar mapping from every book in the library.',
    lifecycle: 'active',
    emits: ['book_knowledge'],
    consumes: [],
    cron: null,
  },
  {
    id: 'voice_evolution',
    label: 'Voice Evolution',
    role: 'Learns monthly edit tendencies from direct canonical agent-draft to creator-revision pairs; publication is not inferred.',
    lifecycle: 'active',
    emits: ['voice_pattern', 'voice_phrase_trend', 'voice_analysis_fingerprint'],
    consumes: ['book_knowledge'],
    cron: 'voice_evolution',
  },
  {
    id: 'reaction_radar',
    label: 'Reaction Radar',
    role: 'Paused until reaction discovery, preferences, and emitted opportunities are tenant-user scoped.',
    lifecycle: 'paused',
    emits: [],
    consumes: [],
    cron: 'reaction_radar',
  },
  {
    id: 'content_discovery',
    label: 'Content Discovery',
    role: 'Autopilot topic discovery using web search and ranked heat scores; it does not currently read or write the intelligence bus.',
    lifecycle: 'active',
    emits: [],
    consumes: [],
    cron: null,
  },
  {
    id: 'content_workflow',
    label: 'Content Workflow',
    role: 'Weekly scheduler — Tuesday reels, Thursday YouTube, Friday package. Produces topic candidates.',
    lifecycle: 'active',
    emits: [],
    consumes: ['book_knowledge', 'trending_spike', 'competitor_upload', 'reaction_opportunity'],
    cron: 'friday_weekly',
  },
  {
    id: 'pipeline_agent',
    label: 'Pipeline Tracker',
    role: 'Monitors internal workflow stages and emits capacity or bottleneck signals; sprint mode is portal-authored, and external publication tracking is unavailable.',
    lifecycle: 'active',
    emits: ['pipeline_bottleneck', 'pipeline_capacity'],
    consumes: ['keyword_opportunity', 'hook_effectiveness', 'pillar_performance', 'content_formula', 'content_sprint_mode'],
    cron: 'pipeline_agent',
  },
  {
    id: 'performance_agent',
    label: 'Performance Intel',
    role: 'Paused until channel-performance signals have tenant-user scoped storage.',
    lifecycle: 'paused',
    emits: [],
    consumes: [],
    cron: 'performance_agent',
  },
  {
    id: 'seo_agent',
    label: 'SEO Tracker',
    role: 'Paused until keyword ranks and emitted signals have tenant-user scoped storage.',
    lifecycle: 'paused',
    emits: [],
    consumes: [],
    cron: 'seo_agent',
  },
  {
    id: 'autoresearch',
    label: 'Autoresearch',
    role: 'Scheduled read-only evaluation — reuses unchanged input fingerprints and never mutates prompts automatically.',
    lifecycle: 'active',
    emits: [],
    consumes: [],
    cron: 'autoresearch',
  },
];

const AGENT_GRAPH_EDGES: AgentEdge[] = [
  { from: 'book_extractor',   to: 'voice_evolution',  signal: 'book_knowledge' },
  { from: 'book_extractor',   to: 'content_workflow', signal: 'book_knowledge' },
];

function normalizeContentAgentRuntimeId(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_');
}

const CONTENT_DASHBOARD_AVAILABILITY_SECTIONS = [
  'books',
  'youtube',
  'agentStats',
  'triggers',
  'voiceDna',
  'knowledgeStats',
  'activeSignals',
] as const;

type ContentDashboardAvailabilitySection = typeof CONTENT_DASHBOARD_AVAILABILITY_SECTIONS[number];

// ─── Response type ──────────────────────────────────────────────────

export interface ContentDashboardResponse {
  ok: true;
  generatedAt: string;
  /**
   * Aggregate truth for the platform/runtime reads that otherwise have an
   * empty-looking fallback. Pipeline keeps its own independent availability
   * contract because its empty projection has different workspace semantics.
   */
  availability: 'available' | 'partial' | 'unavailable';
  unavailableSections: ContentDashboardAvailabilitySection[];
  scope: {
    mode: 'mixed_operator_overview';
    workspaceScope: ContentWorkspaceScope | null;
    workspaceScopedSections: ['pipeline', 'activeSignals'];
    platformSections: ['commands', 'books', 'youtube', 'agentGraph', 'triggers', 'voiceDna', 'reactionRadar', 'knowledgeStats', 'referenceChannels'];
  };
  commands: {
    group: string;
    rows: {
      name: string;
      label: string;
      description: string;
      calls7d: number;
      calls30d: number;
      lastUsedAt: string | null;
      costUsd7d: number;
    }[];
  }[];
  books: {
    total: number;
    extracted: number;
    pending: number;
    rows: {
      id: number;
      title: string;
      author: string;
      status: string;
      thesis: string | null;
      frameworks: string[];
      pillars: string[];
      timesReferenced: number;
      createdAt: string;
    }[];
  };
  youtube: {
    channels: {
      id: number;
      url: string;
      name: string | null;
      status: string;
      videosAnalyzed: number;
      lastAnalyzedAt: string | null;
      errorMessage: string | null;
    }[];
    videos: {
      videoId: string;
      title: string | null;
      channelName: string | null;
      studyType: string | null;
      hasStudy: boolean;
      createdAt: string;
      youtubeUrl: string;
    }[];
    totals: {
      channels: number;
      activeChannels: number;
      transcripts: number;
      studies: number;
    };
  };
  agentGraph: {
    nodes: (AgentNode & {
      lastRun: string | null;
      lastStatus: string;
      totalRuns: number;
      signalsProduced: number;
    })[];
    edges: AgentEdge[];
  };
  triggers: {
    name: string;
    label: string;
    cronExpression: string;
    cronHuman: string;
    domain: string;
    lastRunAt: string | null;
    lastResult: string;
    lastDurationMs: number | null;
    nextFireAt: string | null;
    lifecycle: 'active' | 'paused';
    status: 'ok' | 'failed' | 'running' | 'never' | 'paused';
  }[];
  voiceDna: {
    category: string;
    label: string;
    text: string;
    sources: string[];
    version: number;
    updatedAt: string;
  }[];
  reactionRadar: {
    activeSignals: number;
    recentSignals: {
      id: number;
      type: string;
      priority: string;
      summary: string;
      createdAt: string;
      status: string;
    }[];
    lastRunAt: string | null;
    lastStatus: string;
  };
  pipeline: {
    availability: 'available' | 'unavailable';
    source: 'content_workspace';
    reasonCode: string | null;
    stages: Record<string, number | null>;
    stageTracking: Record<string, unknown>;
    bottleneck: { stage: string; count: number; avgDays: number } | null;
    publishedThisWeek: number | null;
    publicationTracking: {
      availability: 'unavailable';
      reasonCode: string;
      publicationExecution: 'not_supported';
    };
    totalActive: number;
    recent: {
      id: number;
      topicTitle: string;
      niche: string | null;
      stage: string;
      createdAt: string;
      updatedAt: string;
      publishedUrl: string | null;
      publishedAt: string | null;
      productionState: string;
      artifactPhase: string;
      publicationEvidence: string;
    }[];
  };
  knowledgeStats: { category: string; updatedAt: string; sources: number }[];
  referenceChannels: number;
  activeSignals: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Returns a map of `category → {calls, cost, lastTs}` for a given window.
 * `window` is a SQLite datetime modifier (e.g. `-7 days`).
 */
function fetchUsageByCategories(
  categories: string[],
  window: '-7 days' | '-30 days',
): Map<string, { calls: number; cost: number; lastTs: string | null }> {
  const out = new Map<string, { calls: number; cost: number; lastTs: string | null }>();
  if (categories.length === 0) return out;
  const db = getDb();
  // SQLite LIKE match: any api_usage row whose `category` contains one of the
  // command names (e.g. `content_workflow_reel`, `video_study`, `addbook`).
  const cat = db.prepare(
    `SELECT category,
            COUNT(*) as calls,
            COALESCE(SUM(cost_usd), 0) as cost,
            MAX(ts) as last_ts
       FROM api_usage
      WHERE ts >= date('now', ?)
        AND category LIKE ?
      GROUP BY category`,
  );
  for (const name of categories) {
    const rows = cat.all(window, `%${name}%`) as Array<{
      category: string;
      calls: number;
      cost: number;
      last_ts: string | null;
    }>;
    let calls = 0;
    let cost = 0;
    let lastTs: string | null = null;
    for (const r of rows) {
      calls += r.calls;
      cost += Number(r.cost) || 0;
      if (r.last_ts && (!lastTs || r.last_ts > lastTs)) lastTs = r.last_ts;
    }
    out.set(name, { calls, cost, lastTs });
  }
  return out;
}

/** Human-friendly cron description — deliberately brittle + pragmatic. */
function humanizeCron(expr: string): string {
  const CANNED: Record<string, string> = {
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
    '0 * * * *': 'Hourly',
    '0 0 * * *': 'Daily at midnight',
    '0 20 * * *': 'Daily at 20:00',
    '0 9 * * 2': 'Tuesdays 09:00',
    '0 9 * * 4': 'Thursdays 09:00',
    '30 18 * * 5': 'Fridays 18:30',
    '0 3 * * 0': 'Sundays 03:00',
    '0 6 * * 0': 'Sundays 06:00',
    '0 1 * * 0': 'Sundays 01:00',
    '0 6 * * 1': 'Mondays 06:00',
    '0 8,14,20 * * *': 'Daily 08:00, 14:00, 20:00',
    '0 4 1 * *': '1st of month 04:00',
  };
  return CANNED[expr] ?? expr;
}

/** Compute next fire time for a cron expression (UTC). */
function nextFireAtIso(expr: string): string | null {
  try {
    const interval = CronExpressionParser.parse(expr, { tz: 'UTC' });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

// ─── Route ──────────────────────────────────────────────────────────

/**
 * Middleware: require a portal read-capable token on every request to this
 * sub-router.
 *
 * The parent iOS router skips `authMiddleware` for us (see `router.ts`
 * where this sub-router is mounted BEFORE the JWT middleware), and the
 * portal-token middleware in `server.ts` explicitly bypasses `/v1/*` —
 * so we have to verify the token ourselves. Local unauthenticated
 * preview is now explicit opt-in via PORTAL_ALLOW_LOCAL_BYPASS=true
 * and only on loopback in non-production runtimes.
 */
export function contentDashboardRoutes(): Router {
  const router = Router();
  const dashboardRateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: CONTENT_DASHBOARD_RATE_LIMIT_PER_MINUTE,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many content dashboard requests. Slow down.',
          retryAfter,
        },
      });
    },
  });

  router.get('/', dashboardRateLimitMiddleware, requirePortalToken, (_req: Request, res: Response) => {
    try {
      const ownerTarget = getOwnerBootstrapTarget();
      const payload = buildContentDashboard(ownerTarget ? {
        tenantId: ownerTarget.tenantId,
        userId: ownerTarget.tenantId,
      } : undefined);
      // 10s edge cache so rapid polling from the portal doesn't hammer the DB
      res.set('Cache-Control', 'private, max-age=10');
      res.json(payload);
    } catch (err: any) {
      logger.error({ errorName: safeDashboardErrorName(err) }, 'Content dashboard: build failed');
      sendInternalError(res, 'Failed to build content dashboard');
    }
  });

  return router;
}

// ─── Builder ────────────────────────────────────────────────────────

/**
 * Builds the full content dashboard payload. Extracted from the route
 * handler so it can be unit-tested in isolation and warm-called in
 * the future if we ever add a cache layer.
 */
export function buildContentDashboard(contentScope?: ContentWorkspaceScope): ContentDashboardResponse {
  const db = getDb();
  const unavailableSections: ContentDashboardResponse['unavailableSections'] = [];
  const markUnavailable = (
    section: ContentDashboardAvailabilitySection,
    err: unknown,
    message: string,
  ): void => {
    if (!unavailableSections.includes(section)) unavailableSections.push(section);
    logger.warn({ errorName: safeDashboardErrorName(err), section }, message);
  };

  // ── Commands — call counts from api_usage ──────────────────────────
  const names = CONTENT_COMMANDS.map((c) => c.name);
  const usage7d = fetchUsageByCategories(names, '-7 days');
  const usage30d = fetchUsageByCategories(names, '-30 days');

  const byGroup = new Map<string, ContentDashboardResponse['commands'][number]>();
  for (const cmd of CONTENT_COMMANDS) {
    const u7 = usage7d.get(cmd.name) ?? { calls: 0, cost: 0, lastTs: null };
    const u30 = usage30d.get(cmd.name) ?? { calls: 0, cost: 0, lastTs: null };
    let bucket = byGroup.get(cmd.group);
    if (!bucket) {
      bucket = { group: cmd.group, rows: [] };
      byGroup.set(cmd.group, bucket);
    }
    bucket.rows.push({
      name: cmd.name,
      label: cmd.label,
      description: cmd.description,
      calls7d: u7.calls,
      calls30d: u30.calls,
      lastUsedAt: u30.lastTs,
      costUsd7d: Math.round(u7.cost * 10000) / 10000,
    });
  }
  const commands = Array.from(byGroup.values()).sort((a, b) => a.group.localeCompare(b.group));

  // ── Books ──────────────────────────────────────────────────────────
  let books: ContentDashboardResponse['books'] = {
    total: 0,
    extracted: 0,
    pending: 0,
    rows: [],
  };
  try {
    books = getBooks(50, db);
  } catch (err) {
    markUnavailable('books', err, 'Content dashboard: book library read unavailable');
  }

  // ── YouTube research ───────────────────────────────────────────────
  let youtube: ContentDashboardResponse['youtube'] = {
    channels: [],
    videos: [],
    totals: { channels: 0, activeChannels: 0, transcripts: 0, studies: 0 },
  };
  try {
    const channelRows = db.prepare(`
      SELECT id, channel_url, channel_name, status, video_count_analyzed,
             last_analyzed_at, error_message
        FROM content_ref_channels
       WHERE ${platformContentScopePredicate()}
       ORDER BY (status = 'active') DESC, channel_name ASC
       LIMIT 30
    `).all() as Array<{
      id: number;
      channel_url: string;
      channel_name: string | null;
      status: string;
      video_count_analyzed: number;
      last_analyzed_at: string | null;
      error_message: string | null;
    }>;

    const videoRows = db.prepare(`
      SELECT vt.video_id, vt.title, vt.channel_name,
             vs.study_type, vs.created_at as study_created_at,
             vt.created_at as transcript_created_at
        FROM video_transcripts vt
   LEFT JOIN video_studies vs
          ON vs.video_id = vt.video_id
         AND ${platformContentScopePredicate('vs')}
       WHERE ${platformContentScopePredicate('vt')}
       ORDER BY COALESCE(vs.created_at, vt.created_at) DESC
       LIMIT 30
    `).all() as Array<{
      video_id: string;
      title: string | null;
      channel_name: string | null;
      study_type: string | null;
      study_created_at: string | null;
      transcript_created_at: string;
    }>;

    const totalsRow = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM content_ref_channels WHERE ${platformContentScopePredicate()}) as channels,
        (SELECT COUNT(*) FROM content_ref_channels WHERE status = 'active' AND ${platformContentScopePredicate()}) as active_channels,
        (SELECT COUNT(*) FROM video_transcripts WHERE ${platformContentScopePredicate()}) as transcripts,
        (SELECT COUNT(*) FROM video_studies WHERE ${platformContentScopePredicate()}) as studies
    `).get() as {
      channels: number;
      active_channels: number;
      transcripts: number;
      studies: number;
    } | undefined;

    youtube = {
      channels: channelRows.map((r) => ({
        id: r.id,
        url: r.channel_url,
        name: r.channel_name,
        status: r.status,
        videosAnalyzed: r.video_count_analyzed ?? 0,
        lastAnalyzedAt: r.last_analyzed_at,
        errorMessage: r.error_message,
      })),
      videos: videoRows.map((r) => ({
        videoId: r.video_id,
        title: r.title,
        channelName: r.channel_name,
        studyType: r.study_type,
        hasStudy: !!r.study_type,
        createdAt: r.study_created_at ?? r.transcript_created_at,
        youtubeUrl: `https://www.youtube.com/watch?v=${r.video_id}`,
      })),
      totals: {
        channels: totalsRow?.channels ?? 0,
        activeChannels: totalsRow?.active_channels ?? 0,
        transcripts: totalsRow?.transcripts ?? 0,
        studies: totalsRow?.studies ?? 0,
      },
    };
  } catch (err) {
    markUnavailable('youtube', err, 'Content dashboard: YouTube research read unavailable');
  }

  // ── Agent graph — overlay live agent_runs data on the static graph ─
  const liveStats = new Map<
    string,
    { last_run: string | null; last_status: string; signals_produced: number; total_runs: number }
  >();
  try {
    const stats = getAgentStats({ strict: true });
    for (const s of stats) {
      liveStats.set(normalizeContentAgentRuntimeId(String(s.agent)), s as any);
    }
  } catch (err) {
    markUnavailable('agentStats', err, 'Content dashboard: agent runtime stats unavailable');
  }

  const agentGraph: ContentDashboardResponse['agentGraph'] = {
    nodes: AGENT_GRAPH_NODES.map((n) => {
      const stats = liveStats.get(normalizeContentAgentRuntimeId(n.id));
      const paused = n.lifecycle === 'paused';
      return {
        ...n,
        lastRun: paused ? null : (stats?.last_run ?? null),
        lastStatus: paused ? 'paused' : (stats?.last_status ?? 'never'),
        totalRuns: paused ? 0 : (stats?.total_runs ?? 0),
        signalsProduced: paused ? 0 : (stats?.signals_produced ?? 0),
      };
    }),
    edges: AGENT_GRAPH_EDGES.filter((edge) => (
      !isPausedContentAgent(edge.from) && !isPausedContentAgent(edge.to)
    )),
  };

  // ── Triggers — content-domain cron jobs from telemetry ─────────────
  const triggers: ContentDashboardResponse['triggers'] = [];
  try {
    const allJobs = getJobStatuses();
    const contentJobs = allJobs.filter((j) => j.domain === 'content');
    for (const job of contentJobs) {
      const lifecycle: 'active' | 'paused' = isPausedContentAgent(job.name) ? 'paused' : 'active';
      const status: 'ok' | 'failed' | 'running' | 'never' | 'paused' =
        lifecycle === 'paused'
          ? 'paused'
          : job.lastResult === 'success'
          ? 'ok'
          : job.lastResult === 'failed'
            ? 'failed'
            : job.lastResult === 'running'
              ? 'running'
              : 'never';
      triggers.push({
        name: job.name,
        label: job.label,
        cronExpression: job.cronExpression,
        cronHuman: humanizeCron(job.cronExpression),
        domain: job.domain,
        lastRunAt: lifecycle === 'paused' ? null : job.lastRunAt,
        lastResult: lifecycle === 'paused' ? 'paused' : job.lastResult,
        lastDurationMs: lifecycle === 'paused' ? null : job.lastDurationMs,
        nextFireAt: lifecycle === 'paused' ? null : nextFireAtIso(job.cronExpression),
        lifecycle,
        status,
      });
    }
    // Sort: failed first, then oldest last-run first so stale jobs bubble up
    triggers.sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === 'failed') return -1;
        if (b.status === 'failed') return 1;
      }
      return (a.lastRunAt ?? '').localeCompare(b.lastRunAt ?? '');
    });
  } catch (err) {
    markUnavailable('triggers', err, 'Content dashboard: trigger status read unavailable');
  }

  // ── Voice DNA — extracted content knowledge categories ─────────────
  const CATEGORY_LABELS: Record<string, string> = {
    hook_style: 'Hook Styles',
    title_pattern: 'Title Patterns',
    content_structure: 'Content Structure',
    editing_style: 'Editing Style',
    storytelling: 'Storytelling',
    cta_pattern: 'CTA Patterns',
    audience_engagement: 'Audience Engagement',
    visual_style: 'Visual Style',
    brand_voice: 'Brand Voice',
    addition_pattern: 'Additions (Voice Evolution)',
    removal_pattern: 'Removals (Voice Evolution)',
    rephrasing_pattern: 'Rephrasings (Voice Evolution)',
    book_influence: 'Book Influence',
    voice_summary: 'Voice Summary',
  };

  let voiceDna: ContentDashboardResponse['voiceDna'] = [];
  try {
    voiceDna = getVoiceDna(db);
  } catch (err) {
    markUnavailable('voiceDna', err, 'Content dashboard: voice DNA read unavailable');
  }

  // ── Reaction Radar — signals + last run ────────────────────────────
  let reactionRadar: ContentDashboardResponse['reactionRadar'] = {
    activeSignals: 0,
    recentSignals: [],
    lastRunAt: null,
    lastStatus: 'paused',
  };
  if (!isPausedContentAgent('reaction_radar')) {
    try {
      const signals = filterActiveContentAgentSignals(getSignalLog(40, undefined, undefined, {
        excludeSourceAgents: PAUSED_CONTENT_AGENT_IDS,
      }));
      const radarSignals = signals.filter((s) =>
        s.signal_type === 'reaction_opportunity' ||
        s.signal_type === 'trending_spike' ||
        s.signal_type === 'competitor_upload',
      );
      const radarStats = liveStats.get(normalizeContentAgentRuntimeId('reaction_radar'));
      reactionRadar = {
        activeSignals: radarSignals.filter((s) => s.status === 'active').length,
        recentSignals: radarSignals.slice(0, 20).map((s) => ({
          id: s.id,
          type: s.signal_type,
          priority: s.priority,
          summary: formatSignalSummary(s.signal_type, s.payload),
          createdAt: s.created_at,
          status: s.status,
        })),
        lastRunAt: radarStats?.last_run ?? null,
        lastStatus: radarStats?.last_status ?? 'never',
      };
    } catch (err) {
      logger.debug({ errorName: safeDashboardErrorName(err) }, 'Content dashboard: reaction radar query failed');
    }
  }

  // ── Pipeline — stage counts + recent items ─────────────────────────
  let pipeline: ContentDashboardResponse['pipeline'] = {
    availability: 'unavailable',
    source: 'content_workspace',
    reasonCode: contentScope ? 'CONTENT_WORKSPACE_READ_FAILED' : 'CONTENT_WORKSPACE_SCOPE_UNAVAILABLE',
    stages: {},
    stageTracking: {},
    bottleneck: null,
    publishedThisWeek: null,
    publicationTracking: {
      availability: 'unavailable',
      reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
      publicationExecution: 'not_supported',
    },
    totalActive: 0,
    recent: [],
  };
  try {
    if (!contentScope) throw new Error('Content workspace scope unavailable');
    const stats = getPipelineStats(contentScope);
    const recent = getPipelineRecent(contentScope, 30, db);
    pipeline = {
      availability: stats.availability,
      source: stats.source,
      reasonCode: null,
      stages: stats.stages,
      stageTracking: stats.stageTracking,
      bottleneck: stats.bottleneck,
      publishedThisWeek: stats.publishedThisWeek,
      publicationTracking: stats.publicationTracking,
      totalActive: stats.totalActive,
      recent,
    };
  } catch (err) {
    logger.debug({ errorName: safeDashboardErrorName(err) }, 'Content dashboard: pipeline query failed');
  }

  // ── Knowledge categories stats + ref channel count ─────────────────
  let knowledgeStats: { category: string; updatedAt: string; sources: number }[] = [];
  let referenceChannels = 0;
  try {
    const ks = getKnowledgeStats(db);
    knowledgeStats = ks.categories;
    referenceChannels = ks.referenceChannels;
  } catch (err) {
    markUnavailable('knowledgeStats', err, 'Content dashboard: knowledge stats read unavailable');
  }

  // Also include an aggregate active-signal count so the UI can show
  // a global badge without having to sum its own filter.
  let activeTotal = 0;
  if (!contentScope) {
    markUnavailable(
      'activeSignals',
      new Error('Content workspace scope unavailable'),
      'Content dashboard: active signal scope unavailable',
    );
  } else {
    try {
      activeTotal = getActiveSignalCount(contentScope.userId, contentScope.tenantId, {
        excludeSourceAgents: PAUSED_CONTENT_AGENT_IDS,
        excludeIneligibleContentLearningDigests: true,
        strict: true,
      });
    } catch (err) {
      markUnavailable('activeSignals', err, 'Content dashboard: active signal count unavailable');
    }
  }

  const availability: ContentDashboardResponse['availability'] = unavailableSections.length === 0
    ? 'available'
    : unavailableSections.length === CONTENT_DASHBOARD_AVAILABILITY_SECTIONS.length
      ? 'unavailable'
      : 'partial';

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    availability,
    unavailableSections,
    scope: {
      mode: 'mixed_operator_overview',
      workspaceScope: contentScope ?? null,
      workspaceScopedSections: ['pipeline', 'activeSignals'],
      platformSections: [
        'commands',
        'books',
        'youtube',
        'agentGraph',
        'triggers',
        'voiceDna',
        'reactionRadar',
        'knowledgeStats',
        'referenceChannels',
      ],
    },
    commands,
    books,
    youtube,
    agentGraph,
    triggers,
    voiceDna,
    reactionRadar,
    pipeline,
    knowledgeStats,
    referenceChannels,
    activeSignals: activeTotal,
  };
}

function safeDashboardErrorName(error: unknown): string {
  const candidate = error instanceof Error && error.name ? error.name : typeof error;
  return candidate.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'UnknownError';
}

// ─── Small helpers ──────────────────────────────────────────────────

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      return v
        .map((x) => (typeof x === 'string' ? x : (x?.name ?? x?.title ?? JSON.stringify(x))))
        .filter(Boolean)
        .slice(0, 20);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Build a short human summary of an agent signal's payload. Keeps the
 * portal UI lightweight — we don't ship the whole payload to the browser
 * for every row.
 */
function formatSignalSummary(type: string, payload: Record<string, any>): string {
  if (!payload || typeof payload !== 'object') return type;
  switch (type) {
    case 'reaction_opportunity':
      return (
        payload.title ||
        payload.topic ||
        payload.channel_name ||
        'New reaction opportunity'
      );
    case 'trending_spike':
      return payload.topic || payload.keyword || payload.title || 'Trending spike detected';
    case 'competitor_upload':
      return payload.channel || payload.channel_name || payload.title || 'Competitor upload';
    case 'pipeline_bottleneck':
      return `${payload.stage ?? 'stage'} bottleneck: ${payload.count ?? '?'} items`;
    case 'content_sprint_mode':
      return payload.enabled ? 'Sprint mode ON' : 'Sprint mode OFF';
    case 'hook_effectiveness':
      return payload.hook || payload.pattern || 'Hook effectiveness update';
    case 'voice_pattern':
      return payload.pattern || payload.category || 'Voice pattern signal';
    case 'book_knowledge':
      return payload.book || payload.title || 'Book knowledge update';
    default:
      return (
        payload.summary ||
        payload.title ||
        payload.topic ||
        payload.message ||
        type
      );
  }
}
