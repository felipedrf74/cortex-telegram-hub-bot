/**
 * Cortex Status Portal — Express server.
 *
 * Runs inside the same Node.js process as the Grammy bot.
 * Provides:
 *   GET  /              → serves the single-page dashboard (portal.html)
 *   GET  /api/snapshot  → full JSON payload for the dashboard (cached 3s)
 *   POST /api/action/:name → quick actions (refresh garmin, trigger reports, etc.)
 *
 * Auth: Bearer token from PORTAL_TOKEN env var on all /api/* routes.
 */
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDb } from '../services/database';
import {
  getRecentEvents,
  getJobStatuses,
  getBotRef,
  isBotPollingActive,
  getLastMessageAt,
  getGarminRefreshStatus,
  isRestarting,
  setIsRestarting,
  setBotPollingActive,
  pushEvent,
} from './telemetry';
import { clearAllConversations } from '../state/conversation';
import { isGarminConfigured, keepAlive as garminKeepAlive } from '../services/garmin';
import { isMicrosoftConfigured } from '../services/microsoft-auth';
import { isInvoiceFilingConfigured } from '../services/invoice-filer';
import { sendDailyBriefing } from '../services/scheduler';
import { generateCoachBriefing } from '../services/garmin-coach';
import { runContentDiscovery } from '../services/content-discovery';
import { escapeHtml, splitMessage } from '../utils/telegram-formatter';

// ─── Types ──────────────────────────────────────────────────────────

interface SnapshotResponse {
  generatedAt: string;
  uptime: { seconds: number; human: string };
  bot: {
    polling: boolean;
    restarting: boolean;
    lastMessageAt: string | null;
  };
  integrations: {
    name: string;
    configured: boolean;
    status?: string;
    lastCheck?: string;
  }[];
  jobs: ReturnType<typeof getJobStatuses>;
  apiUsage: {
    today: { calls: number; cost: number; tokens: number };
    last7d: { calls: number; cost: number; tokens: number };
    last30d: { calls: number; cost: number; tokens: number };
    byCategory: { category: string; calls: number; cost: number }[];
  };
  recentEvents: ReturnType<typeof getRecentEvents>;
  invoices: {
    thisMonth: number;
    lastMonth: number;
    recentFilings: { vendor: string; date: string; amount: string | null; status: string }[];
  };
}

// ─── Snapshot Cache ─────────────────────────────────────────────────

let cachedSnapshot: { data: SnapshotResponse; at: number } | null = null;
const CACHE_TTL_MS = 3_000;

// ─── Rate Limiter (per-action, 30s cooldown) ────────────────────────

const actionCooldowns = new Map<string, number>();
const ACTION_COOLDOWN_MS = 30_000;

function isRateLimited(action: string): boolean {
  const last = actionCooldowns.get(action) ?? 0;
  return Date.now() - last < ACTION_COOLDOWN_MS;
}

function recordAction(action: string): void {
  actionCooldowns.set(action, Date.now());
}

// ─── Uptime Helper ──────────────────────────────────────────────────

const startedAt = Date.now();

function humanUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// ─── Snapshot Builder ───────────────────────────────────────────────

function buildSnapshot(): SnapshotResponse {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  const garminStatus = getGarminRefreshStatus();

  // ── Integration status list ────────────────────────────────────
  const integrations = [
    {
      name: 'Telegram Bot',
      configured: true,
      status: isBotPollingActive() ? 'polling' : isRestarting() ? 'restarting' : 'stopped',
    },
    {
      name: 'Microsoft Graph',
      configured: isMicrosoftConfigured(),
      status: isMicrosoftConfigured() ? 'configured' : 'not configured',
    },
    {
      name: 'Garmin Connect',
      configured: isGarminConfigured(),
      status: garminStatus.at
        ? `last refresh: ${garminStatus.ok ? '✓' : '✗'} at ${garminStatus.at}`
        : isGarminConfigured() ? 'awaiting first refresh' : 'not configured',
      lastCheck: garminStatus.at ?? undefined,
    },
    {
      name: 'Invoice Filing (SSH)',
      configured: isInvoiceFilingConfigured(),
      status: isInvoiceFilingConfigured() ? 'configured' : 'not configured',
    },
    {
      name: 'Anthropic API',
      configured: true,
      status: 'active',
    },
  ];

  // ── API usage from SQLite ──────────────────────────────────────
  const db = getDb();
  let apiUsage: SnapshotResponse['apiUsage'];
  try {
    const todayRow = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now')
    `).get() as any;

    const week = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now', '-7 days')
    `).get() as any;

    const month = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now', '-30 days')
    `).get() as any;

    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost
      FROM api_usage WHERE ts >= date('now', '-7 days')
      GROUP BY category ORDER BY cost DESC
    `).all() as any[];

    apiUsage = {
      today: { calls: todayRow.calls, cost: todayRow.cost, tokens: todayRow.tokens },
      last7d: { calls: week.calls, cost: week.cost, tokens: week.tokens },
      last30d: { calls: month.calls, cost: month.cost, tokens: month.tokens },
      byCategory,
    };
  } catch (err) {
    logger.warn({ err }, 'Portal: failed to query api_usage');
    apiUsage = {
      today: { calls: 0, cost: 0, tokens: 0 },
      last7d: { calls: 0, cost: 0, tokens: 0 },
      last30d: { calls: 0, cost: 0, tokens: 0 },
      byCategory: [],
    };
  }

  // ── Invoice filings from SQLite ────────────────────────────────
  let invoices: SnapshotResponse['invoices'];
  try {
    const thisMonth = db.prepare(`
      SELECT COUNT(*) as c FROM invoice_filings
      WHERE document_date >= date('now', 'start of month') AND status = 'filed'
    `).get() as any;

    const lastMonth = db.prepare(`
      SELECT COUNT(*) as c FROM invoice_filings
      WHERE document_date >= date('now', 'start of month', '-1 month')
        AND document_date < date('now', 'start of month')
        AND status = 'filed'
    `).get() as any;

    const recent = db.prepare(`
      SELECT vendor, document_date, amount, status
      FROM invoice_filings ORDER BY created_at DESC LIMIT 10
    `).all() as any[];

    invoices = {
      thisMonth: thisMonth.c,
      lastMonth: lastMonth.c,
      recentFilings: recent.map((r: any) => ({
        vendor: r.vendor,
        date: r.document_date ?? 'unknown',
        amount: r.amount,
        status: r.status,
      })),
    };
  } catch (err) {
    logger.warn({ err }, 'Portal: failed to query invoice_filings');
    invoices = { thisMonth: 0, lastMonth: 0, recentFilings: [] };
  }

  return {
    generatedAt: new Date().toISOString(),
    uptime: { seconds: uptimeSec, human: humanUptime(uptimeSec) },
    bot: {
      polling: isBotPollingActive(),
      restarting: isRestarting(),
      lastMessageAt: getLastMessageAt(),
    },
    integrations,
    jobs: getJobStatuses(),
    apiUsage,
    recentEvents: getRecentEvents(),
    invoices,
  };
}

