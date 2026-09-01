import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => []),
  isApnsConfigured: vi.fn(() => false),
  sendPushNotification: vi.fn(),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  createCanonicalContentDecisionFixture,
  ensureCanonicalContentDecisionFixtureSchema,
} from '../helpers/content-workspace-decision-fixture';
import type { DecisionApiItem } from '../../src/services/decision-center';
import {
  addDecisionDependency,
  applyDecisionFatigueCaps,
  isDecisionItemPolicyFloored,
  isUncertainDecisionExecutionOutcome,
  buildDecisionCenterReportDocument,
  buildSkillDecisionFixtureIntent,
  cleanupDecisionCenterSmokeItems,
  createDecisionIntent,
  decisionRefreshSupportedForDecision,
  DecisionActionError,
  DECISION_OUTCOME_LEDGER_RETENTION_POLICY,
  dismissDecision,
  ensureDecisionCenterTables,
  evaluateDecisionApnsActionRequest,
  evaluateDecisionEligibility,
  getDecisionItem,
  refreshDecisionItem,
  getDecisionGuidanceStats,
  getDecisionOverview,
  getDecisionOutcomeMetrics,
  getDecisionSummary,
  listDecisionDependencies,
  listDecisionItems,
  listHandledByNexusItems,
  performDecisionAction,
  reviewDecision,
  reviseDecisionProposal,
  runDecisionHandledHistoryBackfillJob,
  runDecisionSourceStateSupersessionJob,
  sanitizeGuidanceString,
  runDecisionExpiryJob,
  runDecisionLedgerRetentionPruneJob,
  legacyStatusToLifecycle,
  actionOutcomeFromRecord,
  computeEffectiveStatus,
  computeActionEffectiveStatus,
  computeDecisionKind,
  computeActionability,
  gateActionabilityForStaleEvidence,
  gateActionabilityForHumanReview,
  isHumanReviewQueueAvailable,
  rankDecisionPriority,
  computeConfidenceExplanation,
  getDecisionLifecycleEvents,
  getDecisionLifecycleEventWriteFailures,
  runDecisionMetricsRollupJob,
  runDecisionRankSnapshotBackfillJob,
  getDecisionMetricsDaily,
  decisionMetricsLocalDayWindow,
  getDecisionReleaseGateStatus,
  getDecisionActiveBreakdowns,
  recordDecisionItemExposures,
  recordDecisionItemExposuresByIds,
  applyDecisionTypeSuppression,
  suppressDecisionType,
  unsuppressDecisionType,
  listDecisionTypeSuppressions,
  getDecisionFeedbackSignals,
  markDecisionViewed,
  snoozeDecision,
  updateDecisionPreferences,
} from '../../src/services/decision-center';
import { resolveNotificationContract } from '../../src/services/notification-contracts';
import { buildSkillNotificationFixtureIntent, createNotificationIntent, ensureNotificationTables, listNotificationCenterItems } from '../../src/services/notification-orchestrator';
import { clearPendingChatConfirmation, trackPendingChatConfirmation } from '../../src/services/chat-pending-confirmations';
import { buildNormalizedDecisionAction } from '../../src/services/decision-action-contract';
import { evaluateDecisionConflicts } from '../../src/services/decision-conflict-evaluator';
import { decideContentWorkspaceReview } from '../../src/services/content-workspace-decision-adapter';
import { transitionContentWorkspaceItem } from '../../src/services/content-workspace';
import { initializeDecisionCenterSchemaForTests } from '../../src/testing/decision-center-test-schema';

// Most cases in this compatibility suite characterize the preserved legacy
// surface. Rewrite-authoritative cases delete this explicitly inside the test.
beforeEach(() => {
  process.env.DECISION_CENTER_REWRITE_MODE = 'legacy';
});

afterEach(() => {
  delete process.env.DECISION_CENTER_REWRITE_MODE;
});

async function createContentApprovalDecision(userId: number, tenantId: number, dedupeKey: string) {
  const object = createCanonicalContentDecisionFixture(testDb, {
    userId,
    tenantId,
    objectType: 'script',
    title: `Draft ${dedupeKey}`,
    editorialState: 'drafted',
    inReview: true,
  });
  const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', userId, {
    tenantId,
    relatedEntityId: object.id,
    relatedEntityType: 'content_workflow_object',
    dedupeKey,
  }));
  return { object, created };
}

function insertActionedDecisionFixture(input: {
  itemId: string;
  userId: number;
  tenantId: number;
  createdAt: string;
  actionedAt?: string;
  sourceSkill?: string;
  actionResult?: Record<string, unknown>;
}): void {
  const sourceSkill = input.sourceSkill ?? 'content';
  const intentId = `intent-${input.itemId}`;
  testDb.prepare(`
    INSERT INTO notification_intents (
      intent_id, user_id, tenant_id, source_skill, type, priority,
      related_entity_id, related_entity_type, title, body, sensitive_body,
      action_buttons_json, deeplink, requires_user_action, privacy_policy,
      decision_context_json, status, created_at
    ) VALUES (?, ?, ?, ?, 'decision_required', 'time_sensitive',
      ?, 'content_workflow_object', 'Content review', 'Decision body', NULL,
      ?, 'nexushub://decision-center', 1, 'private_content',
      ?, 'delivered', ?)
  `).run(
    intentId,
    input.userId,
    input.tenantId,
    sourceSkill,
    `entity-${input.itemId}`,
    JSON.stringify([{ id: 'approve_script', label: 'Approve', style: 'primary' }]),
    JSON.stringify({ entityTitle: `Draft ${input.itemId}` }),
    input.createdAt,
  );
  testDb.prepare(`
    INSERT INTO notification_center_items (
      item_id, intent_id, user_id, tenant_id, title, body, safe_body,
      source_skill, type, priority, status, deeplink, actions_json,
      dedupe_key, created_at, actioned_at, action_result_json
    ) VALUES (?, ?, ?, ?, 'Content review', 'Decision body', 'Decision body',
      ?, 'decision_required', 'time_sensitive', 'actioned', 'nexushub://decision-center',
      ?, ?, ?, ?, ?)
  `).run(
    input.itemId,
    intentId,
    input.userId,
    input.tenantId,
    sourceSkill,
    JSON.stringify([{ id: 'approve_script', label: 'Approve', style: 'primary' }]),
    `dedupe-${input.itemId}`,
    input.createdAt,
    input.actionedAt ?? input.createdAt,
    JSON.stringify(input.actionResult ?? {
      actionId: 'approve_script',
      contentApprovalState: 'approved',
    }),
  );
}

function insertHandledFixture(input: {
  handledItemId: string;
  decisionId: string;
  userId: number;
  tenantId: number;
  createdAt: string;
}): void {
  testDb.prepare(`
    INSERT INTO handled_by_nexus_items (
      handled_item_id, decision_id, user_id, tenant_id, source_skill, title, summary,
      action_taken, why_brief, explanation_json, related_entities_json, rollback_available,
      changed_rule_option, privacy_classification, created_at
    ) VALUES (?, ?, ?, ?, 'content', 'Content review', 'Content workflow is now approved.',
      'approve_script', 'Nexus checked Content and found the state is approved.', NULL, '[]', 0,
      NULL, 'private_content', ?)
  `).run(input.handledItemId, input.decisionId, input.userId, input.tenantId, input.createdAt);
}

