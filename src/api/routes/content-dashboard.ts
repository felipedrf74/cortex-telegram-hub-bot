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
 *      the admin portal (which sends `Authorization: Bearer <PORTAL_TOKEN>`)
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

import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { getJobStatuses } from '../../portal/telemetry';
import { getPipelineStats } from '../../agents/pipeline-agent';
import {
  getAgentStats,
  getSignalLog,
  getActiveSignalCount,
} from '../../services/intelligence-bus';
import { CronExpressionParser } from 'cron-parser';

// ─── Static registries ──────────────────────────────────────────────

/**
 * Every chat slash command handled by `src/handlers/commands/content.ts`,
 * with a human label and category grouping. The `name` is the literal
 * command string (no leading slash) as it appears in the handler file.
 *
 * The call counts that sit next to each row in the UI come from the
 * `api_usage` table at request time, matching `category` strings that
 * include the command name. Any command the code hasn't tracked through
 * `trackedCreate` (e.g. pure DB reads like /books) simply reports 0.
 */
interface CommandRegistryRow {
  name: string;
  label: string;
  group: 'discover' | 'ideate' | 'script' | 'visuals' | 'analysis' | 'library' | 'seo' | 'pipeline' | 'research';
  description: string;
}

const CONTENT_COMMANDS: CommandRegistryRow[] = [
  // ── Discovery & research ────────────────────────────────────────────
  { name: 'discover',     label: '/discover',     group: 'discover', description: 'Autopilot content discovery — web + YouTube trends.' },
  { name: 'deepsearch',   label: '/deepsearch',   group: 'discover', description: 'Deep research brief for a topic.' },
  { name: 'sources',      label: '/sources',      group: 'discover', description: 'List sources from the last deep search.' },
  { name: 'hotnews',      label: '/hotnews',      group: 'discover', description: 'Ranked hot news in your niches.' },
  { name: 'trending',     label: '/trending',     group: 'discover', description: 'YouTube trending by pillar.' },
  { name: 'transcribe',   label: '/transcribe',   group: 'research', description: 'Fetch and store a YouTube transcript.' },
  { name: 'studyvideo',   label: '/studyvideo',   group: 'research', description: 'Deep study a YouTube video (hook, structure, reel cuts).' },
  { name: 'learnfrom',    label: '/learnfrom',    group: 'research', description: 'Register a YouTube channel as a reference and analyze it.' },
  { name: 'references',   label: '/references',   group: 'research', description: 'List all registered reference channels.' },
  { name: 'relearn',      label: '/relearn',      group: 'research', description: 'Re-run channel learner across all references.' },
  // ── Ideation ────────────────────────────────────────────────────────
  { name: 'ideas',        label: '/ideas',        group: 'ideate',   description: 'Generate new content ideas for a pillar.' },
  { name: 'hooks',        label: '/hooks',        group: 'ideate',   description: 'Hook ideas for a given topic.' },
  { name: 'titles',       label: '/titles',       group: 'ideate',   description: 'Title variants for a topic.' },
  { name: 'reaction',     label: '/reaction',     group: 'ideate',   description: 'Build a reaction-video brief from a URL.' },
  { name: 'contenttopic', label: '/contenttopic', group: 'ideate',   description: 'Suggest the next topic using approved taste profile.' },
  { name: 'contentretro', label: '/contentretro', group: 'ideate',   description: 'Retrospective on last week of topic feedback.' },
  // ── Scripting ───────────────────────────────────────────────────────
  { name: 'script',       label: '/script',       group: 'script',   description: 'Generate a script from a topic.' },
  { name: 'genscript',    label: '/genscript',    group: 'script',   description: 'Generate a production-ready long-form script.' },
  { name: 'buildscript',  label: '/buildscript',  group: 'script',   description: 'Assemble a script from approved sections.' },
  { name: 'reel',         label: '/reel',         group: 'script',   description: 'Short-form reel script.' },
  { name: 'repurpose',    label: '/repurpose',    group: 'script',   description: 'Repurpose long-form content into reels.' },
  // ── Visuals ─────────────────────────────────────────────────────────
  { name: 'genthumbnail', label: '/genthumbnail', group: 'visuals',  description: 'Generate thumbnail copy + concept.' },
  { name: 'gencaption',   label: '/gencaption',   group: 'visuals',  description: 'Generate captions and on-screen text.' },
  // ── Analysis ────────────────────────────────────────────────────────
  { name: 'competitor',   label: '/competitor',   group: 'analysis', description: 'Competitive intel brief for a channel or niche.' },
  { name: 'gaps',         label: '/gaps',         group: 'analysis', description: 'Content gap analysis for a pillar.' },
  { name: 'brandcheck',   label: '/brandcheck',   group: 'analysis', description: 'Check a draft against the brand voice guidelines.' },
  { name: 'feedback',     label: '/feedback',     group: 'analysis', description: 'Log human feedback on a piece of content.' },
  { name: 'report',       label: '/report',       group: 'analysis', description: 'Generate a performance report.' },
  // ── Book knowledge ─────────────────────────────────────────────────
  { name: 'addbook',      label: '/addbook',      group: 'library',  description: 'Add a book and extract its knowledge.' },
  { name: 'booknote',     label: '/booknote',     group: 'library',  description: 'Attach a personal note to a book.' },
  { name: 'books',        label: '/books',        group: 'library',  description: 'List books in the library with extraction status.' },
  { name: 'bookidea',     label: '/bookidea',     group: 'library',  description: 'Generate a content idea grounded in a book framework.' },
  // ── SEO ─────────────────────────────────────────────────────────────
  { name: 'seo',          label: '/seo',          group: 'seo',      description: 'Full SEO brief for a topic.' },
  { name: 'seokeyword',   label: '/seokeyword',   group: 'seo',      description: 'Register a keyword for rank tracking.' },
  { name: 'seorank',      label: '/seorank',      group: 'seo',      description: 'Current ranks for tracked keywords.' },
  // ── Pipeline ────────────────────────────────────────────────────────
  { name: 'pipeline',     label: '/pipeline',     group: 'pipeline', description: 'Pipeline status summary (all stages).' },
  { name: 'filmed',       label: '/filmed',       group: 'pipeline', description: 'Mark an approved item as filmed.' },
  { name: 'editing',      label: '/editing',      group: 'pipeline', description: 'Mark an item as in editing.' },
  { name: 'published',    label: '/published',    group: 'pipeline', description: 'Mark an item as published and attach URL.' },
  { name: 'autoresearch', label: '/autoresearch', group: 'pipeline', description: 'Kick off a prompt-optimization experiment.' },
  { name: 'evalscore',    label: '/evalscore',    group: 'pipeline', description: 'Score a completed autoresearch run.' },
  { name: 'calendar',     label: '/calendar',     group: 'pipeline', description: 'Publish-ready content calendar.' },
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
    emits: ['channel_dna', 'voice_pattern'],
    consumes: [],
    cron: 'channel_relearn',
  },
  {
    id: 'book_extractor',
    label: 'Book Extractor',
    role: 'Extracts thesis, frameworks, quotes and pillar mapping from every book in the library.',
    emits: ['book_knowledge'],
    consumes: [],
    cron: null,
  },
  {
    id: 'voice_evolution',
    label: 'Voice Evolution',
    role: 'Monthly re-synthesis of the voice DNA — compares current to last, spots drift.',
    emits: ['voice_pattern', 'voice_phrase_trend'],
    consumes: ['channel_dna', 'book_knowledge'],
    cron: 'voice_evolution',
  },
  {
    id: 'reaction_radar',
    label: 'Reaction Radar',
    role: 'Scans reference channels + trending API three times a day for reaction-worthy uploads.',
    emits: ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
    consumes: ['channel_dna', 'book_knowledge', 'voice_pattern', 'pillar_performance'],
    cron: 'reaction_radar',
  },
  {
    id: 'content_discovery',
    label: 'Content Discovery',
    role: 'Autopilot topic discovery using web search + ranked heat scores.',
    emits: ['trending_spike'],
    consumes: ['pillar_performance', 'voice_pattern'],
    cron: null,
  },
  {
    id: 'content_workflow',
    label: 'Content Workflow',
    role: 'Weekly scheduler — Tuesday reels, Thursday YouTube, Friday package. Produces topic candidates.',
    emits: ['content_formula'],
    consumes: ['voice_pattern', 'book_knowledge', 'reaction_opportunity'],
    cron: 'friday_weekly',
  },
  {
    id: 'pipeline_agent',
    label: 'Pipeline Tracker',
    role: 'Monitors pipeline stages, flags bottlenecks, throttles topic generation when backlogged.',
    emits: ['pipeline_bottleneck', 'pipeline_capacity', 'content_sprint_mode'],
    consumes: ['content_published'],
    cron: 'pipeline_agent',
  },
  {
    id: 'performance_agent',
    label: 'Performance Intel',
    role: 'Weekly pull of YouTube Analytics — hooks, retention, pillar performance.',
    emits: ['hook_effectiveness', 'retention_pattern', 'pillar_performance'],
    consumes: [],
    cron: 'performance_agent',
  },
  {
    id: 'seo_agent',
    label: 'SEO Tracker',
    role: 'Weekly keyword rank checks + opportunity scoring.',
    emits: ['keyword_rank_change', 'keyword_opportunity'],
    consumes: [],
    cron: 'seo_agent',
  },
  {
    id: 'autoresearch',
    label: 'Autoresearch',
    role: 'Automated prompt optimization — mutates prompts, scores them against an eval set, keeps wins.',
    emits: ['learning_digest'],
    consumes: [],
    cron: 'autoresearch',
  },
];