// ─── Quick Actions ──────────────────────────────────────────────────

async function handleAction(
  name: string,
  bot: Bot,
): Promise<{ ok: boolean; message: string }> {
  switch (name) {
    // 1. Refresh Garmin session
    case 'refresh-garmin': {
      if (!isGarminConfigured()) return { ok: false, message: 'Garmin not configured' };
      const ok = await garminKeepAlive();
      pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: `Manual Garmin refresh: ${ok ? 'success' : 'failed'}` });
      return { ok, message: ok ? 'Garmin session refreshed' : 'Garmin refresh failed' };
    }

    // 2. Trigger morning briefing
    case 'trigger-briefing': {
      await sendDailyBriefing(bot);
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual morning briefing sent' });
      return { ok: true, message: 'Morning briefing sent to Telegram' };
    }

    // 3. Trigger coach report
    case 'trigger-coach': {
      if (!isGarminConfigured()) return { ok: false, message: 'Garmin not configured' };
      const result = await generateCoachBriefing();
      const chunks = splitMessage(result.message);
      for (const userId of config.telegram.allowedUserIds) {
        for (const chunk of chunks) {
          await bot.api.sendMessage(userId, chunk, { parse_mode: 'HTML' });
        }
      }
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual coach report sent' });
      return { ok: true, message: 'Coach report sent to Telegram' };
    }

    // 4. Trigger content discovery
    case 'trigger-content': {
      const discovery = await runContentDiscovery();
      let msg = `🎬 <b>Daily Content Ideas Ready</b>\n\n`;
      if (discovery.ideas.length > 0) {
        for (let i = 0; i < discovery.ideas.length; i++) {
          msg += `${i + 1}. ${escapeHtml(discovery.ideas[i])}\n`;
        }
      } else {
        msg += `Ideas generated but couldn't parse titles — check the file.\n`;
      }
      msg += `\n📁 <code>${escapeHtml(discovery.filePath)}</code>`;
      msg += `\n🔍 ${discovery.searchCount} web searches used`;
      for (const userId of config.telegram.allowedUserIds) {
        await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
      }
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual content discovery sent' });
      return { ok: true, message: `Content discovery complete — ${discovery.ideas.length} ideas` };
    }

    // 5. Clear conversation history
    case 'clear-history': {
      clearAllConversations();
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Conversation history cleared' });
      return { ok: true, message: 'All conversation history cleared' };
    }

    // 6. Test SSH connection (invoice filing)
    case 'test-ssh': {
      if (!isInvoiceFilingConfigured()) return { ok: false, message: 'Invoice filing not configured' };
      const { execFileSync } = await import('child_process');
      const sshArgs = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
      if (config.invoices.sshKeyPath) sshArgs.push('-i', config.invoices.sshKeyPath);
      if (config.invoices.sshPort !== '22') sshArgs.push('-p', config.invoices.sshPort);
      sshArgs.push(`${config.invoices.sshUser}@${config.invoices.sshHost}`, 'echo ok');
      try {
        execFileSync('ssh', sshArgs, { timeout: 15_000, stdio: 'pipe' });
        pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: 'SSH test: success' });
        return { ok: true, message: 'SSH connection successful' };
      } catch (err: any) {
        pushEvent({ ts: new Date().toISOString(), type: 'error', summary: `SSH test: failed — ${(err?.message ?? '').slice(0, 60)}` });
        return { ok: false, message: `SSH failed: ${err?.message ?? 'unknown error'}` };
      }
    }

    // 7. Test Microsoft Graph token
    case 'test-graph': {
      if (!isMicrosoftConfigured()) return { ok: false, message: 'Microsoft Graph not configured' };
      try {
        const { getGraphClient } = await import('../services/microsoft-auth');
        const me = await getGraphClient().api('/me').select('displayName').get();
        pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: `Graph test: OK (${me.displayName})` });
        return { ok: true, message: `Graph token valid — signed in as ${me.displayName}` };
      } catch (err: any) {
        pushEvent({ ts: new Date().toISOString(), type: 'error', summary: `Graph test: failed — ${(err?.message ?? '').slice(0, 60)}` });
        return { ok: false, message: `Graph failed: ${err?.message ?? 'unknown error'}` };
      }
    }

    // 8. Restart bot polling (safe: stop → wait → start with retry)
    case 'restart-polling': {
      if (isRestarting()) return { ok: false, message: 'Already restarting — please wait' };
      const botRef = getBotRef();
      if (!botRef) return { ok: false, message: 'Bot reference not available' };

      // Run async restart in background — respond immediately
      setIsRestarting(true);
      setImmediate(async () => {
        try {
          logger.info('Portal: stopping bot polling for restart...');
          botRef.stop();
          setBotPollingActive(false);
          pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Bot polling stopped for restart' });

          // Wait for Telegram to release the polling lock
          await new Promise((r) => setTimeout(r, 5_000));

          // Retry loop (up to 3 attempts, 15s apart)
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              logger.info({ attempt }, 'Portal: restarting bot polling...');
              await botRef.start({
                onStart: () => {
                  logger.info('Portal: bot polling restarted successfully');
                  setBotPollingActive(true);
                  setIsRestarting(false); // Clear BEFORE start() blocks indefinitely
                  pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Bot polling restarted successfully' });
                },
              });
              break; // start() blocks while polling — only reaches here after stop()
            } catch (err: any) {
              const is409 = err?.error_code === 409 || err?.message?.includes('409');
              if (is409 && attempt < 3) {
                logger.warn({ attempt }, 'Portal restart: 409 conflict, retrying...');
                await new Promise((r) => setTimeout(r, 15_000));
                continue;
              }
              throw err;
            }
          }
        } catch (err) {
          logger.error({ err }, 'Portal: bot restart failed');
          pushEvent({ ts: new Date().toISOString(), type: 'error', summary: `Bot restart failed: ${(err as Error)?.message?.slice(0, 60)}` });
        } finally {
          setIsRestarting(false);
        }
      });

      return { ok: true, message: 'Bot restart initiated — polling will resume in ~5s' };
    }

    default:
      return { ok: false, message: `Unknown action: ${name}` };
  }
}

