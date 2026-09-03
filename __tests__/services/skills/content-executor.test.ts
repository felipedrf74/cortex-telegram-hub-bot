import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/database')>(
    '../../../src/services/database',
  )),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

import { CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION } from '../../../src/services/content-agency';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../../src/services/chat/types';
import { executeContentAgencyStep } from '../../../src/services/skills/content/executor';

const USER_ID = 8801;
const TENANT_ID = 9901;
const NOW_ISO = '2026-08-31T12:00:00.000Z';
let sequence = 0;

function buildStep(
  args: Record<string, unknown>,
  action: 'content_script_create' | 'content_rewrite' = 'content_script_create',
): ChatPlanStep {
  sequence += 1;
  return {
    stepId: `content-agency-step-${sequence}`,
    skill: 'content',
    type: action,
    action,
    risk: 'safe_write',
    provider: 'nexus',
    args,
    requiredArgsPresent: true,
    idempotencyKey: `content-agency-executor-${sequence}`,
    verification: { required: true, method: 'local_read_back' },
  };
}

function buildInput(messageId = `content-agency-message-${sequence}`): ChatPlannerInput {
  return {
    text: 'Create an evidence-led TikTok script about recovery readiness.',
    userId: USER_ID,
    tenantId: TENANT_ID,
    conversationId: 'content-agency-executor-conversation',
    messageId,
    channel: 'ios',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    nowIso: NOW_ISO,
  };
}

function buildPlan(step: ChatPlanStep, input: ChatPlannerInput): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale ?? 'en-US',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: NOW_ISO,
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: false,
    confidence: 0.95,
  };
}

function execute(
  args: Record<string, unknown>,
  persistRuns = false,
  action: 'content_script_create' | 'content_rewrite' = 'content_script_create',
): ReturnType<typeof executeContentAgencyStep> {
  const step = buildStep(args, action);
  const input = buildInput();
  return executeContentAgencyStep(step, buildPlan(step, input), input, persistRuns);
}