const AGENT_GRAPH_EDGES: AgentEdge[] = [
  { from: 'channel_learner',  to: 'voice_evolution',  signal: 'channel_dna' },
  { from: 'channel_learner',  to: 'reaction_radar',   signal: 'channel_dna' },
  { from: 'book_extractor',   to: 'voice_evolution',  signal: 'book_knowledge' },
  { from: 'book_extractor',   to: 'reaction_radar',   signal: 'book_knowledge' },
  { from: 'book_extractor',   to: 'content_workflow', signal: 'book_knowledge' },
  { from: 'voice_evolution',  to: 'reaction_radar',   signal: 'voice_pattern' },
  { from: 'voice_evolution',  to: 'content_discovery', signal: 'voice_pattern' },
  { from: 'voice_evolution',  to: 'content_workflow', signal: 'voice_pattern' },
  { from: 'performance_agent', to: 'reaction_radar',  signal: 'pillar_performance' },
  { from: 'performance_agent', to: 'content_discovery', signal: 'pillar_performance' },
  { from: 'reaction_radar',   to: 'content_workflow', signal: 'reaction_opportunity' },
  { from: 'content_discovery', to: 'content_workflow', signal: 'trending_spike' },
  { from: 'content_workflow', to: 'pipeline_agent',   signal: 'content_formula' },
  { from: 'pipeline_agent',   to: 'content_workflow', signal: 'pipeline_bottleneck' },
  { from: 'pipeline_agent',   to: 'content_workflow', signal: 'content_sprint_mode' },
  { from: 'seo_agent',        to: 'content_workflow', signal: 'keyword_opportunity' },
];

