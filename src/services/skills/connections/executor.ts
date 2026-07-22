// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import {
  claimActionRunForStepExecution,
  reconciliationPendingResult,
  replayDuplicateClaimedActionRun,
  updateClaimedActionRun,
  withProviderWriteTimeout,
} from '../../chat/executor/helpers';
import { getIntegrationSummary, getProviderStatus } from '../../integration-status';
import { getEventsWithDiagnostics, type CalendarSource } from '../../unified-calendar';
import { ensureAuthenticated as ensureGarminAuthenticated } from '../../garmin';
import { runWithContext } from '../../../utils/request-context';

export function executeConnectionsStatusStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  try {
    const summary = getIntegrationSummary(input.userId);
    const requestedProvider = typeof (step.args as any).provider === 'string' ? (step.args as any).provider : null;
    const providers = requestedProvider
      ? summary.providers.filter((provider) => provider.provider === requestedProvider)
      : summary.providers;
    return { step, status: 'verified_success', result: { providers, counts: summary.counts, capabilities: summary.capabilities } };
  } catch {
    return { step, status: 'failed', error: 'connections_status_failed' };
  }
}

export function executeConnectionsReconnectGuidanceStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const status = executeConnectionsStatusStep(step, input);
  if (status.status !== 'verified_success') return status;
  const provider = typeof (step.args as any).provider === 'string' ? (step.args as any).provider : null;
  return {
    step,
    status: 'verified_success',
    result: {
      ...(status.result as Record<string, unknown>),
      guidance: provider
        ? `Open Connections and reconnect ${provider} with the required scopes.`
        : 'Open Connections and reconnect the provider that is expired or missing required scopes.',
    },
  };
}

type ConnectionRefreshProbe = {
  provider: string;
  attempted: boolean;
  verified: boolean;
  providerState: string | null;
  evidence: Record<string, unknown>;
  error?: string;
};

function isUsableProviderState(state: string | undefined): boolean {
  return state === 'connected' || state === 'degraded';
}

function normalizeConnectionProvider(value: unknown): string {
  const provider = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (provider === 'google_calendar' || provider === 'gmail') return 'google';
  if (provider === 'outlook_calendar' || provider === 'outlook_mail' || provider === 'microsoft') return 'outlook';
  if (provider === 'apple_health' || provider === 'healthkit') return 'apple_health';
  return provider;
}

function calendarProbeWindow(input: ChatPlannerInput): { start: string; end: string } {
  const parsed = new Date(input.nowIso ?? Date.now());
  const startMs = Number.isFinite(parsed.getTime()) ? parsed.getTime() : Date.now();
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function probeConnectionRefresh(
  provider: string,
  input: ChatPlannerInput,
): Promise<ConnectionRefreshProbe> {
  if (!['google', 'outlook', 'garmin'].includes(provider)) {
    return {
      provider,
      attempted: false,
      verified: false,
      providerState: null,
      evidence: {},
      error: provider === 'apple_health'
        ? 'apple_health_sync_is_device_managed'
        : 'connection_sync_provider_unsupported',
    };
  }

  const before = getProviderStatus(input.userId, provider as 'google' | 'outlook' | 'garmin');
  if (!isUsableProviderState(before.state)) {
    return {
      provider,
      attempted: false,
      verified: false,
      providerState: before.state,
      evidence: {},
      error: 'connection_not_connected',
    };
  }

  if (provider === 'garmin') {
    const authenticated = await runWithContext({
      source: 'manual',
      userId: input.userId,
      tenantId: input.tenantId,
      garminSilent: true,
    }, () => ensureGarminAuthenticated({ silent: true }));
    const after = getProviderStatus(input.userId, 'garmin');
    const verified = authenticated === true && isUsableProviderState(after.state);
    return {
      provider,
      attempted: true,
      verified,
      providerState: after.state,
      evidence: { authenticated },
      ...(verified ? {} : { error: 'garmin_refresh_probe_failed' }),
    };
  }

  const source = provider as CalendarSource;
  const window = calendarProbeWindow(input);
  const diagnostics = await getEventsWithDiagnostics(
    window.start,
    window.end,
    input.userId,
    { sources: [source] },
  );
  const after = getProviderStatus(input.userId, provider as 'google' | 'outlook');
  const providerFulfilled = diagnostics.sources.fulfilled.includes(source);
  const verified = providerFulfilled && isUsableProviderState(after.state);
  return {
    provider,
    attempted: true,
    verified,
    providerState: after.state,
    evidence: {
      calendarStatus: diagnostics.status,
      fulfilledSources: diagnostics.sources.fulfilled,
      failedSources: diagnostics.sources.failed,
    },
    ...(verified ? {} : { error: 'calendar_refresh_probe_failed' }),
  };
}

export async function executeConnectionsRetrySyncStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
  confirmed: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  if (!confirmed) {
    return { step, status: 'needs_confirmation', error: 'connection_sync_confirmation_required' };
  }
  const provider = normalizeConnectionProvider((step.args as Record<string, unknown>).provider);
  if (!provider) return { step, status: 'blocked', error: 'connection_provider_required' };

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const result = await withProviderWriteTimeout(() => probeConnectionRefresh(provider, input));
    const status: ChatActionRunStatus = result.verified
      ? 'verified_success'
      : result.attempted
        ? 'failed'
        : 'blocked';
    if (!updateClaimedActionRun(claim, status, {
      result,
      verification: {
        verified: result.verified,
        method: 'provider_and_local_read_back',
        providerState: result.providerState,
        evidence: result.evidence,
      },
      error: result.error ? { reason: result.error } : undefined,
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: result.error };
  } catch {
    if (claim) {
      updateChatActionRun(claim.row.id, 'failed', {
        error: { message: 'connection_sync_failed' },
      });
    }
    return { step, status: 'failed', error: 'connection_sync_failed' };
  }
}
