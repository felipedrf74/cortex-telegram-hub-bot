// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getIntegrationSummary,
  type IntegrationSummary,
  type ProviderIntegrationStatus,
} from '../../integration-status';
import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  isReadModelFreshEnough,
} from '../read-models';
import {
  buildChatCoreV2MessageResponse,
  normalizeChatCoreV2Locale,
} from '../response-contracts';
import {
  CONNECTIONS_STATUS_CAPABILITY,
  MAX_VISIBLE_CONNECTIONS,
  hashStable,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2ConnectionStatusData,
  ChatCoreV2ConnectionStatusItem,
  ChatCoreV2DeterministicReadRouteResult,
} from './types';

export function buildConnectionsStatusRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const summary = getIntegrationSummary(input.userId);
  const data = summarizeConnections(summary);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2ConnectionStatusData>({
    capabilityId: CONNECTIONS_STATUS_CAPABILITY,
    domain: 'connections',
    data,
    sourceEntityIds: data.topProviders.map((item) => item.entityId),
    sourceVersions: sourceVersionsForConnections(summary.providers),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'credential_adjacent',
    summary: buildConnectionsStatusText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildConnectionsStatusText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', CONNECTIONS_STATUS_CAPABILITY],
  });

  return {
    capabilityId: CONNECTIONS_STATUS_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function summarizeConnections(summary: IntegrationSummary): ChatCoreV2ConnectionStatusData {
  const topProviders = [...summary.providers]
    .filter((provider) => provider.state !== 'coming_soon' && provider.state !== 'not_configured')
    .sort((a, b) => {
      const rank = connectionStateRank(a.state) - connectionStateRank(b.state);
      if (rank !== 0) return rank;
      return a.provider.localeCompare(b.provider);
    })
    .slice(0, MAX_VISIBLE_CONNECTIONS)
    .map(connectionStatusItem);

  return {
    providerCount: summary.providers.length,
    connectedCount: summary.counts.connected,
    degradedCount: summary.counts.degraded,
    revokedCount: summary.counts.revoked,
    pendingCount: summary.counts.pending,
    disconnectedCount: summary.counts.disconnected,
    attentionCount: summary.counts.degraded + summary.counts.revoked + summary.counts.pending,
    capabilities: summary.capabilities,
    topProviders,
  };
}

function connectionStatusItem(provider: ProviderIntegrationStatus): ChatCoreV2ConnectionStatusItem {
  return {
    entityId: connectionEntityId(provider),
    provider: provider.provider,
    state: provider.state,
    connectedAt: provider.connectedAt,
    capabilities: provider.capabilities,
    needsAttention: provider.state === 'degraded' || provider.state === 'revoked' || provider.state === 'pending',
    reasonCode: provider.reasonCode ?? null,
    lastCheckedAt: provider.lastCheckedAt ?? null,
  };
}

function buildConnectionsStatusText(
  data: ChatCoreV2ConnectionStatusData,
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  const header = buildConnectionsStatusHeader(data, normalizedLocale);
  if (data.topProviders.length === 0) return header;
  const providerLines = data.topProviders.map((provider) => {
    const capabilities = provider.capabilities.length > 0
      ? connectionCapabilitiesSuffix(provider.capabilities, normalizedLocale)
      : '';
    return `- ${providerLabel(provider.provider)}: ${connectionStateLabel(provider.state, normalizedLocale)}${capabilities}`;
  });
  return `${header}\n\n${connectionListLabel(normalizedLocale)}\n${providerLines.join('\n')}`;
}

function buildConnectionsStatusHeader(
  data: ChatCoreV2ConnectionStatusData,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts: string[] = [];
  if (data.attentionCount > 0) parts.push(connectionCountPhrase(data.attentionCount, locale, 'attention'));
  if (data.connectedCount > 0) parts.push(connectionCountPhrase(data.connectedCount, locale, 'connected'));
  if (data.degradedCount > 0) parts.push(connectionCountPhrase(data.degradedCount, locale, 'limited'));
  if (data.pendingCount > 0) parts.push(connectionCountPhrase(data.pendingCount, locale, 'pending'));
  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}` : '';

  if (data.connectedCount === 0 && data.attentionCount === 0) {
    if (locale === 'pt-BR') return 'Nenhuma integração está conectada no momento.';
    if (locale === 'pt-PT') return 'Não tens integrações ligadas neste momento.';
    if (locale === 'es') return 'No tienes integraciones conectadas ahora.';
    return 'No integrations are connected right now.';
  }

  if (locale === 'pt-BR') return `Suas conexões têm ${data.connectedCount} ${plural(data.connectedCount, 'integração ativa', 'integrações ativas')}.${detail}`;
  if (locale === 'pt-PT') return `As tuas ligações têm ${data.connectedCount} ${plural(data.connectedCount, 'integração ativa', 'integrações ativas')}.${detail}`;
  if (locale === 'es') return `Tus conexiones tienen ${data.connectedCount} ${plural(data.connectedCount, 'integración activa', 'integraciones activas')}.${detail}`;
  return `Your connections have ${data.connectedCount} active ${data.connectedCount === 1 ? 'integration' : 'integrations'}.${detail}`;
}

function connectionCountPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'attention' | 'connected' | 'limited' | 'pending',
): string {
  if (locale === 'pt-BR') {
    if (kind === 'attention') return `${count} ${plural(count, 'precisa de atenção', 'precisam de atenção')}`;
    if (kind === 'connected') return `${count} ${plural(count, 'conectada', 'conectadas')}`;
    if (kind === 'limited') return `${count} ${plural(count, 'com dados limitados', 'com dados limitados')}`;
    return `${count} ${plural(count, 'pendente', 'pendentes')}`;
  }
  if (locale === 'pt-PT') {
    if (kind === 'attention') return `${count} ${plural(count, 'precisa de atenção', 'precisam de atenção')}`;
    if (kind === 'connected') return `${count} ${plural(count, 'ligada', 'ligadas')}`;
    if (kind === 'limited') return `${count} ${plural(count, 'com dados limitados', 'com dados limitados')}`;
    return `${count} ${plural(count, 'pendente', 'pendentes')}`;
  }
  if (locale === 'es') {
    if (kind === 'attention') return `${count} ${plural(count, 'necesita atención', 'necesitan atención')}`;
    if (kind === 'connected') return `${count} ${plural(count, 'conectada', 'conectadas')}`;
    if (kind === 'limited') return `${count} ${plural(count, 'con datos limitados', 'con datos limitados')}`;
    return `${count} ${plural(count, 'pendiente', 'pendientes')}`;
  }
  if (kind === 'attention') return `${count} needing attention`;
  if (kind === 'connected') return `${count} connected`;
  if (kind === 'limited') return `${count} limited`;
  return `${count} pending`;
}

function connectionListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Principais integrações:';
  if (locale === 'pt-PT') return 'Integrações principais:';
  if (locale === 'es') return 'Integraciones principales:';
  return 'Top integrations:';
}

function connectionStateLabel(state: string, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') {
    if (state === 'connected') return 'conectada';
    if (state === 'degraded') return 'dados limitados';
    if (state === 'revoked') return 'precisa reconectar';
    if (state === 'pending') return 'pendente';
    return 'desconectada';
  }
  if (locale === 'pt-PT') {
    if (state === 'connected') return 'ligada';
    if (state === 'degraded') return 'dados limitados';
    if (state === 'revoked') return 'precisa de voltar a ligar';
    if (state === 'pending') return 'pendente';
    return 'desligada';
  }
  if (locale === 'es') {
    if (state === 'connected') return 'conectada';
    if (state === 'degraded') return 'datos limitados';
    if (state === 'revoked') return 'necesita reconexión';
    if (state === 'pending') return 'pendiente';
    return 'desconectada';
  }
  if (state === 'connected') return 'connected';
  if (state === 'degraded') return 'limited data';
  if (state === 'revoked') return 'needs reconnect';
  if (state === 'pending') return 'pending';
  return 'disconnected';
}

function connectionCapabilitiesSuffix(capabilities: string[], locale: ChatCoreV2NormalizedLocale): string {
  const label = locale === 'en' ? 'supports' : locale === 'es' ? 'admite' : 'suporta';
  return ` (${label}: ${capabilities.join(', ')})`;
}

function providerLabel(provider: string): string {
  if (provider === 'apple_health') return 'Apple Health';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function sourceVersionsForConnections(items: ProviderIntegrationStatus[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const item of items) {
    versions[connectionEntityId(item)] = hashStable({
      state: item.state,
      connectedAt: item.connectedAt,
      capabilities: item.capabilities,
      reasonCode: item.reasonCode ?? null,
      lastCheckedAt: item.lastCheckedAt ?? null,
    });
  }
  return versions;
}

function connectionEntityId(item: ProviderIntegrationStatus): string {
  return `connection:${item.provider}`;
}

function connectionStateRank(state: string): number {
  if (state === 'revoked') return 0;
  if (state === 'pending') return 1;
  if (state === 'degraded') return 2;
  if (state === 'connected') return 3;
  return 4;
}