// ─── Response type ──────────────────────────────────────────────────

export interface ContentDashboardResponse {
  ok: true;
  generatedAt: string;
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
    status: 'ok' | 'failed' | 'running' | 'never';
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
    stages: Record<string, number>;
    bottleneck: { stage: string; count: number; avgDays: number } | null;
    publishedThisWeek: number;
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
 * Middleware: require portal token on every request to this sub-router.
 *
 * The parent iOS router skips `authMiddleware` for us (see `router.ts`
 * where this sub-router is mounted BEFORE the JWT middleware), and the
 * portal-token middleware in `server.ts` explicitly bypasses `/v1/*` —
 * so we have to verify the token ourselves. In dev mode (no token
 * configured) we allow anonymous access for local preview.
 */
function requirePortalToken(req: Request, res: Response, next: NextFunction): void {
  const portalToken = config.portal.token;
  if (!portalToken) {
    // Dev mode — no token configured, allow anonymous access.
    next();
    return;
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${portalToken}`) {
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid portal token' } });
    return;
  }
  next();
}

export function contentDashboardRoutes(): Router {
  const router = Router();

  router.get('/', requirePortalToken, (_req: Request, res: Response) => {
    try {
      const payload = buildContentDashboard();
      // 10s edge cache so rapid polling from the portal doesn't hammer the DB
      res.set('Cache-Control', 'private, max-age=10');
      res.json(payload);
    } catch (err: any) {
      logger.error({ err }, 'Content dashboard: build failed');
      res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL', message: err?.message || 'Failed to build content dashboard' },
      });
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
export function buildContentDashboard(): ContentDashboardResponse {
  const db = getDb();

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
    const rows = db.prepare(`
      SELECT id, title, author, core_thesis, key_frameworks, pillar_mapping,
             extraction_status, times_referenced, created_at
        FROM book_library
       ORDER BY times_referenced DESC, created_at DESC
       LIMIT 50
    `).all() as Array<{
      id: number;
      title: string;
      author: string;
      core_thesis: string | null;
      key_frameworks: string | null;
      pillar_mapping: string | null;
      extraction_status: string;
      times_referenced: number;
      created_at: string;
    }>;
    const totalsRow = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN extraction_status = 'extracted' THEN 1 ELSE 0 END) as extracted,
        SUM(CASE WHEN extraction_status IN ('pending', 'extracting') THEN 1 ELSE 0 END) as pending
      FROM book_library
    `).get() as { total: number; extracted: number | null; pending: number | null } | undefined;
    books = {
      total: totalsRow?.total ?? 0,
      extracted: totalsRow?.extracted ?? 0,
      pending: totalsRow?.pending ?? 0,
      rows: rows.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        status: r.extraction_status,
        thesis: r.core_thesis,
        frameworks: safeJsonArray(r.key_frameworks),
        pillars: safeJsonArray(r.pillar_mapping),
        timesReferenced: r.times_referenced ?? 0,
        createdAt: r.created_at,
      })),
    };
  } catch (err) {
    logger.debug({ err }, 'Content dashboard: book_library query failed — returning empty');
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
   LEFT JOIN video_studies vs ON vs.video_id = vt.video_id
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
        (SELECT COUNT(*) FROM content_ref_channels) as channels,
        (SELECT COUNT(*) FROM content_ref_channels WHERE status = 'active') as active_channels,
        (SELECT COUNT(*) FROM video_transcripts) as transcripts,
        (SELECT COUNT(*) FROM video_studies) as studies
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
    logger.debug({ err }, 'Content dashboard: YouTube research query failed');
  }

  // ── Agent graph — overlay live agent_runs data on the static graph ─
  const liveStats = new Map<
    string,
    { last_run: string | null; last_status: string; signals_produced: number; total_runs: number }
  >();
  try {
    const stats = getAgentStats();
    for (const s of stats) {
      liveStats.set(String(s.agent), s as any);
    }
  } catch (err) {
    logger.debug({ err }, 'Content dashboard: getAgentStats failed');
  }

  const agentGraph: ContentDashboardResponse['agentGraph'] = {
    nodes: AGENT_GRAPH_NODES.map((n) => {
      const stats = liveStats.get(n.id);
      return {
        ...n,
        lastRun: stats?.last_run ?? null,
        lastStatus: stats?.last_status ?? 'never',
        totalRuns: stats?.total_runs ?? 0,
        signalsProduced: stats?.signals_produced ?? 0,
      };
    }),
    edges: AGENT_GRAPH_EDGES,
  };

  // ── Triggers — content-domain cron jobs from telemetry ─────────────
  const triggers: ContentDashboardResponse['triggers'] = [];
  try {
    const allJobs = getJobStatuses();
    const contentJobs = allJobs.filter((j) => j.domain === 'content');
    for (const job of contentJobs) {
      const status: 'ok' | 'failed' | 'running' | 'never' =
        job.lastResult === 'success'
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
        lastRunAt: job.lastRunAt,
        lastResult: job.lastResult,
        lastDurationMs: job.lastDurationMs,
        nextFireAt: nextFireAtIso(job.cronExpression),
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
    logger.debug({ err }, 'Content dashboard: getJobStatuses failed');
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
    const rows = db.prepare(`
      SELECT category, synthesized_text, source_channels, version, updated_at
        FROM content_knowledge
       ORDER BY updated_at DESC
    `).all() as Array<{
      category: string;
      synthesized_text: string;
      source_channels: string | null;
      version: number;
      updated_at: string;
    }>;
    voiceDna = rows.map((r) => ({
      category: r.category,
      label: CATEGORY_LABELS[r.category] ?? r.category,
      text: r.synthesized_text,
      sources: safeJsonArray(r.source_channels),
      version: r.version,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    logger.debug({ err }, 'Content dashboard: voice DNA query failed');
  }

  // ── Reaction Radar — signals + last run ────────────────────────────
  let reactionRadar: ContentDashboardResponse['reactionRadar'] = {
    activeSignals: 0,
    recentSignals: [],
    lastRunAt: null,
    lastStatus: 'never',
  };
  try {
    const signals = getSignalLog(40);
    const radarSignals = signals.filter((s) =>
      s.signal_type === 'reaction_opportunity' ||
      s.signal_type === 'trending_spike' ||
      s.signal_type === 'competitor_upload',
    );
    const radarStats = liveStats.get('reaction_radar');
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
    logger.debug({ err }, 'Content dashboard: reaction radar query failed');
  }

  // ── Pipeline — stage counts + recent items ─────────────────────────
  let pipeline: ContentDashboardResponse['pipeline'] = {
    stages: {},
    bottleneck: null,
    publishedThisWeek: 0,
    totalActive: 0,
    recent: [],
  };
  try {
    const stats = getPipelineStats();
    const recent = db.prepare(`
      SELECT id, topic_title, niche, stage, created_at, updated_at,
             published_url, published_at
        FROM content_pipeline
       ORDER BY updated_at DESC
       LIMIT 30
    `).all() as Array<{
      id: number;
      topic_title: string;
      niche: string | null;
      stage: string;
      created_at: string;
      updated_at: string;
      published_url: string | null;
      published_at: string | null;
    }>;
    pipeline = {
      stages: stats.stages,
      bottleneck: stats.bottleneck,
      publishedThisWeek: stats.publishedThisWeek,
      totalActive: stats.totalActive,
      recent: recent.map((r) => ({
        id: r.id,
        topicTitle: r.topic_title,
        niche: r.niche,
        stage: r.stage,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        publishedUrl: r.published_url,
        publishedAt: r.published_at,
      })),
    };
  } catch (err) {
    logger.debug({ err }, 'Content dashboard: pipeline query failed');
  }

  // ── Knowledge categories stats + ref channel count ─────────────────
  let knowledgeStats: { category: string; updatedAt: string; sources: number }[] = [];
  let referenceChannels = 0;
  try {
    const kStats = db.prepare(`
      SELECT category, updated_at,
             json_array_length(COALESCE(source_channels, '[]')) as sources
        FROM content_knowledge
       ORDER BY updated_at DESC
    `).all() as Array<{ category: string; updated_at: string; sources: number }>;
    knowledgeStats = kStats.map((r) => ({
      category: r.category,
      updatedAt: r.updated_at,
      sources: r.sources ?? 0,
    }));
    const rc = db.prepare('SELECT COUNT(*) as cnt FROM content_ref_channels').get() as { cnt: number } | undefined;
    referenceChannels = rc?.cnt ?? 0;
  } catch (err) {
    logger.debug({ err }, 'Content dashboard: knowledge-stats query failed');
  }

  // Also include an aggregate active-signal count so the UI can show
  // a global badge without having to sum its own filter.
  let activeTotal = 0;
  try {
    activeTotal = getActiveSignalCount();
  } catch {
    activeTotal = 0;
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
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
