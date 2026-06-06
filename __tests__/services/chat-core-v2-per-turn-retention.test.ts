// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// WP-08b - Per-turn retention for the high-write Chat Core v2 tables.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runChatCoreV2ShadowDataRetention } from '../../src/services/scheduler';
import type { ChatV2CommandEvent } from '../../src/services/chat-core-v2';
import {
  ensureChatCoreV2CommandEventTables,
  recordCanaryTurn,
  recordChatV2CommandEvent,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const NOW = '2026-05-30T00:00:00.000Z';
const nowMs = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

const baseCommandEvent: ChatV2CommandEvent = {
  commandEventId: 'event-base',
  turnId: 'turn-1',
  commandId: 'cmd-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  domain: 'tasks',
  commandType: 'tasks.create',
  eventName: 'command_proposed',
  status: 'proposed',
  origin: 'chat',
  capabilityId: 'tasks.create',
  idempotencyKey: 'chat:v2:turn-1:cmd-1',
  redactedSummary: 'Command event summary.',
  metadata: { source: 'wp-08b-retention-test' },
  createdAt: NOW,
};

function recordCommandEvent(id: string, createdAt: string): void {
  recordChatV2CommandEvent(
    {
      ...baseCommandEvent,
      commandEventId: id,
      turnId: `turn-${id}`,
      commandId: `cmd-${id}`,
      idempotencyKey: `chat:v2:turn-${id}:cmd-${id}`,
      createdAt,
    },
    db,
  );
}

function commandEventIds(): string[] {
  return (
    db
      .prepare('SELECT command_event_id AS id FROM chat_v2_command_events ORDER BY command_event_id')
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function recordCanaryTurnAt(turnId: string, daysAgo: number): void {
  recordCanaryTurn(db, {
    tenantId: 'tenant-1',
    userId: 'user-1',
    turnId,
    routePath: '/api/v1/chat',
    routeMethod: 'POST',
    reasoningTier: 'fast',
    confidence: 0.9,
    locale: 'en',
    recordedAt: new Date(nowMs - daysAgo * DAY_MS),
  });
}

function canaryTurnIds(): string[] {
  return (
    db
      .prepare('SELECT turn_id AS id FROM chat_v2_canary_turn_log ORDER BY turn_id')
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('Chat Core v2 per-turn retention sweep (WP-08b)', () => {
  it('deletes command events older than 90 days and keeps recent lifecycle rows', () => {
    recordCommandEvent('old-1', isoDaysAgo(91));
    recordCommandEvent('old-2', isoDaysAgo(120));
    recordCommandEvent('recent', isoDaysAgo(89));

    const result = runChatCoreV2ShadowDataRetention(db, NOW);

    expect(result.chat_v2_command_events).toBe(2);
    expect(commandEventIds()).toEqual(['recent']);
  });

  it('deletes expired canary turns and command events in the same isolated sweep', () => {
    recordCanaryTurnAt('canary-old', 91);
    recordCanaryTurnAt('canary-recent', 1);
    recordCommandEvent('event-old', isoDaysAgo(91));
    recordCommandEvent('event-recent', isoDaysAgo(1));

    const result = runChatCoreV2ShadowDataRetention(db, NOW);

    expect(result.chat_v2_canary_turn_log).toBe(1);
    expect(result.chat_v2_command_events).toBe(1);
    expect(canaryTurnIds()).toEqual(['canary-recent']);
    expect(commandEventIds()).toEqual(['event-recent']);
  });

  it('warn-skips a missing command event table without blocking canary retention', () => {
    recordCanaryTurnAt('canary-old', 91);

    const result = runChatCoreV2ShadowDataRetention(db, NOW);
    expect(result).toHaveProperty('chat_v2_canary_turn_log');
    expect(result.chat_v2_canary_turn_log).toBe(1);
    expect(result).not.toHaveProperty('chat_v2_command_events');
    expect(canaryTurnIds()).toEqual([]);
  });

  it('uses the existing command event created_at predicate column', () => {
    ensureChatCoreV2CommandEventTables(db);

    const columns = db
      .prepare('PRAGMA table_info(chat_v2_command_events)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('created_at');
  });
});
