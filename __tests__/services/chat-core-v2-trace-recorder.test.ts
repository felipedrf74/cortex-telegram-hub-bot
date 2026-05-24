import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { AICommandEnvelope, ChatV2TraceSpan } from '../../src/services/chat-core-v2';
import {
  buildChatV2ReplayBundle,
  ensureChatCoreV2TraceTables,
  getChatV2TraceSpanById,
  listChatV2TraceSpansForTurn,
  recordChatV2TraceReplay,
  recordChatV2TraceSpan,
  redactChatV2TraceValue,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const baseSpan: ChatV2TraceSpan = {
  traceSpanId: 'span-router-1',
  turnId: 'turn-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  kind: 'router',
  name: 'route message',
  status: 'success',
  sensitivity: 'personal',
  retentionPolicy: '30d',
  redactedSummary: 'Routed to tasks command translation.',
  attributes: { routeMethod: 'llm_command_translation', confidence: 0.92 },
  startedAt: '2026-05-24T10:00:00.000Z',
  endedAt: '2026-05-24T10:00:00.125Z',
};

const baseCommand: AICommandEnvelope = {
  commandId: 'cmd-1',
  commandSchemaVersion: 'tasks.create@2.1.0',
  previewSchemaVersion: 'preview.task@1.0.0',
  responseSchemaVersion: 'chat_response_v2@1.0.0',
  tenantId: 'tenant-1',
  userId: 'user-1',
  domain: 'tasks',
  commandType: 'tasks.create',
  origin: 'chat',
  payload: {
    title: 'Buy milk',
    dueDate: '2026-05-25',
    apiKey: 'sk_secret_should_not_persist',
    bearerExample: 'Bearer abcdefghijklmnop',
  },
  basedOn: {
    entityIds: [],
    entityVersions: {},
    contextHash: 'context:abc',
    createdAt: '2026-05-24T10:00:00.000Z',
  },
  preconditions: {
    requiredEntityVersions: {},
    invariants: [],
  },
  authorization: {
    actorUserId: 'user-1',
    tenantId: 'tenant-1',
    actingSurface: 'ios_chat',
    delegatedScopes: ['tasks:write'],
    permissionSnapshotVersion: 'permissions@1',
    authTime: '2026-05-24T10:00:00.000Z',
  },
  expiresAt: '2026-05-24T10:10:00.000Z',
  idempotencyKey: 'chat:v2:turn-1:cmd-1',
};

describe('Chat Core v2 trace recorder', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates trace tables without raw prompt or provider payload columns', () => {
    ensureChatCoreV2TraceTables(db);

    const columns = db.prepare('PRAGMA table_info(chat_v2_trace_spans)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain('redacted_summary');
    expect(names).toContain('attributes_json');
    expect(names).not.toContain('raw_prompt');
    expect(names).not.toContain('provider_payload_json');
    expect(names).not.toContain('raw_payload_json');
  });

  it('records trace spans chronologically and computes duration from timestamps', () => {
    recordChatV2TraceSpan({
      ...baseSpan,
      traceSpanId: 'span-model',
      kind: 'model',
      name: 'translate command',
      startedAt: '2026-05-24T10:00:01.000Z',
      endedAt: '2026-05-24T10:00:01.450Z',
    }, db);
    recordChatV2TraceSpan({
      ...baseSpan,
      traceSpanId: 'span-router',
      startedAt: '2026-05-24T10:00:00.000Z',
      endedAt: '2026-05-24T10:00:00.125Z',
    }, db);

    const spans = listChatV2TraceSpansForTurn('turn-1', db);
    expect(spans.map((span) => span.traceSpanId)).toEqual(['span-router', 'span-model']);
    expect(spans[0].durationMs).toBe(125);
    expect(spans[1].durationMs).toBe(450);
  });

  it('upserts trace spans by span id for retry-safe trace writing', () => {
    recordChatV2TraceSpan(baseSpan, db);
    recordChatV2TraceSpan({
      ...baseSpan,
      status: 'failed',
      redactedSummary: 'Router failed safely.',
      attributes: { fallbackReason: 'v2_schema_failure' },
      durationMs: 300,
    }, db);

    const count = db.prepare('SELECT COUNT(*) as count FROM chat_v2_trace_spans WHERE trace_span_id = ?')
      .get('span-router-1') as { count: number };
    const saved = getChatV2TraceSpanById('span-router-1', db);

    expect(count.count).toBe(1);
    expect(saved?.status).toBe('failed');
    expect(saved?.durationMs).toBe(300);
    expect(saved?.attributes).toEqual({ fallbackReason: 'v2_schema_failure' });
  });

  it('redacts sensitive attributes and prompt/provider payload keys before persistence', () => {
    const saved = recordChatV2TraceSpan({
      ...baseSpan,
      attributes: {
        api_key: 'sk_live_should_be_hidden',
        apiKeyLabel: 'redacted by evidence policy',
        rawPrompt: 'system prompt content',
        providerPayload: { messages: ['user secret'] },
        nested: {
          sessionSecret: 'session-secret',
          note: 'Authorization Bearer abcdefghijklmnop',
        },
      },
    }, db);

    expect(saved.attributes).toMatchObject({
      api_key: '[redacted]',
      apiKeyLabel: '[redacted]',
      rawPrompt: '[redacted]',
      providerPayload: '[redacted]',
      nested: {
        sessionSecret: '[redacted]',
        note: 'Authorization Bearer [redacted]',
      },
    });
  });

  it('builds redacted replay bundles without mutating the source objects', () => {
    const routeDecision = {
      routeMethod: 'llm_command_translation',
      rawPrompt: 'raw prompt should not persist',
    };
    const response = {
      type: 'action_preview',
      providerResponse: { jwt: 'eyJaaaaaaaaaa.bbbbbbbbbb.cccccccccc' },
      text: 'I can create the task.',
    };
    const bundle = buildChatV2ReplayBundle({
      turnId: 'turn-1',
      routeDecision,
      contextPack: {
        task: {
          title: 'Buy milk',
          session_id: 'session-secret',
        },
      },
      toolSchemaSetVersion: 'chat_core_v2_tool_schema_set:tasks@1.0.0',
      commandProposals: [baseCommand],
      commandEvents: [],
      traceSpans: [baseSpan],
      response,
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('sk_secret_should_not_persist');
    expect(serialized).not.toContain('raw prompt should not persist');
    expect(serialized).not.toContain('session-secret');
    expect(serialized).not.toContain('Bearer abcdefghijklmnop');
    expect(bundle.routeDecision).toMatchObject({ rawPrompt: '[redacted]' });
    expect(bundle.response).toMatchObject({ providerResponse: '[redacted]' });
    expect(bundle.commandProposals[0].payload).toMatchObject({
      title: 'Buy milk',
      apiKey: '[redacted]',
      bearerExample: 'Bearer [redacted]',
    });
    expect(routeDecision.rawPrompt).toBe('raw prompt should not persist');
  });

  it('records a redacted replay bundle and related trace spans together', () => {
    const saved = recordChatV2TraceReplay({
      replayBundleId: 'replay-1',
      turnId: 'turn-1',
      routeDecision: { routeMethod: 'llm_command_translation' },
      contextPack: { redactedSummary: 'Task create context.' },
      modelRuns: [],
      toolSchemaSetVersion: 'chat_core_v2_tool_schema_set:tasks@1.0.0',
      commandProposals: [baseCommand],
      commandEvents: [],
      traceSpans: [baseSpan],
      response: { type: 'message', text: 'Preview ready.' },
      sensitivity: 'personal',
      retentionPolicy: '30d',
      createdAt: '2026-05-24T10:00:02.000Z',
      expiresAt: '2026-06-23T10:00:02.000Z',
    }, db);

    expect(saved.replayBundle).toMatchObject({
      replayBundleId: 'replay-1',
      turnId: 'turn-1',
      sensitivity: 'personal',
      retentionPolicy: '30d',
      encryptedFullBundle: null,
      expiresAt: '2026-06-23T10:00:02.000Z',
    });
    expect(saved.traceSpans).toHaveLength(1);
    expect(saved.replayBundle.bundle?.traceSpans?.[0].traceSpanId).toBe('span-router-1');
    expect(listChatV2TraceSpansForTurn('turn-1', db).map((span) => span.traceSpanId)).toEqual(['span-router-1']);
  });

  it('rejects invalid trace metadata before SQLite checks', () => {
    expect(() => recordChatV2TraceSpan({
      ...baseSpan,
      kind: 'unknown' as ChatV2TraceSpan['kind'],
    }, db)).toThrow(/kind/);

    expect(() => recordChatV2TraceSpan({
      ...baseSpan,
      status: 'done' as ChatV2TraceSpan['status'],
    }, db)).toThrow(/status/);

    expect(() => recordChatV2TraceSpan({
      ...baseSpan,
      redactedSummary: '',
    }, db)).toThrow(/redactedSummary/);

    expect(() => recordChatV2TraceSpan({
      ...baseSpan,
      durationMs: -1,
    }, db)).toThrow(/durationMs/);
  });

  it('redacts circular and oversized values deterministically', () => {
    const circular: Record<string, unknown> = { safe: 'ok' };
    circular.self = circular;
    const redacted = redactChatV2TraceValue({
      circular,
      longList: Array.from({ length: 55 }, (_, index) => index),
    }) as Record<string, unknown>;

    expect(redacted.circular).toEqual({ safe: 'ok', self: '[redacted-circular]' });
    expect(redacted.longList).toHaveLength(51);
    expect((redacted.longList as unknown[])[50]).toBe('[truncated]');
  });
});
