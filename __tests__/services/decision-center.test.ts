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
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  DECISION_OUTCOME_LEDGER_RETENTION_POLICY,
  dismissDecision,
  ensureDecisionCenterTables,
  evaluateDecisionEligibility,
  getDecisionItem,
  getDecisionOutcomeMetrics,
  getDecisionSummary,
  listDecisionDependencies,
  listDecisionItems,
  performDecisionAction,
  runDecisionSourceStateSupersessionJob,
  snoozeDecision,
} from '../../src/services/decision-center';
import { buildSkillNotificationFixtureIntent, ensureNotificationTables } from '../../src/services/notification-orchestrator';
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

function ensureSecretaryAgendaFixtureTables(): void {
  testDb.exec(readFileSync('migrations/083_secretary_agenda_ledger.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/098_secretary_decision_explanation.sql', 'utf8'));
}

function ensureUserFixtureTable(): void {
  testDb.exec(readFileSync('migrations/030_users.sql', 'utf8'));
}

function ensureFinanceFixtureTables(): void {
  testDb.exec(readFileSync('migrations/022_finance_tables.sql', 'utf8'));
  testDb.exec(`
    ALTER TABLE finance_tax_events ADD COLUMN encrypted_gross_income TEXT;
    ALTER TABLE finance_tax_events ADD COLUMN encrypted_deductions TEXT;
    ALTER TABLE finance_tax_events ADD COLUMN encrypted_taxable_income TEXT;
    ALTER TABLE finance_tax_events ADD COLUMN encrypted_tax_due TEXT;
    ALTER TABLE finance_tax_events ADD COLUMN encrypted_inss_due TEXT;
    ALTER TABLE finance_tax_events ADD COLUMN encrypted_notes TEXT;
  `);
}

function ensureCookingFixtureTables(): void {
  testDb.exec(readFileSync('migrations/024_cooking_tables.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/088_skill_memory_foundation.sql', 'utf8'));
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

    const summary = getDecisionSummary(1, 1);
    expect(summary.openCount).toBe(1);
    expect(summary.urgentCount).toBe(0);
    expect(summary.ctaLabel).toBe('1 Decision');
    expect(summary.previewItems).toHaveLength(1);
    expect(summary.previewItems[0].safePreviewBody).not.toContain('Calendar details');
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
      sourceTraceSummary: expect.stringContaining('Decision Center v2'),
      dependencyGraphSummary: null,
    });
    expect(listed[0].alternatives.some((option) => option.rank === 'best')).toBe(true);
    expect(listed[0].alternatives.find((option) => option.rank === 'best')?.source).toBe('recipe');
    expect(listed[0].alternatives.find((option) => option.actionId === 'snooze')?.source).toBe('system_default');
    expect(listed[0].alternatives.find((option) => option.actionId === 'dismiss')?.source).toBe('system_default');
    expect(listed[0].relatedEntitiesSafe[0]).toMatchObject({ type: 'calendar_conflict' });
    expect(listed[0].sourceTrace).toMatchObject({
      originatingSkill: 'secretary',
      originatingSignal: 'conflict_detected',
      enrichmentService: 'decision-center-logic-v2',
    });
    expect(listed[0].actionTruthTableEntry).toMatchObject({
      actionType: 'open_detail',
      verifier: null,
      analyticsEvent: 'decision_action:secretary:open_detail',
    });
    expect(listed[0].askNexusContext.prompt).toContain('Secretary');
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
    expect(listed[0].actionTruthTableEntry).toMatchObject({
      actionType: 'retry',
      executor: 'provider-sync',
      successUi: 'Action unavailable until a deterministic executor is wired.',
      retryAvailable: false,
      apnsActionAllowed: false,
    });
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

    expect(created.item).not.toBeNull();
    expect(created.item?.visibilityScope).toBe('system_admin');
    expect(created.item?.title).toBe('Owner operations decision');
    expect(created.item?.safePreviewTitle).toBe('Owner review needed');

    const listed = listDecisionItems(91, 91);
    expect(listed).toHaveLength(1);
    expect(listed[0].visibilityScope).toBe('system_admin');
    expect(listed[0].safePreviewBody).not.toContain('Model fallback policy');
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

    const result = await performDecisionAction(created.item!.decisionId, 'approve_script', 2, 2, {
      idempotencyKey: 'tap-1',
    });
    expect(result.status).toBe('succeeded');
    expect(result.verification.readBackOk).toBe(true);
    expect(result.item.status).toBe('actioned');
    expect(result.item.outcomeSummary).toContain('content workflow');
    expect(result.verification.actualEffect.contentApprovalState).toBe('approved');

    const duplicate = await performDecisionAction(created.item!.decisionId, 'approve_script', 2, 2, {
      idempotencyKey: 'tap-1',
    });
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.status).toBe('idempotent');
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
      INSERT INTO finance_tax_events (user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due, status, darf_code)
      VALUES (43, '2026-05', 5000, 0, 5000, 450, 0, 'pending', '0190')
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
      snoozedCount: 1,
      explanationOpenCount: 0,
      genericBlockedCount: 1,
      primaryActionCount: 3,
      failedActionCount: 0,
      partialFailureCount: 0,
      primaryActionRate: 1,
      dismissRate: 0.3333,
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
      SELECT title, action_taken, privacy_classification
      FROM handled_by_nexus_items
      WHERE decision_id = ?
    `).get(created.item!.decisionId) as { title: string; action_taken: string; privacy_classification: string };
    expect(handled).toMatchObject({
      title: 'Content review',
      action_taken: 'auto_dismiss_stale_decision',
      privacy_classification: 'private_content',
    });
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