function ensureSecretaryAgendaFixtureTables(): void {
  testDb.exec(readFileSync('migrations/083_secretary_agenda_ledger.sql', 'utf8'));
  const columns = new Set((testDb.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has('decision_explanation')) {
    testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN decision_explanation TEXT');
  }
  if (!columns.has('reasoning_trail_json')) {
    testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  }
}

function ensureTrainingCommitmentFixtureTables(): void {
  testDb.exec(readFileSync('migrations/023_fitness_training_plans.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/081_training_agenda_event_ownership.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/140_training_tenant_id.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/180_plan_adaptation_revision.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/039_unified_task_store.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/216_offline_first_tasks.sql', 'utf8'));
}

function clearScopedDecisionFlowFlags(): void {
  for (const key of Object.keys(process.env)) {
    if (/^(DECISION_CONFLICT_POLICY_V1_ENABLED|DECISION_FLOW_V1_ENFORCE_ENABLED|TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED|DECISION_LOW_RISK_AUTO_RESOLUTION_ENABLED)_/.test(key)) {
      delete process.env[key];
    }
  }
}

function ensureUserFixtureTable(): void {
  testDb.exec(readFileSync('migrations/030_users.sql', 'utf8'));
}

function ensureFinanceFixtureTables(): void {
  testDb.exec(readFileSync('migrations/004_invoice_filings.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/022_finance_tables.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/025_finance_encryption.sql', 'utf8'));
  testDb.exec(`
    ALTER TABLE invoice_filings ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE invoice_vendors ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
  `);
  testDb.exec(readFileSync('migrations/067_fiscal_collection_profiles.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/136_finance_transaction_soft_delete.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/138_finance_tenant_id.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/144_finance_money_to_cents.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/145_finance_tax_pt_invoice_code.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/146_finance_eur_tenant_rebuild.sql', 'utf8'));
}

function ensureCookingFixtureTables(): void {
  testDb.exec(readFileSync('migrations/024_cooking_tables.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/102_cooking_tenant_scope_and_intelligence.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/088_skill_memory_foundation.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/141_cooking_meal_plan_tenant_uniques.sql', 'utf8'));
}

describe('Decision Center facade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    process.env.DECISION_CENTER_REWRITE_MODE = 'legacy';
    delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
    delete process.env.DECISION_FEEDBACK_SUPPRESSION_ENABLED;
    delete process.env.DECISION_CANDIDATE_REJECTION_COOLDOWN_DAYS;
    delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED;
    delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    delete process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED;
    ensureCanonicalContentDecisionFixtureSchema(testDb);
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
    ensureTrainingCommitmentFixtureTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
    delete process.env.DECISION_FEEDBACK_SUPPRESSION_ENABLED;
    delete process.env.DECISION_CANDIDATE_REJECTION_COOLDOWN_DAYS;
    delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED;
    delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    delete process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED;
    clearScopedDecisionFlowFlags();
    vi.useRealTimers();
    testDb?.close();
  });

  it('classifies true decisions separately from routine notifications and passive insights', () => {
    expect(evaluateDecisionEligibility({
      sourceSkill: 'cooking',
      type: 'reminder',
      priority: 'active',
      requiresUserAction: false,
      actionButtons: [{ id: 'open_detail', label: 'Open' }],
    }).classification).toBe('notification');

    const reminderWithActionChip = evaluateDecisionEligibility({
      sourceSkill: 'finance',
      type: 'reminder',
      priority: 'time_sensitive',
      requiresUserAction: false,
      actionButtons: [{ id: 'mark_paid', label: 'Mark paid' }],
    });
    expect(reminderWithActionChip.classification).toBe('notification');
    expect(reminderWithActionChip.apnsEligible).toBe(false);
    expect(reminderWithActionChip.reasons.join(' ')).toContain('do not imply a user decision');

    const conflict = evaluateDecisionEligibility({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      requiresUserAction: true,
      actionButtons: [{ id: 'accept_reflow', label: 'Accept' }],
    });
    expect(conflict.classification).toBe('decision');
    expect(conflict.apnsEligible).toBe(true);

    const insight = evaluateDecisionEligibility({
      sourceSkill: 'system',
      type: 'insight',
      priority: 'passive',
      requiresUserAction: false,
    });
    expect(insight.classification).toBe('insight');
    expect(insight.apnsEligible).toBe(false);
  });

  it('does not create Decision Center items from routine reminders just because they have action chips', async () => {
    const created = await createDecisionIntent(buildSkillNotificationFixtureIntent('finance', 1, {
      type: 'reminder',
      requiresUserAction: false,
      actionButtons: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary' }],
      dedupeKey: 'finance:routine-action-chip',
    }));

    expect(created.item).toBeNull();
    expect(created.eligibility.classification).toBe('notification');
    expect(listDecisionItems(1, 1)).toHaveLength(0);
    expect(getDecisionSummary(1, 1).ctaLabel).toBe('All Clear');
  });

  it('replays proposal idempotency keys without creating another intent, item, or receipt', async () => {
    const proposal = {
      ...buildSkillDecisionFixtureIntent('training', 1, {
        tenantId: 1,
        relatedEntityId: 'proposal-replay-profile',
        relatedEntityType: 'training_profile',
        dedupeKey: 'training:proposal-replay',
      }),
      idempotencyKey: 'proposal-replay-key-1',
    };

    const first = await createDecisionIntent(proposal);
    const second = await createDecisionIntent(proposal);

    expect(first.item?.decisionId).toBeTruthy();
    expect(second.item?.decisionId).toBe(first.item?.decisionId);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_intents
       WHERE user_id = 1 AND tenant_id = 1 AND intent_id LIKE 'dci_%'
    `).get()).toMatchObject({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_center_items
       WHERE user_id = 1 AND tenant_id = 1 AND intent_id LIKE 'dci_%'
    `).get()).toMatchObject({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM decision_lifecycle_events
       WHERE user_id = 1 AND tenant_id = 1
         AND event = 'mutation_receipt' AND action_id = 'create_intent'
    `).get()).toMatchObject({ count: 1 });
  });

  it('rejects altered proposal reuse and never persists the raw idempotency key', async () => {
    const proposal = {
      ...buildSkillDecisionFixtureIntent('training', 2, {
        tenantId: 2,
        relatedEntityId: 'proposal-reuse-profile',
        relatedEntityType: 'training_profile',
        dedupeKey: 'training:proposal-reuse',
      }),
      idempotencyKey: 'private-proposal-key-2',
    };
    await createDecisionIntent(proposal);

    await expect(createDecisionIntent({
      ...proposal,
      title: 'A different proposal under the same transport key',
    })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 409,
    });

    const stored = testDb.prepare(`
      SELECT intents.intent_id AS intentId, receipts.metadata_json AS metadataJson
        FROM notification_intents intents
        JOIN decision_lifecycle_events receipts
          ON receipts.user_id = intents.user_id
         AND receipts.tenant_id = intents.tenant_id
         AND receipts.event = 'mutation_receipt'
         AND receipts.action_id = 'create_intent'
       WHERE intents.user_id = 2 AND intents.tenant_id = 2
       LIMIT 1
    `).get() as { intentId: string; metadataJson: string };
    expect(`${stored.intentId}:${stored.metadataJson}`).not.toContain('private-proposal-key-2');
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM notification_intents WHERE user_id = 2 AND tenant_id = 2
    `).get()).toMatchObject({ count: 1 });
  });

  it('scopes the same proposal idempotency key independently by user and tenant', async () => {
    const first = await createDecisionIntent({
      ...buildSkillDecisionFixtureIntent('training', 3, {
        tenantId: 30,
        relatedEntityId: 'scope-a-profile',
        relatedEntityType: 'training_profile',
        dedupeKey: 'training:proposal-scope:a',
      }),
      idempotencyKey: 'shared-proposal-key',
    });
    const second = await createDecisionIntent({
      ...buildSkillDecisionFixtureIntent('training', 4, {
        tenantId: 40,
        relatedEntityId: 'scope-b-profile',
        relatedEntityType: 'training_profile',
        dedupeKey: 'training:proposal-scope:b',
      }),
      idempotencyKey: 'shared-proposal-key',
    });

    expect(first.item?.decisionId).toBeTruthy();
    expect(second.item?.decisionId).toBeTruthy();
    expect(first.item?.decisionId).not.toBe(second.item?.decisionId);
  });

  it('creates a bounded Home summary from scoped decision-worthy items only', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 1, {
      relatedEntityId: 'triathlon-running',
      relatedEntityType: 'training_profile',
      dedupeKey: 'training:race-date-decision',
    }));
    await createDecisionIntent(buildSkillNotificationFixtureIntent('cooking', 1, {
      type: 'reminder',
      requiresUserAction: false,
      actionButtons: [{ id: 'open_detail', label: 'Open' }],
      dedupeKey: 'cooking:routine',
    }));

    const items = listDecisionItems(1, 1);
    expect(items).toHaveLength(1);
    expect(items[0].sourceSkill).toBe('training');
    expect(items[0].problemStatement).toContain('race date');
    expect(items[0].quality.status).toBe('pass');
    expect(items[0].displayMode).toBe('needs_input');
    expect(items[0].frontendActionState).toBe('enabled');
    expect(items[0].analysis.confidenceLabel).toMatch(/high|medium|low/);
    expect(items[0].analysis.whyNow).toBeTruthy();

    const summary = getDecisionSummary(1, 1);
    expect(summary.openCount).toBe(1);
    expect(summary.urgentCount).toBe(0);
    expect(summary.ctaLabel).toBe('1 Decision');
    expect(summary.topSuggestion?.title).toBeTruthy();
    expect(summary.previewItems).toHaveLength(1);
    expect(summary.previewItems[0].safePreviewBody).not.toContain('Calendar details');

    const overview = getDecisionOverview(1, 1, { limit: 20, handledLimit: 5 });
    expect(overview.openCount).toBe(1);
    expect(overview.partial).toEqual({ items: true, handled: true, summary: true });
    expect(overview.topSuggestion?.expectedOutcome).toBeTruthy();

    const report = buildDecisionCenterReportDocument(1, 1);
    expect(report.type).toBe('decision_briefing');
    expect((report.openDecisions as unknown[])).toHaveLength(1);
  });

  it('keeps Decision Center overview renderable when handled history is unavailable', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 1, {
      relatedEntityId: 'triathlon-running-partial',
      relatedEntityType: 'training_profile',
      dedupeKey: 'training:race-date-decision-partial',
    }));

    const originalPrepare = testDb.prepare.bind(testDb);
    const prepareSpy = vi.spyOn(testDb, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('FROM handled_by_nexus_items')) {
        throw new Error('handled history unavailable');
      }
      return originalPrepare(sql);
    }) as typeof testDb.prepare);

    try {
      const overview = getDecisionOverview(1, 1, { limit: 20, handledLimit: 5 });

      expect(overview.partial).toEqual({ items: true, handled: false, summary: false });
      expect(overview.items).toHaveLength(1);
      expect(overview.handled).toEqual([]);
      expect(overview.topSuggestion?.title).toBeTruthy();
      expect(overview.summary.previewItems).toEqual([]);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('scopes overview items by sourceSkill and reports the pre-limit skill total (BE-1)', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 1, {
      relatedEntityId: 'be1-training',
      relatedEntityType: 'training_profile',
      dedupeKey: 'training:be1-filter-a',
    }));
    await createContentApprovalDecision(1, 1, 'content:be1-filter-a');
    await createContentApprovalDecision(1, 1, 'content:be1-filter-b');

    // Unfiltered responses carry no skill-filter fields (byte-compat).
    const unfiltered = getDecisionOverview(1, 1, { limit: 20, handledLimit: 5 });
    expect(unfiltered.sourceSkillFilter).toBeUndefined();
    expect(unfiltered.sourceSkillTotalCount).toBeUndefined();
    expect(unfiltered.items.length).toBeGreaterThanOrEqual(3);

    // Filtered: items are skill-scoped, the total counts past the limit,
    // and the global counters stay global.
    const filtered = getDecisionOverview(1, 1, { limit: 1, handledLimit: 5, sourceSkill: 'content' });
    expect(filtered.sourceSkillFilter).toBe('content');
    expect(filtered.sourceSkillTotalCount).toBe(2);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items.every((item) => item.sourceSkill === 'content')).toBe(true);
    expect(filtered.openCount).toBe(unfiltered.openCount);
  });

  it('reports total overview counts beyond the 100-item presentation page', async () => {
    for (let index = 0; index < 101; index += 1) {
      if (index === 55) {
        testDb.prepare(`
          DELETE FROM resource_budget_counters
           WHERE tenant_id = 1 AND user_id = 1
             AND budget_key = 'notification_intent_create:training'
        `).run();
      }
      await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 1, {
        relatedEntityId: `overview-pagination-${index}`,
        relatedEntityType: 'training_profile',
        dedupeKey: `training:overview-pagination-${index}`,
      }));
    }

    const overview = getDecisionOverview(1, 1, { limit: 100, handledLimit: 0 });

    expect(overview.items).toHaveLength(100);
    expect(overview.count).toBe(101);
    expect(overview.openCount).toBe(101);
  }, 30_000);

  it('localizes Home Decision Center CTA labels from the user locale', async () => {
    ensureUserFixtureTable();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (84, 8400, 'Portuguese Owner', 'pt-BR', 'Europe/Lisbon', 'active')
    `).run();

    expect(getDecisionSummary(84, 84).ctaLabel).toBe('Tudo certo');

    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 84, {
      relatedEntityId: 'profile-pt',
      relatedEntityType: 'training_profile',
      dedupeKey: 'training:pt-summary',
    }));
    expect(getDecisionSummary(84, 84).ctaLabel).toBe('1 decisão');

    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 84, {
      priority: 'time_sensitive',
      relatedEntityId: 'profile-pt-urgent',
      relatedEntityType: 'training_profile',
      dedupeKey: 'training:pt-summary-urgent',
    }));
    expect(getDecisionSummary(84, 84).ctaLabel).toBe('Decisão urgente');
  });

  it('uses the user local day for timeline sections and separates unresolved carryover', async () => {
    vi.setSystemTime(new Date('2026-05-10T01:30:00.000Z'));
    ensureUserFixtureTable();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (846, 84600, 'Los Angeles Owner', 'en-US', 'America/Los_Angeles', 'active')
    `).run();

    const tomorrowLocal = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 846, {
      priority: 'active',
      dedupeKey: 'timeline-local-day',
      decisionDeadline: '2026-05-10T08:00:00.000Z',
    }));
    expect(getDecisionItem(tomorrowLocal.item!.decisionId, 846, 846)).toMatchObject({
      sectionKey: 'tomorrow',
      timingLabel: 'Tomorrow',
      isCarryover: false,
    });

    const carryover = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 846, {
      priority: 'active',
      dedupeKey: 'timeline-carryover',
      decisionDeadline: null,
      expiresAt: null,
    }));
    testDb.prepare(`
      UPDATE notification_center_items
         SET created_at = '2026-05-08T20:00:00.000Z'
       WHERE item_id = ?
    `).run(carryover.item!.decisionId);
    expect(getDecisionItem(carryover.item!.decisionId, 846, 846)).toMatchObject({
      sectionKey: 'today',
      isCarryover: true,
    });
    expect(getDecisionSummary(846, 846).todayCount).toBe(0);
  });

  it('localizes the Home CTA for non-urgent schedule conflicts', async () => {
    ensureUserFixtureTable();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (85, 8500, 'Lisbon Owner', 'pt-PT', 'Europe/Lisbon', 'active')
    `).run();

    await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 85, {
      priority: 'active',
      title: 'Schedule conflict',
      body: 'Focus block overlaps with a fixed meeting.',
      relatedEntityId: 'conflict-85',
      relatedEntityType: 'calendar_conflict',
      actionButtons: [{ id: 'open_detail', label: 'Open details', style: 'primary' }],
      dedupeKey: 'secretary:pt-summary-conflict',
      decisionContext: {
        entityTitle: 'Bloco de foco',
        currentStartAt: '2026-05-10T13:00:00.000Z',
        currentEndAt: '2026-05-10T14:00:00.000Z',
        recommendedStartAt: '2026-05-10T15:00:00.000Z',
        recommendedEndAt: '2026-05-10T16:00:00.000Z',
      },
    }));

    expect(getDecisionSummary(85, 85).ctaLabel).toBe('Conflito de agenda');
  });

  it('exposes a privacy-safe conflict summary only when conflict policy v1 is enabled', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED = 'active';
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, provider_event_id, provider_source,
        version, title, start_at, end_at, duration_minutes, decision_action,
        decision_reason_codes_json, decision_explanation, source_shape_hash,
        scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-conflict-1', 'intent-conflict-1', 'training', 'focus_block', 'protect_time_for_this',
        'source-conflict-1', 'training_session', 85, '85',
        'synced', 'synced', 'provider-event-1', 'google',
        3, 'Protected focus block', '2026-05-11T08:00:00.000Z', '2026-05-11T09:00:00.000Z',
        60, 'scheduled', '[]', 'Confirmed calendar overlap', 'shape-conflict-1',
        '[]', '2026-05-10T09:00:00.000Z', '2026-05-10T09:00:00.000Z'
      )
    `).run();
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'review_calendar_conflict',
      targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda-conflict-1', version: '3' }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      requestedWindow: {
        start: '2026-05-11T08:00:00.000Z',
        end: '2026-05-11T09:00:00.000Z',
        timezone: 'Europe/Lisbon',
      },
      preconditions: [{ type: 'agenda_version', ref: 'agenda-conflict-1', expectedVersion: '3', required: true }],
      expectedEffects: [{ type: 'review_required', targetRef: 'secretary_agenda_item:agenda-conflict-1' }],
      prohibitedEffects: [{ type: 'automatic_calendar_mutation', targetRef: 'secretary_agenda_item:agenda-conflict-1' }],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:85'],
      authorizationScope: ['decision_center:read'],
      risk: 'medium',
      reversibility: 'reversible',
      contextVersion: 'ctx_conflict_1',
    });
    const existing = buildNormalizedDecisionAction({
      ...normalizedAction,
      intent: 'preserve_confirmed_calendar_commitment',
      targetEntities: [{ type: 'calendar_event', id: 'opaque_event_2' }],
      requestedWindow: {
        start: '2026-05-11T08:30:00.000Z',
        end: '2026-05-11T09:30:00.000Z',
        timezone: 'Europe/Lisbon',
      },
      preconditions: [],
      expectedEffects: [{ type: 'preserve_commitment', targetRef: 'opaque_event_2' }],
      prohibitedEffects: [],
    });
    const conflictEvaluation = evaluateDecisionConflicts({
      candidate: normalizedAction,
      existing: [{ action: existing, authority: 'approved_commitment', approved: true, createdAt: '2026-05-10T09:00:00.000Z' }],
      now: new Date('2026-05-10T10:00:00.000Z'),
    });

    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 85, {
      priority: 'active',
      title: 'Calendar commitments overlap',
      body: 'A Secretary-owned agenda item overlaps a confirmed calendar commitment.',
      relatedEntityId: 'agenda-conflict-1',
      relatedEntityType: 'secretary_agenda_item',
      actionButtons: [{ id: 'open_detail', label: 'Review commitments', style: 'primary' }],
      dedupeKey: 'secretary:calendar-conflict-preview:agenda-conflict-1:ctx_conflict_1',
      decisionContext: {
        entityTitle: 'Protected focus block',
        currentStartAt: '2026-05-11T08:00:00.000Z',
        currentEndAt: '2026-05-11T09:00:00.000Z',
        reasonCodes: ['calendar_time_overlap', 'approved_commitment_requires_review', 'preview_only'],
        timezone: 'Europe/Lisbon',
        normalizedAction,
        conflictComparisons: [{
          action: existing,
          authority: 'approved_commitment',
          approved: true,
          createdAt: '2026-05-10T09:00:00.000Z',
        }],
        conflictEvaluation,
      },
    }));

    expect(created.item?.contextVersion).toBe('ctx_conflict_1');
    expect(created.item?.conflictSummary).toMatchObject({
      disposition: 'needs_confirmation',
      requiresConfirmation: true,
      blocking: false,
    });
    expect(created.item).toMatchObject({ approvalLevel: 'none', actionability: 'read_only' });
    expect(JSON.stringify(created.item?.conflictSummary)).not.toContain('agenda-conflict-1');

    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED = 'false';
    const hidden = getDecisionItem(created.item!.decisionId, 85, 85);
    expect(hidden?.conflictSummary).toBeUndefined();
    expect(hidden?.contextVersion).toBe('ctx_conflict_1');
  });

  it('does not create user-facing items for generic screenshot-style decisions', async () => {
    const created = await createDecisionIntent(buildSkillNotificationFixtureIntent('secretary', 80, {
      title: 'Secretary',
      body: 'Secretary needs your attention — open Nexus to view details.',
      safeBody: 'Secretary needs your attention — open Nexus to view details.',
      relatedEntityId: null,
      relatedEntityType: null,
      actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
      requiresUserAction: true,
      dedupeKey: 'secretary:generic-screenshot',
    } as any));

    expect(created.item).toBeNull();
    expect(created.eligibility.reasons.join(' ')).toContain('quality_gate');
    expect(listDecisionItems(80, 80)).toHaveLength(0);
    expect(getDecisionSummary(80, 80).ctaLabel).toBe('All Clear');
  });

  it('counts current decision streaks beyond the 14-day display window', () => {
    const insert = testDb.prepare(`
      INSERT INTO decision_queue_daily_rollups (
        user_id, tenant_id, local_date, timezone, reached_zero_at,
        final_open_count, best_observed_open_count
      ) VALUES (?, ?, ?, 'UTC', ?, 0, 0)
    `);
    for (let daysAgo = 0; daysAgo < 30; daysAgo += 1) {
      const date = new Date(Date.UTC(2026, 4, 10 - daysAgo)).toISOString().slice(0, 10);
      insert.run(90, 90, date, `${date}T22:00:00.000Z`);
    }

    const summary = getDecisionSummary(90, 90);

    expect(summary.gamification?.currentStreakDays).toBe(30);
    expect(summary.gamification?.bestStreakDays).toBeGreaterThanOrEqual(30);
    expect(summary.gamification?.last14Days).toHaveLength(14);
  });

  it('treats missing decision rollup days as best-streak breaks', () => {
    const insert = testDb.prepare(`
      INSERT INTO decision_queue_daily_rollups (
        user_id, tenant_id, local_date, timezone, reached_zero_at,
        final_open_count, best_observed_open_count
      ) VALUES (?, ?, ?, 'UTC', ?, 0, 0)
    `);
    for (const date of ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-09', '2026-05-10']) {
      insert.run(91, 91, date, `${date}T22:00:00.000Z`);
    }

    const summary = getDecisionSummary(91, 91);

    expect(summary.gamification?.currentStreakDays).toBe(2);
    expect(summary.gamification?.bestStreakDays).toBe(3);
  });

  it('preserves supplied decision context so concrete Secretary decisions survive persistence', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 81, {
      title: 'Schedule conflict',
      body: 'Focus block overlaps with a fixed meeting.',
      relatedEntityId: 'conflict-81',
      relatedEntityType: 'calendar_conflict',
      actionButtons: [{ id: 'open_detail', label: 'Open details', style: 'primary' }],
      dedupeKey: 'secretary:contextual-conflict',
      decisionContext: {
        entityTitle: 'Focus block',
        currentStartAt: '2026-05-10T13:00:00.000Z',
        currentEndAt: '2026-05-10T14:00:00.000Z',
        recommendedStartAt: '2026-05-10T15:00:00.000Z',
        recommendedEndAt: '2026-05-10T16:00:00.000Z',
        sourceState: 'conflict_detected',
      },
    }));

    expect(created.item).not.toBeNull();
    expect(created.item?.quality.status).toBe('pass');
    expect(created.item?.displayMode).toBe('needs_input');
    expect(created.item?.frontendActionState).toBe('enabled');
    expect(created.item?.problemStatement).toContain('Focus block');
    expect(created.item?.recommendation).toContain('Sun, May 10');
    expect(created.item?.recommendation).not.toContain('2026-05-10T15:00:00.000Z');

    const listed = listDecisionItems(81, 81);
    expect(listed).toHaveLength(1);
    expect(listed[0].quality.status).toBe('pass');
    expect(listed[0].problemStatement).toContain('Focus block');
    expect(listed[0].whatWillChange[0]).toMatchObject({
      item: 'Focus block',
      targetSkill: 'secretary',
    });
    expect(listed[0]).toMatchObject({
      sectionKey: 'urgent',
      groupKey: 'secretary:calendar_conflict:conflict-81',
      impactLevel: 'high',
      sourceTraceSummary: null,
      dependencyGraphSummary: null,
    });
    expect(listed[0].alternatives.some((option) => option.rank === 'best')).toBe(true);
    expect(listed[0].alternatives.find((option) => option.rank === 'best')?.source).toBe('recipe');
    expect(listed[0].alternatives.find((option) => option.actionId === 'snooze')?.source).toBe('system_default');
    expect(listed[0].alternatives.find((option) => option.actionId === 'dismiss')?.source).toBe('system_default');
    expect(listed[0].relatedEntitiesSafe[0]).toMatchObject({ type: 'calendar_conflict' });
    expect(listed[0].sourceTrace).toBeNull();
    expect(listed[0].actionTruthTableEntry).toBeNull();
    expect(listed[0].askNexusContext).toBeNull();
  });

  it('disables user-facing actions when a recipe has no deterministic executor yet', async () => {
    const created = await createDecisionIntent({
      userId: 86,
      tenantId: 86,
      sourceSkill: 'secretary',
      type: 'sync_failure',
      priority: 'active',
      title: 'Calendar sync incomplete',
      body: 'Outlook sync did not complete.',
      actionButtons: [{ id: 'retry', label: 'Retry sync', style: 'primary', mutating: true }],
      relatedEntityType: null,
      relatedEntityId: null,
      requiresUserAction: true,
      privacyPolicy: 'standard',
      decisionContext: {
        providerName: 'Outlook',
        explicitNoRelatedEntityReason: 'sync failure is scoped to provider state',
      },
      dedupeKey: 'unsupported-retry-action',
    });

    expect(created.item).toBeTruthy();
    const listed = listDecisionItems(86, 86);
    expect(listed).toHaveLength(1);
    // `retry` is no longer advertised by the sync_failure contract — its
    // executor never existed, so it always rendered permanently greyed while
    // being floored to the top of the queue. The action contract now drops it.
    expect(listed[0].alternatives.find((option) => option.actionId === 'retry')).toBeUndefined();
    expect(listed[0].actionTruthTableEntry).toBeNull();

    // ...and is replaced by `reconnect`, which is navigation rather than a
    // provider mutation, so it needs no deterministic executor and renders
    // enabled instead of disabled_not_implemented.
    const reconnect = listed[0].alternatives.find((option) => option.actionId === 'reconnect');
    expect(reconnect?.available).toBe(true);
    expect(resolveNotificationContract({
      sourceSkill: 'secretary',
      type: 'sync_failure',
    }).supportedActions).toEqual(['reconnect', 'open_detail']);
  });

  it('threads owner/admin visibility scope through internal decision intents', async () => {
    const created = await createDecisionIntent({
      userId: 91,
      tenantId: 91,
      sourceSkill: 'system',
      type: 'risk_warning',
      priority: 'active',
      title: 'Model fallback invalid',
      body: 'A configured fallback needs owner review before release.',
      requiresUserAction: true,
      actionButtons: [{ id: 'open_detail', label: 'Review evidence', style: 'primary' }],
      relatedEntityType: 'ops_model_fallback',
      relatedEntityId: 'fallback-invalid',
      privacyPolicy: 'sensitive',
      visibilityScope: 'system_admin',
      decisionContext: { entityTitle: 'Model fallback policy' },
      dedupeKey: 'ops:model-fallback-invalid',
    });

    expect(created.item).toBeNull();

    const listed = listDecisionItems(91, 91);
    expect(listed).toHaveLength(0);
    const stored = testDb.prepare(`
      SELECT intents.decision_context_json
        FROM notification_center_items items
        JOIN notification_intents intents ON intents.intent_id = items.intent_id
       WHERE items.user_id = 91 AND items.tenant_id = 91
    `).get() as { decision_context_json: string };
    expect(JSON.parse(stored.decision_context_json).visibilityScope).toBe('system_admin');
    expect(getDecisionGuidanceStats().filteredByReason.admin_visibility_scope).toBeGreaterThan(0);
  });

  it('excludes smoke and internal decisions from normal Decision Center surfaces', async () => {
    const object = createCanonicalContentDecisionFixture(testDb, {
      userId: 93,
      tenantId: 93,
      objectType: 'script',
      title: 'Smoke proof draft',
      editorialState: 'drafted',
    });
    await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 93, {
      type: 'decision_required',
      priority: 'time_sensitive',
      relatedEntityId: object.id,
      relatedEntityType: 'content_workflow_object',
      actionButtons: [{ id: 'approve_script', label: 'Approve', style: 'primary' }],
      requiresUserAction: true,
      dedupeKey: 'smoke:decision-center:visible:93:test',
      visibilityScope: 'system_admin',
      decisionContext: {
        entityTitle: 'Smoke proof draft',
        visibilityScope: 'system_admin',
        internalOnly: true,
        smoke: true,
      },
    }));

    const row = testDb.prepare(`
      SELECT item_id
        FROM notification_center_items
       WHERE user_id = 93 AND tenant_id = 93
       LIMIT 1
    `).get() as { item_id: string };

    expect(listDecisionItems(93, 93)).toHaveLength(0);
    expect(getDecisionItem(row.item_id, 93, 93)).toBeNull();
    expect(getDecisionSummary(93, 93).openCount).toBe(0);
    const overview = getDecisionOverview(93, 93, { limit: 10, handledLimit: 5 });
    expect(overview.openCount).toBe(0);
    expect(overview.secretaryToday.counts.needsUser).toBe(0);
    expect((buildDecisionCenterReportDocument(93, 93).openDecisions as unknown[])).toHaveLength(0);
    expect(getDecisionGuidanceStats().filteredByReason.admin_visibility_scope).toBeGreaterThan(0);
  });

  it('applies each normal-user Decision Center filtering rule while keeping valid decisions visible', async () => {
    const userId = 97;
    const tenantId = 97;
    const future = new Date('2026-05-10T11:00:00.000Z').toISOString();
    const oldSync = new Date('2026-05-10T08:00:00.000Z').toISOString();
    const before = getDecisionGuidanceStats().filteredByReason;

    async function emitFilterFixture(
      key: string,
      overrides: {
        visibilityScope?: 'user_private' | 'tenant_shared' | 'tenant_admin' | 'system_admin';
        decisionContext?: Record<string, unknown>;
        dedupeKey?: string;
        relatedEntityId?: string | null;
        relatedEntityType?: string | null;
        title?: string;
        body?: string;
      } = {},
    ) {
      const hasRelatedOverride = Object.prototype.hasOwnProperty.call(overrides, 'relatedEntityId');
      const object = hasRelatedOverride
        ? null
        : createCanonicalContentDecisionFixture(testDb, {
          userId,
          tenantId,
          objectType: 'script',
          title: `${key} draft`,
          editorialState: 'drafted',
        });
      return createNotificationIntent(buildSkillNotificationFixtureIntent('content', userId, {
        tenantId,
        type: 'approval_required',
        priority: 'time_sensitive',
        title: overrides.title ?? `${key} content review`,
        body: overrides.body ?? `${key} content draft is ready for approval or rewrite feedback.`,
        relatedEntityId: hasRelatedOverride
          ? overrides.relatedEntityId
          : object!.id,
        relatedEntityType: Object.prototype.hasOwnProperty.call(overrides, 'relatedEntityType')
          ? overrides.relatedEntityType
          : 'content_workflow_object',
        actionButtons: [
          { id: 'approve_script', label: 'Approve', style: 'primary' },
          { id: 'request_rewrite', label: 'Rewrite', style: 'secondary' },
        ],
        requiresUserAction: true,
        dedupeKey: overrides.dedupeKey ?? `filter:${key}`,
        visibilityScope: overrides.visibilityScope ?? 'user_private',
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'private_content',
        decisionDeadline: future,
        decisionContext: {
          entityTitle: `${key} draft`,
          sourceState: 'awaiting_approval',
          ...(overrides.decisionContext ?? {}),
        },
      }));
    }

    const visible = await emitFilterFixture('visible');
    const systemAdmin = await emitFilterFixture('system-admin', { visibilityScope: 'system_admin' });
    const tenantAdmin = await emitFilterFixture('tenant-admin', { visibilityScope: 'tenant_admin' });
    const internalOnly = await emitFilterFixture('internal-only', { decisionContext: { internalOnly: true } });
    const smokeContext = await emitFilterFixture('smoke-context', { decisionContext: { smoke: true } });
    const smokeDedupe = await emitFilterFixture('smoke-dedupe', { dedupeKey: 'smoke:decision-center:filter:97' });
    const smokeEntity = await emitFilterFixture('smoke-entity', {
      relatedEntityId: 'smoke-entity',
      relatedEntityType: 'decision_center_smoke',
    });
    const staleSource = await emitFilterFixture('stale-source', {
      decisionContext: {},
    });
    testDb.prepare(`
      UPDATE notification_intents
         SET decision_context_json = ?
       WHERE intent_id = ?
    `).run(JSON.stringify({
      entityTitle: 'stale-source draft',
      sourceState: 'awaiting_approval',
      providerSyncState: 'not_synced',
      providerSyncUpdatedAt: oldSync,
    }), staleSource.intent.intentId);
    const unsafeQuality = await emitFilterFixture('unsafe-quality', {
      title: 'Review',
      body: 'Decision details unavailable',
    });
    testDb.prepare(`
      UPDATE notification_center_items
         SET title = 'Review', body = 'Decision details unavailable',
             safe_body = 'Open Nexus to view details',
             source_skill = 'chat', type = 'decision_required',
             actions_json = ?
       WHERE item_id = ?
    `).run(JSON.stringify([
      { id: 'choose_priority', label: 'Review', style: 'primary', mutating: true },
    ]), unsafeQuality.item!.itemId);
    testDb.prepare(`
      UPDATE notification_intents
         SET related_entity_id = NULL, related_entity_type = NULL,
             decision_context_json = NULL, privacy_policy = 'standard'
       WHERE intent_id = ?
    `).run(unsafeQuality.intent.intentId);

    const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 20 });
    expect(items.map((item) => item.decisionId)).not.toContain(unsafeQuality.item!.itemId);
    expect(items.map((item) => item.decisionId)).toEqual([visible.item?.itemId]);

    for (const result of [systemAdmin, tenantAdmin, internalOnly, smokeContext, smokeDedupe, smokeEntity, staleSource, unsafeQuality]) {
      expect(result.item).not.toBeNull();
      expect(getDecisionItem(result.item!.itemId, userId, tenantId)).toBeNull();
    }

    const after = getDecisionGuidanceStats().filteredByReason;
    function reasonDelta(reason: string): number {
      return (after[reason] ?? 0) - (before[reason] ?? 0);
    }
    expect(reasonDelta('admin_visibility_scope')).toBeGreaterThanOrEqual(2);
    expect(reasonDelta('internal_only')).toBeGreaterThanOrEqual(1);
    expect(reasonDelta('smoke_decision')).toBeGreaterThanOrEqual(3);
    expect(reasonDelta('stale_action_source')).toBeGreaterThanOrEqual(1);
    expect(reasonDelta('unsafe_quality')).toBeGreaterThanOrEqual(1);
  });

  it('cleans up only scoped Decision Center smoke rows with dry-run and confirm modes', async () => {
    const object = createCanonicalContentDecisionFixture(testDb, {
      userId: 94,
      tenantId: 94,
      objectType: 'script',
      title: 'Cleanup smoke draft',
      editorialState: 'drafted',
    });
    await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 94, {
      type: 'decision_required',
      priority: 'time_sensitive',
      title: '[SMOKE] Cleanup proof',
      body: '[SMOKE] Cleanup proof body',
      relatedEntityId: object.id,
      relatedEntityType: 'content_workflow_object',
      actionButtons: [{ id: 'approve_script', label: 'Approve', style: 'primary' }],
      requiresUserAction: true,
      dedupeKey: 'smoke:decision-center:visible:94:test',
      visibilityScope: 'system_admin',
      decisionContext: {
        entityTitle: '[SMOKE] Cleanup proof',
        visibilityScope: 'system_admin',
        internalOnly: true,
        smoke: true,
      },
    }));
    await createContentApprovalDecision(95, 95, 'not-smoke-cleanup');

    const dryRun = cleanupDecisionCenterSmokeItems({ userId: 94, tenantId: 94, dryRun: true });
    expect(dryRun).toMatchObject({ inspected: 1, expired: 0, dryRun: true });

    const confirmed = cleanupDecisionCenterSmokeItems({ userId: 94, tenantId: 94, dryRun: false });
    expect(confirmed).toMatchObject({ inspected: 1, expired: 1, dryRun: false });
    const smokeStatus = testDb.prepare(`
      SELECT status FROM notification_center_items WHERE user_id = 94 AND tenant_id = 94
    `).get() as { status: string };
    const normalStatus = testDb.prepare(`
      SELECT status FROM notification_center_items WHERE user_id = 95 AND tenant_id = 95
    `).get() as { status: string };
    expect(smokeStatus.status).toBe('expired');
    expect(normalStatus.status).not.toBe('expired');
  });

  it('redacts banned technical terms from user-facing guidance without throwing', async () => {
    const object = createCanonicalContentDecisionFixture(testDb, {
      userId: 96,
      tenantId: 96,
      objectType: 'script',
      title: 'Guidance redaction draft',
      editorialState: 'drafted',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 96, {
      relatedEntityId: object.id,
      relatedEntityType: 'content_workflow_object',
      dedupeKey: 'content:redaction-guidance',
      decisionContext: {
        entityTitle: '[SMOKE] source_trace workflow object',
      },
    }));

    expect(created.item).not.toBeNull();
    const payload = JSON.stringify(created.item?.explanation);
    expect(payload).not.toContain('[SMOKE]');
    expect(payload).not.toContain('source_trace');
    expect(payload).not.toContain('workflow object');
    expect(payload).toContain('[redacted]');
    expect(getDecisionGuidanceStats().bannedTermsCaught).toBeGreaterThan(0);
  });

  it('redacts banned technical terms with expected user-facing replacements', () => {
    const cases = [
      { input: 'The [SMOKE] action ran.', expected: 'The [redacted] action ran.' },
      { input: 'Decision Center v2 ships next week.', expected: '[redacted] ships next week.' },
      { input: 'Source trace shows the read-back attempt.', expected: '[redacted] shows the source confirmation attempt.' },
      { input: 'The verifier verifies the result.', expected: 'The [redacted] checks the result.' },
      { input: 'Update secretary_agenda_items state.', expected: 'Update [redacted].' },
      { input: 'Modify workflow object configuration.', expected: 'Modify [redacted] configuration.' },
      { input: 'Read decision_log_id from the record.', expected: 'Read [redacted] from the record.' },
    ];

    for (const testCase of cases) {
      const result = sanitizeGuidanceString(testCase.input, {
        decisionId: 'sanitizer-contract',
        sourceSkill: 'secretary',
      });
      expect(result.sanitized).toBe(testCase.expected);
      expect(result.rejectedTerms.length).toBeGreaterThan(0);
    }
  });

  it('preserves common user-facing copy and locale codes without false-positive redaction', () => {
    const safeStrings = [
      'Your account is up to date.',
      'Mark as done when verified.',
      'Move the long run to Sunday at 08:00.',
      'Next best move: choose another time.',
      'Locale fallback: pt_BR for Brazilian Portuguese users.',
      "It's time to decide.",
    ];

    for (const safeString of safeStrings) {
      const result = sanitizeGuidanceString(safeString, {
        decisionId: 'sanitizer-negative',
        sourceSkill: 'secretary',
      });
      expect(result.sanitized).toBe(safeString);
      expect(result.rejectedTerms).toEqual([]);
    }
  });

  it('increments banned-term counters per rejected guidance term', () => {
    const before = getDecisionGuidanceStats();
    const result = sanitizeGuidanceString('The [SMOKE] verifier verifies the source trace.', {
      decisionId: 'sanitizer-counters',
      sourceSkill: 'secretary',
    });
    const after = getDecisionGuidanceStats();

    expect(result.sanitized).toBe('The [redacted] [redacted] checks the [redacted].');
    expect(after.bannedTermsCaught).toBeGreaterThan(before.bannedTermsCaught);
    expect((after.bannedTermsByTerm['[SMOKE]'] ?? 0) - (before.bannedTermsByTerm['[SMOKE]'] ?? 0)).toBe(1);
    expect((after.bannedTermsByTerm.verifier ?? 0) - (before.bannedTermsByTerm.verifier ?? 0)).toBe(2);
    expect((after.bannedTermsByTerm.source_trace ?? 0) - (before.bannedTermsByTerm.source_trace ?? 0)).toBe(1);
  });

  it('keeps Secretary decisions internal when the only candidate slot matches the current window', async () => {
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-self-move', 'intent-self-move', 'training', 'long_run', 'reschedule_this',
        'session-self-move', 'training_session', 82, '82',
        'proposed', 'not_synced', 1, 'Long run',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '[]', 'Needs user approval',
        'hash-self-move', '[]', datetime('now'), datetime('now')
      )
    `).run();

    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 82, {
      relatedEntityId: 'agenda-self-move',
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: 'secretary:self-move',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      decisionContext: {
        currentStartAt: '2026-05-11T08:00:00.000Z',
        currentEndAt: '2026-05-11T10:00:00.000Z',
      },
    }));

    expect(created.item).toBeNull();
    expect(created.eligibility.reasons.join(' ')).toContain('quality_gate');
    expect(listDecisionItems(82, 82)).toHaveLength(0);
  });

  it('derives Secretary recommendations from persisted alternatives using the user timezone', async () => {
    ensureUserFixtureTable();
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (83, 8300, 'Time Zone Owner', 'en-US', 'America/New_York', 'active')
    `).run();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-timezone-reflow', 'intent-timezone-reflow', 'training', 'long_run', 'reschedule_this',
        'session-timezone', 'training_session', 83, '83',
        'proposed', 'not_synced', 1, 'Long run',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '["training_schedule_request"]', 'Needs user approval',
        'hash-timezone', ?, datetime('now'), datetime('now')
      )
    `).run(JSON.stringify([
      { start: '2026-05-11T08:00:00.000Z', end: '2026-05-11T10:00:00.000Z', label: 'Current slot' },
      { start: '2026-05-11T14:00:00.000Z', end: '2026-05-11T16:00:00.000Z', label: 'Afternoon alternative' },
    ]));

    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 83, {
      relatedEntityId: 'agenda-timezone-reflow',
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: 'secretary:timezone-reflow',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
    }));

    expect(created.item).not.toBeNull();
    expect(created.item?.quality.status).toBe('pass');
    expect(created.item?.recommendation).toContain('10:00-12:00');
    expect(created.item?.recommendation).not.toContain('15:00-17:00');

    const listed = listDecisionItems(83, 83);
    expect(listed).toHaveLength(1);
    expect(listed[0].problemStatement).toContain('Long run');
    expect(listed[0].recommendation).toContain('10:00-12:00');
  });

  it('D: surfaces structured choose-a-time DecisionOptions + the choose_another_time action (flag-gated, actionable end-to-end)', async () => {
    ensureUserFixtureTable();
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (97, 9700, 'Choice Owner', 'en-US', 'UTC', 'active')
    `).run();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-choice', 'intent-choice', 'training', 'long_run', 'reschedule_this',
        'session-choice', 'training_session', 97, '97',
        'proposed', 'not_synced', 1, 'Long run',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '["training_schedule_request"]', 'Needs user approval',
        'hash-choice', ?, datetime('now'), datetime('now')
      )
    `).run(JSON.stringify([
      { start: '2026-05-11T08:00:00.000Z', end: '2026-05-11T10:00:00.000Z', label: 'Current slot' },
      { start: '2026-05-11T14:00:00.000Z', end: '2026-05-11T16:00:00.000Z', label: 'Afternoon alternative' },
      { start: '2026-05-11T18:00:00.000Z', end: '2026-05-11T20:00:00.000Z', label: 'Evening alternative' },
    ]));
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 97, {
      relatedEntityId: 'agenda-choice',
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: 'secretary:choice-options',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
    }));
    expect(created.item).not.toBeNull();
    const id = created.item!.decisionId;

    // Flag OFF (default) — byte-identical: no options, choose_another_time NOT surfaced as an action.
    const off = getDecisionItem(id, 97, 97)!;
    expect(off.options).toBeUndefined();
    expect(off.alternativeActions.concat(off.recommendedAction ? [off.recommendedAction] : []).map((a) => a.id)).not.toContain('choose_another_time');

    try {
      process.env.DECISION_CHOICE_OPTIONS_ENABLED = 'true';
      const on = getDecisionItem(id, 97, 97)!;
      expect(Array.isArray(on.options)).toBe(true);
      // recommended + at least one ranked alternative (two feasible non-current slots were seeded).
      expect(on.options!.length).toBeGreaterThanOrEqual(2);
      const recommended = on.options!.find((o) => o.recommended);
      expect(recommended).toBeDefined();
      expect(recommended!.actionId).toBe('choose_another_time');
      expect(recommended!.actionPayload?.startAt).toBeTruthy();
      // every option carries a concrete window intent (lightweight, not a baked preview) + tradeoffs.
      for (const opt of on.options!) {
        expect(opt.actionId).toBe('choose_another_time');
        expect(opt.actionPayload?.startAt && opt.actionPayload?.endAt).toBeTruthy();
        expect(Array.isArray(opt.tradeoffs)).toBe(true);
      }
      // the action is now surfaced (so the options are invokable through the normal action gate).
      const actionIds = on.alternativeActions.concat(on.recommendedAction ? [on.recommendedAction] : []).map((a) => a.id);
      expect(actionIds).toContain('choose_another_time');

      await expect(performDecisionAction(id, 'choose_another_time', 97, 97, {
        idempotencyKey: 'choice-option-not-advertised',
        payload: {
          startAt: '2026-05-12T01:00:00.000Z',
          endAt: '2026-05-12T03:00:00.000Z',
        },
      })).rejects.toMatchObject({ code: 'DECISION_ACTION_PAYLOAD_MISMATCH' });

      // END-TO-END: selecting an alternative option actually reflows the agenda to that window.
      const alternative = on.options!.find((o) => !o.recommended)!;
      const result = await performDecisionAction(id, 'choose_another_time', 97, 97, {
        idempotencyKey: 'choice-option-select',
        payload: { startAt: alternative.actionPayload!.startAt, endAt: alternative.actionPayload!.endAt },
      });
      expect(result.status).toBe('succeeded');
      const agenda = testDb.prepare('SELECT lifecycle_state, start_at, end_at FROM secretary_agenda_items WHERE agenda_item_id = ?').get('agenda-choice') as any;
      expect(agenda.lifecycle_state).toBe('reflowed');
      expect(agenda.start_at).toBe(alternative.actionPayload!.startAt);

      // IDEMPOTENT REPLAY: a duplicate with the SAME key must return the original result, not a spurious
      // 404 — even though choose_another_time mutated the agenda so a filtered re-read would hide it.
      const replay = await performDecisionAction(id, 'choose_another_time', 97, 97, {
        idempotencyKey: 'choice-option-select',
        payload: { startAt: alternative.actionPayload!.startAt, endAt: alternative.actionPayload!.endAt },
      });
      expect(replay.idempotent).toBe(true);
      expect(replay.item.decisionId).toBe(id);
    } finally {
      delete process.env.DECISION_CHOICE_OPTIONS_ENABLED;
    }
  });

  it('D: surfaces a content pipeline card from the workflow object (flag-gated, real fields only)', async () => {
    const { created } = await createContentApprovalDecision(98, 98, 'content-card');
    expect(created.item).not.toBeNull();
    const id = created.item!.decisionId;

    // OFF (default) — byte-identical: no contentCard.
    expect(getDecisionItem(id, 98, 98)!.contentCard).toBeUndefined();

    try {
      process.env.DECISION_SKILL_CARDS_ENABLED = 'true';
      const card = getDecisionItem(id, 98, 98)!.contentCard;
      expect(card).toBeDefined();
      expect(card!.objectType).toBe('script');     // straight from the workflow object
      expect(card!.pipelineStage).toBe('reviewed'); // canonical review state
      expect(typeof card!.approvalState).toBe('string');
      expect(typeof card!.reviewRequired).toBe('boolean');
      expect(card!.nextActionLabel).toBeTruthy();   // the decision's primary action label

      // a NON-content decision gets no content card even with the flag ON.
      const training = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 98, { dedupeKey: 'content-card-nonmatch' }));
      expect(getDecisionItem(training.item!.decisionId, 98, 98)!.contentCard).toBeUndefined();
    } finally {
      delete process.env.DECISION_SKILL_CARDS_ENABLED;
    }
  });

  it('D: surfaces a training before/after card from the anchoring agenda (flag-gated; risk from reason codes, not text)', async () => {
    ensureUserFixtureTable();
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`INSERT INTO users (id, telegram_id, first_name, language, timezone, status) VALUES (110, 11000, 'Train Owner', 'en-US', 'UTC', 'active')`).run();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-train', 'intent-train', 'training', 'long_run', 'reschedule_this',
        'session-train', 'training_session', 110, '110',
        'proposed', 'not_synced', 1, 'PEAK RACE high risk override by text',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '["peak_week"]', 'Needs approval',
        'hash-train', ?, datetime('now'), datetime('now')
      )
    `).run(JSON.stringify([
      { start: '2026-05-11T08:00:00.000Z', end: '2026-05-11T10:00:00.000Z', label: 'Current' },
      { start: '2026-05-11T14:00:00.000Z', end: '2026-05-11T16:00:00.000Z', label: 'Afternoon' },
    ]));
    // A training-session reflow is surfaced under the secretary skill, anchored on the training agenda.
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 110, {
      relatedEntityId: 'agenda-train', relatedEntityType: 'secretary_agenda_item', dedupeKey: 'train-card',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
    }));
    expect(created.item).not.toBeNull();
    const id = created.item!.decisionId;

    expect(getDecisionItem(id, 110, 110)!.trainingCard).toBeUndefined(); // OFF — byte-identical

    try {
      process.env.DECISION_SKILL_CARDS_ENABLED = 'true';
      const card = getDecisionItem(id, 110, 110)!.trainingCard;
      expect(card).toBeDefined();
      expect(card!.beforeStartAt).toBe('2026-05-11T08:00:00.000Z');
      expect(card!.beforeWindowLabel).toBeTruthy();
      // risk comes from the STRUCTURED reason code 'peak_week' (-> medium), NEVER the "high risk" free text.
      expect(card!.risk).toBe('medium');
      expect(typeof card!.undoAvailable).toBe('boolean');

      // a decision NOT anchored on a training agenda gets no training card.
      const plain = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 110, { tenantId: 110, dedupeKey: 'train-card-nonmatch' }));
      expect(getDecisionItem(plain.item!.decisionId, 110, 110)!.trainingCard).toBeUndefined();
    } finally {
      delete process.env.DECISION_SKILL_CARDS_ENABLED;
    }
  });

  it('D: surfaces a privacy-safe finance card (month/status/freshness only — NEVER amounts; flag-gated)', async () => {
    ensureFinanceFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due, status, darf_code)
      VALUES (111, 111, '2026-03', 9000, 0, 9000, 1234, 0, 'pending', '0190')
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('finance', 111, {
      type: 'decision_required', requiresUserAction: true,
      relatedEntityId: '2026-03', relatedEntityType: 'finance_tax_event', dedupeKey: 'finance-card',
    }));
    expect(created.item).not.toBeNull();
    const id = created.item!.decisionId;

    expect(getDecisionItem(id, 111, 111)!.financeCard).toBeUndefined(); // OFF — byte-identical

    try {
      process.env.DECISION_SKILL_CARDS_ENABLED = 'true';
      const card = getDecisionItem(id, 111, 111)!.financeCard;
      expect(card).toBeDefined();
      expect(card!.taxMonth).toBe('2026-03');
      expect(typeof card!.paymentStatus).toBe('string');
      expect(card!.freshnessLabel).toBeTruthy();
      // PRIVACY (load-bearing): the card carries ONLY safe labels — no amount keys, and the serialized
      // card never leaks the seeded amounts (tax_due 1234, gross 9000).
      expect(Object.keys(card!).sort()).toEqual(['freshnessLabel', 'nextActionLabel', 'paymentStatus', 'taxMonth']);
      const serialized = JSON.stringify(card);
      expect(serialized).not.toContain('1234');
      expect(serialized).not.toContain('9000');
    } finally {
      delete process.env.DECISION_SKILL_CARDS_ENABLED;
    }
  });

  it('executes content approval actions through Content and read-back verifies state', async () => {
    const object = createCanonicalContentDecisionFixture(testDb, {
      userId: 2,
      tenantId: 2,
      objectType: 'script',
      title: 'Draft for approval',
      editorialState: 'drafted',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 2, {
      relatedEntityId: object.id,
      relatedEntityType: 'content_workflow_object',
      dedupeKey: 'content:approval',
    }));
    expect(created.item?.status).toBe('unread');
    expect(created.item?.explanation.whatHappened).toContain('ready for approval');
    expect(created.item?.explanation.userAction).toContain('Approve');
    expect(created.item?.explanation.verification).toContain('content state');
    expect(created.item?.explanation.recommendedMove).toBeTruthy();
    expect(created.item?.explanation.ifIgnored).toBeTruthy();
    expect(created.item?.explanation.actionLabels?.primary).toBe('Approve');

    const result = await performDecisionAction(created.item!.decisionId, 'approve_script', 2, 2, {
      idempotencyKey: 'tap-1',
    });
    expect(result.status).toBe('succeeded');
    expect(result.verification.readBackOk).toBe(true);
    expect(result.item.status).toBe('actioned');
    expect(result.item.outcomeSummary).toContain('content workflow');
    expect(result.verification.actualEffect.contentApprovalState).toBe('approved');
    testDb.prepare(`UPDATE handled_by_nexus_items SET created_at = ? WHERE decision_id = ?`)
      .run('2026-05-10T10:00:00.000Z', created.item!.decisionId);
    const handled = listHandledByNexusItems(2, 2, 5);
    expect(handled[0]).toMatchObject({
      sourceSkill: 'content',
      actionTaken: 'approve_script',
      rollbackAvailable: false,
      privacyClassification: 'private_content',
    });
    expect(handled[0].summary).toContain('approved');
    expect(handled[0].whyBrief).toContain('Nexus checked Content');
    expect(handled[0].explanation?.result).toContain('approved');
    expect(handled[0].explanation?.whyItMatters).toContain('verified next state');
    expect(handled[0].explanation?.nextStep).toContain('Content');
    expect(getDecisionOverview(2, 2, { limit: 20, handledLimit: 5 }).summary.handledTodayCount).toBe(1);

    const duplicate = await performDecisionAction(created.item!.decisionId, 'approve_script', 2, 2, {
      idempotencyKey: 'tap-1',
    });
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.status).toBe('idempotent');
  });

  it('backfills handled history from already-actioned decisions when explicit handled rows are absent', async () => {
    const { created } = await createContentApprovalDecision(24, 24, 'handled-backfill');
    await performDecisionAction(created.item!.decisionId, 'approve_script', 24, 24, {
      idempotencyKey: 'handled-backfill-approval',
    });
    testDb.prepare(`DELETE FROM handled_by_nexus_items WHERE decision_id = ?`).run(created.item!.decisionId);
    testDb.prepare(`UPDATE notification_center_items SET actioned_at = ? WHERE item_id = ?`)
      .run('2026-05-10T10:00:00.000Z', created.item!.decisionId);

    const handled = listHandledByNexusItems(24, 24, 5);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      itemId: `actioned_${created.item!.decisionId}`,
      actionTaken: 'approve_script',
      sourceSkill: 'content',
    });
    expect(handled[0].explanation?.result).toContain('approved');
    expect(handled[0].whyBrief).not.toContain('requested action');
    const overview = getDecisionOverview(24, 24, { limit: 20, handledLimit: 5 });
    expect(overview.handledCount).toBe(1);
    expect(overview.summary.handledTodayCount).toBe(1);
  });

  it('does not claim read-back confirmation when handled state fields are absent', () => {
    insertActionedDecisionFixture({
      itemId: 'empty-effect-decision',
      userId: 26,
      tenantId: 26,
      createdAt: '2026-05-10T10:00:00.000Z',
      actionResult: { actionId: 'approve_script' },
    });

    const result = runDecisionHandledHistoryBackfillJob({ userId: 26, tenantId: 26, limit: 10 });

    expect(result).toMatchObject({ inspected: 1, backfilled: 1, failed: 0 });
    const stored = testDb.prepare(`
      SELECT explanation_json
        FROM handled_by_nexus_items
       WHERE decision_id = ?
    `).get('empty-effect-decision') as { explanation_json: string };
    const explanation = JSON.parse(stored.explanation_json);
    expect(explanation.verification).not.toContain('Read-back confirmed');
    expect(explanation.verification).toContain('source confirmation is still pending');
    expect(explanation.steps.map((step: { label: string }) => step.label)).toContain('Verification checked');
  });

  it('merges handled history after fetching a wider window from each source', () => {
    const userId = 27;
    const tenantId = 27;
    const expected: Array<{ itemId: string; createdAt: string }> = [];
    for (let index = 0; index < 30; index += 1) {
      const explicitCreatedAt = new Date(Date.UTC(2026, 4, 10, 12, 0, 0) - index * 120_000).toISOString();
      const actionedCreatedAt = new Date(Date.UTC(2026, 4, 10, 11, 59, 0) - index * 120_000).toISOString();
      const handledItemId = `handled-wide-${index}`;
      const actionedItemId = `actioned-wide-${index}`;
      insertHandledFixture({
        handledItemId,
        decisionId: `explicit-wide-${index}`,
        userId,
        tenantId,
        createdAt: explicitCreatedAt,
      });
      insertActionedDecisionFixture({
        itemId: actionedItemId,
        userId,
        tenantId,
        createdAt: actionedCreatedAt,
        actionedAt: actionedCreatedAt,
      });
      expected.push({ itemId: handledItemId, createdAt: explicitCreatedAt });
      expected.push({ itemId: `actioned_${actionedItemId}`, createdAt: actionedCreatedAt });
    }

    const handled = listHandledByNexusItems(userId, tenantId, 25);
    const expectedTopIds = expected
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 25)
      .map((item) => item.itemId);

    expect(handled).toHaveLength(25);
    expect(handled.map((item) => item.itemId)).toEqual(expectedTopIds);
  });

  it('localizes Decision Center Secretary Today copy from the user locale', () => {
    ensureUserFixtureTable();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (92, 9200, 'Felipe', 'pt-PT', 'Europe/Lisbon', 'active')
    `).run();

    const overview = getDecisionOverview(92, 92, { limit: 10, handledLimit: 5 });

    expect(overview.secretaryToday.title).toBe('Secretary hoje');
    expect(overview.secretaryToday.checked[0]?.label).toBe('Centro de Decisões verificado');
    expect(overview.secretaryToday.summary).toBe(
      'A Secretary verificou a fila de decisões; nada urgente precisa da tua ação agora.',
    );
    expect(JSON.stringify(overview.secretaryToday)).not.toContain('Decision Center checked');
  });

  it('describes content rewrite decisions with result, benefit, verification, and next step', async () => {
    const { created } = await createContentApprovalDecision(25, 25, 'rewrite-explanation');

    const result = await performDecisionAction(created.item!.decisionId, 'request_rewrite', 25, 25, {
      idempotencyKey: 'rewrite-explanation-tap',
    });

    expect(result.status).toBe('succeeded');
    const handled = listHandledByNexusItems(25, 25, 5);
    expect(handled).toHaveLength(1);
    expect(handled[0].explanation).toMatchObject({
      headline: expect.stringContaining('Rewrite requested'),
      result: expect.stringContaining('rewrite'),
      verification: expect.stringContaining('Content'),
      nextStep: expect.stringContaining('rewritten draft'),
    });
    expect(handled[0].explanation?.steps.map((step) => step.status)).toContain('done');
  });

  it('counts handled-today by the user local day instead of UTC boundaries', () => {
    ensureUserFixtureTable();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (86, 8600, 'Lisbon Owner', 'en-US', 'Europe/Lisbon', 'active')
    `).run();
    testDb.prepare(`
      INSERT INTO handled_by_nexus_items (
        handled_item_id, user_id, tenant_id, source_skill, title, summary,
        action_taken, why_brief, privacy_classification, created_at
      ) VALUES (
        'hbn_lisbon_midnight', 86, 86, 'secretary', 'Schedule cleanup',
        'Nexus resolved the stale conflict.', 'auto_dismiss_stale_decision',
        'Source state changed.', 'sensitive', '2026-05-09T23:30:00.000Z'
      )
    `).run();

    expect(getDecisionSummary(86, 86).handledTodayCount).toBe(1);
  });

  it('executes legacy content notification decisions through their workflow object data', async () => {
    testDb.exec(readFileSync('migrations/061_content_notifications.sql', 'utf8'));
    const object = createCanonicalContentDecisionFixture(testDb, {
      userId: 22,
      tenantId: 22,
      objectType: 'script',
      title: 'Legacy notification draft',
      editorialState: 'drafted',
    });
    const notification = testDb.prepare(`
      INSERT INTO content_notifications (user_id, type, title, body, data)
      VALUES (?, 'script_ready', 'Content review', 'Ready for approval', ?)
    `).run(22, JSON.stringify({ contentObjectId: object.id }));
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 22, {
      tenantId: 22,
      relatedEntityId: String(notification.lastInsertRowid),
      relatedEntityType: 'content_notification',
      dedupeKey: 'content:legacy-notification-approval',
    }));

    const result = await performDecisionAction(created.item!.decisionId, 'approve_script', 22, 22, {
      idempotencyKey: 'legacy-content-approval',
    });

    expect(result.status).toBe('succeeded');
    expect(result.verification.actualEffect.contentObjectId).toBe(object.id);
    expect(result.verification.actualEffect.contentApprovalState).toBe('approved');
  });

  it('keeps GETs write-free while the explicit job supersedes a stale content decision', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 23, {
      tenantId: 23,
      relatedEntityId: 'script-demo',
      relatedEntityType: 'content_script',
      dedupeKey: 'content:stale-script-demo',
    }));
    expect(created.item).toBeNull();
    const stored = testDb.prepare(`
      SELECT item_id AS decisionId
        FROM notification_center_items
       WHERE user_id = 23 AND tenant_id = 23 AND dedupe_key = 'content:stale-script-demo'
    `).get() as { decisionId: string };
    const decisionId = stored.decisionId;

    const before = {
      status: (testDb.prepare('SELECT status FROM notification_center_items WHERE item_id = ?')
        .get(decisionId) as { status: string }).status,
      lifecycle: (testDb.prepare('SELECT COUNT(*) AS count FROM decision_lifecycle_events WHERE decision_id = ?')
        .get(decisionId) as { count: number }).count,
      handled: (testDb.prepare('SELECT COUNT(*) AS count FROM handled_by_nexus_items WHERE decision_id = ?')
        .get(decisionId) as { count: number }).count,
      outcomes: (testDb.prepare('SELECT COUNT(*) AS count FROM decision_outcome_ledger WHERE decision_id = ?')
        .get(decisionId) as { count: number }).count,
    };
    expect(listDecisionItems(23, 23)).toHaveLength(0);
    expect(getDecisionItem(decisionId, 23, 23)).toBeNull();
    expect(listDecisionItems(23, 23)).toHaveLength(0);
    const afterReads = {
      status: (testDb.prepare('SELECT status FROM notification_center_items WHERE item_id = ?')
        .get(decisionId) as { status: string }).status,
      lifecycle: (testDb.prepare('SELECT COUNT(*) AS count FROM decision_lifecycle_events WHERE decision_id = ?')
        .get(decisionId) as { count: number }).count,
      handled: (testDb.prepare('SELECT COUNT(*) AS count FROM handled_by_nexus_items WHERE decision_id = ?')
        .get(decisionId) as { count: number }).count,
      outcomes: (testDb.prepare('SELECT COUNT(*) AS count FROM decision_outcome_ledger WHERE decision_id = ?')
        .get(decisionId) as { count: number }).count,
    };
    expect(afterReads).toEqual(before);

    expect(runDecisionSourceStateSupersessionJob({ userId: 23, tenantId: 23 }))
      .toMatchObject({ supersededCount: 1 });
    expect((testDb.prepare('SELECT status FROM notification_center_items WHERE item_id = ?')
      .get(decisionId) as { status: string }).status).toBe('superseded');
    await expect(performDecisionAction(decisionId, 'approve_script', 23, 23, {
      idempotencyKey: 'stale-content-approval',
    })).rejects.toMatchObject({ code: 'DECISION_SUPERSEDED' });
  });

  it('supersedes stale Secretary reflow decisions that have no persisted agenda item', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 3, {
      dedupeKey: 'secretary:unsupported',
      relatedEntityId: 'conflict-demo',
      relatedEntityType: 'calendar_conflict',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
    }));

    expect(created.item).toBeNull();
    expect(listDecisionItems(3, 3)).toHaveLength(0);
  });

  it('executes Secretary agenda reflow actions against persisted Secretary agenda state', async () => {
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-42', 'intent-42', 'training', 'long_run', 'reschedule_this',
        'session-42', 'training_session', 42, '42',
        'proposed', 'not_synced', 1, 'Move long run',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '[]', 'Needs user approval',
        'hash-42', '[]', datetime('now'), datetime('now')
      )
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 42, {
      relatedEntityId: 'agenda-42',
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: 'secretary:agenda-reflow',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      decisionContext: {
        currentStartAt: '2026-05-10T08:00:00.000Z',
        currentEndAt: '2026-05-10T10:00:00.000Z',
        recommendedStartAt: '2026-05-11T08:00:00.000Z',
        recommendedEndAt: '2026-05-11T10:00:00.000Z',
      },
    }));

    const result = await performDecisionAction(created.item!.decisionId, 'accept_reflow', 42, 42, {
      idempotencyKey: 'accept-secretary-reflow',
    });

    expect(result.status).toBe('succeeded');
    expect(result.verification.actualEffect).toMatchObject({
      decisionStatus: 'actioned',
      secretaryAgendaItemId: 'agenda-42',
      lifecycleState: 'reflowed',
      decisionAction: 'reflowed',
      rollbackAvailable: true,
      rollbackActionId: 'undo_reflow',
      rollbackExpectedRevision: expect.stringMatching(/^agenda_state_/),
    });
    expect(result.item.rollbackAvailable).toBe(true);
    expect(result.item.actions.map((action) => action.id)).toContain('undo_reflow');
    const agenda = testDb.prepare('SELECT lifecycle_state, decision_action FROM secretary_agenda_items WHERE agenda_item_id = ?').get('agenda-42') as any;
    expect(agenda).toMatchObject({ lifecycle_state: 'reflowed', decision_action: 'reflowed' });
    const handled = listHandledByNexusItems(42, 42, 5);
    expect(handled[0].explanation).toMatchObject({
      headline: expect.stringContaining('Secretary rescheduled'),
      result: expect.stringContaining('removed from active decisions'),
      verification: expect.stringContaining('Nexus checked Secretary'),
    });
    expect(handled[0].explanation?.nextStep).toContain('Undo');
    expect(handled[0].rollbackAction).toMatchObject({
      actionId: 'undo_reflow',
      recordVersion: result.item.recordVersion,
      contextVersion: result.item.contextVersion,
    });

    const undo = await performDecisionAction(created.item!.decisionId, 'undo_reflow', 42, 42, {
      idempotencyKey: 'undo-secretary-reflow',
    });
    expect(undo.status).toBe('succeeded');
    expect(undo.verification.actualEffect).toMatchObject({
      decisionStatus: 'actioned',
      executionStatus: 'rolled_back',
      secretaryAgendaItemId: 'agenda-42',
      lifecycleState: 'proposed',
      decisionAction: 'deferred',
    });
    expect(undo.item.actionOutcomeStatus).toBe('rolled_back');
    expect(undo.item.rollbackAvailable).toBe(false);
    expect(listHandledByNexusItems(42, 42, 5)[0].rollbackAction).toBeUndefined();
    expect(undo.item.actions.map((action) => action.id)).not.toContain('undo_reflow');
    expect(getDecisionLifecycleEvents(created.item!.decisionId, 42, 42).map((e) => e.event)).toContain('rolled_back');
    const restored = testDb.prepare('SELECT lifecycle_state, decision_action FROM secretary_agenda_items WHERE agenda_item_id = ?').get('agenda-42') as any;
    expect(restored).toMatchObject({ lifecycle_state: 'proposed', decision_action: 'deferred' });

    const sameAttemptReplay = await performDecisionAction(created.item!.decisionId, 'undo_reflow', 42, 42, {
      idempotencyKey: 'undo-secretary-reflow',
    });
    expect(sameAttemptReplay.status).toBe('idempotent');
    await expect(performDecisionAction(created.item!.decisionId, 'undo_reflow', 42, 42, {
      idempotencyKey: 'undo-secretary-reflow-fresh-key',
    })).rejects.toMatchObject({ code: 'DECISION_ACTION_NOT_ALLOWED' });
  });

  it('reconciles an uncertain Secretary rollback and releases its exclusivity claim', async () => {
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-rollback-reconcile', 'intent-rollback-reconcile', 'training', 'long_run', 'reschedule_this',
        'session-rollback-reconcile', 'training_session', 420, '420',
        'proposed', 'not_synced', 1, 'Move long run',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '[]', 'Needs user approval',
        'hash-rollback-reconcile', '[]', datetime('now'), datetime('now')
      )
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 420, {
      tenantId: 420,
      relatedEntityId: 'agenda-rollback-reconcile',
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: 'secretary:agenda-rollback-reconcile',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      decisionContext: {
        currentStartAt: '2026-05-10T08:00:00.000Z',
        currentEndAt: '2026-05-10T10:00:00.000Z',
        recommendedStartAt: '2026-05-11T08:00:00.000Z',
        recommendedEndAt: '2026-05-11T10:00:00.000Z',
      },
    }));
    await performDecisionAction(created.item!.decisionId, 'accept_reflow', 420, 420, {
      idempotencyKey: 'rollback-reconcile-accept',
    });
    testDb.exec(`
      CREATE TRIGGER ignore_rollback_reconcile_projection
      BEFORE UPDATE OF action_result_json ON notification_center_items
      WHEN NEW.item_id = '${created.item!.decisionId.replace(/'/g, "''")}'
        AND NEW.action_result_json LIKE '%"actionId":"undo_reflow"%'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    await expect(performDecisionAction(created.item!.decisionId, 'undo_reflow', 420, 420, {
      idempotencyKey: 'rollback-reconcile-undo',
    })).rejects.toMatchObject({ code: 'DECISION_SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED' });
    testDb.exec('DROP TRIGGER ignore_rollback_reconcile_projection');

    process.env.DECISION_REFRESH_ENABLED_USER_420 = 'true';
    try {
      const refreshed = refreshDecisionItem(created.item!.decisionId, 420, 420)!.item;
      expect(refreshed.execution.status).toBe('rolled_back');
      expect(refreshed.actionOutcomeStatus).toBe('rolled_back');
      const execution = testDb.prepare(`
        SELECT action_execution_id AS executionId, status
          FROM decision_action_executions
         WHERE decision_id = ? AND action_id = 'undo_reflow'
         ORDER BY rowid DESC LIMIT 1
      `).get(created.item!.decisionId) as { executionId: string; status: string };
      expect(execution.status).toBe('succeeded');
      expect(testDb.prepare(`
        SELECT status FROM decision_exclusivity_claims
         WHERE action_execution_id = ? AND user_id = 420 AND tenant_id = 420
      `).get(execution.executionId)).toMatchObject({ status: 'succeeded' });
    } finally {
      delete process.env.DECISION_REFRESH_ENABLED_USER_420;
    }
  });

  it('auto-resolves only an opted-in low-risk reversible Secretary resource conflict and keeps undo', async () => {
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-auto-404', 'intent-auto-404', 'training', 'easy_run', 'reschedule_this',
        'session-auto-404', 'training_session', 404, '404',
        'proposed', 'not_synced', 1, 'Easy run',
        '2026-05-11T14:00:00.000Z', '2026-05-11T15:00:00.000Z',
        60, 'deferred', '[]', 'Low-risk move',
        'hash-auto-404', '[]', datetime('now'), datetime('now')
      )
    `).run();
    const competingAction = buildNormalizedDecisionAction({
      intent: 'review_shared_schedule_resource',
      targetEntities: [{ type: 'task', id: 'task-auto-404', version: '1' }],
      affectedResources: [{ type: 'calendar_timeline', id: '404:shared' }],
      preconditions: [],
      expectedEffects: [{ type: 'reserve_resource', targetRef: 'task:task-auto-404' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:404:shared'],
      authorizationScope: ['decision_center:read'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: 'ctx_auto_existing',
    });
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 404, {
      tenantId: 404,
      dedupeKey: 'auto-existing-resource',
      decisionContext: { entityTitle: 'Existing low-risk proposal', normalizedAction: competingAction },
    }));

    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_404 = 'active';
    process.env.DECISION_LOW_RISK_AUTO_RESOLUTION_ENABLED_USER_404 = 'true';
    updateDecisionPreferences(404, 404, { allowLowRiskAutoReflow: true });
    try {
      const candidate = buildNormalizedDecisionAction({
        intent: 'reflow_secretary_agenda',
        targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda-auto-404', version: '1' }],
        affectedResources: [{ type: 'calendar_timeline', id: '404:shared' }],
        preconditions: [],
        expectedEffects: [{ type: 'move_agenda_window', targetRef: 'secretary_agenda_item:agenda-auto-404' }],
        prohibitedEffects: [],
        dependencies: [],
        exclusivityKeys: ['calendar_timeline:404:shared'],
        authorizationScope: ['decision_center:write'],
        risk: 'low',
        reversibility: 'reversible',
        contextVersion: 'ctx_auto_candidate',
      });
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 404, {
        tenantId: 404,
        relatedEntityId: 'agenda-auto-404',
        relatedEntityType: 'secretary_agenda_item',
        dedupeKey: 'auto-low-risk-reflow',
        actionButtons: [{ id: 'accept_reflow', label: 'Apply reflow', style: 'primary' }],
        decisionContext: {
          entityTitle: 'Schedule item',
          currentStartAt: '2026-05-11T13:00:00.000Z',
          currentEndAt: '2026-05-11T14:00:00.000Z',
          recommendedStartAt: '2026-05-11T14:00:00.000Z',
          recommendedEndAt: '2026-05-11T15:00:00.000Z',
          candidateSlots: [{
            startAt: '2026-05-11T14:00:00.000Z',
            endAt: '2026-05-11T15:00:00.000Z',
            label: 'Low-risk alternative',
          }],
          normalizedAction: candidate,
        },
      }));

      expect(created.item?.status).toBe('actioned');
      expect(created.item?.rollbackAvailable).toBe(true);
      expect(getDecisionLifecycleEvents(created.item!.decisionId, 404, 404)).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'auto_resolved', reason: 'persisted_user_opt_in_low_risk_reversible' }),
      ]));
      expect(listHandledByNexusItems(404, 404, 5)[0].rollbackAction?.actionId).toBe('undo_reflow');
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_404;
      delete process.env.DECISION_LOW_RISK_AUTO_RESOLUTION_ENABLED_USER_404;
    }
  });

  it('normalizes serving Finance, Content, and Cooking producer actions before conflict persistence', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED = 'active';
    ensureFinanceFixtureTables();
    ensureCookingFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (
        user_id, tenant_id, month, gross_income, deductions, taxable_income,
        tax_due, inss_due, status, created_at, updated_at
      ) VALUES (606, 606, '2026-05', 0, 0, 0, 0, 0, 'pending', datetime('now'), datetime('now'))
    `).run();
    const contentObject = createCanonicalContentDecisionFixture(testDb, {
      userId: 606,
      tenantId: 606,
      objectType: 'script',
      title: 'Private source test draft',
      editorialState: 'drafted',
    });
    try {
      const finance = await createDecisionIntent({
        userId: 606,
        tenantId: 606,
        sourceSkill: 'finance',
        type: 'decision_required',
        priority: 'time_sensitive',
        relatedEntityId: '2026-05',
        relatedEntityType: 'finance_tax_event',
        title: 'Finance deadline',
        body: 'A finance deadline needs review.',
        actionButtons: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary' }],
        requiresUserAction: true,
        decisionDeadline: '2026-05-11T10:00:00.000Z',
        decisionContext: { entityTitle: 'Tax payment', sourceState: 'payment_due' },
        privacyPolicy: 'financial',
        dedupeKey: 'finance:normalized:606:2026-05',
      });
      const content = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 606, {
        tenantId: 606,
        relatedEntityId: contentObject.id,
        relatedEntityType: 'content_workflow_object',
        dedupeKey: 'content:normalized:606',
      }));
      const cooking = await createDecisionIntent({
        userId: 606,
        tenantId: 606,
        sourceSkill: 'cooking',
        type: 'decision_required',
        priority: 'active',
        relatedEntityId: '2026-05-11:dinner',
        relatedEntityType: 'meal_plan',
        title: 'Meal slot review',
        body: 'A meal slot is ready to add.',
        actionButtons: [{ id: 'add_meal', label: 'Add meal', style: 'primary' }],
        requiresUserAction: true,
        decisionDeadline: '2026-05-11T18:00:00.000Z',
        decisionContext: {
          entityTitle: 'Dinner slot',
          sourceState: 'slot_available',
          deadlineAt: '2026-05-11T18:00:00.000Z',
        },
        privacyPolicy: 'standard',
        dedupeKey: 'cooking:normalized:606:2026-05-11:dinner',
      });

      const persistedActions = [finance, content, cooking].map((created) => {
        const row = testDb.prepare(`
          SELECT normalized_action_json AS normalizedActionJson
            FROM notification_intents
           WHERE intent_id = ?
        `).get(created.item!.intentId) as { normalizedActionJson: string | null };
        return JSON.parse(row.normalizedActionJson!);
      });
      expect(persistedActions.map((action) => action.intent)).toEqual([
        'finance.mark_tax_paid',
        'content.approve_script',
        'cooking.add_meal',
      ]);
      expect(persistedActions[0]).toMatchObject({ risk: 'high', reversibility: 'irreversible' });
      expect(persistedActions[0].preconditions).toEqual([
        expect.objectContaining({ type: 'finance_tax_state', ref: '2026-05', required: true }),
      ]);
      expect(persistedActions[1].targetEntities[0].type).toBe('content_workflow_object');
      expect(persistedActions[1].preconditions).toEqual([
        expect.objectContaining({ type: 'content_workflow_state', ref: String(contentObject.id), required: true }),
      ]);
      expect(persistedActions[2].targetEntities[0].id).toBe('2026-05-11:dinner');
      expect(persistedActions[2].preconditions).toEqual([
        expect.objectContaining({ type: 'meal_plan_slot_state', ref: '2026-05-11:dinner', required: true }),
      ]);
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED;
    }
  });

  it('blocks known producer actions when authoritative domain state changes before execution', async () => {
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED = 'active';
    ensureFinanceFixtureTables();
    ensureCookingFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (
        user_id, tenant_id, month, gross_income, deductions, taxable_income,
        tax_due, inss_due, status, created_at, updated_at
      ) VALUES (607, 607, '2026-05', 0, 0, 0, 0, 0, 'pending', datetime('now'), datetime('now'))
    `).run();
    const contentObject = createCanonicalContentDecisionFixture(testDb, {
      userId: 608,
      tenantId: 608,
      objectType: 'script',
      title: 'Private stale-state draft',
      editorialState: 'drafted',
    });
    const contentStateBefore = testDb.prepare(`
      SELECT approval_state AS approvalState FROM content_domain_objects
       WHERE id = ? AND owner_user_id = 608 AND tenant_id = 608
    `).get(contentObject.id) as { approvalState: string };

    try {
      const finance = await createDecisionIntent({
        userId: 607,
        tenantId: 607,
        sourceSkill: 'finance',
        type: 'decision_required',
        priority: 'time_sensitive',
        relatedEntityId: '2026-05',
        relatedEntityType: 'finance_tax_event',
        title: 'Finance state review',
        body: 'Review the current tax-event action.',
        actionButtons: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary' }],
        requiresUserAction: true,
        decisionContext: { entityTitle: 'Tax event', sourceState: 'payment_due' },
        privacyPolicy: 'financial',
        dedupeKey: 'finance:state-revalidation:607',
      });
      const content = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 608, {
        tenantId: 608,
        relatedEntityId: contentObject.id,
        relatedEntityType: 'content_workflow_object',
        dedupeKey: 'content:state-revalidation:608',
      }));
      const cooking = await createDecisionIntent({
        userId: 609,
        tenantId: 609,
        sourceSkill: 'cooking',
        type: 'decision_required',
        priority: 'active',
        relatedEntityId: '2026-05-12:dinner',
        relatedEntityType: 'meal_plan',
        title: 'Meal slot state review',
        body: 'Review the proposed meal slot.',
        actionButtons: [{ id: 'add_meal', label: 'Add meal', style: 'primary' }],
        requiresUserAction: true,
        decisionContext: { entityTitle: 'Dinner slot', sourceState: 'slot_available' },
        privacyPolicy: 'standard',
        dedupeKey: 'cooking:state-revalidation:609',
      });
      const reviewedFinance = reviewDecision(finance.item!.decisionId, 607, 607, {
        outcome: 'approve',
        expectedVersion: finance.item!.recordVersion,
        idempotencyKey: 'approve-finance-before-state-change',
        strongConfirmationText: 'CONFIRM',
      });
      testDb.prepare(`
        UPDATE finance_tax_events
           SET status = 'overdue', updated_at = '2026-05-10T10:01:00.000Z'
         WHERE user_id = 607 AND tenant_id = 607 AND month = '2026-05'
      `).run();
      testDb.prepare(`
        UPDATE content_domain_objects
           SET workflow_version = workflow_version + 1,
               updated_at = '2026-05-10T10:01:00.000Z'
         WHERE id = ? AND owner_user_id = 608 AND tenant_id = 608
      `).run(contentObject.id);
      testDb.prepare(`
        INSERT INTO meal_plans (
          user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
          scope_status, created_by, updated_by, audit_metadata_json,
          date, meal_type, title, created_at
        ) VALUES (609, 609, 609, 'user_private', 'planned', 'active', 609, 609, '{}',
                  '2026-05-12', 'dinner', 'Meal added elsewhere', datetime('now'))
      `).run();

      await expect(performDecisionAction(finance.item!.decisionId, 'mark_paid', 607, 607, {
        idempotencyKey: 'finance-stale-domain-state',
        expectedVersion: reviewedFinance.recordVersion,
        contextVersion: reviewedFinance.contextVersion,
      })).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED', status: 409 });
      await expect(performDecisionAction(content.item!.decisionId, 'approve_script', 608, 608, {
        idempotencyKey: 'content-stale-domain-state',
        expectedVersion: content.item!.recordVersion,
        contextVersion: content.item!.contextVersion,
      })).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED', status: 409 });
      await expect(performDecisionAction(cooking.item!.decisionId, 'add_meal', 609, 609, {
        idempotencyKey: 'cooking-stale-domain-state',
        expectedVersion: cooking.item!.recordVersion,
        contextVersion: cooking.item!.contextVersion,
        payload: { date: '2026-05-12', mealType: 'dinner', title: 'Original proposal' },
      })).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED', status: 409 });

      expect(testDb.prepare(`
        SELECT status FROM finance_tax_events WHERE user_id = 607 AND tenant_id = 607 AND month = '2026-05'
      `).get()).toMatchObject({ status: 'overdue' });
      expect(testDb.prepare(`
        SELECT approval_state AS approvalState FROM content_domain_objects
         WHERE id = ? AND owner_user_id = 608 AND tenant_id = 608
      `).get(contentObject.id)).toEqual(contentStateBefore);
      expect(testDb.prepare(`
        SELECT title FROM meal_plans
         WHERE user_id = 609 AND tenant_id = 609 AND date = '2026-05-12' AND meal_type = 'dinner'
      `).get()).toMatchObject({ title: 'Meal added elsewhere' });
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED;
    }
  });

  it('B2: redacts the rollback snapshot explanation for a sensitive decision (flag ON) while undo still restores state', async () => {
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-b2', 'intent-b2', 'training', 'long_run', 'reschedule_this',
        'session-b2', 'training_session', 55, '55',
        'proposed', 'not_synced', 1, 'Move long run',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '[]', 'SENSITIVE_EXPLANATION_TEXT',
        'hash-b2', '[]', datetime('now'), datetime('now')
      )
    `).run();
    process.env.DECISION_ROLLBACK_SNAPSHOT_PROTECTION_ENABLED = 'true';
    try {
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 55, {
        relatedEntityId: 'agenda-b2', relatedEntityType: 'secretary_agenda_item', dedupeKey: 'b2-rollback',
        privacyPolicy: 'sensitive',
        actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
        decisionContext: {
          currentStartAt: '2026-05-10T08:00:00.000Z', currentEndAt: '2026-05-10T10:00:00.000Z',
          recommendedStartAt: '2026-05-11T08:00:00.000Z', recommendedEndAt: '2026-05-11T10:00:00.000Z',
        },
      }));
      expect(created.item).not.toBeNull();
      const result = await performDecisionAction(created.item!.decisionId, 'accept_reflow', 55, 55, { idempotencyKey: 'b2-accept' });
      expect(result.status).toBe('succeeded');
      // the stored rollback snapshot omits the sensitive free-text explanation; machine fields are kept.
      const row = testDb.prepare('SELECT action_result_json FROM notification_center_items WHERE item_id = ?').get(created.item!.decisionId) as any;
      const snapshot = JSON.parse(row.action_result_json).rollback;
      expect(snapshot.previous.explanation).toBeUndefined();
      expect(snapshot.previous.startAt).toBe('2026-05-11T08:00:00.000Z');
      expect(JSON.stringify(snapshot)).not.toContain('SENSITIVE_EXPLANATION_TEXT');
      // undo still restores the schedule state (the reader tolerates the missing explanation).
      const undo = await performDecisionAction(created.item!.decisionId, 'undo_reflow', 55, 55, { idempotencyKey: 'b2-undo' });
      expect(undo.status).toBe('succeeded');
      const restored = testDb.prepare('SELECT lifecycle_state FROM secretary_agenda_items WHERE agenda_item_id = ?').get('agenda-b2') as any;
      expect(restored.lifecycle_state).toBe('proposed');
    } finally {
      delete process.env.DECISION_ROLLBACK_SNAPSHOT_PROTECTION_ENABLED;
    }
  });

  it('requires strong approval unconditionally in the legacy fallback before a Finance payment mutation', async () => {
    process.env.DECISION_CENTER_REWRITE_MODE = 'legacy';
    ensureFinanceFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due, status, darf_code)
      VALUES (43, 43, '2026-05', 5000, 0, 5000, 450, 0, 'pending', '0190')
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('finance', 43, {
      type: 'decision_required',
      requiresUserAction: true,
      relatedEntityId: '2026-05',
      relatedEntityType: 'finance_tax_event',
      dedupeKey: 'finance:tax-payment',
    }));

    await expect(performDecisionAction(created.item!.decisionId, 'mark_paid', 43, 43, {
      idempotencyKey: 'mark-tax-paid-without-approval',
      expectedVersion: created.item!.recordVersion,
      contextVersion: created.item!.contextVersion,
    })).rejects.toMatchObject({ code: 'DECISION_STRONG_CONFIRMATION_REQUIRED' });

    const reviewed = reviewDecision(created.item!.decisionId, 43, 43, {
      outcome: 'approve',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'approve-tax-payment',
      strongConfirmationText: 'CONFIRM',
    });
    const result = await performDecisionAction(created.item!.decisionId, 'mark_paid', 43, 43, {
      idempotencyKey: 'mark-tax-paid',
      expectedVersion: reviewed.recordVersion,
      contextVersion: reviewed.contextVersion,
    });

    expect(result.status).toBe('succeeded');
    expect(result.verification.actualEffect).toMatchObject({
      decisionStatus: 'actioned',
      financeTaxMonth: '2026-05',
      paymentStatus: 'paid',
    });
    const event = testDb.prepare('SELECT status, paid_at FROM finance_tax_events WHERE user_id = 43 AND month = ?').get('2026-05') as any;
    expect(event.status).toBe('paid');
    expect(event.paid_at).toBeTruthy();
    expect(getDecisionLifecycleEvents(created.item!.decisionId, 43, 43)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'approved' }),
      expect.objectContaining({ event: 'action_succeeded', actionId: 'mark_paid' }),
    ]));
    expect(getDecisionLifecycleEvents(created.item!.decisionId, 43, 43))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ event: 'strong_confirmation_legacy_bypass' })]));
  });

  it.each([
    ['dismiss', 44, 'dismiss-finance'],
    ['snooze', 45, 'snooze-finance'],
  ] as const)('keeps low-risk Finance lifecycle action %s outside strong approval', async (actionId, userId, key) => {
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    ensureFinanceFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (
        tenant_id, user_id, month, gross_income, deductions,
        taxable_income, tax_due, inss_due, status, darf_code
      ) VALUES (?, ?, '2026-09', 5000, 0, 5000, 450, 0, 'pending', '0190')
    `).run(userId, userId);
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('finance', userId, {
      type: 'decision_required',
      requiresUserAction: true,
      relatedEntityId: '2026-09',
      relatedEntityType: 'finance_tax_event',
      dedupeKey: `finance:lifecycle:${actionId}`,
    }));

    const result = await performDecisionAction(created.item!.decisionId, actionId, userId, userId, {
      idempotencyKey: key,
      expectedVersion: created.item!.recordVersion,
      contextVersion: created.item!.contextVersion,
      ...(actionId === 'snooze' ? { payload: { minutes: 60 } } : {}),
    });

    expect(result.status).toBe('succeeded');
    expect(result.item.status).toBe(actionId === 'dismiss' ? 'dismissed' : 'snoozed');
    expect(testDb.prepare(`
      SELECT status FROM finance_tax_events
       WHERE tenant_id = ? AND user_id = ? AND month = '2026-09'
    `).get(userId, userId)).toEqual({ status: 'pending' });
  });

  it('does not let a Finance action payload retarget the reviewed tax event', async () => {
    ensureFinanceFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due, status, darf_code)
      VALUES (43, 43, '2026-07', 5000, 0, 5000, 450, 0, 'pending', '0190'),
             (43, 43, '2026-08', 5000, 0, 5000, 450, 0, 'pending', '0190')
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('finance', 43, {
      type: 'decision_required',
      requiresUserAction: true,
      relatedEntityId: '2026-07',
      relatedEntityType: 'finance_tax_event',
      dedupeKey: 'finance:tax-payment-target-binding',
    }));

    await expect(performDecisionAction(created.item!.decisionId, 'mark_paid', 43, 43, {
      idempotencyKey: 'mark-wrong-tax-month',
      payload: { month: '2026-08' },
    })).rejects.toMatchObject({ code: 'DECISION_ACTION_PAYLOAD_MISMATCH' });

    const events = testDb.prepare(`
      SELECT month, status FROM finance_tax_events
       WHERE user_id = 43 AND month IN ('2026-07', '2026-08') ORDER BY month
    `).all() as Array<{ month: string; status: string }>;
    expect(events).toEqual([
      { month: '2026-07', status: 'pending' },
      { month: '2026-08', status: 'pending' },
    ]);
  });

  it('rejects APNs finance payment mutations while allowing in-app confirmation', async () => {
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    ensureFinanceFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due, status, darf_code)
      VALUES (43, 43, '2026-06', 5000, 0, 5000, 450, 0, 'pending', '0190')
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('finance', 43, {
      type: 'decision_required',
      requiresUserAction: true,
      relatedEntityId: '2026-06',
      relatedEntityType: 'finance_tax_event',
      dedupeKey: 'finance:tax-payment-apns',
    }));

    await expect(performDecisionAction(created.item!.decisionId, 'mark_paid', 43, 43, {
      idempotencyKey: 'apns-mark-tax-paid',
      channel: 'apns',
      expectedVersion: created.item!.recordVersion,
      contextVersion: created.item!.contextVersion,
    })).rejects.toMatchObject({
      code: 'APNS_ACTION_NOT_ALLOWED',
      status: 409,
      details: expect.objectContaining({
        disposition: 'open_app',
        execute: false,
        reasonCode: 'action_review_required',
      }),
    } satisfies Partial<DecisionActionError>);

    const pending = testDb.prepare('SELECT status, paid_at FROM finance_tax_events WHERE user_id = 43 AND month = ?').get('2026-06') as any;
    expect(pending.status).toBe('pending');
    expect(pending.paid_at).toBeNull();
    const executionCount = (testDb.prepare('SELECT COUNT(*) AS n FROM decision_action_executions WHERE decision_id = ?')
      .get(created.item!.decisionId) as { n: number }).n;
    expect(executionCount).toBe(0);

    const reviewed = reviewDecision(created.item!.decisionId, 43, 43, {
      outcome: 'approve',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'review-in-app-tax-payment',
      strongConfirmationText: 'CONFIRM',
    });
    const result = await performDecisionAction(created.item!.decisionId, 'mark_paid', 43, 43, {
      idempotencyKey: 'in-app-mark-tax-paid',
      expectedVersion: reviewed.recordVersion,
      contextVersion: reviewed.contextVersion,
    });
    expect(result.status).toBe('succeeded');
    const paid = testDb.prepare('SELECT status, paid_at FROM finance_tax_events WHERE user_id = 43 AND month = ?').get('2026-06') as any;
    expect(paid.status).toBe('paid');
    expect(paid.paid_at).toBeTruthy();
  });

  it('executes only a current low-risk APNs lifecycle action and rejects stale versions before claiming', async () => {
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 430, {
      tenantId: 430,
      title: 'Choose whether to revisit the current chat request',
      body: 'The chat request is still open and can be dismissed or revisited later.',
      dedupeKey: 'chat:apns-low-risk-dismiss',
    }));
    expect(created.item?.contextVersion).toMatch(/^ctx_notification_/);

    const stale = evaluateDecisionApnsActionRequest({
      decisionId: created.item!.decisionId,
      actionId: 'dismiss',
      userId: 430,
      tenantId: 430,
      recordVersion: created.item!.recordVersion + 1,
      contextVersion: created.item!.contextVersion!,
    });
    expect(stale).toMatchObject({
      disposition: 'open_app',
      execute: false,
      reasonCode: 'record_version_changed',
    });

    const result = await performDecisionAction(created.item!.decisionId, 'dismiss', 430, 430, {
      idempotencyKey: 'apns-dismiss-current-v1',
      channel: 'apns',
      expectedVersion: created.item!.recordVersion,
      contextVersion: created.item!.contextVersion,
    });
    expect(result.status).toBe('succeeded');
    expect(result.item.status).toBe('dismissed');
    expect((testDb.prepare(`
      SELECT COUNT(*) AS count FROM decision_action_executions WHERE decision_id = ?
    `).get(created.item!.decisionId) as { count: number }).count).toBe(1);
    const execution = testDb.prepare(`
      SELECT expected_effect_json AS expectedEffectJson
        FROM decision_action_executions
       WHERE decision_id = ? AND idempotency_key = 'apns-dismiss-current-v1'
    `).get(created.item!.decisionId) as { expectedEffectJson: string };
    expect(JSON.parse(execution.expectedEffectJson)).toMatchObject({
      commandContract: {
        schemaVersion: 'decision_mutation_command@1.0.0',
        channel: 'apns',
        recordVersion: created.item!.recordVersion,
        contextVersion: created.item!.contextVersion,
        scope: { userId: 430, tenantId: 430 },
        approval: {
          requiredLevel: 'user_confirmation',
          evidence: { level: 'user_confirmation', actorUserId: 430 },
        },
        execution: { executorId: 'decision.dismiss', supportsIdempotency: true },
        readback: { verifierId: 'decision.status', mode: 'versioned' },
      },
    });
  });

  it('executes Cooking meal decisions when a concrete meal slot payload is supplied', async () => {
    ensureCookingFixtureTables();
    const created = await createDecisionIntent(buildSkillNotificationFixtureIntent('cooking', 44, {
      type: 'decision_required',
      requiresUserAction: true,
      actionButtons: [{ id: 'add_meal', label: 'Add meal', style: 'primary' }],
      relatedEntityId: '2026-05-12:dinner',
      relatedEntityType: 'meal_plan',
      dedupeKey: 'cooking:add-meal',
    }));

    await expect(performDecisionAction(created.item!.decisionId, 'add_meal', 44, 44, {
      idempotencyKey: 'add-meal-wrong-slot',
      payload: {
        date: '2026-05-13',
        mealType: 'lunch',
        title: 'Retargeted meal',
      },
    })).rejects.toMatchObject({ code: 'DECISION_ACTION_PAYLOAD_MISMATCH' });

    const result = await performDecisionAction(created.item!.decisionId, 'add_meal', 44, 44, {
      idempotencyKey: 'add-meal',
      payload: {
        date: '2026-05-12',
        mealType: 'dinner',
        title: 'Recovery rice bowl',
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.verification.actualEffect).toMatchObject({
      decisionStatus: 'actioned',
      date: '2026-05-12',
      mealType: 'dinner',
      title: 'Recovery rice bowl',
    });
    const meal = testDb.prepare('SELECT title FROM meal_plans WHERE user_id = 44 AND date = ? AND meal_type = ?').get('2026-05-12', 'dinner') as any;
    expect(meal.title).toBe('Recovery rice bowl');
  });

  it('executes Chat clarification decisions through the pending-confirmation store', async () => {
    vi.useRealTimers();
    const pending = trackPendingChatConfirmation({
      userId: 45,
      tenantId: 45,
      actionSummary: 'Choose the content workflow',
      involvedSkills: ['content'],
      reasonCodes: ['ambiguous_action'],
    });
    const created = await createDecisionIntent(buildSkillNotificationFixtureIntent('chat', 45, {
      actionButtons: [
        { id: 'option_a', label: 'Use the content draft', style: 'primary' },
        { id: 'option_b', label: 'Ask first', style: 'secondary' },
      ],
      relatedEntityId: pending.id,
      relatedEntityType: 'chat_confirmation',
      dedupeKey: 'chat:clarification',
    }));

    const result = await performDecisionAction(created.item!.decisionId, 'option_a', 45, 45, {
      idempotencyKey: 'chat-option-a',
    });

    expect(result.status).toBe('succeeded');
    expect(result.verification.actualEffect).toMatchObject({
      decisionStatus: 'actioned',
      chatConfirmationId: pending.id,
      selectedOption: 'option_a',
      involvedSkills: ['content'],
    });
  });

  it('reconciles a cleared chat confirmation and releases the uncertain exclusivity claim', async () => {
    const pending = trackPendingChatConfirmation({
      userId: 451,
      tenantId: 451,
      actionSummary: 'Choose the content workflow',
      involvedSkills: ['content'],
      reasonCodes: ['ambiguous_action'],
    });
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'resolve_chat_confirmation',
      targetEntities: [{ type: 'chat_confirmation', id: pending.id, version: '1' }],
      affectedResources: [{ type: 'chat_confirmation', id: pending.id }],
      preconditions: [],
      expectedEffects: [{ type: 'chat_confirmation_cleared', targetRef: pending.id }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: [`chat_confirmation:451:${pending.id}`],
      authorizationScope: ['decision_center:read', 'decision_center:write'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: 'ctx_chat_confirmation_reconcile',
    });
    const created = await createDecisionIntent(buildSkillNotificationFixtureIntent('chat', 451, {
      actionButtons: [{ id: 'option_a', label: 'Use the content draft', style: 'primary' }],
      relatedEntityId: pending.id,
      relatedEntityType: 'chat_confirmation',
      dedupeKey: 'chat:clarification-reconcile',
      decisionContext: { entityTitle: 'Content workflow', normalizedAction },
    }));
    const executionId = 'dae_chat_confirmation_reconcile';
    testDb.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, expected_effect_json,
        logical_action_hash, effect_results_json, recovery_json
      ) VALUES (?, ?, 'option_a', 451, 451, 'chat-confirmation-reconcile', 'chat',
        'partially_failed', ?, ?, '[]', '{}')
    `).run(executionId, created.item!.decisionId, JSON.stringify({
      verifier: 'chat_pending_confirmation',
      targetRef: pending.id,
      expectedStatus: 'cleared',
    }), normalizedAction.logicalActionHash);
    testDb.prepare(`
      INSERT INTO decision_exclusivity_claims (
        user_id, tenant_id, exclusivity_key, action_execution_id, decision_id,
        context_version, status, lease_expires_at
      ) VALUES (451, 451, ?, ?, ?, ?, 'partially_failed', datetime('now', '+5 minutes'))
    `).run(normalizedAction.exclusivityKeys[0], executionId, created.item!.decisionId, normalizedAction.contextVersion);
    clearPendingChatConfirmation(451, 451);

    process.env.DECISION_REFRESH_ENABLED_USER_451 = 'true';
    try {
      const refreshed = refreshDecisionItem(created.item!.decisionId, 451, 451)!.item;
      expect(refreshed.execution.status).toBe('succeeded');
      expect(testDb.prepare(`
        SELECT status FROM decision_exclusivity_claims
         WHERE action_execution_id = ? AND user_id = 451 AND tenant_id = 451
      `).get(executionId)).toMatchObject({ status: 'succeeded' });
    } finally {
      delete process.env.DECISION_REFRESH_ENABLED_USER_451;
    }
  });

  it('keeps a rewrite execution uncertain when an unrelated edit only matches the generic active state', async () => {
    const { object, created } = await createContentApprovalDecision(452, 452, 'rewrite-reconcile-unrelated-edit');
    const resumed = transitionContentWorkspaceItem({
      scope: { tenantId: 452, userId: 452 },
      itemId: object.id,
      targetState: 'active',
      expectedWorkflowVersion: object.workflowVersion,
      idempotencyKey: 'user-resumed-editing-without-decision',
    }, testDb).value;
    expect(resumed).toMatchObject({ productionState: 'active' });

    testDb.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, expected_effect_json,
        effect_results_json, recovery_json
      ) VALUES ('dae_content_rewrite_unrelated', ?, 'request_rewrite', 452, 452,
        'rewrite-reconcile-unrelated-edit', 'content', 'partially_failed', ?, '[]', '{}')
    `).run(created.item!.decisionId, JSON.stringify({
      verifier: 'content_workflow_object',
      targetRef: String(object.id),
      expectedApprovalState: 'rewrite_requested',
    }));

    const refreshed = refreshDecisionItem(created.item!.decisionId, 452, 452)!.item;
    expect(refreshed.status).not.toBe('actioned');
    expect(testDb.prepare(`
      SELECT status, error_code AS errorCode
        FROM decision_action_executions
       WHERE action_execution_id = 'dae_content_rewrite_unrelated'
    `).get()).toEqual({
      status: 'partially_failed',
      errorCode: 'DECISION_MANUAL_RECONCILIATION_REQUIRED',
    });
  });

  it('reconciles a rewrite only when the scoped receipt and Decision audit event prove the exact action', async () => {
    const { object, created } = await createContentApprovalDecision(453, 453, 'rewrite-reconcile-explicit-decision');
    const decisionId = created.item!.decisionId;
    expect(decideContentWorkspaceReview({
      userId: 453,
      tenantId: 453,
      objectId: object.id,
      decision: 'rewrite_requested',
      approvalType: 'content_review',
      expectedWorkflowVersion: object.workflowVersion,
      idempotencyKey: `decision-content:${decisionId}:request_rewrite`,
      metadata: { source: 'decision_center', decisionId },
    }, testDb)).toMatchObject({
      ok: true,
      status: 'rewrite_requested',
      object: { productionState: 'active', approvalState: 'not_required' },
    });

    testDb.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, expected_effect_json,
        effect_results_json, recovery_json
      ) VALUES ('dae_content_rewrite_explicit', ?, 'request_rewrite', 453, 453,
        'rewrite-reconcile-explicit-decision', 'content', 'partially_failed', ?, '[]', '{}')
    `).run(decisionId, JSON.stringify({
      verifier: 'content_workflow_object',
      targetRef: String(object.id),
      expectedApprovalState: 'rewrite_requested',
    }));

    const refreshed = refreshDecisionItem(decisionId, 453, 453)!.item;
    expect(refreshed.status).toBe('actioned');
    expect(testDb.prepare(`
      SELECT status, error_code AS errorCode
        FROM decision_action_executions
       WHERE action_execution_id = 'dae_content_rewrite_explicit'
    `).get()).toEqual({ status: 'succeeded', errorCode: null });
  });

  it('does not use personal task state to supersede a malformed cross-tenant daily-attention decision', async () => {
    const created = await createDecisionIntent(buildSkillNotificationFixtureIntent('secretary', 454, {
      tenantId: 954,
      type: 'decision_required',
      requiresUserAction: true,
      relatedEntityType: 'task_attention_day',
      relatedEntityId: '2026-05-10',
      actionButtons: [{ id: 'open_detail', label: 'Open tasks', style: 'primary' }],
      dedupeKey: 'malformed-cross-tenant-task-attention',
    }));
    expect(created.item).not.toBeNull();

    const prepareSpy = vi.spyOn(testDb, 'prepare');
    const item = getDecisionItem(created.item!.decisionId, 454, 954);
    const preparedSql = prepareSpy.mock.calls.map(([sql]) => String(sql));
    prepareSpy.mockRestore();
    expect(item).toMatchObject({ status: 'unread', tenantId: 954, userId: 454 });
    expect(preparedSql.some((sql) => sql.includes('unified_tasks') || sql.includes('native_tasks'))).toBe(false);
    expect(testDb.prepare(`
      SELECT status, decision_state AS decisionState
        FROM notification_center_items
       WHERE item_id = ? AND user_id = 454 AND tenant_id = 954
    `).get(created.item!.decisionId)).toEqual({
      status: 'unread',
      decisionState: 'ready_for_review',
    });
  });

  it('denies wrong-user decision list/detail/action access by scope', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 4, {
      dedupeKey: 'content:scope',
    }));
    expect(created.item).toBeNull();
    const stored = testDb.prepare(`
      SELECT item_id AS decisionId FROM notification_center_items
       WHERE user_id = 4 AND tenant_id = 4 AND dedupe_key = 'content:scope'
    `).get() as { decisionId: string };

    expect(listDecisionItems(5, 5)).toHaveLength(0);
    await expect(performDecisionAction(stored.decisionId, 'approve_script', 5, 5, {
      idempotencyKey: 'wrong-user-tap',
    }))
      .rejects.toThrow(/Decision not found/);
  });

  it('isolates two users inside the same tenant for list, detail, and action access', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 10, { tenantId: 77, dedupeKey: 'u10:a' }));
    await createDecisionIntent(buildSkillNotificationFixtureIntent('chat', 10, {
      tenantId: 77,
      type: 'decision_required',
      requiresUserAction: true,
      relatedEntityId: 'chat-confirmation-u10',
      relatedEntityType: 'chat_confirmation',
      actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
      dedupeKey: 'u10:b',
    }));
    const userB = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 11, { tenantId: 77, dedupeKey: 'u11:a' }));

    const userAItems = listDecisionItems(10, 77);
    expect(userAItems).toHaveLength(2);
    expect(userAItems.every((item) => item.userId === 10 && item.tenantId === 77)).toBe(true);

    const userBItems = listDecisionItems(11, 77);
    expect(userBItems).toHaveLength(1);
    expect(getDecisionItem(userB.item!.decisionId, 10, 77)).toBeNull();
    await expect(performDecisionAction(userB.item!.decisionId, 'open_detail', 10, 77, {
      idempotencyKey: 'wrong-user-open',
    })).rejects.toThrow(/Decision not found/);
  });

  it('isolates same numeric user id across different tenants', async () => {
    const tenantOne = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 100, { tenantId: 1, dedupeKey: 'same-user:t1' }));
    const tenantTwo = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 100, { tenantId: 2, dedupeKey: 'same-user:t2' }));

    expect(listDecisionItems(100, 1).map((item) => item.decisionId)).toEqual([tenantOne.item!.decisionId]);
    expect(listDecisionItems(100, 2).map((item) => item.decisionId)).toEqual([tenantTwo.item!.decisionId]);
    expect(getDecisionItem(tenantTwo.item!.decisionId, 100, 1)).toBeNull();
    expect(getDecisionItem(tenantOne.item!.decisionId, 100, 2)).toBeNull();
  });

  it('coalesces concurrent duplicate actions into one execution and one underlying write', async () => {
    vi.useRealTimers();
    const { object, created } = await createContentApprovalDecision(20, 20, 'content:concurrent');

    const [first, second] = await Promise.all([
      performDecisionAction(created.item!.decisionId, 'approve_script', 20, 20, { idempotencyKey: 'same-tap' }),
      performDecisionAction(created.item!.decisionId, 'approve_script', 20, 20, { idempotencyKey: 'same-tap' }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['idempotent', 'succeeded']);
    const executions = testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM decision_action_executions
      WHERE decision_id = ? AND action_id = 'approve_script' AND idempotency_key = 'same-tap'
    `).get(created.item!.decisionId) as { count: number };
    expect(executions.count).toBe(1);

    const workflow = testDb.prepare(`SELECT workflow_version, approval_state FROM content_domain_objects WHERE id = ?`).get(object.id) as { workflow_version: number; approval_state: string };
    expect(workflow.workflow_version).toBe(object.workflowVersion + 1);
    expect(workflow.approval_state).toBe('approved');
  });

  it('coalesces concurrent different transport keys for the same logical mutation', async () => {
    vi.useRealTimers();
    const { object, created } = await createContentApprovalDecision(21, 21, 'content:logical-concurrent');

    const settled = await Promise.all([
      performDecisionAction(created.item!.decisionId, 'approve_script', 21, 21, {
        idempotencyKey: 'device-a',
        expectedVersion: created.item!.recordVersion,
      }),
      performDecisionAction(created.item!.decisionId, 'approve_script', 21, 21, {
        idempotencyKey: 'device-b',
        expectedVersion: created.item!.recordVersion,
      }),
    ]);

    expect(settled.map((result) => result.status).sort()).toEqual(['idempotent', 'succeeded']);
    const executions = testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM decision_action_executions
      WHERE decision_id = ? AND action_id = 'approve_script'
    `).get(created.item!.decisionId) as { count: number };
    expect(executions.count).toBe(1);
    const workflow = testDb.prepare(`SELECT workflow_version, approval_state FROM content_domain_objects WHERE id = ?`).get(object.id) as { workflow_version: number; approval_state: string };
    expect(workflow).toEqual({ workflow_version: object.workflowVersion + 1, approval_state: 'approved' });
  });

  it('enforces expected proposal versions for opted-in mutating clients', async () => {
    const { created } = await createContentApprovalDecision(22, 22, 'content:versioned');
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED_USER_22 = 'true';
    try {
      await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 22, 22, {
        idempotencyKey: 'missing-version',
      })).rejects.toMatchObject({ code: 'DECISION_VERSION_REQUIRED', status: 428 });

      await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 22, 22, {
        idempotencyKey: 'stale-version',
        expectedVersion: created.item!.recordVersion + 1,
      })).rejects.toMatchObject({
        code: 'DECISION_VERSION_CONFLICT',
        status: 409,
        details: {
          currentVersion: created.item!.recordVersion,
          currentItem: expect.objectContaining({ decisionId: created.item!.decisionId }),
        },
      });

      const result = await performDecisionAction(created.item!.decisionId, 'approve_script', 22, 22, {
        idempotencyKey: 'current-version',
        expectedVersion: created.item!.recordVersion,
      });
      expect(result.item.recordVersion).toBe(created.item!.recordVersion + 1);
      expect(result.item.decisionState).toBe('approved');
    } finally {
      delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED_USER_22;
    }
  });

  it('does not apply the Training-only Decision gate to non-Training personal decisions', async () => {
    process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    const { created } = await createContentApprovalDecision(222, 222, 'content:training-gate-isolation');

    expect(created.item).toMatchObject({ sourceSkill: 'content', reviewSupported: false });
    expect(decisionRefreshSupportedForDecision(created.item!.decisionId, 222, 222)).toBe(false);
    const result = await performDecisionAction(created.item!.decisionId, 'approve_script', 222, 222, {
      idempotencyKey: 'content-without-version-under-training-gate',
    });
    expect(result.status).toBe('succeeded');
  });

  it('requires and preserves the current version for snooze through the action path', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 221, {
      tenantId: 221,
      dedupeKey: 'versioned-snooze-action',
      actionButtons: [{ id: 'snooze', label: 'Defer', style: 'secondary' }],
    }));
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED_USER_221 = 'true';
    try {
      await expect(performDecisionAction(created.item!.decisionId, 'snooze', 221, 221, {
        idempotencyKey: 'snooze-without-version',
        payload: { minutes: 30 },
      })).rejects.toMatchObject({ code: 'DECISION_VERSION_REQUIRED', status: 428 });

      const result = await performDecisionAction(created.item!.decisionId, 'snooze', 221, 221, {
        idempotencyKey: 'snooze-current-version',
        expectedVersion: created.item!.recordVersion,
        payload: { minutes: 30 },
      });
      expect(result.status).toBe('succeeded');
      expect(result.item.status).toBe('snoozed');
      expect(result.item.recordVersion).toBe(created.item!.recordVersion + 1);
    } finally {
      delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED_USER_221;
    }
  });

  it('rejects a mismatched context version before invoking an action', async () => {
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'review_calendar_conflict',
      targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda-context', version: '1' }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      preconditions: [],
      expectedEffects: [{ type: 'review_required', targetRef: 'secretary_agenda_item:agenda-context' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:23'],
      authorizationScope: ['decision_center:read'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: 'ctx_current',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 23, {
      dedupeKey: 'context-version-mismatch',
      decisionContext: {
        entityTitle: 'Training review',
        sourceState: 'pending',
        normalizedAction,
      },
    }));

    await expect(performDecisionAction(created.item!.decisionId, 'open_detail', 23, 23, {
      idempotencyKey: 'wrong-context',
      contextVersion: 'ctx_stale',
    })).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED', status: 409 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM decision_action_executions WHERE decision_id = ?').get(created.item!.decisionId))
      .toMatchObject({ count: 0 });
  });

  it('records versioned reviews idempotently without treating model output as execution authority', async () => {
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'review_training_proposal',
      targetEntities: [{ type: 'training_plan', id: 'plan-review-24', version: '1' }],
      affectedResources: [{ type: 'training_state', id: 'primary' }],
      preconditions: [],
      expectedEffects: [{ type: 'review_required', targetRef: 'training_plan:plan-review-24' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['training_state:24'],
      authorizationScope: ['decision_center:read'],
      risk: 'medium',
      reversibility: 'reversible',
      contextVersion: 'ctx_review_24',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 24, {
      dedupeKey: 'review-versioned',
      decisionContext: {
        entityTitle: 'Training proposal',
        evidenceConfidence: 0.51,
        candidateConfidence: 'medium',
        normalizedAction,
      },
    }));
    expect(created.item).toMatchObject({
      reviewSupported: true,
      editableProposalFields: [],
      reversibility: 'reversible',
      riskLevel: 'medium',
      confidence: 0.51,
    });
    const approved = reviewDecision(created.item!.decisionId, 24, 24, {
      outcome: 'approve',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'review-attempt-1',
      reasonCode: 'user_confirmed',
    });
    expect(approved.decisionState).toBe('approved');
    expect(approved.recordVersion).toBe(created.item!.recordVersion + 1);
    expect(approved.status).toBe('read');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM decision_action_executions WHERE decision_id = ?').get(created.item!.decisionId))
      .toMatchObject({ count: 0 });

    const replay = reviewDecision(created.item!.decisionId, 24, 24, {
      outcome: 'approve',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'review-attempt-1',
      reasonCode: 'user_confirmed',
    });
    expect(replay.recordVersion).toBe(approved.recordVersion);
    const approvalEvents = getDecisionLifecycleEvents(created.item!.decisionId, 24, 24)
      .filter((event) => event.event === 'approved');
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0].metadata.commandContract).toMatchObject({
      schemaVersion: 'decision_mutation_command@1.0.0',
      operation: 'review',
      actionId: 'review:approve',
      scope: { userId: 24, tenantId: 24 },
      idempotencyKey: 'review-attempt-1',
      readback: { expectedState: { decisionState: 'approved' } },
    });
    expect(() => reviewDecision(created.item!.decisionId, 24, 24, {
      outcome: 'reject',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'review-attempt-1',
      reasonCode: 'changed_request',
    })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 }));
  });

  it('does not expose or accept approval for a structured Secretary review-only preview', async () => {
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    const start = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const end = new Date(Date.now() + 7 * 3_600_000).toISOString();
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'secretary.schedule_event',
      targetEntities: [{ type: 'calendar_event', id: 'opaque-event', version: '1' }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      requestedWindow: { start, end, timezone: 'UTC' },
      preconditions: [],
      expectedEffects: [{ type: 'review_required', targetRef: 'calendar_event:opaque-event' }],
      prohibitedEffects: [{ type: 'automatic_execution', targetRef: 'calendar_event:opaque-event' }],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:240'],
      authorizationScope: ['decision_center:read'],
      risk: 'medium',
      reversibility: 'irreversible',
      contextVersion: 'ctx_review_only',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 240, {
      tenantId: 240,
      type: 'decision_required',
      title: 'Review a scoped schedule proposal',
      body: 'A structured calendar proposal must be compared with current commitments before any change.',
      relatedEntityId: normalizedAction.candidateFingerprint,
      relatedEntityType: 'secretary_candidate',
      actionButtons: [{ id: 'open_detail', label: 'Review proposal', style: 'primary' }],
      dedupeKey: 'secretary:structured-preview:review-only-test',
      decisionDeadline: start,
      expiresAt: start,
      requiresUserAction: true,
      deliveryPolicy: 'in_app_only',
      decisionContext: {
        entityTitle: 'Calendar change proposed by Secretary',
        recommendedStartAt: start,
        recommendedEndAt: end,
        timezone: 'UTC',
        reasonCodes: ['structured_secretary_preview', 'preview_only', 'context_revalidation_required'],
        sourceState: 'allow',
        recipe: 'secretary_structured_preview_v1',
        normalizedAction,
      },
    }));

    expect(created.item).toMatchObject({ approvalLevel: 'none', actionability: 'read_only' });
    try {
      reviewDecision(created.item!.decisionId, 240, 240, {
        outcome: 'approve',
        expectedVersion: created.item!.recordVersion,
        idempotencyKey: 'review-only-approve',
      });
      expect.fail('review-only preview must not accept approval');
    } catch (error) {
      expect(error).toMatchObject({ code: 'DECISION_REVIEW_NOT_APPLICABLE', status: 409 });
    }
  });

  it('revises only a structured proposal window and invalidates prior conflict evaluation', async () => {
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    ensureSecretaryAgendaFixtureTables();
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'reschedule_secretary_item',
      targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda-edit', version: '1' }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      requestedWindow: { start: '2026-05-11T08:00:00.000Z', end: '2026-05-11T09:00:00.000Z', timezone: 'Europe/Lisbon' },
      preconditions: [],
      expectedEffects: [{ type: 'calendar_window_changed', targetRef: 'secretary_agenda_item:agenda-edit' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:25'],
      authorizationScope: ['decision_center:write'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: 'ctx_before_edit',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 25, {
      dedupeKey: 'proposal-edit',
      relatedEntityId: 'agenda-edit',
      relatedEntityType: 'secretary_agenda_item',
      decisionContext: {
        entityTitle: 'Schedule proposal',
        sourceState: 'pending',
        recommendedStartAt: '2026-05-11T08:00:00.000Z',
        recommendedEndAt: '2026-05-11T09:00:00.000Z',
        timezone: 'Europe/Lisbon',
        recipe: 'secretary_reflow_window_v1',
        normalizedAction,
      },
    }));

    const revised = reviseDecisionProposal(created.item!.decisionId, 25, 25, {
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'proposal-edit-1',
      recommendedStartAt: '2026-05-11T10:00:00.000Z',
      recommendedEndAt: '2026-05-11T11:30:00.000Z',
    });
    expect(revised.recordVersion).toBe(created.item!.recordVersion + 1);
    expect(revised.decisionState).toBe('ready_for_review');
    expect(revised.contextVersion).toMatch(/^ctx_revision_/);
    const persisted = testDb.prepare('SELECT decision_context_json, context_version FROM notification_intents WHERE intent_id = ?').get(created.item!.intentId) as any;
    const context = JSON.parse(persisted.decision_context_json);
    expect(context.recommendedStartAt).toBe('2026-05-11T10:00:00.000Z');
    expect(context.recommendedEndAt).toBe('2026-05-11T11:30:00.000Z');
    expect(context.conflictEvaluation).toMatchObject({
      contextVersion: revised.contextVersion,
      disposition: 'allow',
      findings: [],
    });
    expect(persisted.context_version).toBe(revised.contextVersion);
    const replay = reviseDecisionProposal(created.item!.decisionId, 25, 25, {
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'proposal-edit-1',
      recommendedStartAt: '2026-05-11T10:00:00.000Z',
      recommendedEndAt: '2026-05-11T11:30:00.000Z',
    });
    expect(replay.recordVersion).toBe(revised.recordVersion);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM decision_lifecycle_events
       WHERE decision_id = ? AND event = 'revised'
    `).get(created.item!.decisionId)).toEqual({ count: 1 });
    const revisedEvent = getDecisionLifecycleEvents(created.item!.decisionId, 25, 25)
      .find((event) => event.event === 'revised');
    expect(revisedEvent?.metadata.commandContract).toMatchObject({
      schemaVersion: 'decision_mutation_command@1.0.0',
      operation: 'edit',
      actionId: 'edit_proposal',
      idempotencyKey: 'proposal-edit-1',
      readback: {
        expectedState: {
          recommendedStartAt: '2026-05-11T10:00:00.000Z',
          recommendedEndAt: '2026-05-11T11:30:00.000Z',
        },
      },
    });
    expect(() => reviseDecisionProposal(created.item!.decisionId, 25, 25, {
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'proposal-edit-1',
      recommendedStartAt: '2026-05-11T12:00:00.000Z',
      recommendedEndAt: '2026-05-11T13:00:00.000Z',
    })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 }));
  });

  it('rejects proposal edits outside the Secretary reflow allowlist', async () => {
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'review_training_window',
      targetEntities: [{ type: 'training_plan', id: 'plan-edit-denied', version: '1' }],
      affectedResources: [{ type: 'training_state', id: 'primary' }],
      requestedWindow: {
        start: '2026-05-11T08:00:00.000Z',
        end: '2026-05-11T09:00:00.000Z',
        timezone: 'Europe/Lisbon',
      },
      preconditions: [],
      expectedEffects: [{ type: 'review_required', targetRef: 'training_plan:plan-edit-denied' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['training_state:25'],
      authorizationScope: ['decision_center:read'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: 'ctx_training_edit_denied',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 251, {
      tenantId: 251,
      dedupeKey: 'proposal-edit-denied',
      decisionContext: { entityTitle: 'Training window', normalizedAction },
    }));

    expect(created.item?.editableProposalFields).toEqual([]);
    expect(() => reviseDecisionProposal(created.item!.decisionId, 251, 251, {
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'proposal-edit-denied-1',
      recommendedStartAt: '2026-05-11T10:00:00.000Z',
      recommendedEndAt: '2026-05-11T11:00:00.000Z',
    })).toThrow(/not allowlisted/i);
  });

  it('requires an explicit replacement choice and strong confirmation when policy calls for them', async () => {
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    ensureSecretaryAgendaFixtureTables();
    const candidate = buildNormalizedDecisionAction({
      intent: 'replace_calendar_commitment',
      targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda-replace', version: '1' }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      requestedWindow: {
        start: '2026-05-11T08:00:00.000Z',
        end: '2026-05-11T09:00:00.000Z',
        timezone: 'Europe/Lisbon',
      },
      preconditions: [],
      expectedEffects: [{ type: 'calendar_window_changed', targetRef: 'secretary_agenda_item:agenda-replace' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:252'],
      authorizationScope: ['decision_center:read'],
      risk: 'high',
      reversibility: 'reversible',
      contextVersion: 'ctx_replacement_review',
    });
    const existing = buildNormalizedDecisionAction({
      intent: 'preserve_calendar_commitment',
      targetEntities: [{ type: 'calendar_event', id: 'event-existing', version: '1' }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      requestedWindow: {
        start: '2026-05-11T08:30:00.000Z',
        end: '2026-05-11T09:30:00.000Z',
        timezone: 'Europe/Lisbon',
      },
      preconditions: [],
      expectedEffects: [{ type: 'commitment_preserved', targetRef: 'calendar_event:event-existing' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:252'],
      authorizationScope: ['decision_center:read'],
      risk: 'medium',
      reversibility: 'reversible',
      contextVersion: 'ctx_existing_commitment',
    });
    const conflictEvaluation = evaluateDecisionConflicts({
      candidate,
      existing: [{
        action: existing,
        decisionId: 'existing-commitment',
        authority: 'approved_commitment',
        approved: true,
        createdAt: '2026-05-10T08:00:00.000Z',
      }],
      now: new Date('2026-05-10T10:00:00.000Z'),
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 252, {
      tenantId: 252,
      dedupeKey: 'explicit-replacement-review',
      relatedEntityId: 'agenda-replace',
      relatedEntityType: 'secretary_agenda_item',
      decisionContext: {
        entityTitle: 'Replacement proposal',
        currentStartAt: candidate.requestedWindow!.start,
        currentEndAt: candidate.requestedWindow!.end,
        normalizedAction: candidate,
        conflictComparisons: [{
          action: existing,
          decisionId: 'existing-commitment',
          authority: 'approved_commitment',
          approved: true,
          createdAt: '2026-05-10T08:00:00.000Z',
        }],
        conflictEvaluation,
      },
    }));

    expect(created.item).toMatchObject({ approvalLevel: 'strong_confirmation', reviewSupported: true });
    expect(() => reviewDecision(created.item!.decisionId, 252, 252, {
      outcome: 'defer',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'invalid-explicit-defer',
      deferUntil: 'not-an-iso-instant',
    })).toThrowError(expect.objectContaining({
      code: 'DECISION_DEFER_UNTIL_INVALID',
      status: 400,
    }));
    expect(() => reviewDecision(created.item!.decisionId, 252, 252, {
      outcome: 'approve',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'replacement-without-choice',
      strongConfirmationText: 'CONFIRM',
    })).toThrow(/replacement explicitly/i);
    expect(() => reviewDecision(created.item!.decisionId, 252, 252, {
      outcome: 'approve',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'replacement-without-strong-confirmation',
      replacementChoiceId: 'replace_with_candidate',
    })).toThrow(/type CONFIRM/i);

    const approved = reviewDecision(created.item!.decisionId, 252, 252, {
      outcome: 'approve',
      expectedVersion: created.item!.recordVersion,
      idempotencyKey: 'replacement-approved',
      replacementChoiceId: 'replace_with_candidate',
      strongConfirmationText: 'CONFIRM',
    });
    expect(approved.decisionState).toBe('approved');
    const approvedEvent = getDecisionLifecycleEvents(created.item!.decisionId, 252, 252)
      .find((event) => event.event === 'approved');
    expect(approvedEvent?.metadata).toMatchObject({
      replacementChoiceId: 'replace_with_candidate',
      confirmationStrength: 'strong',
    });
    expect(JSON.stringify(approvedEvent?.metadata)).not.toContain('CONFIRM');
  });

  it('suppresses a repeated low-risk rejected candidate until its context materially changes', async () => {
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    const actionFor = (contextVersion: string) => buildNormalizedDecisionAction({
      intent: 'review_low_risk_schedule_option',
      targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda-cooldown', version: contextVersion }],
      affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
      requestedWindow: { start: '2026-05-12T08:00:00.000Z', end: '2026-05-12T09:00:00.000Z', timezone: 'Europe/Lisbon' },
      preconditions: [],
      expectedEffects: [{ type: 'review_required', targetRef: 'secretary_agenda_item:agenda-cooldown' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['calendar_timeline:26'],
      authorizationScope: ['decision_center:read'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion,
    });
    const build = (dedupeKey: string, contextVersion: string) => buildSkillDecisionFixtureIntent('training', 26, {
      priority: 'active',
      dedupeKey,
      decisionContext: {
        entityTitle: 'Schedule review',
        sourceState: 'pending',
        normalizedAction: actionFor(contextVersion),
      },
    });
    const first = await createDecisionIntent(build('cooldown:first', 'ctx_same'));
    reviewDecision(first.item!.decisionId, 26, 26, {
      outcome: 'reject',
      expectedVersion: first.item!.recordVersion,
      idempotencyKey: 'reject-cooldown',
    });
    process.env.DECISION_FEEDBACK_SUPPRESSION_ENABLED = 'true';
    process.env.DECISION_CANDIDATE_REJECTION_COOLDOWN_DAYS = '14';

    const repeated = await createDecisionIntent(build('cooldown:repeat', 'ctx_same'));
    expect(repeated.item).toBeNull();
    expect(repeated.eligibility.reasons).toContain('candidate_rejection_cooldown');

    const changed = await createDecisionIntent(build('cooldown:changed', 'ctx_changed'));
    expect(changed.item).not.toBeNull();
  });

  it('denies expired, superseded, dismissed, and already-actioned decisions correctly', async () => {
    const expired = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 30, { dedupeKey: 'expired' }));
    testDb.prepare(`UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?`)
      .run('2026-05-09T10:00:00.000Z', expired.item!.decisionId);
    await expect(performDecisionAction(expired.item!.decisionId, 'open_detail', 30, 30, { idempotencyKey: 'expired-tap' }))
      .rejects.toThrow(/expired/i);

    const superseded = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 31, { dedupeKey: 'superseded' }));
    testDb.prepare(`UPDATE notification_center_items SET status = 'superseded' WHERE item_id = ?`).run(superseded.item!.decisionId);
    await expect(performDecisionAction(superseded.item!.decisionId, 'open_detail', 31, 31, { idempotencyKey: 'superseded-tap' }))
      .rejects.toThrow(/superseded/i);

    const dismissed = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 32, { dedupeKey: 'dismissed' }));
    testDb.prepare(`UPDATE notification_center_items SET status = 'dismissed' WHERE item_id = ?`).run(dismissed.item!.decisionId);
    await expect(performDecisionAction(dismissed.item!.decisionId, 'open_detail', 32, 32, { idempotencyKey: 'dismissed-tap' }))
      .rejects.toThrow(/dismissed/i);

    const { created: rejectedMutation } = await createContentApprovalDecision(321, 321, 'rejected-mutation-replay');
    dismissDecision(rejectedMutation.item!.decisionId, 321, 321, 'user_rejected');
    await expect(performDecisionAction(rejectedMutation.item!.decisionId, 'approve_script', 321, 321, {
      idempotencyKey: 'rejected-mutation-replay',
    })).rejects.toMatchObject({ code: 'DECISION_DISMISSED' });

    const { created: supersededMutation } = await createContentApprovalDecision(322, 322, 'superseded-mutation-replay');
    testDb.prepare(`UPDATE notification_center_items SET status = 'superseded', decision_state = 'superseded' WHERE item_id = ?`)
      .run(supersededMutation.item!.decisionId);
    await expect(performDecisionAction(supersededMutation.item!.decisionId, 'approve_script', 322, 322, {
      idempotencyKey: 'superseded-mutation-replay',
    })).rejects.toMatchObject({ code: 'DECISION_SUPERSEDED' });

    const { created } = await createContentApprovalDecision(33, 33, 'already-actioned');
    await performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-once' });
    const duplicate = await performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-once' });
    expect(duplicate.status).toBe('idempotent');
    await expect(performDecisionAction(created.item!.decisionId, 'dismiss', 33, 33, { idempotencyKey: 'action-once' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-twice' }))
      .rejects.toThrow(/already actioned/i);
  });

  it('dismisses a snoozed decision truthfully and rejects a duplicate no-op', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 34, { dedupeKey: 'dismiss-snoozed' }));
    const snoozed = snoozeDecision(created.item!.decisionId, 34, 34, 60);
    expect(snoozed.status).toBe('snoozed');
    const dismissed = dismissDecision(created.item!.decisionId, 34, 34, 'not_relevant');
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.decisionState).toBe('rejected');
    expect(dismissed.recordVersion).toBe(created.item!.recordVersion + 2);
    expect(() => dismissDecision(created.item!.decisionId, 34, 34, 'duplicate'))
      .toThrow(/no longer in a dismissible state/i);
  });

  it('resolves revisit timing once and replays the exact durable snooze result', async () => {
    const nextWeek = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 35, {
      dedupeKey: 'snooze-next-week-local-time',
      decisionContext: { timezone: 'Europe/Lisbon' },
    }));
    const first = await performDecisionAction(nextWeek.item!.decisionId, 'snooze', 35, 35, {
      idempotencyKey: 'snooze-next-week-1',
      payload: { followUp: 'next week' },
    });
    expect(first.verification.actualEffect).toMatchObject({
      decisionStatus: 'snoozed',
      snoozedUntil: '2026-05-11T08:00:00.000Z',
    });

    const replay = await performDecisionAction(nextWeek.item!.decisionId, 'snooze', 35, 35, {
      idempotencyKey: 'snooze-next-week-1',
      payload: { followUp: 'next week' },
    });
    expect(replay.status).toBe('idempotent');
    expect(replay.verification.actualEffect.snoozedUntil).toBe('2026-05-11T08:00:00.000Z');
    await expect(performDecisionAction(nextWeek.item!.decisionId, 'snooze', 35, 35, {
      idempotencyKey: 'snooze-next-week-1',
      payload: { minutes: 30 },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    const exact = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 36, {
      dedupeKey: 'snooze-explicit-instant',
      decisionContext: { timezone: 'America/Sao_Paulo' },
    }));
    const exactResult = await performDecisionAction(exact.item!.decisionId, 'snooze', 36, 36, {
      idempotencyKey: 'snooze-exact-1',
      payload: { deferUntil: '2026-05-13T09:45:00-03:00' },
    });
    expect(exactResult.verification.actualEffect.snoozedUntil).toBe('2026-05-13T12:45:00.000Z');

    const invalid = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 37, {
      dedupeKey: 'snooze-invalid-minutes',
    }));
    await expect(performDecisionAction(invalid.item!.decisionId, 'snooze', 37, 37, {
      idempotencyKey: 'snooze-invalid-1',
      payload: { minutes: Number.NaN },
    })).rejects.toMatchObject({ code: 'DECISION_INVALID_MINUTES', status: 400 });
  });

  it('marks decisions failed when fresh read-back status does not match the expected effect', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 40, { dedupeKey: 'readback-mismatch' }));
    testDb.exec(`
      CREATE TRIGGER force_decision_readback_mismatch
      AFTER UPDATE OF status ON notification_center_items
      WHEN NEW.item_id = '${created.item!.decisionId}' AND NEW.status = 'read'
      BEGIN
        UPDATE notification_center_items SET status = 'unread' WHERE item_id = NEW.item_id;
      END;
    `);

    await expect(performDecisionAction(created.item!.decisionId, 'open_detail', 40, 40, { idempotencyKey: 'mismatch-tap' }))
      .rejects.toThrow(/read-back/i);
    const item = getDecisionItem(created.item!.decisionId, 40, 40);
    expect(item?.status).toBe('failed');
    const execution = testDb.prepare(`
      SELECT status, error_code
      FROM decision_action_executions
      WHERE decision_id = ? AND idempotency_key = 'mismatch-tap'
    `).get(created.item!.decisionId) as { status: string; error_code: string };
    expect(execution).toMatchObject({ status: 'partially_failed', error_code: 'DECISION_READBACK_MISMATCH' });
    const ledger = testDb.prepare(`
      SELECT failed_reason, action_succeeded, partial_failure
      FROM decision_outcome_ledger
      WHERE decision_id = ?
    `).get(created.item!.decisionId) as { failed_reason: string; action_succeeded: number; partial_failure: number };
    expect(ledger).toMatchObject({
      failed_reason: 'DECISION_READBACK_MISMATCH',
      action_succeeded: 0,
      partial_failure: 1,
    });
  });

  it('durably revokes approval and audits when execution-time revalidation finds a new conflict', async () => {
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    const actionFor = (id: string, contextVersion: string) => buildNormalizedDecisionAction({
      intent: `review_chat_choice_${id}`,
      targetEntities: [{ type: 'chat_choice', id, version: '1' }],
      affectedResources: [{ type: 'shared_choice', id: 'primary' }],
      preconditions: [],
      expectedEffects: [{ type: 'choice_selected', targetRef: `chat_choice:${id}` }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['shared_choice:253'],
      authorizationScope: ['decision_center:read'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion,
    });
    const first = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 253, {
      tenantId: 253,
      dedupeKey: 'revalidation-revoke-first',
      actionButtons: [{ id: 'option_a', label: 'Choose A', style: 'primary' }],
      decisionContext: { entityTitle: 'First choice', normalizedAction: actionFor('first', 'ctx_revoke_first') },
    }));
    const approved = reviewDecision(first.item!.decisionId, 253, 253, {
      outcome: 'approve',
      expectedVersion: first.item!.recordVersion,
      idempotencyKey: 'approve-before-new-conflict',
    });
    await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 253, {
      tenantId: 253,
      dedupeKey: 'revalidation-revoke-second',
      actionButtons: [{ id: 'option_b', label: 'Choose B', style: 'primary' }],
      decisionContext: { entityTitle: 'Second choice', normalizedAction: actionFor('second', 'ctx_revoke_second') },
    }));

    await expect(performDecisionAction(first.item!.decisionId, 'option_a', 253, 253, {
      idempotencyKey: 'execute-after-new-conflict',
      expectedVersion: approved.recordVersion,
      contextVersion: approved.contextVersion,
    })).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED' });

    const invalidated = getDecisionItem(first.item!.decisionId, 253, 253)!;
    expect(invalidated.decisionState).toBe('ready_for_review');
    expect(invalidated.recordVersion).toBe(approved.recordVersion + 1);
    expect(getDecisionLifecycleEvents(first.item!.decisionId, 253, 253)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'revalidation_failed', reason: 'conflicts_changed_after_review' }),
    ]));
  });

  it('treats an expired execution lease as an uncertain partial outcome and retains its exclusivity guard', async () => {
    const uncertain = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 401, {
      tenantId: 401,
      dedupeKey: 'expired-execution-lease',
    }));
    testDb.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, logical_action_hash,
        lease_expires_at, effect_results_json, recovery_json
      ) VALUES (?, ?, 'approve_script', 401, 401, 'lease-attempt', 'content', 'started', ?, ?, '[]', '{}')
    `).run('dae_expired_lease', uncertain.item!.decisionId, 'logical-expired-lease', '2026-05-09T10:00:00.000Z');
    testDb.prepare(`
      INSERT INTO decision_exclusivity_claims (
        user_id, tenant_id, exclusivity_key, action_execution_id, decision_id,
        status, lease_expires_at
      ) VALUES (401, 401, 'training_state:401', 'dae_expired_lease', ?, 'started', ?)
    `).run(uncertain.item!.decisionId, '2026-05-09T10:00:00.000Z');
    const trigger = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 401, {
      tenantId: 401,
      dedupeKey: 'trigger-lease-reconciliation',
    }));

    await performDecisionAction(trigger.item!.decisionId, 'open_detail', 401, 401, {
      idempotencyKey: 'trigger-lease-sweep',
    });

    expect(testDb.prepare(`
      SELECT status, error_code, effect_results_json
        FROM decision_action_executions WHERE action_execution_id = 'dae_expired_lease'
    `).get()).toMatchObject({
      status: 'partially_failed',
      error_code: 'DECISION_EXECUTION_LEASE_EXPIRED',
      effect_results_json: expect.stringContaining('"status":"unknown"'),
    });
    expect(testDb.prepare(`
      SELECT status FROM decision_exclusivity_claims
       WHERE user_id = 401 AND tenant_id = 401 AND exclusivity_key = 'training_state:401'
    `).get()).toMatchObject({ status: 'partially_failed' });
  });

  it('blocks lifecycle mutations while an execution is active or awaiting reconciliation', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 402, {
      tenantId: 402,
      dedupeKey: 'lifecycle-blocked-by-partial-execution',
    }));
    testDb.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, effect_results_json, recovery_json
      ) VALUES ('dae_partial_lifecycle', ?, 'retry', 402, 402,
        'partial-lifecycle-attempt', 'training', 'partially_failed', '[]', '{}')
    `).run(created.item!.decisionId);

    expect(() => dismissDecision(created.item!.decisionId, 402, 402, 'not_relevant'))
      .toThrow(/reconcile/i);
    expect(() => snoozeDecision(created.item!.decisionId, 402, 402, 30))
      .toThrow(/reconcile/i);
  });

  it('classifies transport timeouts as uncertain without weakening deterministic validation failures', () => {
    expect(isUncertainDecisionExecutionOutcome('DECISION_ACTION_FAILED', { originalCode: 'ETIMEDOUT' })).toBe(true);
    expect(isUncertainDecisionExecutionOutcome('DECISION_ACTION_FAILED', { originalCode: 'FETCH_FAILED', causeCode: 'ECONNRESET' })).toBe(true);
    expect(isUncertainDecisionExecutionOutcome('DECISION_ACTION_FAILED', { outcomeState: 'dispatched_outcome_unknown' })).toBe(true);
    expect(isUncertainDecisionExecutionOutcome('PROVIDER_NETWORK_ERROR')).toBe(true);
    expect(isUncertainDecisionExecutionOutcome('DECISION_PERMISSION_REQUIRED')).toBe(false);
    expect(isUncertainDecisionExecutionOutcome('DECISION_ACTION_PAYLOAD_REQUIRED')).toBe(false);
  });

  it('rejects snooze when the scoped decision update misses the row', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 41, {
      dedupeKey: 'snooze-stale-row',
    }));
    testDb.prepare(`UPDATE notification_center_items SET status = 'dismissed' WHERE item_id = ?`)
      .run(created.item!.decisionId);

    expect(() => snoozeDecision(created.item!.decisionId, 41, 41, 30))
      .toThrow(/changed/i);
  });

  it('marks execution failed when the final decision action update is ignored', async () => {
    const { created } = await createContentApprovalDecision(42, 42, 'ignored-final-decision-update');
    const decisionId = created.item!.decisionId.replace(/'/g, "''");
    testDb.exec(`
      CREATE TRIGGER ignore_actioned_decision_update
      BEFORE UPDATE OF status ON notification_center_items
      WHEN NEW.item_id = '${decisionId}' AND NEW.status = 'actioned'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 42, 42, {
      idempotencyKey: 'ignored-final-update',
    })).rejects.toMatchObject({ code: 'DECISION_SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED' });

    const execution = testDb.prepare(`
      SELECT status, error_code
      FROM decision_action_executions
      WHERE decision_id = ? AND idempotency_key = 'ignored-final-update'
    `).get(created.item!.decisionId) as { status: string; error_code: string };
    expect(execution).toMatchObject({ status: 'partially_failed', error_code: 'DECISION_SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED' });
    const rawDecision = testDb.prepare(`SELECT status FROM notification_center_items WHERE item_id = ?`)
      .get(created.item!.decisionId) as { status: string };
    expect(rawDecision.status).toBe('failed');

    testDb.exec('DROP TRIGGER ignore_actioned_decision_update');
    process.env.DECISION_REFRESH_ENABLED_USER_42 = 'true';
    try {
      const reconciled = refreshDecisionItem(created.item!.decisionId, 42, 42)!.item;
      expect(reconciled.status).toBe('actioned');
      expect(reconciled.execution.status).toBe('succeeded');
      expect(getDecisionLifecycleEvents(created.item!.decisionId, 42, 42)).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'execution_reconciled', reason: 'authoritative_state_applied' }),
      ]));
    } finally {
      delete process.env.DECISION_REFRESH_ENABLED_USER_42;
    }
  });

  it('fails closed when durable normalized-action metadata cannot be persisted', async () => {
    const action = buildNormalizedDecisionAction({
      intent: 'review_metadata_failure',
      targetEntities: [{ type: 'task', id: 'task-metadata-failure', version: '1' }],
      affectedResources: [{ type: 'task_store', id: 'primary' }],
      preconditions: [],
      expectedEffects: [{ type: 'review_required', targetRef: 'task:task-metadata-failure' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['task_store:403:task-metadata-failure'],
      authorizationScope: ['decision_center:read'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: 'ctx_metadata_failure',
    });
    testDb.exec(`
      CREATE TRIGGER fail_decision_flow_metadata_update
      BEFORE UPDATE OF context_version ON notification_intents
      WHEN NEW.context_version IS NOT OLD.context_version
      BEGIN
        SELECT RAISE(ABORT, 'forced metadata failure');
      END;
    `);

    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 403, {
      tenantId: 403,
      dedupeKey: 'fail-closed-flow-metadata',
      decisionContext: { entityTitle: 'Metadata failure fixture', normalizedAction: action },
    }));

    expect(created.item).toBeNull();
    expect(created.eligibility.reasons).toContain('decision_flow_metadata_persistence_failed');
    expect(testDb.prepare(`
      SELECT item_id FROM notification_center_items
       WHERE dedupe_key = 'fail-closed-flow-metadata'
    `).get()).toBeUndefined();
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM notification_intents
       WHERE dedupe_key = 'fail-closed-flow-metadata'
    `).get()).toEqual({ count: 0 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM notification_delivery_attempts
       WHERE user_id = 403 AND tenant_id = 403
    `).get()).toEqual({ count: 0 });
    const backgroundJobsTable = testDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'background_jobs'
    `).get();
    if (backgroundJobsTable) {
      expect(testDb.prepare(`
        SELECT COUNT(*) AS count FROM background_jobs
         WHERE user_id = 403 AND tenant_id = 403 AND job_type = 'deliver_notification'
      `).get()).toEqual({ count: 0 });
    }
    const eventOutboxTable = testDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_outbox'
    `).get();
    if (eventOutboxTable) {
      expect(testDb.prepare(`
        SELECT COUNT(*) AS count FROM event_outbox
         WHERE user_id = 403 AND tenant_id = 403
      `).get()).toEqual({ count: 0 });
    }
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM decision_lifecycle_events WHERE user_id = 403 AND tenant_id = 403
    `).get()).toEqual({ count: 0 });
  });

  it('keeps one canonical proposal and one delivery job across duplicate intent retries', async () => {
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    const input = buildSkillDecisionFixtureIntent('chat', 404, {
      tenantId: 904,
      dedupeKey: 'canonical-duplicate-delivery-once',
      deliveryPolicy: 'auto',
    });

    const first = await createDecisionIntent(input);
    const duplicate = await createDecisionIntent(input);

    expect(first.item).not.toBeNull();
    expect(duplicate.item?.decisionId).toBe(first.item?.decisionId);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_center_items
       WHERE user_id = 404 AND tenant_id = 904
         AND dedupe_key = 'canonical-duplicate-delivery-once'
    `).get()).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM background_jobs
       WHERE user_id = 404 AND tenant_id = 904
         AND job_type = 'deliver_notification'
    `).get()).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM decision_lifecycle_events
       WHERE user_id = 404 AND tenant_id = 904 AND event = 'created'
    `).get()).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_delivery_attempts attempts
        JOIN notification_intents intents ON intents.intent_id = attempts.intent_id
       WHERE intents.user_id = 404 AND intents.tenant_id = 904
    `).get()).toEqual({ count: 0 });
  });

  it('documents outcome ledger retention and aggregate-only admin reporting policy', () => {
    expect(DECISION_OUTCOME_LEDGER_RETENTION_POLICY).toMatchObject({
      rawOutcomeRetentionDays: 180,
      aggregateRetentionDays: 730,
      adminReportingScope: 'aggregate_only',
      privateTextPolicy: 'never_store_raw_private_text',
    });
  });

  it('returns tenant-scoped aggregate outcome metrics without private decision text', async () => {
    const { created: approved } = await createContentApprovalDecision(44, 44, 'metrics-private-draft');
    const dismissed = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 44, {
      tenantId: 44,
      dedupeKey: 'metrics-dismiss',
    }));
    const snoozed = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 44, {
      tenantId: 44,
      dedupeKey: 'metrics-snooze',
    }));

    await performDecisionAction(approved.item!.decisionId, 'approve_script', 44, 44, {
      idempotencyKey: 'metrics-approve',
    });
    dismissDecision(dismissed.item!.decisionId, 44, 44);
    snoozeDecision(snoozed.item!.decisionId, 44, 44, 30);
    const generic = await createDecisionIntent({
      userId: 44,
      tenantId: 44,
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'active',
      title: 'Secretary',
      body: 'Secretary needs your attention.',
      actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
      requiresUserAction: true,
      privacyPolicy: 'standard',
      dedupeKey: 'metrics-generic-blocked',
    });
    expect(generic.item).toBeNull();

    const metrics = getDecisionOutcomeMetrics(44, 44);

    expect(metrics).toMatchObject({
      userId: 44,
      tenantId: 44,
      totalOutcomes: 3,
      decisionQualityScore: expect.any(Number),
      decisionSpecificityScore: expect.any(Number),
      decisionActionabilityScore: expect.any(Number),
      acceptedCount: 1,
      dismissedCount: 1,
      deferredCount: 1,
      snoozedCount: 1,
      explanationOpenCount: 0,
      genericBlockedCount: 1,
      primaryActionCount: 3,
      failedActionCount: 0,
      partialFailureCount: 0,
      primaryActionRate: 1,
      dismissRate: 0.3333,
      deferRate: 0.3333,
      snoozeRate: 0.3333,
      explanationOpenRate: 0,
      genericBlockedRate: 0.25,
      failedActionRate: 0,
      partialFailureRate: 0,
    });
    expect(metrics.decisionQualityScore).toBeGreaterThan(50);
    expect(metrics.decisionSpecificityScore).toBeGreaterThan(50);
    expect(metrics.decisionActionabilityScore).toBeGreaterThan(50);
    expect(metrics.bySourceSkill.content).toBe(1);
    expect(metrics.bySourceSkill.training).toBe(1);
    expect(metrics.bySourceSkill.chat).toBe(1);
    expect(metrics.bySourceSkillOutcome.content).toMatchObject({ total: 1, accepted: 1, dismissed: 0, deferred: 0 });
    expect(metrics.bySourceSkillOutcome.training).toMatchObject({ total: 1, accepted: 0, dismissed: 1, deferred: 0 });
    expect(metrics.bySourceSkillOutcome.chat).toMatchObject({ total: 1, accepted: 0, dismissed: 0, deferred: 1 });
    expect(JSON.stringify(metrics)).not.toContain('metrics-private-draft');
    expect(JSON.stringify(metrics)).not.toContain('Draft');
    expect(getDecisionOutcomeMetrics(44, 45).totalOutcomes).toBe(0);
  });

  it('requires client-supplied idempotency keys for decision actions', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 41, { dedupeKey: 'missing-idempotency' }));
    await expect(performDecisionAction(created.item!.decisionId, 'open_detail', 41, 41))
      .rejects.toThrow(/idempotency key/i);
  });

  it('persists dependencies and blocks mutating actions until parent decisions resolve', async () => {
    const parent = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 60, { dedupeKey: 'dependency-parent' }));
    const { object, created: child } = await createContentApprovalDecision(60, 60, 'dependency-child');

    addDecisionDependency({
      decisionId: child.item!.decisionId,
      dependsOnDecisionId: parent.item!.decisionId,
      userId: 60,
      tenantId: 60,
    });

    expect(listDecisionDependencies(child.item!.decisionId, 60, 60)).toHaveLength(1);
    const blocked = getDecisionItem(child.item!.decisionId, 60, 60)!;
    expect(blocked.dependsOnDecisionIds).toEqual([parent.item!.decisionId]);
    expect(blocked.blockedByDecisionIds).toEqual([parent.item!.decisionId]);
    await expect(performDecisionAction(child.item!.decisionId, 'approve_script', 60, 60, {
      idempotencyKey: 'blocked-child-action',
    })).rejects.toThrow(/blocking decision/i);

    testDb.prepare(`UPDATE notification_center_items SET status = 'actioned' WHERE item_id = ?`).run(parent.item!.decisionId);
    const unblocked = getDecisionItem(child.item!.decisionId, 60, 60)!;
    expect(unblocked.blockedByDecisionIds).toHaveLength(0);
    const result = await performDecisionAction(child.item!.decisionId, 'approve_script', 60, 60, {
      idempotencyKey: 'unblocked-child-action',
    });
    expect(result.status).toBe('succeeded');
    const workflow = testDb.prepare(`SELECT approval_state FROM content_domain_objects WHERE id = ?`).get(object.id) as { approval_state: string };
    expect(workflow.approval_state).toBe('approved');
  });

  it('records a non-blocking typed dependency (conflicts_with) without blocking the action (C6)', async () => {
    const parent = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 62, { tenantId: 62, dedupeKey: 'c6-conflict-parent' }));
    const { created: child } = await createContentApprovalDecision(62, 62, 'c6-conflict-child');

    addDecisionDependency({
      decisionId: child.item!.decisionId,
      dependsOnDecisionId: parent.item!.decisionId,
      userId: 62,
      tenantId: 62,
      relationship: 'conflicts_with',
    });

    // The relationship IS recorded and surfaced as a dependency edge...
    expect(listDecisionDependencies(child.item!.decisionId, 62, 62)).toHaveLength(1);
    const item = getDecisionItem(child.item!.decisionId, 62, 62)!;
    expect(item.dependsOnDecisionIds).toEqual([parent.item!.decisionId]);
    // ...but conflicts_with is advisory, so the (still-unresolved) parent does NOT block the action.
    expect(item.blockedByDecisionIds).toHaveLength(0);
    const result = await performDecisionAction(child.item!.decisionId, 'approve_script', 62, 62, {
      idempotencyKey: 'c6-conflict-action',
    });
    expect(result.status).toBe('succeeded');
  });

  it('treats blocked_by as a display-only inverse label that does NOT block — only a forward blocks edge blocks (C6)', async () => {
    const blocker = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 63, { tenantId: 63, dedupeKey: 'c6-blockedby-blocker' }));
    const { created: subject } = await createContentApprovalDecision(63, 63, 'c6-blockedby-subject');

    // A caller who (mistakenly) writes a lone blocked_by edge expecting `subject` to be blocked...
    addDecisionDependency({
      decisionId: subject.item!.decisionId,
      dependsOnDecisionId: blocker.item!.decisionId,
      userId: 63,
      tenantId: 63,
      relationship: 'blocked_by',
    });

    const item = getDecisionItem(subject.item!.decisionId, 63, 63)!;
    expect(item.dependsOnDecisionIds).toEqual([blocker.item!.decisionId]);
    expect(item.blockedByDecisionIds).toHaveLength(0); // ...gets a non-block: blocked_by is advisory by design
    const result = await performDecisionAction(subject.item!.decisionId, 'approve_script', 63, 63, {
      idempotencyKey: 'c6-blockedby-action',
    });
    expect(result.status).toBe('succeeded'); // the action proceeds — the forward 'blocks' edge is what blocks
  });

  it('surfaces typed relationships[] on the API item with raw type + semantic kind + label (C6)', async () => {
    const subject = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 64, { tenantId: 64, dedupeKey: 'c6-rel-subject' }));
    const blocker = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 64, { tenantId: 64, dedupeKey: 'c6-rel-blocker' }));
    const peer = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 64, { tenantId: 64, dedupeKey: 'c6-rel-peer' }));

    addDecisionDependency({ decisionId: subject.item!.decisionId, dependsOnDecisionId: blocker.item!.decisionId, userId: 64, tenantId: 64, relationship: 'blocks' });
    addDecisionDependency({ decisionId: subject.item!.decisionId, dependsOnDecisionId: peer.item!.decisionId, userId: 64, tenantId: 64, relationship: 'conflicts_with' });

    const item = getDecisionItem(subject.item!.decisionId, 64, 64)!;
    expect(item.relationships).toHaveLength(2);
    const byType = Object.fromEntries(item.relationships.map((r) => [r.type, r]));
    expect(byType.blocks).toMatchObject({ decisionId: blocker.item!.decisionId, kind: 'prevents_action', label: 'Blocks' });
    expect(byType.conflicts_with).toMatchObject({ decisionId: peer.item!.decisionId, kind: 'warns', label: 'Conflicts with' });
  });

  it('supersedes content decisions when approval resolves outside Decision Center', async () => {
    const { object, created } = await createContentApprovalDecision(61, 61, 'content-supersession');
    testDb.prepare(`
      UPDATE content_domain_objects
         SET production_state = 'approved', lifecycle_state = 'approved',
             artifact_phase = 'final', editorial_state = 'approved',
             approval_state = 'approved', approved_at = datetime('now'),
             workflow_version = workflow_version + 1
       WHERE id = ?
    `).run(object.id);

    const result = runDecisionSourceStateSupersessionJob({ userId: 61, tenantId: 61 });

    expect(result.supersededCount).toBe(1);
    expect(result.reasons.content_approval_resolved_elsewhere).toBe(1);
    expect(getDecisionItem(created.item!.decisionId, 61, 61)?.status).toBe('superseded');
    const handled = testDb.prepare(`
      SELECT title, action_taken, privacy_classification, explanation_json
      FROM handled_by_nexus_items
      WHERE decision_id = ?
    `).get(created.item!.decisionId) as { title: string; action_taken: string; privacy_classification: string; explanation_json: string };
    expect(handled).toMatchObject({
      title: 'Content review',
      action_taken: 'auto_dismiss_stale_decision',
      privacy_classification: 'private_content',
    });
    const explanation = JSON.parse(handled.explanation_json);
    expect(explanation.result).toContain('no longer asks');
    expect(explanation.nextStep).toContain('No action');
  });

  it('supersedes Secretary conflict decisions when the agenda item is resolved elsewhere', async () => {
    ensureSecretaryAgendaFixtureTables();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, version, title, start_at, end_at,
        duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-61', 'intent-61', 'training', 'long_run', 'reschedule_this',
        'session-61', 'training_session', 61, '61',
        'proposed', 'not_synced', 1, 'Move long run',
        '2026-05-11T08:00:00.000Z', '2026-05-11T10:00:00.000Z',
        120, 'deferred', '[]', 'Needs user approval',
        'hash-61', '[]', datetime('now'), datetime('now')
      )
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 61, {
      relatedEntityId: 'agenda-61',
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: 'secretary:supersession',
      actionButtons: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      decisionContext: {
        currentStartAt: '2026-05-12T08:00:00.000Z',
        currentEndAt: '2026-05-12T10:00:00.000Z',
        recommendedStartAt: '2026-05-13T08:00:00.000Z',
        recommendedEndAt: '2026-05-13T10:00:00.000Z',
      },
    }));
    testDb.prepare(`UPDATE secretary_agenda_items SET lifecycle_state = 'scheduled' WHERE agenda_item_id = 'agenda-61'`).run();

    const result = runDecisionSourceStateSupersessionJob({ userId: 61, tenantId: 61 });

    expect(result.supersededCount).toBe(1);
    expect(result.reasons.calendar_conflict_resolved_elsewhere).toBe(1);
    expect(getDecisionItem(created.item!.decisionId, 61, 61)?.status).toBe('superseded');
  });

  it('supersedes missing race date decisions after a manual training profile update', async () => {
    testDb.exec(readFileSync('migrations/023_onboarding.sql', 'utf8'));
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 62, {
      relatedEntityId: 'triathlon-running',
      relatedEntityType: 'training_profile',
      title: 'Training plan needs race date',
      body: 'Add a race date before plan generation.',
      dedupeKey: 'training:race-date-supersession',
    }));
    testDb.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data)
      VALUES (62, 'triathlon-running', ?)
    `).run(JSON.stringify({ target_race_date: '2026-10-18' }));

    const result = runDecisionSourceStateSupersessionJob({ userId: 62, tenantId: 62 });

    expect(result.supersededCount).toBe(1);
    expect(result.reasons.training_race_date_added_elsewhere).toBe(1);
    expect(getDecisionItem(created.item!.decisionId, 62, 62)?.status).toBe('superseded');
  });

  it('supersedes finance payment decisions when the tax event was paid elsewhere', async () => {
    ensureFinanceFixtureTables();
    testDb.prepare(`
      INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due, status, darf_code)
      VALUES (62, 62, '2026-04', 5000, 0, 5000, 450, 0, 'pending', '0190')
    `).run();
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('finance', 62, {
      type: 'decision_required',
      requiresUserAction: true,
      relatedEntityId: '2026-04',
      relatedEntityType: 'finance_tax_event',
      actionButtons: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary' }],
      dedupeKey: 'finance:tax-payment:supersession',
    }));
    testDb.prepare(`
      UPDATE finance_tax_events
         SET status = 'paid', paid_at = datetime('now')
       WHERE tenant_id = 62 AND user_id = 62 AND month = '2026-04'
    `).run();

    const result = runDecisionSourceStateSupersessionJob({ userId: 62, tenantId: 62 });

    expect(result.supersededCount).toBe(1);
    expect(result.reasons.finance_payment_resolved_elsewhere).toBe(1);
    expect(getDecisionItem(created.item!.decisionId, 62, 62)?.status).toBe('superseded');
  });

  it('does NOT supersede a training decision via free-text "race date" when its recipe is not missing-race-date (F1 hardening)', async () => {
    testDb.exec(readFileSync('migrations/023_onboarding.sql', 'utf8'));
    // A non-race-date RECIPE (dedupeKey) whose injected TITLE/BODY nonetheless mentions "race date" —
    // and crucially NOT a 'training_profile' relatedEntityType, so the clean structured path can't fire.
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 92, {
      title: 'Your readiness is low before your race date',
      body: 'race date race date race date',
      dedupeKey: 'training:readiness-low:92',
    }));
    // A real race date IS present — under the old free-text match this would wrongly supersede the decision.
    testDb.prepare(`INSERT INTO user_profiles (user_id, profile_type, data) VALUES (92, 'triathlon-running', ?)`)
      .run(JSON.stringify({ target_race_date: '2026-10-18' }));

    const result = runDecisionSourceStateSupersessionJob({ userId: 92, tenantId: 92 });

    expect(result.reasons.training_race_date_added_elsewhere ?? 0).toBe(0); // recipe-gated: injected text is ignored
    expect(getDecisionItem(created.item!.decisionId, 92, 92)?.status).not.toBe('superseded'); // not hidden
  });

  it('can replay migration 119 without duplicate-column failures', () => {
    const sql = readFileSync('migrations/119_decision_center_facade.sql', 'utf8');
    expect(() => {
      testDb.exec(sql);
      testDb.exec(sql);
    }).not.toThrow();
  });

  it('fails closed on a partially applied Decision flow schema without mutating legacy data', () => {
    testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, created_at
      ) VALUES ('partial-schema-item', 'partial-schema-intent', 71, 71,
        'Retained decision', 'Retained body', 'Retained body',
        'secretary', 'decision_required', 'active', 'unread', datetime('now'))
    `).run();
    testDb.exec(`
      DROP TABLE decision_flow_preferences;
      DROP TABLE decision_conflict_evaluations;
      ALTER TABLE decision_action_executions DROP COLUMN recovery_json;
    `);

    let readinessError: unknown;
    try {
      ensureDecisionCenterTables();
    } catch (error) {
      readinessError = error;
    }
    expect(readinessError).toMatchObject({
      code: 'DECISION_REPOSITORY_NOT_READY',
      status: 500,
    });

    expect(testDb.prepare(`
      SELECT title FROM notification_center_items WHERE item_id = 'partial-schema-item'
    `).get()).toEqual({ title: 'Retained decision' });
    expect(testDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_flow_preferences'
    `).get()).toBeUndefined();
    expect(testDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_conflict_evaluations'
    `).get()).toBeUndefined();
    const executionColumns = testDb.prepare('PRAGMA table_info(decision_action_executions)').all() as Array<{ name: string }>;
    expect(executionColumns.map((column) => column.name)).not.toContain('recovery_json');
  });

  it('logs unexpected action failures without serializing original messages', () => {
    const source = readFileSync('src/services/decision-center/command-service.ts', 'utf8');
    expect(source).toContain("'Decision action failed'");
    expect(source).toContain('logger.error');
    expect(source).toContain('originalCode');
    expect(source).toContain('originalErrorLogged');
    expect(source).not.toContain('originalMessage:');
    expect(source).toContain('const failureOutcome = markExecutionFailed(');
    expect(source).toContain('claimed.execution.action_execution_id,\n      userId,\n      tenantId,\n      error.code,\n      error.details,');

    const apiRoute = readFileSync('src/api/routes/decisions.ts', 'utf8');
    const portalRoute = readFileSync('src/portal/decision-center-routes.ts', 'utf8');
    expect(apiRoute).toContain('sanitizeDecisionErrorDetails(err.details)');
    expect(portalRoute).toContain('sanitizeDecisionErrorDetails(err.details)');
    expect(apiRoute).toContain("key === 'originalMessage'");
    expect(portalRoute).toContain("key === 'originalMessage'");
  });
});

