import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { ChatReplayBundle, ChatV2ModelRun } from '../../src/services/chat-core-v2';
import {
  ensureChatCoreV2AuditTables,
  getChatV2ModelRunById,
  listChatV2ModelRunsForTurn,
  listChatV2ReplayBundlesForTurn,
  recordChatV2ModelRun,
  recordChatV2ReplayBundle,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const baseRun: ChatV2ModelRun = {
  modelRunId: 'model-run-1',
  turnId: 'turn-1',
  provider: 'openai',
  model: 'gpt-test',
  modelVersion: '2026-05-24',
  modelSettingsHash: 'settings:abc',
  promptTemplateVersion: 'chat_v2_tasks@1.0.0',
  toolSchemaSetVersion: 'tools.tasks@1.0.0',
  contextBuilderVersion: 'context.tasks@1.0.0',
  routerVersion: 'router@1.0.0',
  entityResolverVersion: 'entities@1.0.0',
  reasoningPolicyVersion: 'reasoning.fast@1.0.0',
  inputTokenCount: 120,
  cachedInputTokenCount: 64,
  outputTokenCount: 42,
  latencyMs: 350,
  status: 'success',
  createdAt: '2026-05-24T10:00:00.000Z',
};

const baseBundle: ChatReplayBundle = {
  turnId: 'turn-1',
  routeDecision: {
    routeMethod: 'deterministic_read',
    confidence: 0.98,
  },
  contextPack: {
    redactedSummary: 'User has 2 tasks today.',
  },
  modelRuns: [baseRun],
  toolSchemaSetVersion: 'tools.tasks@1.0.0',
  commandProposals: [],
  commandEvents: [],
  response: {
    type: 'message',
    text: 'You have 2 tasks today.',
  },
};

describe('Chat Core v2 model audit persistence', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates model-run and replay tables without raw prompt/provider columns', () => {
    ensureChatCoreV2AuditTables(db);

    const modelColumns = db.prepare('PRAGMA table_info(chat_v2_model_runs)').all() as Array<{ name: string }>;
    const replayColumns = db.prepare('PRAGMA table_info(chat_v2_replay_bundles)').all() as Array<{ name: string }>;

    expect(modelColumns.map((column) => column.name)).toContain('prompt_template_version');
    expect(modelColumns.map((column) => column.name)).toContain('tool_schema_set_version');
    expect(modelColumns.map((column) => column.name)).toContain('reasoning_policy_version');
    expect(modelColumns.map((column) => column.name)).not.toContain('raw_prompt');
    expect(modelColumns.map((column) => column.name)).not.toContain('provider_payload_json');

    expect(replayColumns.map((column) => column.name)).toContain('redacted_bundle_json');
    expect(replayColumns.map((column) => column.name)).toContain('encrypted_full_bundle');
    expect(replayColumns.map((column) => column.name)).not.toContain('raw_bundle_json');
  });

  it('records model run versions, usage, latency, and status', () => {
    const saved = recordChatV2ModelRun(baseRun, db);

    expect(saved).toMatchObject({
      modelRunId: 'model-run-1',
      turnId: 'turn-1',
      provider: 'openai',
      model: 'gpt-test',
      promptTemplateVersion: 'chat_v2_tasks@1.0.0',
      toolSchemaSetVersion: 'tools.tasks@1.0.0',
      contextBuilderVersion: 'context.tasks@1.0.0',
      routerVersion: 'router@1.0.0',
      entityResolverVersion: 'entities@1.0.0',
      reasoningPolicyVersion: 'reasoning.fast@1.0.0',
      inputTokenCount: 120,
      cachedInputTokenCount: 64,
      outputTokenCount: 42,
      latencyMs: 350,
      status: 'success',
    });

    const row = getChatV2ModelRunById('model-run-1', db);
    expect(row?.modelSettingsHash).toBe('settings:abc');
  });

  it('upserts model runs by modelRunId for retry-safe persistence', () => {
    recordChatV2ModelRun(baseRun, db);
    recordChatV2ModelRun({
      ...baseRun,
      inputTokenCount: 180,
      outputTokenCount: 0,
      latencyMs: 2000,
      status: 'timeout',
      createdAt: '2026-05-24T10:00:01.000Z',
    }, db);

    const count = db.prepare('SELECT COUNT(*) as count FROM chat_v2_model_runs WHERE model_run_id = ?')
      .get('model-run-1') as { count: number };
    const saved = getChatV2ModelRunById('model-run-1', db);

    expect(count.count).toBe(1);
    expect(saved?.inputTokenCount).toBe(180);
    expect(saved?.status).toBe('timeout');
    expect(saved?.createdAt).toBe('2026-05-24T10:00:01.000Z');
  });

  it('lists model runs for a turn in chronological order', () => {
    recordChatV2ModelRun({ ...baseRun, modelRunId: 'model-run-2', createdAt: '2026-05-24T10:00:02.000Z' }, db);
    recordChatV2ModelRun({ ...baseRun, modelRunId: 'model-run-1', createdAt: '2026-05-24T10:00:01.000Z' }, db);
    recordChatV2ModelRun({ ...baseRun, modelRunId: 'other-turn-run', turnId: 'turn-2' }, db);

    const runs = listChatV2ModelRunsForTurn('turn-1', db);

    expect(runs.map((run) => run.modelRunId)).toEqual(['model-run-1', 'model-run-2']);
  });

  it('stores redacted replay bundles and only stores full payloads when explicitly encrypted', () => {
    const saved = recordChatV2ReplayBundle({
      replayBundleId: 'replay-1',
      bundle: baseBundle,
      sensitivity: 'personal',
      retentionPolicy: '30d',
      createdAt: '2026-05-24T10:05:00.000Z',
      expiresAt: '2026-06-23T10:05:00.000Z',
    }, db);

    expect(saved).toMatchObject({
      replayBundleId: 'replay-1',
      turnId: 'turn-1',
      sensitivity: 'personal',
      retentionPolicy: '30d',
      encryptedFullBundle: null,
      expiresAt: '2026-06-23T10:05:00.000Z',
    });
    expect(saved.bundle?.response).toMatchObject({ type: 'message' });

    recordChatV2ReplayBundle({
      replayBundleId: 'replay-2',
      bundle: { ...baseBundle, turnId: 'turn-1' },
      sensitivity: 'financial',
      retentionPolicy: '90d',
      encryptedFullBundle: 'encrypted:full-payload',
    }, db);

    const bundles = listChatV2ReplayBundlesForTurn('turn-1', db);
    const encryptedBundle = bundles.find((bundle) => bundle.replayBundleId === 'replay-2');
    expect(bundles).toHaveLength(2);
    expect(encryptedBundle?.encryptedFullBundle).toBe('encrypted:full-payload');
  });

  it('rejects invalid model-run and replay metadata before hitting SQLite checks', () => {
    expect(() => recordChatV2ModelRun({
      ...baseRun,
      inputTokenCount: -1,
    }, db)).toThrow(/inputTokenCount/);

    expect(() => recordChatV2ModelRun({
      ...baseRun,
      status: 'done' as ChatV2ModelRun['status'],
    }, db)).toThrow(/status/);

    expect(() => recordChatV2ReplayBundle({
      replayBundleId: 'bad-replay',
      bundle: { ...baseBundle, turnId: '' },
      sensitivity: 'normal',
      retentionPolicy: '30d',
    }, db)).toThrow(/bundle.turnId/);
  });
});
