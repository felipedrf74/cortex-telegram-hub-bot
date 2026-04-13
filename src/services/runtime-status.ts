// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { getLastMessageAt, isBotPollingActive, isRestarting } from '../portal/telemetry';

export type ServiceStatus = 'online' | 'offline';
export type BotStatus = 'online' | 'restarting' | 'offline';

export function isDatabaseConnected(): boolean {
  try {
    const row = getDb().prepare('SELECT 1 as ok').get() as { ok?: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

export function getServiceStatus(): ServiceStatus {
  return isDatabaseConnected() ? 'online' : 'offline';
}

export function getBotStatus(): BotStatus {
  if (isBotPollingActive()) return 'online';
  if (isRestarting()) return 'restarting';
  return 'offline';
}

export function getRuntimeStatus(): {
  serviceStatus: ServiceStatus;
  databaseStatus: 'connected' | 'disconnected';
  botStatus: BotStatus;
  botPolling: boolean;
  botRestarting: boolean;
  lastMessageAt: string | null;
} {
  return {
    serviceStatus: getServiceStatus(),
    databaseStatus: isDatabaseConnected() ? 'connected' : 'disconnected',
    botStatus: getBotStatus(),
    botPolling: isBotPollingActive(),
    botRestarting: isRestarting(),
    lastMessageAt: getLastMessageAt(),
  };
}