describe('Decision Center expiry (A1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
    delete process.env.DECISION_FEEDBACK_SUPPRESSION_ENABLED;
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  const PAST = '2020-01-01T00:00:00.000Z';   // before fake clock AND real wall clock
  const FUTURE = '2999-01-01T00:00:00.000Z'; // after fake clock AND real wall clock
  const setExpiry = (decisionId: string, expiresAt: string) =>
    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?').run(expiresAt, decisionId);
  const setSnoozedUntil = (decisionId: string, snoozedUntil: string | null) =>
    testDb.prepare("UPDATE notification_center_items SET status = 'snoozed', snoozed_until = ? WHERE item_id = ?").run(snoozedUntil, decisionId);
  const statusOf = (decisionId: string) =>
    (testDb.prepare('SELECT status FROM notification_center_items WHERE item_id = ?').get(decisionId) as { status: string }).status;
  it('hides past-deadline decisions from the list and overview while keeping future-deadline ones', async () => {
    const expired = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 50, { dedupeKey: 'a1-expired' }));
    const active = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 50, { dedupeKey: 'a1-active' }));
    setExpiry(expired.item!.decisionId, PAST);
    setExpiry(active.item!.decisionId, FUTURE);

    const listed = listDecisionItems(50, 50, { status: 'all', limit: 80 }).map((i) => i.decisionId);
    expect(listed).toContain(active.item!.decisionId);
    expect(listed).not.toContain(expired.item!.decisionId);

    const overviewIds = getDecisionOverview(50, 50).items.map((i) => i.decisionId);
    expect(overviewIds).toContain(active.item!.decisionId);
    expect(overviewIds).not.toContain(expired.item!.decisionId);
  });

  it('applies expiry and snooze predicates before SQL LIMIT so stale rows cannot starve active rows', async () => {
    const active = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 54, { dedupeKey: 'a1-limit-active' }));
    setExpiry(active.item!.decisionId, FUTURE);
    for (let i = 0; i < 8; i += 1) {
      const expired = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 54, { dedupeKey: `a1-limit-expired-${i}` }));
      setExpiry(expired.item!.decisionId, PAST);
    }

    const limited = listDecisionItems(54, 54, { status: 'all', limit: 1 });

    expect(limited.map((item) => item.decisionId)).toEqual([active.item!.decisionId]);
  });

  it('uses materialized priority_score in the SQL window and refreshes missing scores', async () => {
    const lowStored = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 57, {
      priority: 'passive', dedupeKey: 'rank-low-stored',
    }));
    const highStored = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 57, {
      priority: 'critical', dedupeKey: 'rank-high-stored',
    }));
    testDb.prepare('UPDATE notification_center_items SET priority_score = ? WHERE item_id = ?')
      .run(10, lowStored.item!.decisionId);
    testDb.prepare('UPDATE notification_center_items SET priority_score = ? WHERE item_id = ?')
      .run(95, highStored.item!.decisionId);

    const limited = listDecisionItems(57, 57, { status: 'all', limit: 1, maxLimit: 1, recordExposure: false });

    expect(limited.map((item) => item.decisionId)).toEqual([highStored.item!.decisionId]);

    testDb.prepare('UPDATE notification_center_items SET priority_score = NULL WHERE item_id = ?')
      .run(lowStored.item!.decisionId);
    listDecisionItems(57, 57, { status: 'all', limit: 20, recordExposure: false, materializePriorityScore: true });
    const refreshed = testDb.prepare('SELECT priority_score AS score FROM notification_center_items WHERE item_id = ?')
      .get(lowStored.item!.decisionId) as { score: number | null };
    expect(refreshed.score).toBeGreaterThan(0);
  });

  it('records exposure and materializes priority only for the returned page', async () => {
    const top = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 58, {
      priority: 'critical',
      dedupeKey: 'rank-page-top',
    }));
    const offPage = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 58, {
      priority: 'active',
      dedupeKey: 'rank-page-off-page',
    }));
    const allIds = [top.item!.decisionId, offPage.item!.decisionId];
    testDb.prepare('UPDATE notification_center_items SET priority_score = NULL WHERE item_id IN (?, ?)')
      .run(...allIds);

    const page = listDecisionItems(58, 58, { status: 'all', limit: 1, maxLimit: 20 });

    expect(page).toHaveLength(1);
    recordDecisionItemExposures(page);
    const renderedId = page[0].decisionId;
    const offPageId = allIds.find((id) => id !== renderedId)!;
    const scores = testDb.prepare(`
      SELECT item_id AS itemId, priority_score AS priorityScore
        FROM notification_center_items
       WHERE item_id IN (?, ?)
    `).all(...allIds) as Array<{ itemId: string; priorityScore: number | null }>;
    expect(Object.fromEntries(scores.map((row) => [row.itemId, row.priorityScore]))).toEqual({
      [renderedId]: expect.any(Number),
      [offPageId]: null,
    });
    expect(getDecisionLifecycleEvents(renderedId, 58, 58).map((event) => event.event)).toContain('surfaced');
    expect(getDecisionLifecycleEvents(offPageId, 58, 58).map((event) => event.event)).not.toContain('surfaced');
  });

  it('does not expose another user or tenant decision through an explicit exposure batch', async () => {
    const owner = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 62, {
      tenantId: 620,
      priority: 'active',
      dedupeKey: 'exposure-owner-only',
    }));
    const decisionId = owner.item!.decisionId;

    expect(recordDecisionItemExposuresByIds([decisionId], 63, 630)).toEqual({ recordedCount: 0 });
    expect(getDecisionLifecycleEvents(decisionId, 62, 620).map((event) => event.event))
      .not.toContain('surfaced');

    expect(recordDecisionItemExposuresByIds([decisionId], 62, 620)).toEqual({ recordedCount: 1 });
    expect(getDecisionLifecycleEvents(decisionId, 62, 620).map((event) => event.event))
      .toContain('surfaced');
  });

  it('records summary exposure and priority only for rendered preview items', async () => {
    const first = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 59, {
      priority: 'critical',
      dedupeKey: 'summary-page-first',
    }));
    const second = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 59, {
      priority: 'time_sensitive',
      dedupeKey: 'summary-page-second',
    }));
    const offPreview = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 59, {
      priority: 'active',
      dedupeKey: 'summary-page-off-preview',
    }));
    const allIds = [first.item!.decisionId, second.item!.decisionId, offPreview.item!.decisionId];
    testDb.prepare('UPDATE notification_center_items SET priority_score = NULL WHERE item_id IN (?, ?, ?)')
      .run(...allIds);

    const summary = getDecisionSummary(59, 59, 2);

    expect(summary.previewItems).toHaveLength(2);
    recordDecisionItemExposures(summary.previewItems);
    const renderedIds = new Set(summary.previewItems.map((item) => item.decisionId));
    const offPreviewId = allIds.find((id) => !renderedIds.has(id))!;
    const scores = testDb.prepare(`
      SELECT item_id AS itemId, priority_score AS priorityScore
        FROM notification_center_items
       WHERE item_id IN (?, ?, ?)
    `).all(...allIds) as Array<{ itemId: string; priorityScore: number | null }>;
    const byId = Object.fromEntries(scores.map((row) => [row.itemId, row.priorityScore]));
    for (const renderedId of renderedIds) {
      expect(byId[renderedId]).toEqual(expect.any(Number));
      expect(getDecisionLifecycleEvents(renderedId, 59, 59).map((event) => event.event)).toContain('surfaced');
    }
    expect(byId[offPreviewId]).toBeNull();
    expect(getDecisionLifecycleEvents(offPreviewId, 59, 59).map((event) => event.event)).not.toContain('surfaced');
  });

  it('does not expose or materialize type-suppressed summary decisions', async () => {
    const suppressed = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 60, {
      priority: 'active',
      dedupeKey: 'summary-suppressed',
    }));
    testDb.prepare('UPDATE notification_center_items SET priority_score = NULL WHERE item_id = ?')
      .run(suppressed.item!.decisionId);
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    suppressDecisionType(60, 60, suppressed.item!.sourceSkill, suppressed.item!.type, 'dont_show_type');

    const summary = getDecisionSummary(60, 60, 2);

    expect(summary.openCount).toBe(1);
    expect(summary.previewItems).toEqual([]);
    const score = (testDb.prepare('SELECT priority_score AS priorityScore FROM notification_center_items WHERE item_id = ?')
      .get(suppressed.item!.decisionId) as { priorityScore: number | null }).priorityScore;
    expect(score).toBeNull();
    expect(getDecisionLifecycleEvents(suppressed.item!.decisionId, 60, 60).map((event) => event.event)).not.toContain('surfaced');
  });

  it('records overview exposure and priority only for rendered rows', async () => {
    const first = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 61, {
      priority: 'critical',
      dedupeKey: 'overview-rendered-first',
    }));
    const second = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 61, {
      priority: 'time_sensitive',
      dedupeKey: 'overview-rendered-second',
    }));
    const third = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 61, {
      priority: 'active',
      dedupeKey: 'overview-rendered-third',
    }));
    const wideOnly = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 61, {
      priority: 'passive',
      dedupeKey: 'overview-wide-only',
    }));
    const allIds = [
      first.item!.decisionId,
      second.item!.decisionId,
      third.item!.decisionId,
      wideOnly.item!.decisionId,
    ];
    testDb.prepare('UPDATE notification_center_items SET priority_score = NULL WHERE item_id IN (?, ?, ?, ?)')
      .run(...allIds);

    const overview = getDecisionOverview(61, 61, { limit: 1, handledLimit: 0 });

    expect(overview.items).toHaveLength(1);
    expect(overview.summary.previewItems).toHaveLength(3);
    recordDecisionItemExposures([
      ...overview.items,
      ...overview.summary.previewItems,
    ]);
    const renderedIds = new Set([
      ...overview.items.map((item) => item.decisionId),
      ...overview.summary.previewItems.map((item) => item.decisionId),
    ]);
    const wideOnlyId = allIds.find((id) => !renderedIds.has(id))!;
    const scores = testDb.prepare(`
      SELECT item_id AS itemId, priority_score AS priorityScore
        FROM notification_center_items
       WHERE item_id IN (?, ?, ?, ?)
    `).all(...allIds) as Array<{ itemId: string; priorityScore: number | null }>;
    const byId = Object.fromEntries(scores.map((row) => [row.itemId, row.priorityScore]));
    for (const renderedId of renderedIds) {
      expect(byId[renderedId]).toEqual(expect.any(Number));
      expect(getDecisionLifecycleEvents(renderedId, 61, 61).map((event) => event.event)).toContain('surfaced');
    }
    expect(byId[wideOnlyId]).toBeNull();
    expect(getDecisionLifecycleEvents(wideOnlyId, 61, 61).map((event) => event.event)).not.toContain('surfaced');
  });

  it('treats expires_at equal to the app clock as expired on active reads', async () => {
    const nowExpired = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 55, { dedupeKey: 'a1-app-now' }));
    setExpiry(nowExpired.item!.decisionId, new Date(Date.now()).toISOString());

    expect(listDecisionItems(55, 55, { status: 'all', limit: 80 }).map((i) => i.decisionId)).not.toContain(nowExpired.item!.decisionId);
  });

  it('filters future snoozes before SQL LIMIT and resurfaces elapsed snoozes', async () => {
    const active = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 56, { dedupeKey: 'a1-snooze-active' }));
    const futureSnooze = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 56, { dedupeKey: 'a1-snooze-future' }));
    const elapsedSnooze = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 56, { dedupeKey: 'a1-snooze-elapsed' }));
    setSnoozedUntil(futureSnooze.item!.decisionId, FUTURE);
    setSnoozedUntil(elapsedSnooze.item!.decisionId, PAST);

    const ids = listDecisionItems(56, 56, { status: 'all', limit: 2 }).map((item) => item.decisionId);

    expect(ids).toContain(active.item!.decisionId);
    expect(ids).toContain(elapsedSnooze.item!.decisionId);
    expect(ids).not.toContain(futureSnooze.item!.decisionId);
  });

  it('treats a null expires_at as non-expiring (still surfaced)', async () => {
    const open = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 51, { dedupeKey: 'a1-null-expiry' }));
    setExpiry(open.item!.decisionId, null as unknown as string);
    const listed = listDecisionItems(51, 51, { status: 'all', limit: 80 }).map((i) => i.decisionId);
    expect(listed).toContain(open.item!.decisionId);
  });

  it('batch-expires past-deadline decisions, leaves future ones, and reports remaining', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 60, { dedupeKey: `a1-sweep-${i}` }));
      ids.push(created.item!.decisionId);
    }
    const future = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 60, { dedupeKey: 'a1-sweep-future' }));
    for (const id of ids) setExpiry(id, PAST);
    setExpiry(future.item!.decisionId, FUTURE);

    const result = runDecisionExpiryJob({ batchSize: 2, maxBatches: 20 });
    expect(result.expired).toBe(3);
    expect(result.remaining).toBe(0);
    expect(result.batches).toBe(2); // 3 rows at batchSize 2 → two passes

    for (const id of ids) expect(statusOf(id)).toBe('expired');
    expect(statusOf(future.item!.decisionId)).not.toBe('expired');
  });

  it('is idempotent on a clean sweep (no past-deadline rows → no-op)', async () => {
    const future = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 61, { dedupeKey: 'a1-clean' }));
    setExpiry(future.item!.decisionId, FUTURE);
    const result = runDecisionExpiryJob();
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.batches).toBe(0);
    expect(statusOf(future.item!.decisionId)).not.toBe('expired');
  });

  it('returns null from getDecisionItem detail for a past-deadline decision (list and detail agree)', async () => {
    const expired = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 52, { dedupeKey: 'a1-detail-expired' }));
    setExpiry(expired.item!.decisionId, PAST);
    expect(getDecisionItem(expired.item!.decisionId, 52, 52)).toBeNull();

    const active = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 53, { dedupeKey: 'a1-detail-active' }));
    setExpiry(active.item!.decisionId, FUTURE);
    expect(getDecisionItem(active.item!.decisionId, 53, 53)).not.toBeNull();
  });
});

