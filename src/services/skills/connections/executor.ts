// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { getIntegrationSummary } from '../../integration-status';

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
