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

import { createContentWorkflowObject } from '../../src/services/content-editorial-workflow';
import {
  addDecisionDependency,
  buildDecisionCenterReportDocument,
  buildSkillDecisionFixtureIntent,
  cleanupDecisionCenterSmokeItems,
  createDecisionIntent,
  DECISION_OUTCOME_LEDGER_RETENTION_POLICY,
  dismissDecision,
  ensureDecisionCenterTables,
  evaluateDecisionEligibility,
  getDecisionItem,
  getDecisionGuidanceStats,
  getDecisionOverview,
  getDecisionOutcomeMetrics,
  getDecisionSummary,
  listDecisionDependencies,
  listDecisionItems,
  listHandledByNexusItems,
  performDecisionAction,
  runDecisionHandledHistoryBackfillJob,
  runDecisionSourceStateSupersessionJob,
  sanitizeGuidanceString,
  runDecisionExpiryJob,
  legacyStatusToLifecycle,
  actionOutcomeFromRecord,
  computeEffectiveStatus,
  computeActionEffectiveStatus,
  computeDecisionKind,
  computeActionability,
  rankDecisionPriority,
  computeConfidenceExplanation,
  snoozeDecision,
} from '../../src/services/decision-center';
import { buildSkillNotificationFixtureIntent, createNotificationIntent, ensureNotificationTables } from '../../src/services/notification-orchestrator';
import { trackPendingChatConfirmation } from '../../src/services/chat-pending-confirmations';

async function createContentApprovalDecision(userId: number, tenantId: number, dedupeKey: string) {
  const object = createContentWorkflowObject({
    userId,
    tenantId,
    objectType: 'script',
    title: `Draft ${dedupeKey}`,
    editorialState: 'drafted',
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
  testDb.exec(readFileSync('migrations/098_secretary_decision_explanation.sql', 'utf8'));
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
    ensureNotificationTables();
    ensureDecisionCenterTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
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
    expect(listed[0].displayMode).toBe('waiting_on_system');
    expect(listed[0].frontendActionState).toBe('disabled_missing_details');
    expect(listed[0].recommendedAction?.id).toBe('retry');
    expect(listed[0].alternatives.find((option) => option.actionId === 'retry')?.available).toBe(false);
    expect(listed[0].actionTruthTableEntry).toBeNull();
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
    const object = createContentWorkflowObject({
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
    const now = new Date('2026-05-10T10:00:00.000Z').toISOString();
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
        : createContentWorkflowObject({
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
        decisionDeadline: now,
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
      relatedEntityId: null,
      relatedEntityType: null,
      title: 'Decision details',
      body: 'Review this decision.',
    });

    const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 20 });
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
    const object = createContentWorkflowObject({
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
    const object = createContentWorkflowObject({
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

  it('executes content approval actions through Content and read-back verifies state', async () => {
    const object = createContentWorkflowObject({
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
    const object = createContentWorkflowObject({
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

  it('supersedes stale content approval decisions whose source object is missing', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 23, {
      tenantId: 23,
      relatedEntityId: 'script-demo',
      relatedEntityType: 'content_script',
      dedupeKey: 'content:stale-script-demo',
    }));

    expect(listDecisionItems(23, 23)).toHaveLength(0);
    expect(getDecisionItem(created.item!.decisionId, 23, 23)?.status).toBe('superseded');
    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 23, 23, {
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

    const undo = await performDecisionAction(created.item!.decisionId, 'undo_reflow', 42, 42, {
      idempotencyKey: 'undo-secretary-reflow',
    });
    expect(undo.status).toBe('succeeded');
    expect(undo.verification.actualEffect).toMatchObject({
      decisionStatus: 'read',
      secretaryAgendaItemId: 'agenda-42',
      lifecycleState: 'proposed',
      decisionAction: 'deferred',
    });
    const restored = testDb.prepare('SELECT lifecycle_state, decision_action FROM secretary_agenda_items WHERE agenda_item_id = ?').get('agenda-42') as any;
    expect(restored).toMatchObject({ lifecycle_state: 'proposed', decision_action: 'deferred' });
  });

  it('executes Finance payment decisions through tax-event state and read-back verification', async () => {
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

    const result = await performDecisionAction(created.item!.decisionId, 'mark_paid', 43, 43, {
      idempotencyKey: 'mark-tax-paid',
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

  it('denies wrong-user decision list/detail/action access by scope', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 4, {
      dedupeKey: 'content:scope',
    }));

    expect(listDecisionItems(5, 5)).toHaveLength(0);
    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 5, 5, {
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
    expect(workflow.workflow_version).toBe(2);
    expect(workflow.approval_state).toBe('approved');
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

    const { created } = await createContentApprovalDecision(33, 33, 'already-actioned');
    await performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-once' });
    const duplicate = await performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-once' });
    expect(duplicate.status).toBe('idempotent');
    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-twice' }))
      .rejects.toThrow(/already actioned/i);
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
    expect(execution).toMatchObject({ status: 'failed', error_code: 'DECISION_READBACK_MISMATCH' });
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

  it('rejects snooze when the scoped decision update misses the row', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 41, {
      dedupeKey: 'snooze-stale-row',
    }));
    testDb.prepare(`UPDATE notification_center_items SET status = 'dismissed' WHERE item_id = ?`)
      .run(created.item!.decisionId);

    expect(() => snoozeDecision(created.item!.decisionId, 41, 41, 30))
      .toThrow(/scoped update/i);
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
    })).rejects.toThrow(/scoped update/i);

    const execution = testDb.prepare(`
      SELECT status, error_code
      FROM decision_action_executions
      WHERE decision_id = ? AND idempotency_key = 'ignored-final-update'
    `).get(created.item!.decisionId) as { status: string; error_code: string };
    expect(execution).toMatchObject({ status: 'failed', error_code: 'DECISION_READBACK_MISMATCH' });
    const rawDecision = testDb.prepare(`SELECT status FROM notification_center_items WHERE item_id = ?`)
      .get(created.item!.decisionId) as { status: string };
    expect(rawDecision.status).toBe('failed');
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

  it('supersedes content decisions when approval resolves outside Decision Center', async () => {
    const { object, created } = await createContentApprovalDecision(61, 61, 'content-supersession');
    testDb.prepare(`
      UPDATE content_domain_objects
         SET approval_state = 'approved', approved_at = datetime('now')
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

  it('can replay migration 119 without duplicate-column failures', () => {
    const sql = readFileSync('migrations/119_decision_center_facade.sql', 'utf8');
    expect(() => {
      testDb.exec(sql);
      testDb.exec(sql);
    }).not.toThrow();
  });

  it('logs unexpected action failures without serializing original messages', () => {
    const source = readFileSync('src/services/decision-center.ts', 'utf8');
    expect(source).toContain("'Decision action failed'");
    expect(source).toContain('logger.error');
    expect(source).toContain('originalCode');
    expect(source).toContain('originalErrorLogged');
    expect(source).not.toContain('originalMessage:');
    expect(source).toContain('markExecutionFailed(claimed.execution.action_execution_id, error.code, error.details)');

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
    ensureNotificationTables();
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
      setExpiry(created.item!.decisionId, PAST);
    }
    const future = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 60, { dedupeKey: 'a1-sweep-future' }));
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
});

describe('Decision Center layered status (Foundation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
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
    // v1 fields still present/unchanged
    expect(typeof item.status).toBe('string');
    expect(item.frontendActionState).toBeDefined();
    expect(item.displayMode).toBeDefined();
  });
});