describe('Decision Center quality-gate telemetry (C4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('records a gate event for BOTH passing and blocked decisions and exposes the distribution', async () => {
    const passed = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 70, { tenantId: 70, dedupeKey: 'c4-pass' }));
    expect(passed.item).not.toBeNull();

    const blocked = await createDecisionIntent({
      userId: 70,
      tenantId: 70,
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'active',
      title: 'Secretary',
      body: 'Secretary needs your attention.',
      actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
      requiresUserAction: true,
      privacyPolicy: 'standard',
      dedupeKey: 'c4-blocked',
    });
    expect(blocked.item).toBeNull();

    const recorded = (testDb.prepare('SELECT COUNT(*) AS n FROM decision_quality_gate_events WHERE user_id = ?').get(70) as { n: number }).n;
    expect(recorded).toBe(2); // pre-fix only the blocked one was recorded

    const metrics = getDecisionOutcomeMetrics(70, 70);
    expect(metrics.totalQualityGateEvents).toBe(2);
    expect(metrics.qualityGateByStatus.pass ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.genericBlockedCount).toBeGreaterThanOrEqual(1);
    // Rejection rate now uses gate events as the denominator (no double-counting outcomes).
    expect(metrics.genericBlockedRate).toBeCloseTo(metrics.genericBlockedCount / 2, 4);
  });

  it('does not inflate the gate denominator on deduped retries', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 71, { tenantId: 71, dedupeKey: 'c4-dedup' }));
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 71, { tenantId: 71, dedupeKey: 'c4-dedup' })); // same key → deduped
    const recorded = (testDb.prepare('SELECT COUNT(*) AS n FROM decision_quality_gate_events WHERE user_id = ?').get(71) as { n: number }).n;
    expect(recorded).toBe(1); // the deduped retry recorded no second gate event
    expect(getDecisionOutcomeMetrics(71, 71).totalQualityGateEvents).toBe(1);
  });
});

