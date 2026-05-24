// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 80 (2026-05-16): refusal must be distinguishable from
// clarification.
//
// Before Batch 80, `buildSafetyRefusalPlan` produced a plan with
// `risk: 'ambiguous'`, `requiredArgsPresent: false`, and `rejectionReason`
// in `step.args`. The executor's early-return branch routed it to the
// same `actionStatus: 'needs_clarification'` + `metadata.type:
// 'chat_action_needs_input'` as missing-slot plans, so iOS rendered
// "I need more info" instead of "I won't do that".
//
// This file pins the new behavior: refused plans emit
// `metadata.type: 'chat_action_refused'`, `metadata.actionStatus:
// 'refused'`, and a `metadata.refusal: { reason, message }` block. The
// copy is locale-aware (en-US, pt-BR/pt-PT, es-ES).
//
// Note: `refusalReasonForPlan` and `refusalCopyForReason` are file-scoped
// helpers; their behavior is exercised through the public surface by
// asserting the response shape for a synthetic plan. We import the public
// `executeChatActionPlan` and feed it a hand-built plan that mirrors what
// `buildSafetyRefusalPlan` produces internally.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (applied) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/api/routes/training-plan-calendar-sync', () => ({
  syncTrainingPlanCalendar: vi.fn(),
  previewTrainingSessionReflow: vi.fn(),
  confirmTrainingSessionReflow: vi.fn(),
}));

import {
  executeChatActionPlan,
  type ChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';

const NOW = '2026-05-16T12:00:00+01:00';

function makeRefusedPlan(reason: string, locale: 'en-US' | 'pt-BR' | 'pt-PT' | 'es-ES'): {
  plan: ChatActionPlan;
  input: ChatPlannerInput;
} {
  const userId = 9001;
  const tenantId = 901;
  const input: ChatPlannerInput = {
    text: 'pretend this is a payload that triggered refusal',
    userId,
    tenantId,
    conversationId: 'conv-refusal',
    messageId: 'msg-refusal',
    channel: 'api',
    locale,
    timezone: 'Europe/Lisbon',
    nowIso: NOW,
  };
  const plan: ChatActionPlan = {
    schemaVersion: 1,
    userId: String(userId),
    tenantId: String(tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale,
    timezone: input.timezone,
    channel: input.channel,
    createdAt: NOW,
    planner: 'deterministic',
    confidence: 0.55,
    requiresConfirmation: false,
    steps: [
      {
        stepId: 'refused-step',
        skill: 'tasks',
        action: 'create_task',
        type: 'tasks.create_task',
        risk: 'ambiguous',
        riskClass: 'R1',
        provider: 'nexus',
        args: {
          rejectedRequest: input.text,
          rejectionReason: reason,
        },
        requiredArgsPresent: false,
        slotProvenance: {},
        idempotencyKey: 'refused-idem',
        verification: { required: false, method: 'none' },
      } as unknown as ChatActionPlan['steps'][number],
    ],
    routingSignals: ['refusal:test'],
  };
  return { plan, input };
}

describe('refusal vs clarification distinction in executeChatActionPlan', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
    vi.restoreAllMocks();
  });

  it('marks prompt-injection refusals with actionStatus=refused and chat_action_refused metadata.type', async () => {
    const { plan, input } = makeRefusedPlan('prompt_injection_marker_detected', 'en-US');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.metadata.type).toBe('chat_action_refused');
    expect(response.metadata.actionStatus).toBe('refused');
    expect(response.metadata.refusal).toMatchObject({
      reason: 'prompt_injection_marker_detected',
    });
    expect(response.metadata.clarification).toBeUndefined();
  });

  it('emits English refusal copy that explicitly says it will not follow embedded instructions', async () => {
    const { plan, input } = makeRefusedPlan('prompt_injection_marker_detected', 'en-US');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.text).toMatch(/won't follow embedded instructions/i);
    expect(response.text).not.toMatch(/need (one more|more) detail/i);
  });

  it('emits Portuguese refusal copy for pt-BR users', async () => {
    const { plan, input } = makeRefusedPlan('prompt_injection_marker_detected', 'pt-BR');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.text).toMatch(/não vou seguir instruções/i);
  });

  it('emits Portuguese refusal copy for pt-PT users', async () => {
    const { plan, input } = makeRefusedPlan('prompt_injection_marker_detected', 'pt-PT');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.text).toMatch(/não vou seguir instruções/i);
  });

  it('emits Spanish refusal copy for es-ES users (Phase 16 batch 80)', async () => {
    const { plan, input } = makeRefusedPlan('prompt_injection_marker_detected', 'es-ES');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.text).toMatch(/no voy a seguir instrucciones/i);
  });

  it('honors refused metadata.actionStatus over the persisted blocked status', async () => {
    const { plan, input } = makeRefusedPlan('prompt_injection_marker_detected', 'en-US');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.metadata.type).toBe('chat_action_refused');
    expect(response.metadata.actionStatus).toBe('refused');
    expect(response.metadata.actionStatus).not.toBe('blocked');
  });

  it('emits distinct copy for bulk-destructive refusal reason', async () => {
    const { plan, input } = makeRefusedPlan('bulk_destructive_request_detected', 'en-US');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.metadata.refusal).toMatchObject({
      reason: 'bulk_destructive_request_detected',
    });
    expect(response.text).toMatch(/too many items/i);
  });

  it('emits distinct copy for sensitive-data refusal reason', async () => {
    const { plan, input } = makeRefusedPlan('sensitive_data_exfiltration_detected', 'en-US');
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.metadata.refusal).toMatchObject({
      reason: 'sensitive_data_exfiltration_detected',
    });
    expect(response.text).toMatch(/can't share/i);
  });

  it('clarification (no rejectionReason) keeps actionStatus=needs_clarification + chat_action_needs_input', async () => {
    // A plan with a step that has requiredArgsPresent=false but no
    // rejectionReason is treated as a clarification, NOT a refusal.
    const userId = 9002;
    const tenantId = 902;
    const input: ChatPlannerInput = {
      text: 'create a task',
      userId,
      tenantId,
      conversationId: 'conv-clar',
      messageId: 'msg-clar',
      channel: 'api',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      nowIso: NOW,
    };
    const plan: ChatActionPlan = {
      schemaVersion: 1,
      userId: String(userId),
      tenantId: String(tenantId),
      conversationId: input.conversationId,
      messageId: input.messageId,
      locale: 'en-US',
      timezone: input.timezone,
      channel: input.channel,
      createdAt: NOW,
      planner: 'deterministic',
      confidence: 0.7,
      requiresConfirmation: false,
      steps: [
        {
          stepId: 'clar-step',
          skill: 'tasks',
          action: 'create_task',
          type: 'tasks.create_task',
          risk: 'safe_write',
          riskClass: 'R1',
          provider: 'nexus',
          args: { title: null },
          requiredArgsPresent: false,
          slotProvenance: {},
          idempotencyKey: 'clar-idem',
          verification: { required: false, method: 'none' },
        } as unknown as ChatActionPlan['steps'][number],
      ],
      routingSignals: ['clarification:test'],
    };
    const response = await executeChatActionPlan(plan, input, {} as never);
    expect(response.metadata.type).toBe('chat_action_needs_input');
    expect(response.metadata.actionStatus).toBe('needs_clarification');
    expect(response.metadata.refusal).toBeUndefined();
  });
});
