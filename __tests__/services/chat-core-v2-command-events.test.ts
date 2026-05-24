import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { ChatV2CommandEvent } from '../../src/services/chat-core-v2';
import {
  ensureChatCoreV2CommandEventTables,
  getChatV2CommandEventById,
  listChatV2CommandEventsForCommand,
  listChatV2CommandEventsForTurn,
  recordChatV2CommandEvent,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const baseEvent: ChatV2CommandEvent = {
  commandEventId: 'event-1',
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
  redactedSummary: 'Task create command proposed.',
  metadata: { routeMethod: 'llm_command_translation', risk: 'low' },
  createdAt: '2026-05-24T10:00:00.000Z',
};

describe('Chat Core v2 command event timeline', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates the command event table without raw payload or prompt columns', () => {
    ensureChatCoreV2CommandEventTables(db);

    const columns = db.prepare('PRAGMA table_info(chat_v2_command_events)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain('redacted_summary');
    expect(names).toContain('metadata_json');
    expect(names).not.toContain('raw_payload_json');
    expect(names).not.toContain('raw_prompt');
    expect(names).not.toContain('provider_payload_json');
  });

  it('records redacted command lifecycle events with metadata', () => {
    const saved = recordChatV2CommandEvent(baseEvent, db);

    expect(saved).toMatchObject({
      commandEventId: 'event-1',
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
      redactedSummary: 'Task create command proposed.',
      metadata: { routeMethod: 'llm_command_translation', risk: 'low' },
    });
  });

  it('upserts by commandEventId so event recording is retry-safe', () => {
    recordChatV2CommandEvent(baseEvent, db);
    recordChatV2CommandEvent({
      ...baseEvent,
      status: 'previewed',
      eventName: 'preview_rendered',
      redactedSummary: 'Preview rendered.',
      metadata: { cardType: 'task_preview_card' },
      createdAt: '2026-05-24T10:00:01.000Z',
    }, db);

    const count = db.prepare('SELECT COUNT(*) as count FROM chat_v2_command_events WHERE command_event_id = ?')
      .get('event-1') as { count: number };
    const saved = getChatV2CommandEventById('event-1', db);

    expect(count.count).toBe(1);
    expect(saved?.eventName).toBe('preview_rendered');
    expect(saved?.status).toBe('previewed');
    expect(saved?.metadata).toEqual({ cardType: 'task_preview_card' });
  });

  it('lists command events chronologically by turn and by command', () => {
    recordChatV2CommandEvent({
      ...baseEvent,
      commandEventId: 'event-2',
      eventName: 'confirmation_requested',
      status: 'confirmation_required',
      createdAt: '2026-05-24T10:00:02.000Z',
    }, db);
    recordChatV2CommandEvent({
      ...baseEvent,
      commandEventId: 'event-1',
      eventName: 'command_proposed',
      status: 'proposed',
      createdAt: '2026-05-24T10:00:01.000Z',
    }, db);
    recordChatV2CommandEvent({
      ...baseEvent,
      commandEventId: 'other-command-event',
      commandId: 'cmd-2',
      createdAt: '2026-05-24T10:00:03.000Z',
    }, db);
    recordChatV2CommandEvent({
      ...baseEvent,
      commandEventId: 'other-turn-event',
      turnId: 'turn-2',
      createdAt: '2026-05-24T10:00:04.000Z',
    }, db);

    expect(listChatV2CommandEventsForTurn('turn-1', db).map((event) => event.commandEventId))
      .toEqual(['event-1', 'event-2', 'other-command-event']);
    expect(listChatV2CommandEventsForCommand('cmd-1', db).map((event) => event.commandEventId))
      .toEqual(['event-1', 'event-2', 'other-turn-event']);
  });

  it('rejects invalid command event metadata before SQLite checks', () => {
    expect(() => recordChatV2CommandEvent({
      ...baseEvent,
      domain: 'unknown' as ChatV2CommandEvent['domain'],
    }, db)).toThrow(/domain/);

    expect(() => recordChatV2CommandEvent({
      ...baseEvent,
      eventName: 'done' as ChatV2CommandEvent['eventName'],
    }, db)).toThrow(/event name/);

    expect(() => recordChatV2CommandEvent({
      ...baseEvent,
      status: 'done' as ChatV2CommandEvent['status'],
    }, db)).toThrow(/status/);

    expect(() => recordChatV2CommandEvent({
      ...baseEvent,
      redactedSummary: '',
    }, db)).toThrow(/redactedSummary/);
  });

  it('bounds long redacted summaries for operational views', () => {
    const saved = recordChatV2CommandEvent({
      ...baseEvent,
      redactedSummary: 'x'.repeat(1200),
    }, db);

    expect(saved.redactedSummary).toHaveLength(1000);
  });
});