describe('Decision Center layered status (Foundation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
    ensureTrainingCommitmentFixtureTables();
    ensureSecretaryAgendaFixtureTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED;
    delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    clearScopedDecisionFlowFlags();
    vi.useRealTimers();
    testDb?.close();
  });

  const recOf = (over: Record<string, unknown> = {}) =>
    ({ status: 'unread', expiresAt: null, type: 'decision_required', snoozedUntil: null, ...over }) as unknown as Parameters<typeof computeEffectiveStatus>[0];
  const ctxOf = (over: { blocked?: string[]; safeToShow?: boolean; safeFrontend?: boolean; retryAvailable?: boolean } = {}) => ({
    dependencies: { blockedByDecisionIds: over.blocked ?? [] },
    logic: { quality: { safeToShowUser: over.safeToShow ?? true, safeForFrontendAction: over.safeFrontend ?? true } } as any,
    retryAvailable: over.retryAvailable,
  });
  const PAST = '2020-01-01T00:00:00.000Z';
  const FUTURE = '2999-01-01T00:00:00.000Z';

  it('computeEffectiveStatus honors the documented precedence', () => {
    expect(computeEffectiveStatus(recOf(), ctxOf())).toBe('needs_action');
    expect(computeEffectiveStatus(recOf({ expiresAt: PAST }), ctxOf())).toBe('expired');
    expect(computeEffectiveStatus(recOf({ status: 'expired' }), ctxOf())).toBe('expired');
    expect(computeEffectiveStatus(recOf({ status: 'superseded' }), ctxOf())).toBe('superseded');
    expect(computeEffectiveStatus(recOf({ status: 'dismissed' }), ctxOf())).toBe('dismissed');
    expect(computeEffectiveStatus(recOf({ status: 'actioned' }), ctxOf())).toBe('completed');
    expect(computeEffectiveStatus(recOf({ status: 'failed' }), ctxOf({ retryAvailable: true }))).toBe('failed_retryable');
    expect(computeEffectiveStatus(recOf({ status: 'failed' }), ctxOf({ retryAvailable: false }))).toBe('failed_terminal');
    expect(computeEffectiveStatus(recOf(), ctxOf({ safeToShow: false }))).toBe('unavailable');
    expect(computeEffectiveStatus(recOf({ status: 'snoozed', snoozedUntil: FUTURE }), ctxOf())).toBe('snoozed');
    expect(computeEffectiveStatus(recOf(), ctxOf({ blocked: ['d2'] }))).toBe('waiting_on_dependency');
    expect(computeEffectiveStatus(recOf({ type: 'sync_failure' }), ctxOf())).toBe('waiting_on_system');
    // precedence: expiry beats a blocking dependency
    expect(computeEffectiveStatus(recOf({ expiresAt: PAST }), ctxOf({ blocked: ['d2'] }))).toBe('expired');
  });

  it('computeActionEffectiveStatus folds capability + lifecycle gating', () => {
    const open = { id: 'open_detail', label: 'Open' } as any;   // implemented: true
    const retry = { id: 'retry', label: 'Retry' } as any;       // implemented: false
    expect(computeActionEffectiveStatus(recOf(), open, ctxOf()).effective).toBe('enabled');
    const retryState = computeActionEffectiveStatus(recOf(), retry, ctxOf());
    expect(retryState.effective).toBe('disabled_not_implemented');
    expect(retryState.implemented).toBe(false);
    expect(computeActionEffectiveStatus(recOf(), open, ctxOf({ safeFrontend: false })).effective).toBe('disabled_missing_details');
    expect(computeActionEffectiveStatus(recOf({ expiresAt: PAST }), open, ctxOf()).effective).toBe('disabled_expired');
    expect(computeActionEffectiveStatus(recOf({ status: 'actioned' }), open, ctxOf()).effective).toBe('disabled_already_actioned');
    expect(computeActionEffectiveStatus(recOf(), open, ctxOf({ blocked: ['d2'] })).effective).toBe('disabled_blocked_by_dependency');
  });

  it('A2: reframes an unwired sync-retry as a reconnect path only when the affordance is enabled', () => {
    const retry = { id: 'retry', label: 'Retry' } as any;          // implemented: false
    const open = { id: 'open_detail', label: 'Open' } as any;      // implemented: true
    const syncFailure = recOf({ type: 'sync_failure' });

    // OFF (default ctx has no reconnectAffordance) — byte-identical to today: disabled_not_implemented.
    expect(computeActionEffectiveStatus(syncFailure, retry, ctxOf()).effective).toBe('disabled_not_implemented');

    // ON — the unwired retry becomes a reconnect affordance carrying reconnect guidance (still disabled,
    // still implemented:false; the value just refines WHY, routing the client to connection settings).
    const onCtx = { ...ctxOf(), reconnectAffordance: true };
    const reconnect = computeActionEffectiveStatus(syncFailure, retry, onCtx);
    expect(reconnect.effective).toBe('disabled_requires_reconnect');
    expect(reconnect.implemented).toBe(false);
    expect(reconnect.capabilityReason).toMatch(/reconnect/i);

    // ON but NOT a sync_failure (an unwired retry on a different decision type) → unchanged.
    expect(computeActionEffectiveStatus(recOf({ type: 'decision_required' }), retry, onCtx).effective).toBe('disabled_not_implemented');

    // ON but a different (implemented) action on the same sync_failure → unaffected (still enabled).
    expect(computeActionEffectiveStatus(syncFailure, open, onCtx).effective).toBe('enabled');

    // Precedence preserved: the safeForFrontendAction gate is still checked before the !implemented branch,
    // so missing-details wins over the reconnect reframe (proves the reframe did not reorder the guards).
    expect(computeActionEffectiveStatus(syncFailure, retry, { ...ctxOf({ safeFrontend: false }), reconnectAffordance: true }).effective).toBe('disabled_missing_details');
  });

  it('hides unwired actions from both Notification Center and Decision Center proposals', async () => {
    const created = await createDecisionIntent({
      userId: 88,
      tenantId: 88,
      sourceSkill: 'secretary',
      type: 'decision_required',
      priority: 'active',
      relatedEntityId: 'capacity-2026-06-24',
      relatedEntityType: 'capacity_window',
      title: 'Overcapacity choice',
      body: 'A schedule window needs a priority choice.',
      actionButtons: [
        { id: 'choose_priority', label: 'Choose priority', style: 'primary' },
        { id: 'open_detail', label: 'Open', style: 'secondary' },
      ],
      deeplink: 'nexus://decision-center/capacity-2026-06-24',
      dedupeKey: 'secretary:overcapacity:state-parity',
      requiresUserAction: true,
      decisionContext: {
        entityTitle: 'Wednesday schedule',
        sourceState: 'overcapacity',
        reasonCodes: ['overcapacity'],
      },
      privacyPolicy: 'standard',
    });
    expect(created.item?.actions.map((action) => action.id)).toEqual(['open_detail']);

    const notificationItem = listNotificationCenterItems(88, 88, { status: 'all' })[0];
    const decisionItem = getDecisionItem(created.item!.decisionId, 88, 88)!;
    expect(notificationItem.actions.map((action) => action.id)).toEqual(['open_detail']);
    expect(notificationItem.actionEffectiveStatuses?.some((state) => state.actionId === 'choose_priority')).toBe(false);
    expect(decisionItem.actions.map((action) => action.id)).toEqual(['open_detail']);
    expect(decisionItem.actionEffectiveStatuses.some((state) => state.actionId === 'choose_priority')).toBe(false);
  });

  it('maps legacy status to lifecycle + action outcome', () => {
    expect(legacyStatusToLifecycle('unread')).toBe('surfaced');
    expect(legacyStatusToLifecycle('read')).toBe('viewed');
    expect(legacyStatusToLifecycle('actioned')).toBe('completed');
    expect(legacyStatusToLifecycle('failed')).toBe('surfaced');
    expect(legacyStatusToLifecycle('mystery')).toBe('created');
    expect(actionOutcomeFromRecord(recOf({ status: 'actioned' }))).toBe('succeeded');
    expect(actionOutcomeFromRecord(recOf({ status: 'failed' }))).toBe('failed');
    expect(actionOutcomeFromRecord(recOf({ status: 'unread' }))).toBe('none');
  });

  it('classifies decisionKind and actionability', () => {
    const logic = { quality: { safeForFrontendAction: true, safeToShowUser: true } } as any;
    const deps = { blockedByDecisionIds: [] as string[] };
    const open = { id: 'open_detail', label: 'Open' } as any;  // implemented
    const retry = { id: 'retry', label: 'Retry' } as any;       // not implemented

    expect(computeDecisionKind(recOf({ requiresUserAction: false }), logic, deps, open)).toBe('insight');
    expect(computeDecisionKind(recOf({ requiresUserAction: true, type: 'sync_failure' }), logic, deps, open)).toBe('status_update');
    expect(computeDecisionKind(recOf({ requiresUserAction: true }), logic, { blockedByDecisionIds: ['d2'] }, open)).toBe('blocked_action');
    expect(computeDecisionKind(recOf({ requiresUserAction: true, sourceSkill: 'finance' }), logic, deps, open)).toBe('risk_alert');
    expect(computeDecisionKind(recOf({ requiresUserAction: true, type: 'approval_required' }), logic, deps, open)).toBe('choice_required');
    expect(computeDecisionKind(recOf({ requiresUserAction: true }), logic, deps, open)).toBe('action_proposal');
    expect(computeDecisionKind(recOf({ requiresUserAction: true }), logic, deps, retry)).toBe('recommendation');

    expect(computeActionability(recOf({ requiresUserAction: true }), logic, 'needs_action', open)).toBe('confirmation_required');
    expect(computeActionability(recOf({ requiresUserAction: true }), logic, 'waiting_on_dependency', open)).toBe('blocked');
    expect(computeActionability(recOf({ requiresUserAction: true }), logic, 'unavailable', open)).toBe('unavailable');
    expect(computeActionability(recOf({ requiresUserAction: true }), logic, 'expired', open)).toBe('read_only');
    expect(computeActionability(recOf({ requiresUserAction: true }), logic, 'needs_action', retry)).toBe('read_only');
    expect(computeActionability(recOf({ requiresUserAction: true }), { quality: { safeForFrontendAction: false } } as any, 'needs_action', open)).toBe('read_only');
  });

  it('ranks by multi-signal priority separate from confidence, with non-suppressible floors', () => {
    const base = {
      priority: 'active' as const, sourceSkill: 'content', type: 'decision_required',
      status: 'unread', deadlineSoon: false, riskLevel: 'low' as const, actionCount: 1, dependencyBlocked: false,
    };
    const later = rankDecisionPriority(base);
    expect(later.rankingVersion).toBe(1);

    // critical priority floors to critical
    expect(rankDecisionPriority({ ...base, priority: 'critical' }).priorityTier).toBe('critical');

    // finance + risk → non-suppressible floor, at least 'high'
    const fin = rankDecisionPriority({ ...base, sourceSkill: 'finance', riskLevel: 'medium' });
    expect(['high', 'critical']).toContain(fin.priorityTier);
    expect(fin.reasonCodes).toContain('floor_finance_risk');

    // connection-blocking (sync_failure) → at least 'high'
    const sync = rankDecisionPriority({ ...base, type: 'sync_failure' });
    expect(['high', 'critical']).toContain(sync.priorityTier);
    expect(sync.reasonCodes).toContain('floor_connection_blocking');

    // training high-risk safety floor tag present
    expect(rankDecisionPriority({ ...base, sourceSkill: 'training', riskLevel: 'high' }).reasonCodes).toContain('floor_training_safety');

    // higher cost-of-delay outranks at equal other signals; snooze penalizes
    expect(rankDecisionPriority({ ...base, deadlineSoon: true }).priorityScore).toBeGreaterThan(later.priorityScore);
    expect(rankDecisionPriority({ ...base, status: 'snoozed' }).priorityScore).toBeLessThan(later.priorityScore);
  });

  it('ranking-stability invariants compose on a real blocked item: visible-but-not-primary + floor is fatigue-exempt (plan §F)', async () => {
    // A dependency-blocked decision; the blocking parent stays unresolved.
    const parent = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 96, { tenantId: 96, dedupeKey: 'rankinv-parent' }));
    const { created: child } = await createContentApprovalDecision(96, 96, 'rankinv-child');
    addDecisionDependency({ decisionId: child.item!.decisionId, dependsOnDecisionId: parent.item!.decisionId, userId: 96, tenantId: 96 }); // forward `blocks` (default)

    const item = getDecisionItem(child.item!.decisionId, 96, 96)!;

    // "blocked never primary": a blocked decision is VISIBLE (not buried) yet its action is NOT a primary
    // actionable CTA. Ranking visibility and action actionability are INDEPENDENT axes — the floor keeps it
    // surfaced while the dependency keeps it un-actionable. A regression that conflated them would break here.
    expect(item.blockedByDecisionIds).toEqual([parent.item!.decisionId]);
    expect(item.effectiveStatus).toBe('waiting_on_dependency');
    expect(item.actionability).toBe('blocked'); // never confirmation_required/execute_with_undo while blocked
    expect(item.prioritySnapshot?.reasonCodes).toContain('floor_connection_blocking'); // floored visible — not buried

    // policy-floored alerts are fatigue-suppression-EXEMPT (never dropped under "More"/per-domain caps).
    expect(isDecisionItemPolicyFloored(item)).toBe(true);
  });

  it('promotes confidence to an evidence-strength explanation with privacy-gated basis', () => {
    const why = { facts: ['Exact calendar conflict', 'Task due tomorrow'], preferences: [], rules: ['Protect rest window'], tradeoffs: [], uncertainty: ['No fatigue data'] } as any;
    const exposed = computeConfidenceExplanation(0.823, why, { confidenceLabel: 'high', sourceFreshness: 'fresh' }, true);
    expect(exposed.label).toBe('high');
    expect(exposed.value).toBe(0.82);
    expect(exposed.sourceFreshness).toBe('fresh');
    expect(exposed.basis).toEqual(expect.arrayContaining(['Exact calendar conflict', 'Protect rest window']));
    expect(exposed.uncertainty).toContain('No fatigue data');

    // privacy-gated: basis/uncertainty suppressed when evidence is not exposable; label/freshness still shipped
    const gated = computeConfidenceExplanation(0.4, why, { confidenceLabel: 'low', sourceFreshness: 'stale' }, false);
    expect(gated.basis).toEqual([]);
    expect(gated.uncertainty).toEqual([]);
    expect(gated.label).toBe('low');
    expect(gated.sourceFreshness).toBe('stale');
  });

  it('exposes the layered fields (additive) on a real API item without breaking v1 fields', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 90, { dedupeKey: 'fnd-api' }));
    const item = getDecisionItem(created.item!.decisionId, 90, 90)!;
    expect(item.lifecycleStatus).toBe('surfaced');
    expect(item.effectiveStatus).toBe('needs_action');
    expect(item.actionOutcomeStatus).toBe('none');
    expect(Array.isArray(item.actionEffectiveStatuses)).toBe(true);
    expect(item.actionEffectiveStatuses!.length).toBeGreaterThan(0);
    expect(item.reviewSupported).toBe(false);
    expect(item.editableProposalFields).toEqual([]);
    // v1 fields still present/unchanged
    expect(typeof item.status).toBe('string');
    expect(item.frontendActionState).toBeDefined();
    expect(item.displayMode).toBeDefined();
  });

  it('does not advertise a successful refresh for a legacy item without a normalized source contract', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 91, { tenantId: 91, dedupeKey: 'refresh-1' }));
    expect(created.item!.refreshSupported).toBe(false);
    let refreshError: unknown;
    try { refreshDecisionItem(created.item!.decisionId, 91, 91); } catch (error) { refreshError = error; }
    expect(refreshError).toMatchObject({ code: 'DECISION_REFRESH_NOT_SUPPORTED' });
    // unknown / wrong-scope decision -> null (no throw).
    expect(refreshDecisionItem('nc_does_not_exist', 91, 91)).toBeNull();
    expect(refreshDecisionItem(created.item!.decisionId, 999, 999)).toBeNull(); // wrong user scope
  });

  it('retires an elapsed material context instead of reporting a successful no-op refresh', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_916 = 'active';
    try {
      const action = buildNormalizedDecisionAction({
        intent: 'review_elapsed_context',
        targetEntities: [{ type: 'task', id: 'task-expired-context', version: '1' }],
        affectedResources: [{ type: 'task_store', id: 'primary' }],
        preconditions: [],
        expectedEffects: [{ type: 'review_required', targetRef: 'task:task-expired-context' }],
        prohibitedEffects: [],
        dependencies: [],
        exclusivityKeys: ['task_store:916:task-expired-context'],
        authorizationScope: ['decision_center:read'],
        risk: 'low',
        reversibility: 'reversible',
        contextVersion: 'ctx_elapsed_refresh',
      });
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 916, {
        tenantId: 916,
        dedupeKey: 'elapsed-refresh-context',
        decisionContext: {
          entityTitle: 'Elapsed proposal',
          normalizedAction: action,
          contextExpiresAt: '2026-05-09T10:00:00.000Z',
        },
      }));

      const refreshed = refreshDecisionItem(created.item!.decisionId, 916, 916)!.item;

      expect(refreshed.status).toBe('expired');
      expect(refreshed.decisionState).toBe('expired');
      expect(refreshed.refreshSupported).toBe(false);
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_916;
    }
  });

  it('preserves approval and record version when active refresh finds no material context change', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_911 = 'active';
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    try {
      const action = buildNormalizedDecisionAction({
        intent: 'review_task_priority',
        targetEntities: [{ type: 'task', id: 'task-refresh-stable', version: '1' }],
        affectedResources: [{ type: 'task_store', id: 'primary' }],
        preconditions: [],
        expectedEffects: [{ type: 'review_required', targetRef: 'task:task-refresh-stable' }],
        prohibitedEffects: [],
        dependencies: [],
        exclusivityKeys: ['task_store:911:task-refresh-stable'],
        authorizationScope: ['decision_center:read'],
        risk: 'low',
        reversibility: 'reversible',
        contextVersion: 'ctx_refresh_stable',
      });
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 911, {
        tenantId: 911,
        dedupeKey: 'refresh-stable',
        decisionContext: { entityTitle: 'Task priority', normalizedAction: action },
      }));
      const approved = reviewDecision(created.item!.decisionId, 911, 911, {
        outcome: 'approve',
        expectedVersion: created.item!.recordVersion,
        idempotencyKey: 'approve-refresh-stable',
      });

      const refreshOptions = {
        idempotencyKey: 'refresh-stable-journal-1',
        expectedVersion: approved.recordVersion,
        contextVersion: approved.contextVersion,
        channel: 'rest',
      } as const;
      const first = refreshDecisionItem(created.item!.decisionId, 911, 911, refreshOptions)!;
      const replay = refreshDecisionItem(created.item!.decisionId, 911, 911, refreshOptions)!;
      const refreshed = first.item;

      expect(refreshed.decisionState).toBe('approved');
      expect(refreshed.recordVersion).toBe(approved.recordVersion);
      expect(refreshed.contextVersion).toBe(approved.contextVersion);
      expect(replay.refreshedAt).toBe(first.refreshedAt);
      expect(replay.item.recordVersion).toBe(first.item.recordVersion);
      const receipts = testDb.prepare(`
        SELECT metadata_json AS metadataJson
          FROM decision_lifecycle_events
         WHERE decision_id = ? AND user_id = 911 AND tenant_id = 911
           AND event = 'verified' AND action_id = 'refresh'
      `).all(created.item!.decisionId) as Array<{ metadataJson: string }>;
      expect(receipts).toHaveLength(1);
      expect(JSON.parse(receipts[0].metadataJson)).toMatchObject({
        refreshedAt: first.refreshedAt,
        commandContract: {
          schemaVersion: 'decision_mutation_command@1.0.0',
          operation: 'refresh',
          idempotencyKey: 'refresh-stable-journal-1',
          scope: { userId: 911, tenantId: 911 },
          recordVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
          readback: { verifierId: 'decision.context_version' },
        },
      });
      expect(() => refreshDecisionItem(created.item!.decisionId, 911, 911, {
        ...refreshOptions,
        expectedVersion: approved.recordVersion + 1,
      })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_911;
    }
  });

  it('retains a persisted external-calendar comparison when refresh cannot reconstruct it from local tables', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_914 = 'active';
    try {
      const candidate = buildNormalizedDecisionAction({
        intent: 'review_calendar_conflict',
        targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda-external-refresh', version: '1' }],
        affectedResources: [{ type: 'calendar_day', id: 'primary:2026-05-11' }],
        requestedWindow: { start: '2026-05-11T08:00:00.000Z', end: '2026-05-11T09:00:00.000Z', timezone: 'UTC' },
        preconditions: [],
        expectedEffects: [{ type: 'review_required', targetRef: 'secretary_agenda_item:agenda-external-refresh' }],
        prohibitedEffects: [{ type: 'automatic_calendar_mutation', targetRef: 'secretary_agenda_item:agenda-external-refresh' }],
        dependencies: [],
        exclusivityKeys: ['calendar_timeline:914:2026-05-11'],
        authorizationScope: ['decision_center:read'],
        risk: 'medium',
        reversibility: 'reversible',
        contextVersion: 'ctx_external_refresh',
      });
      const external = {
        action: buildNormalizedDecisionAction({
          intent: 'preserve_confirmed_calendar_commitment',
          targetEntities: [{ type: 'calendar_event', id: 'opaque-external-event' }],
          affectedResources: [{ type: 'calendar_day', id: 'primary:2026-05-11' }],
          requestedWindow: { start: '2026-05-11T08:30:00.000Z', end: '2026-05-11T09:30:00.000Z', timezone: 'UTC' },
          preconditions: [],
          expectedEffects: [{ type: 'preserve_commitment', targetRef: 'opaque-external-event' }],
          prohibitedEffects: [],
          dependencies: [],
          exclusivityKeys: ['calendar_timeline:914:2026-05-11'],
          authorizationScope: ['calendar:read'],
          risk: 'medium',
          reversibility: 'irreversible',
          contextVersion: 'ctx_external_refresh',
        }),
        authority: 'approved_commitment' as const,
        approved: true,
        createdAt: '2026-05-10T08:00:00.000Z',
        validUntil: '2026-05-11T09:30:00.000Z',
      };
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 914, {
        tenantId: 914,
        relatedEntityType: 'secretary_candidate',
        relatedEntityId: 'external-refresh-candidate',
        dedupeKey: 'external-refresh-comparison',
        decisionContext: {
          entityTitle: 'Secretary agenda item',
          currentStartAt: candidate.requestedWindow!.start,
          currentEndAt: candidate.requestedWindow!.end,
          contextExpiresAt: '2026-05-11T08:00:00.000Z',
          normalizedAction: candidate,
          conflictComparisons: [external],
          conflictEvaluation: evaluateDecisionConflicts({
            candidate,
            existing: [external],
            now: new Date('2026-05-10T10:00:00.000Z'),
          }),
        },
      }));

      const refreshed = refreshDecisionItem(created.item!.decisionId, 914, 914)!.item;
      expect(refreshed.conflictSummary?.disposition).toBe('needs_confirmation');
      expect(refreshed.conflictSummary?.reasonCodes).toContain('overlaps_approved_commitment');
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_914;
    }
  });

  it('never lets a producer soft-finding count replace a deterministic hard permission failure', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_915 = 'active';
    try {
      const candidate = buildNormalizedDecisionAction({
        intent: 'review_restricted_change',
        targetEntities: [{ type: 'task', id: 'restricted-task', version: '1' }],
        affectedResources: [{ type: 'task_store', id: 'primary' }],
        preconditions: [],
        expectedEffects: [{ type: 'review_required', targetRef: 'task:restricted-task' }],
        prohibitedEffects: [],
        dependencies: [],
        exclusivityKeys: ['task_store:915:restricted-task'],
        authorizationScope: ['unsupported:permission'],
        risk: 'low',
        reversibility: 'reversible',
        contextVersion: 'ctx_permission_precedence',
      });
      const comparison = {
        action: buildNormalizedDecisionAction({
          ...candidate,
          intent: 'preserve_task_state',
          targetEntities: [{ type: 'task', id: 'other-task', version: '1' }],
          contextVersion: 'ctx_permission_precedence',
        }),
        authority: 'configured_preference' as const,
        approved: false,
        createdAt: '2026-05-10T09:00:00.000Z',
      };
      const producerEvaluation = evaluateDecisionConflicts({
        candidate,
        existing: [comparison],
        authorizationAllowed: true,
        now: new Date('2026-05-10T10:00:00.000Z'),
      });
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 915, {
        tenantId: 915,
        dedupeKey: 'hard-permission-precedence',
        decisionContext: {
          entityTitle: 'Restricted proposal',
          normalizedAction: candidate,
          conflictComparisons: [comparison],
          conflictEvaluation: producerEvaluation,
        },
      }));

      expect(created.item?.decisionState).toBe('blocked');
      expect(created.item?.conflictSummary).toMatchObject({ disposition: 'block', severity: 'hard' });
      expect(created.item?.conflictSummary?.reasonCodes).toContain('authorization_or_policy_denied');
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_915;
    }
  });

  it('versions context and returns an approved decision to review when refresh finds a new conflict', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_912 = 'active';
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    try {
      const actionFor = (id: string, contextVersion: string) => buildNormalizedDecisionAction({
        intent: `review_task_priority_${id}`,
        targetEntities: [{ type: 'task', id, version: '1' }],
        affectedResources: [{ type: 'task_store', id: 'primary' }],
        preconditions: [],
        expectedEffects: [{ type: 'review_required', targetRef: `task:${id}` }],
        prohibitedEffects: [],
        dependencies: [],
        exclusivityKeys: ['task_store:912:priority'],
        authorizationScope: ['decision_center:read'],
        risk: 'low',
        reversibility: 'reversible',
        contextVersion,
      });
      const first = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 912, {
        tenantId: 912,
        dedupeKey: 'refresh-conflict-first',
        decisionContext: { entityTitle: 'First task priority', normalizedAction: actionFor('task-a', 'ctx_refresh_before') },
      }));
      const approved = reviewDecision(first.item!.decisionId, 912, 912, {
        outcome: 'approve',
        expectedVersion: first.item!.recordVersion,
        idempotencyKey: 'approve-refresh-conflict',
      });
      await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 912, {
        tenantId: 912,
        dedupeKey: 'refresh-conflict-second',
        decisionContext: { entityTitle: 'Second task priority', normalizedAction: actionFor('task-b', 'ctx_refresh_second') },
      }));

      const refreshed = refreshDecisionItem(first.item!.decisionId, 912, 912)!.item;

      expect(refreshed.decisionState).toBe('ready_for_review');
      expect(refreshed.recordVersion).toBe(approved.recordVersion + 1);
      expect(refreshed.contextVersion).not.toBe(approved.contextVersion);
      expect(refreshed.conflictSummary?.disposition).toBe('needs_confirmation');
    } finally {
      delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED_USER_912;
    }
  });
});

