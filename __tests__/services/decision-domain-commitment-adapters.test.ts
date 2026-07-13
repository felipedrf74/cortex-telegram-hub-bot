// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

import { buildNormalizedDecisionAction } from '../../src/services/decision-action-contract';
import { evaluateDecisionConflicts } from '../../src/services/decision-conflict-evaluator';
import { DOMAIN_COMMITMENT_ADAPTERS } from '../../src/services/decision-domain-commitment-adapters';

function adapter(id: string) {
  const found = DOMAIN_COMMITMENT_ADAPTERS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing adapter: ${id}`);
  return found;
}

function candidate(input: {
  intent: string;
  targetType: string;
  targetId: string;
  resourceType: string;
}) {
  return buildNormalizedDecisionAction({
    intent: input.intent,
    targetEntities: [{ type: input.targetType, id: input.targetId, version: 'candidate_v1' }],
    affectedResources: [{ type: input.resourceType, id: input.targetId }],
    preconditions: [],
    expectedEffects: [{ type: 'review_required', targetRef: `${input.targetType}:${input.targetId}` }],
    prohibitedEffects: [],
    dependencies: [],
    exclusivityKeys: [`${input.resourceType}:70:${input.targetId}`],
    authorizationScope: [`${input.intent.split('.')[0]}:read`],
    risk: 'medium',
    reversibility: 'reversible',
    contextVersion: 'candidate_context_v1',
  });
}

describe('authoritative domain commitment conflict adapters', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
  });

  it('projects only active plans in the authenticated Training scope', () => {
    testDb.exec(`
      CREATE TABLE fitness_training_plans (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
        plan_version INTEGER NOT NULL, adaptation_revision INTEGER NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO fitness_training_plans VALUES
        (1, 7, 70, 3, 5, 'active', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (2, 7, 71, 4, 0, 'active', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (3, 7, 70, 1, 0, 'paused', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');
    `);

    const comparisons = adapter('training_active_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'training.modify_session',
        targetType: 'training_plan',
        targetId: '1',
        resourceType: 'training_state',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      authority: 'approved_commitment',
      approved: true,
      action: { intent: 'preserve_active_training_plan' },
    });
    expect(comparisons[0].decisionId).toMatch(/^training:training_plan:[a-f0-9]{32}$/);
    expect(evaluateDecisionConflicts({
      candidate: candidate({
        intent: 'training.modify_session',
        targetType: 'training_plan',
        targetId: '1',
        resourceType: 'training_state',
      }),
      existing: comparisons,
      now: new Date('2026-07-10T12:00:00Z'),
    }).disposition).toBe('needs_confirmation');
  });

  it('projects an explicitly targeted non-terminal session from an active scoped plan', () => {
    testDb.exec(`
      CREATE TABLE fitness_training_plans (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
        plan_version INTEGER NOT NULL, adaptation_revision INTEGER NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE training_sessions (
        id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL, status TEXT NOT NULL,
        session_shape_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO fitness_training_plans VALUES
        (1, 7, 70, 3, 5, 'active', '2026-07-01 00:00:00', '2026-07-10 00:00:00'),
        (2, 7, 71, 1, 0, 'active', '2026-07-01 00:00:00', '2026-07-10 00:00:00');
      INSERT INTO training_sessions VALUES
        (51, 1, 'scheduled', 'shape_private_1', '2026-07-01 00:00:00', '2026-07-10 00:00:00'),
        (52, 1, 'completed', 'shape_private_2', '2026-07-01 00:00:00', '2026-07-10 00:00:00'),
        (53, 2, 'scheduled', 'shape_private_3', '2026-07-01 00:00:00', '2026-07-10 00:00:00');
    `);

    const comparisons = adapter('training_active_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'training.modify_session',
        targetType: 'training_session',
        targetId: '51',
        resourceType: 'training_session',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      authority: 'approved_commitment',
      action: { targetEntities: [expect.objectContaining({ type: 'training_session', id: '51' })] },
    });
    expect(comparisons[0].decisionId).toMatch(/^training:training_session:[a-f0-9]{32}$/);
    expect(comparisons[0].createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(JSON.stringify(comparisons)).not.toContain('shape_private_1');
  });

  it('projects only an explicitly targeted approved Content object', () => {
    testDb.exec(`
      CREATE TABLE content_domain_objects (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
        scope_status TEXT NOT NULL, editorial_state TEXT NOT NULL, approval_state TEXT NOT NULL,
        workflow_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO content_domain_objects VALUES
        (11, 70, 7, 'active', 'approved', 'approved', 4, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (12, 70, 7, 'active', 'drafted', 'review_required', 2, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (13, 71, 7, 'active', 'approved', 'approved', 1, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');
    `);

    const comparisons = adapter('content_approved_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'content.revise',
        targetType: 'content_object',
        targetId: '11',
        resourceType: 'content_object',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      authority: 'approved_commitment',
      action: { intent: 'preserve_approved_content_object' },
    });
    expect(comparisons[0].decisionId).toMatch(/^content:content_object:[a-f0-9]{32}$/);
  });

  it('accepts the serving content_workflow_object identity without broadening scope', () => {
    testDb.exec(`
      CREATE TABLE content_domain_objects (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
        scope_status TEXT NOT NULL, editorial_state TEXT NOT NULL, approval_state TEXT NOT NULL,
        workflow_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO content_domain_objects VALUES
        (11, 70, 7, 'active', 'scheduled', 'approved', 5, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');
    `);

    const comparisons = adapter('content_approved_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'content.approve_script',
        targetType: 'content_workflow_object',
        targetId: '11',
        resourceType: 'content_workflow_object',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].action.targetEntities[0]).toMatchObject({
      type: 'content_workflow_object',
      id: '11',
      version: '5',
    });
  });

  it('hashes private Cooking slot contents instead of copying them into conflict context', () => {
    testDb.exec(`
      CREATE TABLE meal_plans (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL, lifecycle_state TEXT NOT NULL, scope_status TEXT NOT NULL,
        date TEXT NOT NULL, meal_type TEXT NOT NULL, recipe_id INTEGER,
        title TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO meal_plans VALUES
        (21, 70, 7, 7, 'planned', 'active', '2026-07-11', 'dinner', 9,
         'Private family meal', 'Private allergy note', '2026-07-01T00:00:00Z'),
        (22, 71, 7, 7, 'planned', 'active', '2026-07-11', 'dinner', 9,
         'Other tenant meal', NULL, '2026-07-01T00:00:00Z');
    `);

    const comparisons = adapter('cooking_planned_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'cooking.replace_meal_plan',
        targetType: 'meal_plan',
        targetId: '21',
        resourceType: 'meal_plan',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    const serialized = JSON.stringify(comparisons);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].decisionId).toMatch(/^cooking:meal_plan:[a-f0-9]{32}$/);
    expect(serialized).not.toContain('Private family meal');
    expect(serialized).not.toContain('Private allergy note');
    expect(serialized).not.toContain('2026-07-11');
  });

  it('matches the serving Cooking date-and-meal-slot identity', () => {
    testDb.exec(`
      CREATE TABLE meal_plans (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL, lifecycle_state TEXT NOT NULL, scope_status TEXT NOT NULL,
        date TEXT NOT NULL, meal_type TEXT NOT NULL, recipe_id INTEGER,
        title TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO meal_plans VALUES
        (21, 70, 7, 7, 'planned', 'active', '2026-07-11', 'dinner', 9,
         'Private family meal', NULL, '2026-07-01T00:00:00Z');
    `);

    const comparisons = adapter('cooking_planned_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'cooking.add_meal',
        targetType: 'meal_plan',
        targetId: '2026-07-11:dinner',
        resourceType: 'meal_plan',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].action.targetEntities[0].id).toBe('2026-07-11:dinner');
  });

  it('treats pending Finance tax state as integrity state without copying values', () => {
    testDb.exec(`
      CREATE TABLE finance_tax_events (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL, month TEXT NOT NULL,
        status TEXT NOT NULL, tax_due REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO finance_tax_events VALUES
        (31, 70, 7, '2026-06', 'pending', 12345.67, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (32, 70, 7, '2026-05', 'paid', 999.00, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (33, 71, 7, '2026-04', 'overdue', 888.00, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');
    `);

    const comparisons = adapter('finance_active_tax_state').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'finance.mark_tax_paid',
        targetType: 'finance_tax_event',
        targetId: '31',
        resourceType: 'finance_tax_event',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      authority: 'data_integrity',
      approved: false,
      action: { risk: 'high' },
    });
    expect(comparisons[0].decisionId).toMatch(/^finance:finance_tax_event:[a-f0-9]{32}$/);
    expect(JSON.stringify(comparisons)).not.toContain('12345.67');
  });

  it('matches the serving Finance tax-month identity', () => {
    testDb.exec(`
      CREATE TABLE finance_tax_events (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL, month TEXT NOT NULL,
        status TEXT NOT NULL, tax_due REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO finance_tax_events VALUES
        (31, 70, 7, '2026-06', 'overdue', 12345.67, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');
    `);

    const comparisons = adapter('finance_active_tax_state').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'finance.mark_tax_paid',
        targetType: 'finance_tax_event',
        targetId: '2026-06',
        resourceType: 'finance_tax_event',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].action.targetEntities[0].id).toBe('2026-06');
    expect(JSON.stringify(comparisons)).not.toContain('12345.67');
  });

  it('projects only the explicitly targeted open canonical task', () => {
    testDb.exec(`
      CREATE TABLE unified_tasks (
        id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER NOT NULL,
        nexus_task_id TEXT, local_version INTEGER NOT NULL, status TEXT NOT NULL,
        is_deleted INTEGER NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO unified_tasks VALUES
        (41, 70, 7, 'task_alpha', 6, 'pending', 0, 'Private task title', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (42, 70, 7, 'task_done', 2, 'completed', 0, 'Completed task', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'),
        (43, 71, 7, 'task_other_tenant', 1, 'pending', 0, 'Other tenant task', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');
    `);

    const comparisons = adapter('tasks_open_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: candidate({
        intent: 'tasks.complete',
        targetType: 'task',
        targetId: 'task_alpha',
        resourceType: 'task',
      }),
      now: new Date('2026-07-10T12:00:00Z'),
    });

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      authority: 'approved_commitment',
      action: { targetEntities: [{ type: 'task', id: 'task_alpha', version: '6' }] },
    });
    expect(comparisons[0].decisionId).toMatch(/^tasks:task:[a-f0-9]{32}$/);
    expect(JSON.stringify(comparisons)).not.toContain('Private task title');
  });

  it('does not broaden a Content create proposal to unrelated approved objects', () => {
    testDb.exec(`
      CREATE TABLE content_domain_objects (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
        scope_status TEXT NOT NULL, editorial_state TEXT NOT NULL, approval_state TEXT NOT NULL,
        workflow_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO content_domain_objects VALUES
        (11, 70, 7, 'active', 'approved', 'approved', 4, '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');
    `);
    const create = candidate({
      intent: 'content.brief_draft',
      targetType: 'secretary_evidence',
      targetId: 'opaque_evidence',
      resourceType: 'secretary_review',
    });

    expect(adapter('content_approved_commitments').loadComparisons({
      scope: { userId: 7, tenantId: 70 },
      candidate: create,
      now: new Date('2026-07-10T12:00:00Z'),
    })).toEqual([]);
  });
});
