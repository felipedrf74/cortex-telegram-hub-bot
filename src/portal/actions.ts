// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { runPerformanceAgent } from '../agents/performance-agent';
import { runVoiceEvolutionAgent } from '../agents/voice-evolution-agent';
import { runReactionRadar } from '../agents/reaction-radar-agent';
import { runSEOAgent } from '../agents/seo-agent';
import { runPipelineAgent } from '../agents/pipeline-agent';
import { sendDailyBriefing, refreshConnectedGarminUsers } from '../services/scheduler';
import { isMicrosoftConfigured } from '../services/microsoft-auth';
import { isInvoiceFilingConfigured } from '../services/invoice-filer';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { clearAllConversations } from '../state/conversation';
import { synthesizeKnowledge as reSynthesizeKnowledge } from '../services/channel-learner';
import { logger } from '../utils/logger';
import { pushEvent } from './telemetry';

export type PortalActionResult = { ok: boolean; message: string };

export const VALID_PORTAL_ACTIONS = new Set([
  'refresh-garmin',
  'trigger-briefing',
  'clear-history',
  'test-invoice-storage',
  'test-graph',
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
): Promise<PortalActionResult> {
  switch (name) {
    case 'refresh-garmin': {
      // The portal authenticates with PORTAL_TOKEN rather than a user JWT, so
      // there is no request user to inherit. This used to call
      // `garminKeepAlive()` bare, which became a silent no-op once
      // `resolveGarminUserId` stopped falling back to the owner — the button
      // then always reported failure. Refresh every connected user explicitly,
      // reusing the same scoped fan-out as the cron.
      const outcome = await refreshConnectedGarminUsers('manual');
      if (outcome.total === 0) {
        pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: 'Manual Garmin refresh: no connected users' });
        return { ok: false, message: 'No Garmin-connected users to refresh' };
      }
      const ok = outcome.failed.length === 0;
      const summary = `${outcome.refreshed}/${outcome.total} refreshed`;
      pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: `Manual Garmin refresh: ${summary}` });
      return { ok, message: ok ? `Garmin sessions refreshed (${summary})` : `Garmin refresh incomplete (${summary})` };
    }

    case 'trigger-briefing': {
      await sendDailyBriefing();
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual morning briefing sent' });
      return { ok: true, message: 'Morning briefing stored and pushed' };
    }

    case 'clear-history': {
      const ownerTarget = getOwnerBootstrapTarget();
      if (!ownerTarget) return { ok: false, message: 'Owner bootstrap target unavailable' };
      clearAllConversations(ownerTarget.tenantId);
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Conversation history cleared' });
      return { ok: true, message: 'All conversation history cleared' };
    }

    case 'test-invoice-storage': {
      const ok = isInvoiceFilingConfigured();
      pushEvent({
        ts: new Date().toISOString(),
        type: ok ? 'auth' : 'error',
        summary: `Invoice object storage test: ${ok ? 'configured' : 'not configured'}`,
      });
      return {
        ok,
        message: ok ? 'Invoice object storage configured' : 'Invoice object storage not configured',
      };
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
      const ownerTarget = getOwnerBootstrapTarget();
      if (!ownerTarget) return { ok: false, message: 'Owner bootstrap target unavailable' };
      await runPipelineAgent({
        tenantId: ownerTarget.tenantId,
        userId: ownerTarget.tenantId,
      });
      return { ok: true, message: 'Pipeline Agent completed' };
    }

    default:
      return { ok: false, message: `Unknown action: ${name}` };
  }
}