describe('Decision Center lifecycle events (SI-4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_LIFECYCLE_EVENTS_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  it('records an ordered lifecycle stream across create/view/dismiss/snooze', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 80, { dedupeKey: 'lc-1' }));
    const id = created.item!.decisionId;
    expect(getDecisionLifecycleEvents(id, 80, 80).map((e) => e.event)).toEqual(['created']);
    recordDecisionItemExposures([created.item!]);
    markDecisionViewed(id, 80, 80);
    dismissDecision(id, 80, 80);
    const events = getDecisionLifecycleEvents(id, 80, 80).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(['created', 'surfaced', 'detail_opened', 'viewed', 'dismissed']));
    expect(events[0]).toBe('created'); // append-only, ordered
    expect(events[1]).toBe('surfaced');

    const snoozeTarget = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 80, { dedupeKey: 'lc-snooze' }));
    snoozeDecision(snoozeTarget.item!.decisionId, 80, 80, 30);
    expect(getDecisionLifecycleEvents(snoozeTarget.item!.decisionId, 80, 80).map((e) => e.event)).toContain('snoozed');
  });

  it('records a versioned viewed command once across durable replay', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 805, {
      tenantId: 1805,
      dedupeKey: 'viewed-command-replay',
    }));
    const input = {
      idempotencyKey: 'viewed-command-replay-1',
      expectedVersion: created.item!.recordVersion,
      channel: 'rest',
    };

    const first = markDecisionViewed(created.item!.decisionId, 805, 1805, input);
    const replay = markDecisionViewed(created.item!.decisionId, 805, 1805, input);

    expect(first.recordVersion).toBe(created.item!.recordVersion! + 1);
    expect(replay.recordVersion).toBe(first.recordVersion);
    const events = testDb.prepare(`
      SELECT metadata_json AS metadataJson
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND event = 'viewed'
    `).all(created.item!.decisionId) as Array<{ metadataJson: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].metadataJson).commandContract).toMatchObject({
      operation: 'mark_viewed',
      idempotencyKey: 'viewed-command-replay-1',
      scope: { userId: 805, tenantId: 1805 },
      recordVersion: created.item!.recordVersion,
    });
    expect(() => markDecisionViewed(created.item!.decisionId, 805, 1805, {
      ...input,
      expectedVersion: first.recordVersion,
    })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 }));
  });

  it('records action lifecycle (previewed + started + succeeded + verified) and expiry', async () => {
    const d = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 81, {
      dedupeKey: 'lc-action',
      actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }, { id: 'dismiss', label: 'Not now', style: 'secondary' }],
    }));
    getDecisionItem(d.item!.decisionId, 81, 81);
    await performDecisionAction(d.item!.decisionId, 'open_detail', 81, 81, { idempotencyKey: 'lc-tap' });
    const actionEvents = getDecisionLifecycleEvents(d.item!.decisionId, 81, 81).map((e) => e.event);
    expect(actionEvents).toEqual(expect.arrayContaining(['action_previewed', 'action_started', 'action_succeeded', 'verified']));
    expect(actionEvents.indexOf('action_previewed')).toBeLessThan(actionEvents.indexOf('action_started'));

    const exp = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 81, { dedupeKey: 'lc-exp' }));
    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?').run('2020-01-01T00:00:00.000Z', exp.item!.decisionId);
    runDecisionExpiryJob();
    expect(getDecisionLifecycleEvents(exp.item!.decisionId, 81, 81).map((e) => e.event)).toContain('expired');
  });

  it('emits an unblocked lifecycle event when expiry clears the last blocking dependency', async () => {
    const blocker = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 83, { dedupeKey: 'lc-blocker' }));
    const dependent = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 83, { dedupeKey: 'lc-dependent' }));
    addDecisionDependency({
      decisionId: dependent.item!.decisionId,
      dependsOnDecisionId: blocker.item!.decisionId,
      userId: 83,
      tenantId: 83,
      relationship: 'blocks',
    });
    expect(getDecisionItem(dependent.item!.decisionId, 83, 83)?.blockedByDecisionIds).toEqual([blocker.item!.decisionId]);

    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?')
      .run('2020-01-01T00:00:00.000Z', blocker.item!.decisionId);
    runDecisionExpiryJob();

    const events = getDecisionLifecycleEvents(dependent.item!.decisionId, 83, 83);
    expect(events.some((event) => event.event === 'unblocked' && event.reason === 'blocker_expired')).toBe(true);
    const metadata = testDb.prepare(`
      SELECT metadata_json AS metadata
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND event = 'unblocked'
       LIMIT 1
    `).get(dependent.item!.decisionId) as { metadata: string };
    expect(JSON.parse(metadata.metadata)).toEqual({ blockerDecisionIds: [blocker.item!.decisionId] });
    expect(getDecisionItem(dependent.item!.decisionId, 83, 83)?.blockedByDecisionIds).toEqual([]);
  });

  it('does not re-emit expiry or unblocked lifecycle events when an expired action is retried', async () => {
    const blocker = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 84, { dedupeKey: 'lc-retry-blocker' }));
    const dependent = await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 84, { dedupeKey: 'lc-retry-dependent' }));
    addDecisionDependency({
      decisionId: dependent.item!.decisionId,
      dependsOnDecisionId: blocker.item!.decisionId,
      userId: 84,
      tenantId: 84,
      relationship: 'blocks',
    });
    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?')
      .run('2020-01-01T00:00:00.000Z', blocker.item!.decisionId);

    await expect(performDecisionAction(blocker.item!.decisionId, 'open_detail', 84, 84, { idempotencyKey: 'expired-retry-1' }))
      .rejects.toThrow(/expired/i);
    await expect(performDecisionAction(blocker.item!.decisionId, 'open_detail', 84, 84, { idempotencyKey: 'expired-retry-2' }))
      .rejects.toThrow(/expired/i);

    expect(getDecisionLifecycleEvents(blocker.item!.decisionId, 84, 84)
      .filter((event) => event.event === 'expired')).toHaveLength(1);
    expect(getDecisionLifecycleEvents(dependent.item!.decisionId, 84, 84)
      .filter((event) => event.event === 'unblocked' && event.reason === 'blocker_expired')).toHaveLength(1);
  });

  it('kill-switch (DECISION_LIFECYCLE_EVENTS_ENABLED=0) suppresses writes without throwing', async () => {
    process.env.DECISION_LIFECYCLE_EVENTS_ENABLED = '0';
    const d = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 82, { dedupeKey: 'lc-off' }));
    expect(getDecisionLifecycleEvents(d.item!.decisionId, 82, 82)).toEqual([]);
  });

  it('rolls up the day\'s lifecycle events into decision_metrics_daily (idempotent)', async () => {
    // Real timers so luxon (rollup default date) and SQLite datetime('now') (event timestamps) agree.
    vi.useRealTimers();
    const a = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 90, { tenantId: 90, dedupeKey: 'm-1' }));
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 90, { tenantId: 90, dedupeKey: 'm-2' }));
    dismissDecision(a.item!.decisionId, 90, 90);

    const r1 = runDecisionMetricsRollupJob();
    expect(r1.tenants).toBeGreaterThanOrEqual(1);
    const row = getDecisionMetricsDaily(90)!;
    expect(row.createdCount).toBe(2);
    expect(row.dismissedCount).toBe(1);

    // idempotent re-run does not double-count
    runDecisionMetricsRollupJob();
    const row2 = getDecisionMetricsDaily(90)!;
    expect(row2.createdCount).toBe(2);
    expect(row2.dismissedCount).toBe(1);
  });

  it.each([
    { userId: 901, tenantId: 1901, timezone: 'Europe/Lisbon', localDate: '2026-03-29' },
    { userId: 902, tenantId: 1902, timezone: 'America/Sao_Paulo', localDate: '2026-03-28' },
    { userId: 903, tenantId: 1903, timezone: 'America/Los_Angeles', localDate: '2026-03-28' },
  ])('rolls up the same instant into the account local day for $timezone', ({ userId, tenantId, timezone, localDate }) => {
    testDb.prepare(`
      INSERT INTO decision_lifecycle_events (
        event_id, decision_id, user_id, tenant_id, event, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'created', '{}', '2026-03-29 00:30:00')
    `).run(`local-day-${userId}`, `decision-${userId}`, userId, tenantId);

    expect(runDecisionMetricsRollupJob({ userId, tenantId, timezone, date: localDate }))
      .toEqual({ date: localDate, tenants: 1 });
    expect(getDecisionMetricsDaily(tenantId, { userId, timezone, date: localDate }))
      .toMatchObject({ metricDate: localDate, tenantId, createdCount: 1 });
  });

  it('does not let scoped users in one tenant overwrite each other\'s local-day metrics', () => {
    for (const [eventId, userId] of [['tenant-user-a-1', 920], ['tenant-user-b-1', 921], ['tenant-user-b-2', 921]] as const) {
      testDb.prepare(`
        INSERT INTO decision_lifecycle_events (
          event_id, decision_id, user_id, tenant_id, event, metadata_json, created_at
        ) VALUES (?, ?, ?, 1920, 'created', '{}', '2026-03-29 10:00:00')
      `).run(eventId, `decision-${eventId}`, userId);
    }

    runDecisionMetricsRollupJob({ userId: 920, tenantId: 1920, timezone: 'Europe/Lisbon', date: '2026-03-29' });
    runDecisionMetricsRollupJob({ userId: 921, tenantId: 1920, timezone: 'Europe/Lisbon', date: '2026-03-29' });

    expect(getDecisionMetricsDaily(1920, { userId: 920, timezone: 'Europe/Lisbon', date: '2026-03-29' }))
      .toMatchObject({ createdCount: 1, sourceSkill: '*' });
    expect(getDecisionMetricsDaily(1920, { userId: 921, timezone: 'Europe/Lisbon', date: '2026-03-29' }))
      .toMatchObject({ createdCount: 2, sourceSkill: '*' });
    expect(testDb.prepare(`
      SELECT source_skill AS sourceSkill, created_count AS createdCount
        FROM decision_metrics_daily
       WHERE tenant_id = 1920 AND metric_date = '2026-03-29'
       ORDER BY source_skill
    `).all()).toEqual([
      { sourceSkill: '@user:920:*', createdCount: 1 },
      { sourceSkill: '@user:921:*', createdCount: 2 },
    ]);
  });

  it('uses a 23-hour Lisbon DST window and a 25-hour Los Angeles fallback window', () => {
    const lisbon = decisionMetricsLocalDayWindow({ date: '2026-03-29', timezone: 'Europe/Lisbon' });
    const losAngeles = decisionMetricsLocalDayWindow({ date: '2026-11-01', timezone: 'America/Los_Angeles' });

    expect(Date.parse(lisbon.endUtc) - Date.parse(lisbon.startUtc)).toBe(23 * 60 * 60 * 1000);
    expect(Date.parse(losAngeles.endUtc) - Date.parse(losAngeles.startUtc)).toBe(25 * 60 * 60 * 1000);
  });

  it('release-gate status: clean by default, fails on unswept expired rows, passes after the sweep', async () => {
    expect(getDecisionReleaseGateStatus(95, 95)).toEqual({
      expiredButVisible: 0,
      unimplementedActionableCtas: 0,
      unsupportedNotificationActions: 0,
      deadDeeplinks: 0,
      badgeDrift: null,
      genericMutatingActionSuccesses: 0,
      apnsMutatingActionsExposed: 0,
      staleSourceVisibleInInbox: 0,
      unreconciledDeliveryAttempts: 0,
      deliveryOutcomeUnknownAttempts: 0,
      pass: true,
    });

    const d = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 95, { tenantId: 95, dedupeKey: 'gate-exp' }));
    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?').run('2020-01-01T00:00:00.000Z', d.item!.decisionId);
    const failing = getDecisionReleaseGateStatus(95, 95);
    expect(failing.expiredButVisible).toBe(1);
    expect(failing.pass).toBe(false);

    runDecisionExpiryJob();
    const passing = getDecisionReleaseGateStatus(95, 95);
    expect(passing.expiredButVisible).toBe(0);
    expect(passing.pass).toBe(true);
  });

  it('captures dismiss reason on the lifecycle event, normalized to the vocab (C3a)', async () => {
    const a = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 96, { dedupeKey: 'dr-1' }));
    dismissDecision(a.item!.decisionId, 96, 96, 'not_relevant');
    expect(getDecisionLifecycleEvents(a.item!.decisionId, 96, 96).find((e) => e.event === 'dismissed')?.reason).toBe('not_relevant');

    const b = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 96, { dedupeKey: 'dr-2' }));
    dismissDecision(b.item!.decisionId, 96, 96, 'some free-text the client should not be storing');
    expect(getDecisionLifecycleEvents(b.item!.decisionId, 96, 96).find((e) => e.event === 'dismissed')?.reason).toBe('other');

    const c = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 96, { dedupeKey: 'dr-3' }));
    dismissDecision(c.item!.decisionId, 96, 96);
    expect(getDecisionLifecycleEvents(c.item!.decisionId, 96, 96).find((e) => e.event === 'dismissed')?.reason).toBeNull();
  });

  it('aggregates per-skill feedback signals from the lifecycle stream incl. dismiss reasons (C3b)', async () => {
    // 3 training decisions surfaced through first get/list exposure; 2 dismissed (one with the strong "dont_show_type" signal,
    // one "not_relevant"); 1 left active. Aggregation is read-only and clock-independent.
    const a = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 97, { tenantId: 97, dedupeKey: 'fb-1' }));
    const b = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 97, { tenantId: 97, dedupeKey: 'fb-2' }));
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 97, { tenantId: 97, dedupeKey: 'fb-3' }));
    listDecisionItems(97, 97);
    dismissDecision(a.item!.decisionId, 97, 97, 'dont_show_type');
    dismissDecision(b.item!.decisionId, 97, 97, 'not_relevant');

    const signals = getDecisionFeedbackSignals(97, 97);
    const training = signals.find((s) => s.sourceSkill === 'training')!;
    expect(training).toBeDefined();
    expect(training.surfaced).toBe(3);
    expect(training.dismissed).toBe(2);
    expect(training.dismissRate).toBeCloseTo(0.6667, 3);
    expect(training.dontShowTypeCount).toBe(1); // strongest suppression signal surfaced explicitly
    expect(training.topDismissReasons).toEqual(
      expect.arrayContaining([
        { reason: 'dont_show_type', count: 1 },
        { reason: 'not_relevant', count: 1 },
      ]),
    );
  });

  it('guards dismissRate against missing creation events — never returns a rate > 1.0 (C3b)', async () => {
    const d = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 100, { tenantId: 100, dedupeKey: 'fb-norate' }));
    dismissDecision(d.item!.decisionId, 100, 100, 'not_relevant');
    // Simulate lifecycle tracking that began AFTER this decision was created (or post-retention
    // pruning): drop the exposure events so surfaced=0 while dismissed=1.
    testDb.prepare("DELETE FROM decision_lifecycle_events WHERE decision_id = ? AND event IN ('created', 'surfaced')").run(d.item!.decisionId);
    const training = getDecisionFeedbackSignals(100, 100).find((s) => s.sourceSkill === 'training')!;
    expect(training.surfaced).toBe(0);
    expect(training.dismissed).toBe(1);
    expect(training.dismissRate).toBe(0); // guarded — not the raw count (1.0), never > 1.0
  });

  it('respects the sinceDays decay window — older feedback excluded (C3b)', async () => {
    const recent = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 101, { tenantId: 101, dedupeKey: 'fb-recent' }));
    dismissDecision(recent.item!.decisionId, 101, 101, 'not_relevant');
    const { created: old } = await createContentApprovalDecision(101, 101, 'fb-old');
    dismissDecision(old.item!.decisionId, 101, 101, 'too_risky');
    // Back-date every 'content' event well outside a 7-day window. Both stored timestamps and the
    // window boundary use the SQLite clock, so this is deterministic under the suite's fake JS timers.
    testDb.prepare("UPDATE decision_lifecycle_events SET created_at = '2020-01-01T00:00:00.000Z' WHERE decision_id = ?").run(old.item!.decisionId);

    const windowed = getDecisionFeedbackSignals(101, 101, { sinceDays: 7 });
    expect(windowed.find((s) => s.sourceSkill === 'content')).toBeUndefined(); // outside the window
    expect(windowed.find((s) => s.sourceSkill === 'training')).toBeDefined();  // inside the window

    const allTime = getDecisionFeedbackSignals(101, 101);
    expect(allTime.find((s) => s.sourceSkill === 'content')).toBeDefined();    // no window => included
  });

  it('feedback signals are tenant-scoped (no cross-tenant bleed)', async () => {
    const mine = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 98, { tenantId: 98, dedupeKey: 'fb-mine' }));
    dismissDecision(mine.item!.decisionId, 98, 98, 'not_relevant');
    const other = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 99, { tenantId: 99, dedupeKey: 'fb-other' }));
    dismissDecision(other.item!.decisionId, 99, 99, 'too_risky');

    const mineSignals = getDecisionFeedbackSignals(98, 98);
    expect(mineSignals.reduce((n, s) => n + s.dismissed, 0)).toBe(1);
    expect(mineSignals.flatMap((s) => s.topDismissReasons.map((r) => r.reason))).not.toContain('too_risky');
  });

  it('swallows lifecycle event write failures without breaking the user action', async () => {
    const d = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 83, { dedupeKey: 'lc-failwrite' }));
    const before = getDecisionLifecycleEventWriteFailures();
    // Force every lifecycle-event INSERT to abort (survives ensureDecisionCenterTables' CREATE-IF-NOT-EXISTS).
    testDb.exec("CREATE TRIGGER force_lifecycle_fail BEFORE INSERT ON decision_lifecycle_events BEGIN SELECT RAISE(ABORT, 'forced'); END;");
    const item = dismissDecision(d.item!.decisionId, 83, 83); // emit fails internally; dismiss must still succeed
    expect(item.status).toBe('dismissed');
    expect(getDecisionLifecycleEventWriteFailures()).toBeGreaterThan(before);
  });
});