// ─── Express App Factory ────────────────────────────────────────────

export function createPortalServer(bot: Bot): http.Server {
  const app = express();
  app.use(express.json());

  // ── Auth middleware for /api/* ──────────────────────────────────
  const portalToken = config.portal.token;

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!portalToken) {
      // No token configured — allow (dev mode)
      return next();
    }
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${portalToken}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // ── GET / — serve dashboard HTML ───────────────────────────────
  app.get('/', (_req: Request, res: Response) => {
    const htmlPath = path.join(__dirname, 'portal.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('Dashboard not found — portal.html is missing');
      return;
    }
    res.sendFile(htmlPath);
  });

  // ── GET /api/snapshot — full dashboard payload ─────────────────
  app.get('/api/snapshot', (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (cachedSnapshot && now - cachedSnapshot.at < CACHE_TTL_MS) {
        res.json(cachedSnapshot.data);
        return;
      }
      const data = buildSnapshot();
      cachedSnapshot = { data, at: now };
      res.json(data);
    } catch (err) {
      logger.error({ err }, 'Portal: snapshot failed');
      res.status(500).json({ error: 'Failed to build snapshot' });
    }
  });

  // ── POST /api/action/:name — quick actions ─────────────────────
  app.post('/api/action/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name);

    if (isRateLimited(name)) {
      res.status(429).json({ ok: false, message: 'Too many requests — wait 30s' });
      return;
    }

    try {
      recordAction(name);
      const result = await handleAction(name, bot);
      // Invalidate snapshot cache so next poll reflects the change
      cachedSnapshot = null;
      res.json(result);
    } catch (err) {
      logger.error({ err, action: name }, 'Portal: action failed');
      res.status(500).json({ ok: false, message: `Action failed: ${(err as Error)?.message ?? 'unknown'}` });
    }
  });

  // ── Start HTTP server ──────────────────────────────────────────
  const server = http.createServer(app);
  const bind = config.portal.bind;
  const port = config.portal.port;

  server.listen(port, bind, () => {
    logger.info({ port, bind }, `Cortex Status Portal running at http://${bind}:${port}`);
  });

  return server;
}
