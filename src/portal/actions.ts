// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Bot } from 'grammy';
import { config } from '../config';
import { runPerformanceAgent } from '../agents/performance-agent';
import { runVoiceEvolutionAgent } from '../agents/voice-evolution-agent';
import { runReactionRadar } from '../agents/reaction-radar-agent';
import { runSEOAgent } from '../agents/seo-agent';
import { runPipelineAgent } from '../agents/pipeline-agent';
import { dispatchCoachReports, dispatchContentReports } from '../services/manual-report-triggers';
import { sendDailyBriefing } from '../services/scheduler';
import { isGarminConfigured, keepAlive as garminKeepAlive } from '../services/garmin';
import { isMicrosoftConfigured } from '../services/microsoft-auth';
import { isInvoiceFilingConfigured } from '../services/invoice-filer';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { clearAllConversations } from '../state/conversation';
import { synthesizeKnowledge as reSynthesizeKnowledge } from '../services/channel-learner';
import { logger } from '../utils/logger';
import {
  getBotRef,
  isRestarting,
  setIsRestarting,
  setBotPollingActive,
  pushEvent,
} from './telemetry';

export type PortalActionResult = { ok: boolean; message: string };

export const VALID_PORTAL_ACTIONS = new Set([
  'refresh-garmin',
  'trigger-briefing',
  'trigger-coach',
  'trigger-content',
  'clear-history',
  'test-ssh',
  'test-graph',
  'restart-polling',
  'resynthesize-knowledge',
  'run-performance-agent',
  'run-voice-evolution',
  'run-reaction-radar',
  'run-seo-agent',
  'run-pipeline-agent',
]);

const actionCooldowns = new Map<string, number>();
export const PORTAL_ACTION_COOLDOWN_MS = 30_000;

export function isPortalActionRateLimited(action: string): boolean {
  const last = actionCooldowns.get(action) ?? 0;
  return Date.now() - last < PORTAL_ACTION_COOLDOWN_MS;
}

export function recordPortalAction(action: string): void {
  actionCooldowns.set(action, Date.now());
}

export function resetPortalActionCooldownsForTests(): void {
  actionCooldowns.clear();
}

export async function handlePortalAction(
  name: string,
  bot: Bot,
): Promise<PortalActionResult> {
  switch (name) {
    case 'refresh-garmin': {
      if (!isGarminConfigured()) return { ok: false, message: 'Garmin not configured' };
      const ok = await garminKeepAlive();
      pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: `Manual Garmin refresh: ${ok ? 'success' : 'failed'}` });
      return { ok, message: ok ? 'Garmin session refreshed' : 'Garmin refresh failed' };
    }

    case 'trigger-briefing': {
      await sendDailyBriefing(bot);
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual morning briefing sent' });
      return { ok: true, message: 'Morning briefing sent to Telegram' };
    }

    case 'trigger-coach': {
      if (!isGarminConfigured()) return { ok: false, message: 'Garmin not configured' };
      await dispatchCoachReports(async (telegramId, message, parseMode) => {
        await bot.api.sendMessage(telegramId, message, {
          parse_mode: parseMode ?? 'HTML',
        });
      });
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual coach report sent' });
      return { ok: true, message: 'Coach report sent to Telegram' };
    }

    case 'trigger-content': {
      await dispatchContentReports(async (telegramId, message, parseMode) => {
        await bot.api.sendMessage(telegramId, message, {
          parse_mode: parseMode ?? 'HTML',
        });
      });
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual content discovery sent' });
      return { ok: true, message: 'Content discovery sent to Telegram' };
    }

    case 'clear-history': {
      const ownerTarget = getOwnerBootstrapTarget();
      if (!ownerTarget) return { ok: false, message: 'Owner bootstrap target unavailable' };
      clearAllConversations(ownerTarget.tenantId);
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Conversation history cleared' });
      return { ok: true, message: 'All conversation history cleared' };
    }

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
      } catch (err) {
        logger.warn({ err }, 'Portal action SSH test failed');
        pushEvent({ ts: new Date().toISOString(), type: 'error', summary: 'SSH test: failed' });
        return { ok: false, message: 'SSH test failed' };
      }
    }

    case 'test-graph': {
      if (!isMicrosoftConfigured()) return { ok: false, message: 'Microsoft Graph not configured' };
      try {
        const { getGraphClient } = await import('../services/microsoft-auth');
        const me = await getGraphClient().api('/me').select('displayName').get();
        pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: `Graph test: OK (${me.displayName})` });
        return { ok: true, message: `Graph token valid - signed in as ${me.displayName}` };
      } catch (err) {
        logger.warn({ err }, 'Portal action Graph test failed');
        pushEvent({ ts: new Date().toISOString(), type: 'error', summary: 'Graph test: failed' });
        return { ok: false, message: 'Graph test failed' };
      }
    }

    case 'restart-polling': {
      if (isRestarting()) return { ok: false, message: 'Already restarting - please wait' };
      const botRef = getBotRef();
      if (!botRef) return { ok: false, message: 'Bot reference not available' };

      setIsRestarting(true);
      setImmediate(async () => {
        try {
          logger.info('Portal: stopping bot polling for restart...');
          botRef.stop();
          setBotPollingActive(false);
          pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Bot polling stopped for restart' });

          await new Promise((resolve) => setTimeout(resolve, 5_000));

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              logger.info({ attempt }, 'Portal: restarting bot polling...');
              await botRef.start({
                onStart: () => {
                  logger.info('Portal: bot polling restarted successfully');
                  setBotPollingActive(true);
                  setIsRestarting(false);
                  pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Bot polling restarted successfully' });
                },
              });
              break;
            } catch (err: any) {
              const is409 = err?.error_code === 409 || err?.message?.includes('409');
              if (is409 && attempt < 3) {
                logger.warn({ attempt }, 'Portal restart: 409 conflict, retrying...');
                await new Promise((resolve) => setTimeout(resolve, 15_000));
                continue;
              }
              throw err;
            }
          }
        } catch (err) {
          logger.error({ err }, 'Portal: bot restart failed');
          pushEvent({ ts: new Date().toISOString(), type: 'error', summary: 'Bot restart failed' });
        } finally {
          setIsRestarting(false);
        }
      });

      return { ok: true, message: 'Bot restart initiated - polling will resume in ~5s' };
    }

    case 'resynthesize-knowledge': {
      await reSynthesizeKnowledge();
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual knowledge re-synthesis' });
      return { ok: true, message: 'Content knowledge re-synthesized from all active channels' };
    }

    case 'run-performance-agent': {
      await runPerformanceAgent();
      return { ok: true, message: 'Performance Agent completed' };
    }
    case 'run-voice-evolution': {
      await runVoiceEvolutionAgent();
      return { ok: true, message: 'Voice Evolution Agent completed' };
    }
    case 'run-reaction-radar': {
      await runReactionRadar();
      return { ok: true, message: 'Reaction Radar completed' };
    }
    case 'run-seo-agent': {
      await runSEOAgent();
      return { ok: true, message: 'SEO Agent completed' };
    }
    case 'run-pipeline-agent': {
      await runPipelineAgent();
      return { ok: true, message: 'Pipeline Agent completed' };
    }

    default:
      return { ok: false, message: `Unknown action: ${name}` };
  }
}