describe('Decision Center fatigue caps (C5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_CENTER_FATIGUE_CAPS_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  // Hand-built items: the helpers only read prioritySnapshot + sourceSkill, so a minimal cast is safe.
  const snap = (reasonCodes: string[], priorityTier: 'critical' | 'high' | 'normal' | 'low' = 'normal'): DecisionApiItem =>
    ({ sourceSkill: 'cooking', prioritySnapshot: { priorityTier, priorityScore: 0, reasonCodes, computedAt: 'x', rankingVersion: 1 } } as unknown as DecisionApiItem);
  const item = (sourceSkill: 'cooking' | 'secretary', floored = false): DecisionApiItem =>
    ({ sourceSkill, prioritySnapshot: { priorityTier: floored ? 'critical' : 'normal', priorityScore: 0, reasonCodes: floored ? ['floor_finance_risk'] : [], computedAt: 'x', rankingVersion: 1 } } as unknown as DecisionApiItem);

  it('isDecisionItemPolicyFloored detects every floor_* token + the critical-tier fallback, conservatively', () => {
    for (const t of ['floor_critical_deadline', 'floor_deadline_soon', 'floor_finance_risk', 'floor_connection_blocking', 'floor_training_safety']) {
      expect(isDecisionItemPolicyFloored(snap([t]))).toBe(true);
    }
    expect(isDecisionItemPolicyFloored(snap(['high_urgency', 'deadline_soon']))).toBe(false); // no floor_ prefix
    expect(isDecisionItemPolicyFloored(snap([], 'critical'))).toBe(true); // secondary tier guard
    expect(isDecisionItemPolicyFloored(snap([], 'high'))).toBe(false);
    expect(isDecisionItemPolicyFloored({ sourceSkill: 'cooking' } as unknown as DecisionApiItem)).toBe(false); // no snapshot => conservative
  });

  it('applyDecisionFatigueCaps splits primary/more and honors the visible cap', () => {
    const items = Array.from({ length: 30 }, () => item('secretary'));
    const { primaryItems, moreItems } = applyDecisionFatigueCaps(items, { visibleCap: 20, topPrimaryCount: 5, perDomainCap: 100 });
    expect(primaryItems).toHaveLength(5);
    expect(moreItems).toHaveLength(15);
    expect(primaryItems.length + moreItems.length).toBe(20); // visibleCap ceiling
  });

  it('applyDecisionFatigueCaps enforces perDomainCap so one noisy domain cannot crowd out others', () => {
    const items = [...Array.from({ length: 15 }, () => item('cooking')), ...Array.from({ length: 15 }, () => item('secretary'))];
    const all = (() => { const r = applyDecisionFatigueCaps(items, { visibleCap: 50, topPrimaryCount: 5, perDomainCap: 10 }); return [...r.primaryItems, ...r.moreItems]; })();
    expect(all.filter((i) => i.sourceSkill === 'cooking')).toHaveLength(10);
    expect(all.filter((i) => i.sourceSkill === 'secretary')).toHaveLength(10);
  });

  it('applyDecisionFatigueCaps: floored items bypass ALL caps and sit at the head in rank order', () => {
    const floored = Array.from({ length: 12 }, () => item('cooking', true));
    const regular = Array.from({ length: 25 }, () => item('secretary'));
    const { primaryItems, moreItems } = applyDecisionFatigueCaps([...floored, ...regular], { visibleCap: 20, topPrimaryCount: 5, perDomainCap: 10 });
    const all = [...primaryItems, ...moreItems];
    expect(all.filter((i) => isDecisionItemPolicyFloored(i))).toHaveLength(12); // all 12 survive both caps
    expect(all.slice(0, 12).every((i) => isDecisionItemPolicyFloored(i))).toBe(true); // floored at the head
  });

  it('applyDecisionFatigueCaps: empty + under-cap inputs pass through untouched', () => {
    expect(applyDecisionFatigueCaps([])).toEqual({ primaryItems: [], moreItems: [] });
    const r = applyDecisionFatigueCaps(Array.from({ length: 3 }, () => item('cooking')));
    expect(r.primaryItems.length + r.moreItems.length).toBe(3);
  });

  it('getDecisionOverview: OFF is unchanged; ON routes through the cap; floored decisions survive end-to-end', async () => {
    for (let i = 0; i < 25; i++) {
      await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 300, { tenantId: 300, dedupeKey: `cap-${i}` }));
    }
    // Training fixtures carry a now+24h deadline => floor_deadline_soon => floored seeds.
    for (let i = 0; i < 3; i++) {
      await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 300, { tenantId: 300, dedupeKey: `cap-floor-${i}` }));
    }
    const open = listDecisionItems(300, 300, { status: 'all', limit: 80 })
      .filter((i) => ['unread', 'read', 'snoozed', 'failed', 'open'].includes(i.status));
    // Precondition: cooking seeds are non-floored; training seeds are floored.
    expect(open.filter((i) => i.sourceSkill === 'cooking').some(isDecisionItemPolicyFloored)).toBe(false);
    const flooredIds = open.filter(isDecisionItemPolicyFloored).map((i) => i.decisionId);
    expect(flooredIds.length).toBe(3);

    const expected = applyDecisionFatigueCaps(open);
    const expectedIds = [...expected.primaryItems, ...expected.moreItems].slice(0, 80).map((i) => i.decisionId);

    const off = getDecisionOverview(300, 300, { limit: 80 });
    expect(off.items.length).toBe(open.length); // OFF == existing slice(0, limit) behavior
    expect(off.fatigue).toBeUndefined(); // C5 meta absent when the cap is off (additive-safe)

    process.env.DECISION_CENTER_FATIGUE_CAPS_ENABLED = 'true';
    const on = getDecisionOverview(300, 300, { limit: 80 });
    expect(on.items.map((i) => i.decisionId)).toEqual(expectedIds); // ON == pure-fn selection (wiring)
    expect(expectedIds.length).toBeLessThan(open.length); // the cap actually reduced the visible set
    for (const id of flooredIds) expect(on.items.map((i) => i.decisionId)).toContain(id); // floored never capped away
    // C5 fatigue meta: lets the client split items into primary + "More" and know how many were capped out.
    expect(on.fatigue).toBeDefined();
    expect(on.fatigue!.primaryCount).toBeLessThanOrEqual(5); // topPrimaryCount default
    expect(on.fatigue!.primaryCount + on.fatigue!.moreCount).toBe(on.items.length);
    expect(on.fatigue!.cappedCount).toBe(open.length - on.items.length);
  });

  it('getDecisionOverview fatigue cap stays tenant-scoped', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 301, { tenantId: 301, dedupeKey: 'mine' }));
    await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 302, { tenantId: 302, dedupeKey: 'theirs' }));
    process.env.DECISION_CENTER_FATIGUE_CAPS_ENABLED = 'true';
    const mine = getDecisionOverview(301, 301, { limit: 80 });
    expect(mine.items.every((i) => i.userId === 301)).toBe(true);
    expect(mine.items.some((i) => i.userId === 302)).toBe(false);
  });
});