function countRows(table: string): number {
  return Number((testDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
});

afterEach(() => {
  testDb?.close();
});

describe('Content Agency chat executor boundary', () => {
  it('blocks incomplete rewrites without creating an unusable pending continuation', () => {
    const result = execute({ objective: 'Make it punchier.' }, true, 'content_rewrite');

    expect(result).toMatchObject({
      status: 'blocked',
      error: 'content_rewrite_input_required',
      result: { missingSlots: ['sourceText'], verified: false },
    });
    expect(countRows('content_agency_packages')).toBe(0);
    expect(countRows('chat_pending_actions')).toBe(0);
    const run = testDb.prepare(`
      SELECT status, error_json
        FROM chat_action_runs
       ORDER BY created_at DESC
       LIMIT 1
    `).get() as { status: string; error_json: string };
    expect(run.status).toBe('blocked');
    expect(JSON.parse(run.error_json)).toEqual({
      reason: 'content_rewrite_input_required',
      missingSlots: ['sourceText'],
    });
  });

  it('pins private scope, contract v2, authoritative read-back, and one atomic bundle', () => {
    const args = {
      userId: USER_ID,
      tenantId: TENANT_ID,
      visibilityScope: 'user_private',
      generatorContractVersion: CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION,
      topic: 'recovery readiness for hybrid athletes',
      objective: 'Create a practical script with an evidence-led hook.',
      audience: 'hybrid athletes balancing strength and endurance',
      platform: 'tiktok',
      format: 'short_form_video',
    };

    const first = execute(args);
    const second = execute(args);

    expect(first).toMatchObject({ status: 'verified_success' });
    expect(second).toMatchObject({ status: 'verified_success' });
    expect((second.result as { packageId: string }).packageId)
      .toBe((first.result as { packageId: string }).packageId);

    const stored = testDb.prepare(`
      SELECT user_id, tenant_id, visibility_scope, payload_json
        FROM content_agency_packages
    `).get() as { user_id: number; tenant_id: number; visibility_scope: string; payload_json: string };
    const payload = JSON.parse(stored.payload_json) as Record<string, unknown>;
    expect(stored).toMatchObject({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      visibility_scope: 'user_private',
    });
    expect(payload.generatorContractVersion).toBe(CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION);
    expect(payload.visibilityScope).toBe('user_private');
    expect(countRows('content_agency_packages')).toBe(1);
    expect(countRows('content_compliance_reviews')).toBe(1);
    expect(countRows('content_experiment_runs')).toBe(1);
    expect(countRows('content_agency_quality_reviews')).toBe(1);
  });

  it('rejects tenant and visibility spoofing before package persistence', () => {
    const tenantSpoof = execute({
      userId: USER_ID,
      tenantId: TENANT_ID + 1,
      topic: 'recovery readiness',
      objective: 'Create a recovery script.',
      platform: 'tiktok',
    });
    const visibilitySpoof = execute({
      topic: 'recovery readiness',
      objective: 'Create a recovery script.',
      platform: 'tiktok',
      brief: {
        userId: USER_ID,
        tenantId: TENANT_ID,
        visibilityScope: 'tenant_shared',
      },
    });

    expect(tenantSpoof).toMatchObject({
      status: 'failed',
      error: 'CONTENT_AGENCY_VALIDATION_FAILED',
    });
    expect(visibilitySpoof).toMatchObject({
      status: 'failed',
      error: 'CONTENT_AGENCY_VALIDATION_FAILED',
    });
    expect(countRows('content_agency_packages')).toBe(0);
  });

  it('rejects malformed values without coercion and persists only the safe error contract', () => {
    const result = execute({
      goal: { privateProviderMessage: 'do-not-copy-this-value' },
      objective: 'Create a recovery script.',
      topic: 'recovery readiness',
      platform: 'tiktok',
    }, true);

    expect(result).toMatchObject({
      status: 'failed',
      error: 'CONTENT_AGENCY_VALIDATION_FAILED',
    });
    const row = testDb.prepare(`
      SELECT status, error_json
        FROM chat_action_runs
       ORDER BY created_at DESC
       LIMIT 1
    `).get() as { status: string; error_json: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.error_json)).toEqual({
      code: 'CONTENT_AGENCY_VALIDATION_FAILED',
      field: 'goal',
    });
    expect(row.error_json).not.toContain('do-not-copy-this-value');
    expect(countRows('content_agency_packages')).toBe(0);
  });

  it('rolls back the whole bundle and redacts unexpected storage errors', () => {
    testDb.exec(`
      CREATE TRIGGER content_agency_executor_reject_compliance
      BEFORE INSERT ON content_compliance_reviews
      BEGIN
        SELECT RAISE(ABORT, 'private-provider-storage-message');
      END
    `);

    const args = {
      topic: 'recovery readiness',
      objective: 'Create a recovery script.',
      audience: 'hybrid athletes',
      platform: 'tiktok',
    };
    const step = buildStep(args);
    const input = buildInput();
    const plan = buildPlan(step, input);
    const result = executeContentAgencyStep(step, plan, input, true);

    expect(result).toMatchObject({
      status: 'failed',
      error: 'content_agency_package_failed',
    });
    const row = testDb.prepare(`
      SELECT status, error_json
        FROM chat_action_runs
       ORDER BY created_at DESC
       LIMIT 1
    `).get() as { status: string; error_json: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.error_json)).toMatchObject({
      code: 'SQLITE_CONSTRAINT_TRIGGER',
      errorName: 'SqliteError',
    });
    expect(row.error_json).not.toContain('private-provider-storage-message');
    expect(countRows('content_agency_packages')).toBe(0);
    expect(countRows('content_compliance_reviews')).toBe(0);
    expect(countRows('content_experiment_runs')).toBe(0);
    expect(countRows('content_agency_quality_reviews')).toBe(0);

    testDb.exec('DROP TRIGGER content_agency_executor_reject_compliance');
    const retry = executeContentAgencyStep(step, plan, input, true);
    expect(retry).toMatchObject({
      status: 'failed',
      error: 'idempotent_retry_existing_failed',
    });
    expect(countRows('content_agency_packages')).toBe(0);
  });

  it('rejects attempts to select a stale package generator contract', () => {
    const result = execute({
      generatorContractVersion: 'content-agency-package.v1',
      topic: 'recovery readiness',
      objective: 'Create a recovery script.',
      platform: 'tiktok',
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'CONTENT_AGENCY_VALIDATION_FAILED',
    });
    expect(countRows('content_agency_packages')).toBe(0);
  });
});