describe('runDecisionLedgerRetentionPruneJob (retention)', () => {
  beforeEach(() => {
    // Real timers so inserted `new Date()` timestamps and the SQLite datetime('now') prune predicate agree.
    vi.useRealTimers();
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  const insertOutcome = (id: string, createdAt: string): void => {
    testDb.prepare(
      `INSERT INTO decision_outcome_ledger (outcome_id, decision_id, user_id, tenant_id, source_skill, type, created_at)
       VALUES (?, ?, 1, 1, 'training', 'decision_required', ?)`,
    ).run(id, `d_${id}`, createdAt);
  };
  const insertGate = (id: string, createdAt: string): void => {
    testDb.prepare(
      `INSERT INTO decision_quality_gate_events (event_id, user_id, tenant_id, source_skill, type, quality_status, reason, created_at)
       VALUES (?, 1, 1, 'training', 'decision_required', 'passed', 'ok', ?)`,
    ).run(id, createdAt);
  };
  const insertConflictEvaluation = (id: string, createdAt: string): void => {
    testDb.prepare(`
      INSERT INTO decision_conflict_evaluations (
        conflict_evaluation_id, decision_id, user_id, tenant_id, policy_version,
        context_version, disposition, created_at
      ) VALUES (?, ?, 1, 1, 'decision_conflict_policy.v1', 'ctx_test', 'allow', ?)
    `).run(id, `d_${id}`, createdAt);
  };
  const insertExclusivityClaim = (key: string, status: string, createdAt: string): void => {
    testDb.prepare(`
      INSERT INTO decision_exclusivity_claims (
        user_id, tenant_id, exclusivity_key, action_execution_id, decision_id,
        status, lease_expires_at, created_at, updated_at
      ) VALUES (1, 1, ?, ?, ?, ?, '2030-01-01T00:00:00.000Z', ?, ?)
    `).run(key, `exec_${key}`, `d_${key}`, status, createdAt, createdAt);
  };
  const countOutcome = (): number => (testDb.prepare('SELECT COUNT(*) AS n FROM decision_outcome_ledger').get() as { n: number }).n;
  const countGate = (): number => (testDb.prepare('SELECT COUNT(*) AS n FROM decision_quality_gate_events').get() as { n: number }).n;
  const countConflicts = (): number => (testDb.prepare('SELECT COUNT(*) AS n FROM decision_conflict_evaluations').get() as { n: number }).n;
  const countClaims = (): number => (testDb.prepare('SELECT COUNT(*) AS n FROM decision_exclusivity_claims').get() as { n: number }).n;

  it('prunes rows older than the retention horizon from both raw telemetry tables and keeps recent ones', () => {
    insertOutcome('old1', '2020-01-01T00:00:00.000Z');
    insertOutcome('old2', '2020-06-01T00:00:00.000Z');
    insertOutcome('recent', new Date().toISOString());
    insertGate('gold', '2020-01-01T00:00:00.000Z');
    insertGate('grecent', new Date().toISOString());
    insertConflictEvaluation('cold', '2020-01-01T00:00:00.000Z');
    insertConflictEvaluation('crecent', new Date().toISOString());
    insertExclusivityClaim('claim-old-succeeded', 'succeeded', '2020-01-01T00:00:00.000Z');
    insertExclusivityClaim('claim-old-started', 'started', '2020-01-01T00:00:00.000Z');
    insertExclusivityClaim('claim-old-partial', 'partially_failed', '2020-01-01T00:00:00.000Z');
    insertExclusivityClaim('claim-recent-failed', 'failed', new Date().toISOString());

    const result = runDecisionLedgerRetentionPruneJob({ retentionDays: 180 });
    expect(result.outcomeLedgerPruned).toBe(2);
    expect(result.qualityGateEventsPruned).toBe(1);
    expect(result.conflictEvaluationsPruned).toBe(1);
    expect(result.terminalExclusivityClaimsPruned).toBe(1);
    expect(result.outcomeLedgerRemaining).toBe(0);
    expect(result.qualityGateEventsRemaining).toBe(0);
    expect(result.conflictEvaluationsRemaining).toBe(0);
    expect(result.terminalExclusivityClaimsRemaining).toBe(0);
    expect(countOutcome()).toBe(1); // only the recent outcome survives
    expect(countGate()).toBe(1); // only the recent gate event survives
    expect(countConflicts()).toBe(1); // only the recent conflict evaluation survives
    expect(countClaims()).toBe(3); // active, partial-recovery, and recent terminal claims survive
  });

  it('batches a large backlog of expired rows across multiple passes', () => {
    for (let i = 0; i < 12; i++) insertOutcome(`b${i}`, '2019-01-01T00:00:00.000Z');
    const result = runDecisionLedgerRetentionPruneJob({ retentionDays: 180, batchSize: 5, maxBatches: 50 });
    expect(result.outcomeLedgerPruned).toBe(12);
    expect(result.batches).toBeGreaterThanOrEqual(3); // 12 rows / batchSize 5 => 5 + 5 + 2
    expect(countOutcome()).toBe(0);
  });

  it('respects maxBatches as a time-budget backstop (leaves a remainder for the next run)', () => {
    for (let i = 0; i < 12; i++) insertOutcome(`m${i}`, '2019-01-01T00:00:00.000Z');
    const result = runDecisionLedgerRetentionPruneJob({ retentionDays: 180, batchSize: 5, maxBatches: 1 });
    expect(result.outcomeLedgerPruned).toBe(5); // one pass only
    expect(result.outcomeLedgerRemaining).toBe(7); // remainder reported for the next run
    expect(countOutcome()).toBe(7);
  });

  it('defaults to the declared 180-day raw retention policy when no horizon is passed', () => {
    insertOutcome('o', '2019-01-01T00:00:00.000Z');
    insertOutcome('keep', new Date().toISOString());
    const result = runDecisionLedgerRetentionPruneJob();
    expect(result.outcomeLedgerPruned).toBe(1);
    expect(countOutcome()).toBe(1);
  });
});

describe('Decision Center immutable rank snapshot backfill', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    testDb?.close();
  });

  it('advances bounded runs across only scopes missing a current snapshot', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 701, {
      tenantId: 1701,
      dedupeKey: 'snapshot-backfill-a',
    }));
    await createDecisionIntent(buildSkillDecisionFixtureIntent('chat', 702, {
      tenantId: 1702,
      dedupeKey: 'snapshot-backfill-b',
    }));
    testDb.exec(`
      DELETE FROM decision_center_rank_snapshot_entries;
      DELETE FROM decision_center_rank_snapshots;
    `);

    expect(runDecisionRankSnapshotBackfillJob({ limit: 1 })).toMatchObject({
      inspectedScopes: 1,
      materializedScopes: 1,
      failedScopes: 0,
    });
    expect(runDecisionRankSnapshotBackfillJob({ limit: 1 })).toMatchObject({
      inspectedScopes: 1,
      materializedScopes: 1,
      failedScopes: 0,
    });
    expect(runDecisionRankSnapshotBackfillJob({ limit: 1 })).toEqual({
      inspectedScopes: 0,
      materializedScopes: 0,
      failedScopes: 0,
      failures: [],
    });
    expect(testDb.prepare(`
      SELECT user_id AS userId, tenant_id AS tenantId
        FROM decision_center_rank_snapshots
       ORDER BY tenant_id, user_id
    `).all()).toEqual([
      { userId: 701, tenantId: 1701 },
      { userId: 702, tenantId: 1702 },
    ]);
  });
});

describe('Decision Center evidence-freshness gate (F2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_EVIDENCE_FRESHNESS_GATE_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  it('gateActionabilityForStaleEvidence only LOWERS write-capable actionability (pure)', () => {
    expect(gateActionabilityForStaleEvidence('confirmation_required')).toBe('preview_available');
    expect(gateActionabilityForStaleEvidence('execute_with_undo')).toBe('preview_available');
    expect(gateActionabilityForStaleEvidence('requires_human_review')).toBe('preview_available');
    for (const passthrough of ['read_only', 'preview_available', 'blocked', 'unavailable'] as const) {
      expect(gateActionabilityForStaleEvidence(passthrough)).toBe(passthrough);
    }
  });

  it('F human-review gate maps requires_human_review -> unavailable only when the queue is down (pure)', () => {
    // queue DOWN: only requires_human_review lowers; everything else passes through unchanged.
    expect(gateActionabilityForHumanReview('requires_human_review', false)).toBe('unavailable');
    for (const passthrough of ['read_only', 'preview_available', 'confirmation_required', 'execute_with_undo', 'blocked', 'unavailable'] as const) {
      expect(gateActionabilityForHumanReview(passthrough, false)).toBe(passthrough);
    }
    // queue UP: requires_human_review is preserved (review can actually be submitted).
    expect(gateActionabilityForHumanReview('requires_human_review', true)).toBe('requires_human_review');
    // no env => no queue => default closed.
    const saved = process.env.DECISION_HUMAN_REVIEW_QUEUE_AVAILABLE;
    delete process.env.DECISION_HUMAN_REVIEW_QUEUE_AVAILABLE;
    expect(isHumanReviewQueueAvailable(process.env)).toBe(false);
    expect(isHumanReviewQueueAvailable({ DECISION_HUMAN_REVIEW_QUEUE_AVAILABLE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    if (saved !== undefined) process.env.DECISION_HUMAN_REVIEW_QUEUE_AVAILABLE = saved;
  });

  it('downgrades a STALE decision\'s actionability when the flag is ON; OFF leaves it unchanged', async () => {
    const { created } = await createContentApprovalDecision(85, 85, 'f2-stale');
    snoozeDecision(created.item!.decisionId, 85, 85, 60); // snoozed => sourceFreshness 'stale'

    const off = getDecisionItem(created.item!.decisionId, 85, 85)!;
    expect(off.analysis.sourceFreshness).toBe('stale'); // precondition

    process.env.DECISION_EVIDENCE_FRESHNESS_GATE_ENABLED = 'true';
    const on = getDecisionItem(created.item!.decisionId, 85, 85)!;
    expect(on.actionability).toBe(gateActionabilityForStaleEvidence(off.actionability!)); // wiring applies the gate
    if (['confirmation_required', 'execute_with_undo', 'requires_human_review'].includes(off.actionability ?? '')) {
      expect(on.actionability).toBe('preview_available'); // real downgrade for a write-capable, stale decision
    }
  });

  it('does NOT downgrade a FRESH decision even with the flag ON', async () => {
    const { created } = await createContentApprovalDecision(86, 86, 'f2-fresh');
    const off = getDecisionItem(created.item!.decisionId, 86, 86)!;
    expect(off.analysis.sourceFreshness).not.toBe('stale'); // live/unknown, not stale

    process.env.DECISION_EVIDENCE_FRESHNESS_GATE_ENABLED = 'true';
    const on = getDecisionItem(created.item!.decisionId, 86, 86)!;
    expect(on.actionability).toBe(off.actionability); // fresh => gate does nothing
  });
});

describe('Decision Center B3 acting — conflict linking on create', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_CONFLICT_POLICY_V1_ENABLED;
    delete process.env.DECISION_SEMANTIC_DEDUP_ENABLED;
    delete process.env.DECISION_SEMANTIC_SUPERSEDE_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  it('persists an exact conflict-policy duplicate as superseded audit state and delivers only the canonical item', async () => {
    process.env.DECISION_CONFLICT_POLICY_V1_ENABLED = 'active';
    const normalizedAction = buildNormalizedDecisionAction({
      intent: 'review_training_window',
      targetEntities: [{ type: 'training_plan', id: 'plan-exact-duplicate', version: '1' }],
      affectedResources: [{ type: 'training_state', id: 'primary' }],
      requestedWindow: {
        start: '2026-05-11T08:00:00.000Z',
        end: '2026-05-11T09:00:00.000Z',
        timezone: 'Europe/Lisbon',
      },
      preconditions: [],
      expectedEffects: [{ type: 'review_required', targetRef: 'training_plan:plan-exact-duplicate' }],
      prohibitedEffects: [],
      dependencies: [],
      exclusivityKeys: ['training_state:exact-duplicate'],
      authorizationScope: ['decision_center:read'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: 'ctx_exact_duplicate',
    });
    const first = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 96, {
      tenantId: 96,
      relatedEntityId: 'plan-exact-duplicate',
      relatedEntityType: 'training_plan',
      dedupeKey: 'exact-conflict-policy:first',
      decisionContext: { entityTitle: 'Training window', normalizedAction },
    }));
    expect(first.item).not.toBeNull();

    const duplicate = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 96, {
      tenantId: 96,
      relatedEntityId: 'plan-exact-duplicate',
      relatedEntityType: 'training_plan',
      dedupeKey: 'exact-conflict-policy:second',
      decisionContext: {
        entityTitle: 'Training window replay',
        normalizedAction,
        conflictComparisons: [{
          action: normalizedAction,
          decisionId: first.item!.decisionId,
          authority: 'optimization',
          approved: false,
          createdAt: first.item!.createdAt,
        }],
      },
    }));

    expect(duplicate.item?.decisionId).toBe(first.item!.decisionId);
    expect(duplicate.eligibility).toMatchObject({ apnsEligible: false });
    expect(duplicate.eligibility.reasons).toContain('conflict_policy:duplicate');
    const candidate = testDb.prepare(`
      SELECT items.item_id AS itemId, items.status
        FROM notification_center_items items
        JOIN notification_intents intents ON intents.intent_id = items.intent_id
       WHERE items.user_id = 96 AND items.tenant_id = 96
         AND intents.dedupe_key = 'exact-conflict-policy:second'
    `).get() as { itemId: string; status: string };
    expect(candidate.status).toBe('superseded');
    expect(getDecisionLifecycleEvents(candidate.itemId, 96, 96).map((event) => event.event))
      .toEqual(expect.arrayContaining(['created', 'superseded']));
    expect(listDecisionDependencies(candidate.itemId, 96, 96)).toContainEqual(expect.objectContaining({
      dependsOnDecisionId: first.item!.decisionId,
      relationship: 'duplicate_of',
    }));
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM background_jobs
       WHERE user_id = 96 AND tenant_id = 96 AND job_type = 'deliver_notification'
    `).get()).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_decision_logs
       WHERE user_id = 96 AND tenant_id = 96 AND decision = 'deduped'
    `).get()).toEqual({ count: 1 });
  });

  it('B3 hiding: same_recommendation collapses the new duplicate into the existing (returns existing, only one active)', async () => {
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    process.env.DECISION_SEMANTIC_SUPERSEDE_ENABLED = 'true';
    // Two SAME-skill, SAME-type, SAME-recipe (dedupe first-two 'train:plan'), SAME-entity, SAME-day rows
    // with DISTINCT exact dedupe keys (so exact-dedup does not fire; the semantic same_recommendation does).
    const a = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 90, { tenantId: 90, type: 'decision_required', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'train:plan:a' }));
    expect(a.item).not.toBeNull();
    const b = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 90, { tenantId: 90, type: 'decision_required', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'train:plan:b' }));
    // the new duplicate folded into the existing => createDecisionIntent returns the EXISTING item.
    expect(b.item!.decisionId).toBe(a.item!.decisionId);
    // exactly one active decision remains; the new row is superseded (hidden), the existing is still shown.
    expect(getDecisionItem(a.item!.decisionId, 90, 90)).not.toBeNull();
    expect(listDecisionItems(90, 90)).toHaveLength(1);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM background_jobs
       WHERE user_id = 90 AND tenant_id = 90 AND job_type = 'deliver_notification'
    `).get()).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_intents
       WHERE user_id = 90 AND tenant_id = 90
         AND dedupe_key IN ('train:plan:a', 'train:plan:b')
    `).get()).toEqual({ count: 2 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_decision_logs
       WHERE user_id = 90 AND tenant_id = 90 AND decision = 'deduped'
    `).get()).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_delivery_attempts
       WHERE user_id = 90 AND tenant_id = 90
    `).get()).toEqual({ count: 0 });
  });

  it('B3 hiding: newer_recommendation supersedes the OLDER same-recipe decision (different type, non-floored)', async () => {
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    process.env.DECISION_SEMANTIC_SUPERSEDE_ENABLED = 'true';
    // Cooking @ active priority is NOT policy-floored; different type (intent) => newer supersedes old.
    const older = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 91, { tenantId: 91, type: 'decision_required', priority: 'active', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'cook:plan:older' }));
    expect(older.item).not.toBeNull();
    expect(isDecisionItemPolicyFloored(older.item!)).toBe(false); // precondition: supersedes only fires on a non-floored older
    const newer = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 91, { tenantId: 91, type: 'reminder', priority: 'active', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'cook:plan:newer' }));
    expect(newer.item).not.toBeNull();
    expect(newer.item!.decisionId).not.toBe(older.item!.decisionId); // newer is its own row (not a collapse)
    // the OLDER decision is superseded (hidden from the active list) — proven by the lifecycle stream.
    expect(getDecisionLifecycleEvents(older.item!.decisionId, 91, 91).map((e) => e.event)).toContain('superseded');
    const activeIds = listDecisionItems(91, 91).map((d) => d.decisionId);
    expect(activeIds).not.toContain(older.item!.decisionId); // older no longer surfaces in the active list
    expect(activeIds).toContain(newer.item!.decisionId);     // the newer recommendation is surfaced
  });

  it('rolls back the whole proposal when atomic semantic linking fails', async () => {
    const existing = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 95, {
      tenantId: 95,
      relatedEntityId: 'atomic-link-slot',
      dedupeKey: 'atomic-link-existing',
    }));
    expect(existing.item).not.toBeNull();
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    testDb.exec(`
      CREATE TRIGGER fail_atomic_decision_dependency
      BEFORE INSERT ON decision_dependencies
      BEGIN
        SELECT RAISE(ABORT, 'forced dependency failure');
      END;
    `);

    const failed = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 95, {
      tenantId: 95,
      type: 'decision_required',
      relatedEntityId: 'atomic-link-slot',
      dedupeKey: 'atomic-link-candidate',
      requiresUserAction: true,
    }));

    expect(failed.item).toBeNull();
    expect(failed.eligibility.reasons).toContain('decision_flow_metadata_persistence_failed');
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM notification_intents
       WHERE user_id = 95 AND tenant_id = 95
         AND dedupe_key = 'atomic-link-candidate'
    `).get()).toEqual({ count: 0 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM notification_center_items
       WHERE user_id = 95 AND tenant_id = 95
         AND dedupe_key = 'atomic-link-candidate'
    `).get()).toEqual({ count: 0 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM background_jobs
       WHERE user_id = 95 AND tenant_id = 95
         AND job_type = 'deliver_notification'
    `).get()).toEqual({ count: 1 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM decision_lifecycle_events
       WHERE user_id = 95 AND tenant_id = 95 AND event = 'created'
    `).get()).toEqual({ count: 1 });
  });

  it('B3 hiding NEVER supersedes a DIFFERENT decision (different entity / different skill stay active)', async () => {
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    process.env.DECISION_SEMANTIC_SUPERSEDE_ENABLED = 'true';
    const sameEntityOlder = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 92, { tenantId: 92, type: 'decision_required', priority: 'active', requiresUserAction: true, relatedEntityId: 'slotA', dedupeKey: 'cook:plan:e1' }));
    const otherEntity = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 92, { tenantId: 92, type: 'decision_required', priority: 'active', requiresUserAction: true, relatedEntityId: 'slotB', dedupeKey: 'cook:plan:e2' }));
    const otherSkill = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 92, { tenantId: 92, type: 'decision_required', requiresUserAction: true, relatedEntityId: 'slotA', dedupeKey: 'train:plan:e1' }));
    // a newer cooking decision on slotA, different type => supersedes ONLY the same-skill same-entity older.
    const newer = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 92, { tenantId: 92, type: 'reminder', priority: 'active', requiresUserAction: true, relatedEntityId: 'slotA', dedupeKey: 'cook:plan:new' }));
    expect(newer.item).not.toBeNull();
    const activeIds = listDecisionItems(92, 92).map((d) => d.decisionId);
    expect(activeIds).not.toContain(sameEntityOlder.item!.decisionId); // same skill+entity older -> superseded
    expect(activeIds).toContain(otherEntity.item!.decisionId); // different entity -> untouched
    expect(activeIds).toContain(otherSkill.item!.decisionId);  // different skill -> untouched
  });

  it('B3 hiding NEVER supersedes a policy-floored older decision (fail open)', async () => {
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    process.env.DECISION_SEMANTIC_SUPERSEDE_ENABLED = 'true';
    // critical priority => rankDecisionPriority emits a floor => isDecisionItemPolicyFloored true.
    const flooredOlder = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 93, { tenantId: 93, type: 'decision_required', priority: 'critical', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'cook:plan:floored' }));
    expect(flooredOlder.item).not.toBeNull();
    expect(isDecisionItemPolicyFloored(flooredOlder.item!)).toBe(true); // precondition
    const newer = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 93, { tenantId: 93, type: 'reminder', priority: 'active', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'cook:plan:newer' }));
    expect(newer.item).not.toBeNull();
    // the floored older decision is NOT superseded — it remains visible (fail open).
    expect(getDecisionLifecycleEvents(flooredOlder.item!.decisionId, 93, 93).map((e) => e.event)).not.toContain('superseded');
    expect(getDecisionItem(flooredOlder.item!.decisionId, 93, 93)).not.toBeNull();
  });

  it('B3 hiding is byte-identical when the supersede flag is OFF (linking may be on)', async () => {
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true'; // linking on, hiding OFF
    const older = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 94, { tenantId: 94, type: 'decision_required', priority: 'active', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'cook:plan:a' }));
    const newer = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 94, { tenantId: 94, type: 'reminder', priority: 'active', requiresUserAction: true, relatedEntityId: 'slot1', dedupeKey: 'cook:plan:b' }));
    // nothing superseded, both decisions still active.
    expect(getDecisionItem(older.item!.decisionId, 94, 94)).not.toBeNull();
    expect(getDecisionItem(newer.item!.decisionId, 94, 94)).not.toBeNull();
    expect(getDecisionLifecycleEvents(older.item!.decisionId, 94, 94).map((e) => e.event)).not.toContain('superseded');
  });

  it('links a newly-created cross-skill conflicting decision to the existing one (conflicts_with) when the flag is ON', async () => {
    const a = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 87, { tenantId: 87, relatedEntityId: 'slot1', dedupeKey: 'b3act-a' }));
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    const b = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 87, { tenantId: 87, type: 'decision_required', relatedEntityId: 'slot1', dedupeKey: 'b3act-b', requiresUserAction: true }));

    const item = getDecisionItem(b.item!.decisionId, 87, 87)!;
    const link = item.relationships.find((r) => r.type === 'conflicts_with');
    expect(link).toBeDefined();
    expect(link?.decisionId).toBe(a.item!.decisionId);
    expect(link?.kind).toBe('warns'); // advisory — never blocks
    // The linked decision is NOT blocked by the advisory conflict edge.
    expect(item.blockedByDecisionIds).toHaveLength(0);

    // Reciprocal: the pre-existing decision also surfaces the conflict back to the new one.
    const existing = getDecisionItem(a.item!.decisionId, 87, 87)!;
    expect(existing.relationships.some((r) => r.type === 'conflicts_with' && r.decisionId === b.item!.decisionId)).toBe(true);
  });

  it('does NOT link when the flag is OFF (default)', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 88, { tenantId: 88, relatedEntityId: 'slot2', dedupeKey: 'b3off-a' }));
    const b = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 88, { tenantId: 88, type: 'decision_required', relatedEntityId: 'slot2', dedupeKey: 'b3off-b', requiresUserAction: true }));

    const item = getDecisionItem(b.item!.decisionId, 88, 88)!;
    expect(item.relationships).toHaveLength(0);
  });

  it('does NOT link independent decisions (different entity) even with the flag ON', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 89, { tenantId: 89, relatedEntityId: 'entityA', dedupeKey: 'b3ind-a' }));
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    const b = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 89, { tenantId: 89, type: 'decision_required', relatedEntityId: 'entityB', dedupeKey: 'b3ind-b', requiresUserAction: true }));

    const item = getDecisionItem(b.item!.decisionId, 89, 89)!;
    expect(item.relationships).toHaveLength(0); // no shared entity => independent => no link
  });

  it('links cross-skill, non-conflicting decisions on the same entity as affects_same_entity (same_issue_cluster) when the flag is ON', async () => {
    // A: a content approval_required decision (NOT a conflict signal) about a content object.
    const { object, created: a } = await createContentApprovalDecision(93, 93, 'b3cluster-a');
    expect(a.item).not.toBeNull();
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    // B: a cooking decision_required referencing the SAME entity => cross-skill, same entity+window,
    // and NOT both conflict signals (approval_required is not a signal) => same_issue_cluster.
    const b = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 93, { tenantId: 93, type: 'decision_required', relatedEntityId: object.id, dedupeKey: 'b3cluster-b', requiresUserAction: true }));
    expect(b.item).not.toBeNull();

    const item = getDecisionItem(b.item!.decisionId, 93, 93)!;
    const link = item.relationships.find((r) => r.type === 'affects_same_entity');
    expect(link).toBeDefined();
    expect(link?.decisionId).toBe(a.item!.decisionId);
    expect(link?.kind).toBe('context'); // advisory grouping — never blocks
    expect(item.blockedByDecisionIds).toHaveLength(0);
    // reciprocal: the pre-existing decision also surfaces the grouping
    expect(getDecisionItem(a.item!.decisionId, 93, 93)!.relationships.some((r) => r.type === 'affects_same_entity' && r.decisionId === b.item!.decisionId)).toBe(true);
  });

  it('links a new decision to EVERY qualifying candidate, not just the first (loop completeness)', async () => {
    // Two existing same-entity decisions, created with the flag OFF so they do not pre-link each other.
    // A is a content approval_required (NOT a conflict signal); B is a cooking decision_required (signal).
    const { object, created: a } = await createContentApprovalDecision(94, 94, 'b3multi-a');
    expect(a.item).not.toBeNull();
    const bExisting = await createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', 94, { tenantId: 94, type: 'decision_required', relatedEntityId: object.id, dedupeKey: 'b3multi-b', requiresUserAction: true }));
    expect(bExisting.item).not.toBeNull();

    // Flag ON, then create N (training decision_required) on the SAME entity. Its linker must scan BOTH
    // existing candidates and link each — with DIFFERENT verdicts: same_issue_cluster->affects_same_entity
    // for the content approval, conflicting_recommendation_link->conflicts_with for the cooking decision.
    // A loop that aborted on the first pairing (the QA-flagged regression) would link only one of them.
    process.env.DECISION_SEMANTIC_DEDUP_ENABLED = 'true';
    const n = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 94, { tenantId: 94, type: 'decision_required', relatedEntityId: object.id, dedupeKey: 'b3multi-n', requiresUserAction: true }));
    expect(n.item).not.toBeNull();

    const item = getDecisionItem(n.item!.decisionId, 94, 94)!;
    expect(item.relationships).toHaveLength(2); // BOTH candidates linked, no spurious extras
    expect(item.relationships.some((r) => r.type === 'affects_same_entity' && r.decisionId === a.item!.decisionId)).toBe(true);
    expect(item.relationships.some((r) => r.type === 'conflicts_with' && r.decisionId === bExisting.item!.decisionId)).toBe(true);
    expect(item.blockedByDecisionIds).toHaveLength(0); // all advisory — nothing blocked
  });
});

describe('Decision Center C3 type-suppression controls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
    delete process.env.DECISION_FEEDBACK_SUPPRESSION_ENABLED;
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
    delete process.env.DECISION_FEEDBACK_SUPPRESSION_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  const cooking = (user: number, key: string, priority: 'active' | 'critical' = 'active') =>
    createDecisionIntent(buildSkillDecisionFixtureIntent('cooking', user, { tenantId: user, type: 'decision_required', priority, requiresUserAction: true, relatedEntityId: key, dedupeKey: `cook:plan:${key}` }));

  it('hides a suppressed type from the user-facing list (flag ON), keeps other types; OFF == unchanged; integrity reads unaffected', async () => {
    const cook = await cooking(200, 'a');
    const content = await createContentApprovalDecision(200, 200, 'c3-content');
    const cookItem = getDecisionItem(cook.item!.decisionId, 200, 200)!;
    const contentItem = getDecisionItem(content.created.item!.decisionId, 200, 200)!;
    suppressDecisionType(200, 200, 'cooking', 'decision_required', 'dont_show_type');

    // OFF (default) — byte-identical: both pass through.
    expect(applyDecisionTypeSuppression([cookItem, contentItem], 200, 200)).toHaveLength(2);

    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    // ON: the suppressed cooking decision_required is dropped; the content approval stays.
    expect(applyDecisionTypeSuppression([cookItem, contentItem], 200, 200).map((i) => i.decisionId)).toEqual([contentItem.decisionId]);
    // INTEGRITY: getDecisionActiveBreakdowns (admin read) still counts the suppressed type — never filtered.
    expect(getDecisionActiveBreakdowns(200, 200).byDomain.cooking).toBe(1);
  });

  it('NEVER hides a policy-floored decision of a suppressed type (floor bypass)', async () => {
    const floored = await cooking(201, 'f', 'critical'); // critical => policy-floored
    const item = getDecisionItem(floored.item!.decisionId, 201, 201)!;
    expect(isDecisionItemPolicyFloored(item)).toBe(true); // precondition
    suppressDecisionType(201, 201, 'cooking', 'decision_required', 'dont_show_type');
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    expect(applyDecisionTypeSuppression([item], 201, 201)).toHaveLength(1); // floored never suppressed
  });

  it('snooze_type suppresses only while active; a lapsed snooze and unsuppress both restore', async () => {
    const cook = await cooking(202, 's');
    const item = getDecisionItem(cook.item!.decisionId, 202, 202)!;
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    suppressDecisionType(202, 202, 'cooking', 'decision_required', 'snooze_type', '2999-01-01T00:00:00.000Z');
    expect(applyDecisionTypeSuppression([item], 202, 202)).toHaveLength(0); // active snooze hides
    suppressDecisionType(202, 202, 'cooking', 'decision_required', 'snooze_type', '2020-01-01T00:00:00.000Z');
    expect(applyDecisionTypeSuppression([item], 202, 202)).toHaveLength(1); // lapsed snooze no longer hides
    suppressDecisionType(202, 202, 'cooking', 'decision_required', 'dont_show_type');
    expect(applyDecisionTypeSuppression([item], 202, 202)).toHaveLength(0);
    unsuppressDecisionType(202, 202, 'cooking', 'decision_required');
    expect(applyDecisionTypeSuppression([item], 202, 202)).toHaveLength(1); // unsuppress restores
  });

  it('can suppress and restore one recipe without muting the whole type', async () => {
    const planA = await cooking(222, 'recipe-a');
    const planB = await cooking(222, 'recipe-b');
    const itemA = getDecisionItem(planA.item!.decisionId, 222, 222)!;
    const itemB = getDecisionItem(planB.item!.decisionId, 222, 222)!;
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';

    suppressDecisionType(222, 222, 'cooking', 'decision_required', 'dont_show_type', null, itemA.groupKey);

    expect(listDecisionTypeSuppressions(222, 222)).toEqual([
      expect.objectContaining({ sourceSkill: 'cooking', type: 'decision_required', recipe: itemA.groupKey }),
    ]);
    expect(applyDecisionTypeSuppression([itemA, itemB], 222, 222).map((item) => item.decisionId))
      .toEqual([itemB.decisionId]);

    unsuppressDecisionType(222, 222, 'cooking', 'decision_required', itemA.groupKey);
    expect(applyDecisionTypeSuppression([itemA, itemB], 222, 222)).toHaveLength(2);
  });

  it('uses feedback signals for opt-in suppression while keeping the flag off by default', async () => {
    const historical: DecisionApiItem[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await cooking(223, `feedback-${i}`);
      const item = getDecisionItem(created.item!.decisionId, 223, 223)!;
      historical.push(item);
      if (i < 3) dismissDecision(item.decisionId, 223, 223, 'dont_show_type');
    }
    const current = getDecisionItem((await cooking(223, 'feedback-current')).item!.decisionId, 223, 223)!;

    expect(getDecisionFeedbackSignals(223, 223)[0]).toMatchObject({
      sourceSkill: 'cooking',
      type: 'decision_required',
      dontShowTypeCount: 3,
    });
    expect(applyDecisionTypeSuppression([current], 223, 223)).toHaveLength(1);

    process.env.DECISION_FEEDBACK_SUPPRESSION_ENABLED = 'true';
    expect(applyDecisionTypeSuppression([current], 223, 223)).toHaveLength(0);

    expect(historical).toHaveLength(5);
  });

  it('is scoped — one user\'s suppression does not affect another', async () => {
    const a = await cooking(203, 'a');
    const b = await cooking(204, 'b');
    const itemA = getDecisionItem(a.item!.decisionId, 203, 203)!;
    const itemB = getDecisionItem(b.item!.decisionId, 204, 204)!;
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    suppressDecisionType(203, 203, 'cooking', 'decision_required', 'dont_show_type');
    expect(applyDecisionTypeSuppression([itemA], 203, 203)).toHaveLength(0); // suppressed for 203
    expect(applyDecisionTypeSuppression([itemB], 204, 204)).toHaveLength(1); // 204 unaffected
  });

  it('getDecisionOverview drops suppressed types from the open set (flag ON, integration)', async () => {
    const cook = await cooking(205, 'ov');
    const content = await createContentApprovalDecision(205, 205, 'c3-ov-content');
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    suppressDecisionType(205, 205, 'cooking', 'decision_required', 'dont_show_type');
    const overview = getDecisionOverview(205, 205, { limit: 20 });
    const ids = overview.items.map((i) => i.decisionId);
    expect(ids).not.toContain(cook.item!.decisionId); // suppressed from the rendered list
    expect(ids).toContain(content.created.item!.decisionId);  // kept
    expect(overview.items.length).toBe(1);
    // C3-1: counts are an INTEGRITY read — openCount reflects the true open set (both decisions),
    // not the suppression-filtered list, so it stays consistent with summary.openCount.
    expect(overview.openCount).toBe(2);
    expect(overview.summary.openCount).toBe(2);
  });

  it('all-suppressed: every RENDERED surface (items, previewItems, topSuggestion) is empty while counts stay raw', async () => {
    await cooking(220, 'a');
    await cooking(220, 'b'); // two open cooking decisions of the same suppressed type
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    suppressDecisionType(220, 220, 'cooking', 'decision_required', 'dont_show_type');
    const overview = getDecisionOverview(220, 220, { limit: 20 });
    // Rendered surfaces respect the mute — the muted type must not peek through anywhere user-facing.
    expect(overview.items).toHaveLength(0);
    expect(overview.topSuggestion).toBeNull();
    expect(overview.summary.previewItems).toHaveLength(0);
    expect(overview.summary.topSuggestion).toBeNull();
    // Counts are integrity reads — both decisions stay counted and consistent across overview + summary.
    expect(overview.openCount).toBe(2);
    expect(overview.summary.openCount).toBe(2);
  });

  it('getDecisionSummary suppresses rendered previewItems/topSuggestion at the source (fixes all consumers) but keeps counts raw', async () => {
    await cooking(221, 'a');
    const content = await createContentApprovalDecision(221, 221, 'sum-content');
    expect(content.created.item).toBeTruthy();
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    suppressDecisionType(221, 221, 'cooking', 'decision_required', 'dont_show_type');
    const summary = getDecisionSummary(221, 221);
    // Counts stay raw (both decisions); the rendered preview excludes the muted cooking decision, keeps content.
    expect(summary.openCount).toBe(2);
    const previewSkills = summary.previewItems.map((i) => i.sourceSkill);
    expect(previewSkills).not.toContain('cooking');
    expect(previewSkills).toContain('content');
    expect(summary.topDecisionSourceSkill).not.toBe('cooking');
  });

  it('suppressDecisionType rejects a snooze with no until timestamp (no silent zombie row)', async () => {
    expect(() => suppressDecisionType(206, 206, 'cooking', 'decision_required', 'snooze_type')).toThrow(/until/i);
    expect(listDecisionTypeSuppressions(206, 206)).toHaveLength(0); // nothing persisted
  });

  it('re-suppressing a type replaces the prior mode and clears a stale until', async () => {
    suppressDecisionType(207, 207, 'cooking', 'decision_required', 'snooze_type', '2999-01-01T00:00:00.000Z');
    suppressDecisionType(207, 207, 'cooking', 'decision_required', 'dont_show_type'); // re-suppress same (skill,type)
    const rows = listDecisionTypeSuppressions(207, 207);
    expect(rows).toHaveLength(1); // INSERT OR REPLACE on the PK — not a duplicate
    expect(rows[0].mode).toBe('dont_show_type');
    expect(rows[0].until).toBeNull(); // stale snooze timestamp cleared
  });

  it('fails closed for low-risk items while retaining the safety floor if the suppression-table read throws', async () => {
    const cook = await cooking(208, 'fo');
    const item = getDecisionItem(cook.item!.decisionId, 208, 208)!;
    const critical = await cooking(208, 'fo-critical', 'critical');
    const criticalItem = getDecisionItem(critical.item!.decisionId, 208, 208)!;
    process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    suppressDecisionType(208, 208, 'cooking', 'decision_required', 'dont_show_type');
    testDb.exec('DROP TABLE decision_type_suppressions'); // simulate a transient read fault
    expect(applyDecisionTypeSuppression([item, criticalItem], 208, 208).map((candidate) => candidate.decisionId))
      .toEqual([criticalItem.decisionId]);
  });
});
