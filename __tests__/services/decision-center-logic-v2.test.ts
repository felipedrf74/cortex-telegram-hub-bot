import { describe, expect, it, vi } from 'vitest';
import {
  adviseSecretaryDecision,
  buildDecisionLogicV2,
  evaluateAutopilotPolicy,
  formatDecisionWindow,
  rankDecision,
} from '../../src/services/decision-center-logic-v2';

describe('Decision Center Logic v2', () => {
  it('blocks screenshot-style generic Secretary decisions at the quality gate', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Secretary',
      body: 'Secretary needs your attention — open Nexus to view details.',
      safeBody: 'Secretary needs your attention — open Nexus to view details.',
      actions: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
      relatedEntityType: 'calendar_conflict',
      relatedEntityId: null,
      privacyClassification: 'standard',
    });

    expect(decision.quality.status).toBe('needs_enrichment');
    expect(decision.quality.safeToShowUser).toBe(false);
    expect(decision.quality.safeForAPNs).toBe(false);
    expect(decision.quality.safeForFrontendAction).toBe(false);
    expect(decision.displayMode).toBe('details_unavailable');
    expect(decision.frontendActionState).toBe('disabled_missing_details');
    expect(decision.quality.missingFields).toContain('concreteCopy');
    expect(decision.quality.missingFields).toContain('relatedEntity');
    expect(decision.quality.qualityScore).toBe(76);
  });

  it('blocks Secretary conflicts without a distinct recommendation even when raw copy is specific', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Schedule conflict detected',
      body: 'Two calendar items overlap this afternoon.',
      safeBody: 'Open Nexus to review the schedule conflict.',
      actions: [{ id: 'open_detail', label: 'Open details', style: 'primary' }],
      relatedEntityType: 'calendar_conflict',
      relatedEntityId: 'conflict-1',
      privacyClassification: 'standard',
    });

    expect(decision.quality.status).toBe('needs_enrichment');
    expect(decision.quality.safeToShowUser).toBe(false);
    expect(decision.quality.missingFields).toContain('secretaryRecommendation');
  });

  it('passes a concrete Secretary schedule conflict with recommendation, expected effect, and why details', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Long run conflict',
      body: 'Saturday long run conflicts with another event.',
      safeBody: 'Open Nexus to review a schedule recommendation.',
      actions: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      relatedEntityType: 'secretary_agenda_item',
      relatedEntityId: 'agenda-1',
      privacyClassification: 'standard',
      context: {
        entityTitle: 'Saturday long run',
        currentStartAt: '2026-05-16T08:00:00.000Z',
        currentEndAt: '2026-05-16T10:00:00.000Z',
        recommendedStartAt: '2026-05-17T08:00:00.000Z',
        recommendedEndAt: '2026-05-17T10:00:00.000Z',
      },
    });

    expect(decision.quality.status).toBe('pass');
    expect(decision.quality.safeForFrontendAction).toBe(true);
    expect(decision.displayMode).toBe('needs_input');
    expect(decision.frontendActionState).toBe('enabled');
    expect(decision.problemStatement).toContain('Saturday long run');
    expect(decision.recommendation).toContain('Sun, May 17');
    expect(decision.safePreviewBody).toMatch(/Tomorrow|Sun|May|8:00/);
    expect(decision.safePreviewBody).not.toContain('Open Nexus');
    expect(decision.recommendation).not.toContain('2026-05-17T08:00:00.000Z');
    expect(decision.problemStatement).not.toContain('2026-05-16T08:00:00.000Z');
    expect(decision.expectedEffect).toContain('checks that the calendar item is correct');
    expect(decision.why.facts.length).toBeGreaterThan(0);
    expect(decision.whatWillChange[0]).toMatchObject({
      targetSkill: 'secretary',
      verificationMethod: 'Check the calendar item after the action.',
    });
  });

  it('passes concrete content approval and training missing-race-date recipes', () => {
    const content = buildDecisionLogicV2({
      sourceSkill: 'content',
      type: 'approval_required',
      priority: 'active',
      title: 'Script ready',
      body: 'A script is ready for approval.',
      actions: [
        { id: 'approve_script', label: 'Approve', style: 'primary' },
        { id: 'request_rewrite', label: 'Rewrite', style: 'secondary' },
      ],
      relatedEntityType: 'content_workflow_object',
      relatedEntityId: 'content-1',
      privacyClassification: 'private_content',
      context: { entityTitle: 'Wave 1 launch script' },
    });
    expect(content.quality.status).toBe('pass');
    expect(content.safePreviewBody).not.toContain('Wave 1 launch script');

    const training = buildDecisionLogicV2({
      sourceSkill: 'training',
      type: 'decision_required',
      priority: 'active',
      title: 'Training plan needs race date',
      body: 'Add a race date before the next plan update.',
      actions: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
      relatedEntityType: 'training_profile',
      relatedEntityId: 'triathlon-running',
      privacyClassification: 'health',
    });
    expect(training.quality.status).toBe('pass');
    expect(training.primaryActionLabel).toBe('Add race date');
    expect(training.why.rules.join(' ')).toContain('Training');
  });

  it('passes overcapacity priority decisions without requiring a slot reflow recommendation', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Week over capacity',
      body: 'This week has more commitments than available capacity.',
      actions: [
        { id: 'choose_priority', label: 'Protect long run', style: 'primary', mutating: true },
        { id: 'open_detail', label: 'Review details', style: 'secondary' },
      ],
      relatedEntityType: 'capacity_window',
      relatedEntityId: 'week-2026-W20',
      privacyClassification: 'standard',
      context: {
        entityTitle: 'Week of May 18',
        reasonCodes: ['overcapacity'],
        recommendedStartAt: '2026-05-18T15:00:00.000Z',
        recommendedEndAt: '2026-05-18T15:45:00.000Z',
        timezone: 'UTC',
        locale: 'en-US',
      },
    });

    expect(decision.quality.status).toBe('pass');
    expect(decision.title).toBe('Overcapacity decision');
    expect(decision.problemStatement).toContain('over capacity');
    expect(decision.recommendation).toContain('protect first');
    expect(decision.readBackVerifier).toBe('secretary_agenda_item_state');
    expect(decision.autopilotPolicy).toContain('does not silently choose');
    expect(decision.safePreviewBody).toMatch(/Today 3:00 PM \(45 min\)/);
    expect(decision.quality.missingFields).not.toContain('secretaryRecommendation');
  });

  it('passes daily task attention decisions without exposing raw task details or requiring calendar reflow context', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'decision_required',
      priority: 'active',
      title: 'Clear overdue tasks',
      body: '2 overdue tasks and 1 task due today need a short review.',
      safeBody: '2 overdue tasks and 1 task due today need a short review.',
      actions: [
        { id: 'open_detail', label: 'Open overdue tasks', style: 'primary' },
        { id: 'open_today_plan', label: 'Open today\'s plan', style: 'secondary' },
      ],
      relatedEntityType: 'task_attention_day',
      relatedEntityId: '2026-06-17',
      privacyClassification: 'standard',
      context: {
        recipe: 'daily_task_attention',
        sourceState: 'overdue_tasks',
        reasonCodes: ['daily_attention', 'overdue_tasks', 'tasks_due_today'],
        taskCounts: { pending: 3, overdue: 2, dueToday: 1, highPriority: 0 },
        timezone: 'Europe/Lisbon',
      },
    });

    expect(decision.quality.status).toBe('pass');
    expect(decision.quality.safeToShowUser).toBe(true);
    expect(decision.quality.missingFields).not.toContain('secretaryRecommendation');
    expect(decision.displayMode).toBe('needs_input');
    expect(decision.frontendActionState).toBe('enabled');
    expect(decision.title).toBe('Clear overdue tasks');
    expect(decision.primaryActionLabel).toBe('Open overdue tasks');
    expect(decision.recommendation).toContain('Open the overdue list');
    expect(decision.expectedEffect).toContain('without completing or moving anything automatically');
    expect(decision.safePreviewBody).toBe('2 overdue tasks and 1 task due today need a short review.');
    const userFacingText = [
      decision.title,
      decision.problemStatement,
      decision.recommendation,
      decision.expectedEffect,
      decision.safePreviewTitle,
      decision.safePreviewBody,
      decision.primaryActionLabel,
      decision.whySummary,
    ].join(' ');
    expect(userFacingText).not.toMatch(/private task|ms_todo|provider|externalId|undefined|null|NaN|\[object Object\]/i);
  });

  it('passes owner/admin operational decisions only as scoped review items', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'system',
      type: 'risk_warning',
      priority: 'active',
      title: 'Model fallback invalid',
      body: 'A configured fallback needs owner review before release.',
      actions: [{ id: 'open_detail', label: 'Review evidence', style: 'primary' }],
      relatedEntityType: 'ops_model_fallback',
      relatedEntityId: 'fallback-invalid',
      privacyClassification: 'sensitive',
      visibilityScope: 'system_admin',
      context: { entityTitle: 'Model fallback policy' },
    });

    expect(decision.quality.status).toBe('pass');
    expect(decision.visibilityScope).toBe('system_admin');
    expect(decision.title).toBe('Owner operations decision');
    expect(decision.safePreviewTitle).toBe('Owner review needed');
    expect(decision.safePreviewBody).not.toContain('Model fallback policy');
    expect(decision.automationEligibility).toBe('never');
  });

  it('blocks mutating decisions without read-back verifier and privacy metadata', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'system',
      type: 'decision_required',
      priority: 'active',
      title: 'Generic mutation',
      body: 'Do the thing.',
      actions: [{ id: 'accept_reflow', label: 'Accept', style: 'primary' }],
      relatedEntityType: 'thing',
      relatedEntityId: '1',
      privacyClassification: undefined as never,
    });

    expect(decision.quality.safeToShowUser).toBe(false);
    expect(decision.quality.safeForFrontendAction).toBe(false);
    expect(decision.frontendActionState).toBe('disabled_missing_details');
    expect(decision.quality.missingFields).toContain('readBackVerifier');
    expect(decision.quality.missingFields).toContain('privacyClassification');
  });

  it('Secretary advisor offers feasible alternatives and refuses impossible slots', () => {
    const advice = adviseSecretaryDecision({
      title: 'Long run',
      currentStartAt: '2026-05-16T08:00:00.000Z',
      currentEndAt: '2026-05-16T10:00:00.000Z',
      availableSlots: [
        { startAt: '2026-05-17T08:00:00.000Z', endAt: '2026-05-17T10:00:00.000Z', label: 'Sunday morning' },
        { startAt: '2026-05-16T07:00:00.000Z', endAt: '2026-05-16T07:30:00.000Z', label: 'Too short but valid window' },
      ],
      preferredWindowLabel: 'Weekend mornings',
    });
    expect(advice.feasibility).toBe('feasible');
    expect(advice.bestAction).toContain('Sun, May 17');
    expect(advice.bestAction).not.toContain('2026-05-17T08:00:00.000Z');
    expect(advice.recommendedStartAt).toBe('2026-05-17T08:00:00.000Z');
    expect(advice.whyTradeoffs.length).toBeGreaterThan(0);

    const missing = adviseSecretaryDecision({
      title: 'Long run',
      currentStartAt: '2026-05-16T08:00:00.000Z',
      currentEndAt: '2026-05-16T10:00:00.000Z',
      availableSlots: [],
    });
    expect(missing.feasibility).toBe('needs_enrichment');
    expect(missing.bestAction).toContain('Collect schedule context');
  });

  it('Secretary advisor refuses self-move slots that match the current window', () => {
    const advice = adviseSecretaryDecision({
      title: 'Long run',
      currentStartAt: '2026-05-16T08:00:00.000Z',
      currentEndAt: '2026-05-16T10:00:00.000Z',
      availableSlots: [
        { startAt: '2026-05-16T08:00:00.000Z', endAt: '2026-05-16T10:00:00.000Z', label: 'Current slot' },
      ],
    });

    expect(advice.feasibility).toBe('needs_enrichment');
    expect(advice.recommendedStartAt).toBeNull();
    expect(advice.bestAction).toContain('Collect schedule context');
  });

  it('Secretary advisor ranks preferred feasible slots over first insertion order', () => {
    const advice = adviseSecretaryDecision({
      title: 'Focus block',
      currentStartAt: '2026-05-20T09:00:00.000Z',
      currentEndAt: '2026-05-20T11:00:00.000Z',
      availableSlots: [
        { startAt: '2026-05-20T12:00:00.000Z', endAt: '2026-05-20T14:00:00.000Z', label: 'Open midday buffer' },
        { startAt: '2026-05-20T15:00:00.000Z', endAt: '2026-05-20T17:00:00.000Z', label: 'Preferred afternoon focus' },
      ],
      preferredWindowLabel: 'afternoon focus',
      reasonCodes: ['overcapacity'],
    });

    expect(advice.recommendedStartAt).toBe('2026-05-20T15:00:00.000Z');
    expect(advice.whyTradeoffs[0]).toContain('matches the preferred window');
    expect(advice.alternatives[0].startAt).toBe('2026-05-20T12:00:00.000Z');
  });

  it('Secretary advisor penalizes protected slot metadata even when labels are generic', () => {
    const advice = adviseSecretaryDecision({
      title: 'Focus block',
      currentStartAt: '2026-05-20T09:00:00.000Z',
      currentEndAt: '2026-05-20T11:00:00.000Z',
      availableSlots: [
        { startAt: '2026-05-20T12:00:00.000Z', endAt: '2026-05-20T14:00:00.000Z', label: 'Slot A', classification: 'sleep' },
        { startAt: '2026-05-20T15:00:00.000Z', endAt: '2026-05-20T17:00:00.000Z', label: 'Slot B' },
      ],
    });

    expect(advice.recommendedStartAt).toBe('2026-05-20T15:00:00.000Z');
    expect(advice.alternatives[0].tradeoff).toContain('touches a protected window');
  });

  it('formats decision windows with caller timezone and locale using cached Intl formatters', () => {
    const utc = formatDecisionWindow(
      '2026-05-17T08:00:00.000Z',
      '2026-05-17T10:00:00.000Z',
      'UTC',
      'en-US',
    );
    const newYork = formatDecisionWindow(
      '2026-05-17T08:00:00.000Z',
      '2026-05-17T10:00:00.000Z',
      'America/New_York',
      'en-US',
    );
    const portuguese = formatDecisionWindow(
      '2026-05-17T08:00:00.000Z',
      '2026-05-17T10:00:00.000Z',
      'Europe/Lisbon',
      'pt-BR',
    );

    expect(utc).toContain('08:00-10:00');
    expect(newYork).toContain('04:00-06:00');
    expect(newYork).not.toBe(utc);
    expect(portuguese).toContain('09:00-11:00');
    expect(portuguese).not.toContain('Sun, May');
  });

  it('autopilot safely retries sync but does not move workouts or approve content by default', () => {
    const sync = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'sync_failure',
      priority: 'active',
      title: 'Calendar sync incomplete',
      body: 'Outlook sync did not complete.',
      actions: [{ id: 'retry', label: 'Retry sync', style: 'primary' }],
      relatedEntityType: null,
      relatedEntityId: null,
      privacyClassification: 'standard',
      context: { providerName: 'Outlook', explicitNoRelatedEntityReason: 'sync failure is scoped to provider state' },
    });
    expect(evaluateAutopilotPolicy({
      sourceSkill: 'secretary',
      type: 'sync_failure',
      priority: 'active',
      title: 'Calendar sync incomplete',
      body: 'Outlook sync did not complete.',
      actions: [{ id: 'retry', label: 'Retry sync', style: 'primary' }],
      privacyClassification: 'standard',
      context: { explicitNoRelatedEntityReason: 'sync failure is scoped to provider state' },
    }, sync).eligibility).toBe('safe_auto_handle');

    const reflow = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Schedule conflict',
      body: 'Move a run.',
      actions: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      relatedEntityType: 'secretary_agenda_item',
      relatedEntityId: 'agenda',
      privacyClassification: 'standard',
      context: {
        entityTitle: 'Long run',
        currentStartAt: '2026-05-16T08:00:00.000Z',
        currentEndAt: '2026-05-16T10:00:00.000Z',
      },
    });
    expect(evaluateAutopilotPolicy({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Schedule conflict',
      body: 'Move a run.',
      actions: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      relatedEntityType: 'secretary_agenda_item',
      relatedEntityId: 'agenda',
      privacyClassification: 'standard',
    }, reflow).eligibility).toBe('ask_first');
  });

  it('ranks urgent concrete decisions above optional decisions and excludes optional APNs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T10:00:00.000Z'));
    const urgent = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Schedule conflict',
      body: 'Conflict.',
      actions: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      relatedEntityType: 'secretary_agenda_item',
      relatedEntityId: 'agenda',
      privacyClassification: 'standard',
      deadlineAt: '2026-05-12T18:00:00.000Z',
      context: {
        entityTitle: 'Long run',
        currentStartAt: '2026-05-12T18:00:00.000Z',
        currentEndAt: '2026-05-12T20:00:00.000Z',
        recommendedStartAt: '2026-05-12T20:30:00.000Z',
        recommendedEndAt: '2026-05-12T22:00:00.000Z',
      },
    });
    const optional = buildDecisionLogicV2({
      sourceSkill: 'cooking',
      type: 'decision_required',
      priority: 'passive',
      title: 'Optional meal idea',
      body: 'Add a snack.',
      actions: [{ id: 'add_meal', label: 'Add meal', style: 'primary' }],
      relatedEntityType: 'meal_plan',
      relatedEntityId: 'snack',
      privacyClassification: 'standard',
    });
    const urgentRank = rankDecision({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Schedule conflict',
      body: 'Conflict.',
      actions: [{ id: 'accept_reflow', label: 'Reflow', style: 'primary' }],
      relatedEntityType: 'secretary_agenda_item',
      relatedEntityId: 'agenda',
      privacyClassification: 'standard',
      deadlineAt: '2026-05-12T18:00:00.000Z',
    }, urgent, urgent.quality);
    const optionalRank = rankDecision({
      sourceSkill: 'cooking',
      type: 'decision_required',
      priority: 'passive',
      title: 'Optional meal idea',
      body: 'Add a snack.',
      actions: [{ id: 'add_meal', label: 'Add meal', style: 'primary' }],
      relatedEntityType: 'meal_plan',
      relatedEntityId: 'snack',
      privacyClassification: 'standard',
    }, optional, optional.quality);
    expect(urgentRank.priorityScore).toBeGreaterThan(optionalRank.priorityScore);
    expect(urgentRank.apnsEligible).toBe(true);
    expect(optionalRank.apnsEligible).toBe(false);
    vi.useRealTimers();
  });

  it('requires explicit mutating actions to declare read-back verification even for unknown action ids', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'system',
      type: 'decision_required',
      priority: 'active',
      title: 'Confirm account update',
      body: 'Confirm this scoped account update.',
      actions: [{ id: 'confirm_account_update', label: 'Confirm update', style: 'primary', mutating: true }],
      relatedEntityType: 'account_setting',
      relatedEntityId: 'setting-1',
      privacyClassification: 'sensitive',
    });

    expect(decision.quality.safeToShowUser).toBe(false);
    expect(decision.quality.missingFields).toContain('readBackVerifier');
  });

  it('defaults rankDecision to no Home/APNs eligibility when quality is omitted', () => {
    const ranked = rankDecision({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Schedule conflict',
      body: 'Conflict.',
      actions: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
      relatedEntityType: 'secretary_agenda_item',
      relatedEntityId: 'agenda',
      privacyClassification: 'standard',
    }, {
      confidence: 0.9,
      riskIfIgnored: 'high',
      automationEligibility: 'ask_first',
    });

    expect(ranked.apnsEligible).toBe(false);
    expect(ranked.homeVisible).toBe(false);
  });

  it('rejects generic titles even when the body is otherwise concrete', () => {
    const decision = buildDecisionLogicV2({
      sourceSkill: 'system',
      type: 'decision_required',
      priority: 'active',
      title: 'Review',
      body: 'Confirm whether this account setting should be updated.',
      actions: [{ id: 'open_detail', label: 'Open details', style: 'primary' }],
      relatedEntityType: 'account_setting',
      relatedEntityId: 'setting-1',
      privacyClassification: 'sensitive',
    });

    expect(decision.quality.safeToShowUser).toBe(false);
    expect(decision.quality.missingFields).toContain('title');
  });

  it('keeps the v2 feature flag conservative when disabled', () => {
    const previous = process.env.DECISION_CENTER_LOGIC_V2_ENABLED;
    process.env.DECISION_CENTER_LOGIC_V2_ENABLED = 'false';
    try {
      const decision = buildDecisionLogicV2({
        sourceSkill: 'secretary',
        type: 'conflict_detected',
        priority: 'time_sensitive',
        title: 'Secretary',
        body: 'Secretary needs your attention — open Nexus to view details.',
        actions: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
        relatedEntityType: null,
        relatedEntityId: null,
        privacyClassification: 'standard',
      });

      expect(decision.quality.status).toBe('pass');
      expect(decision.quality.reason).toContain('disabled');
      expect(decision.notificationEligibility).toBe('digest');
      expect(decision.quality.safeForAPNs).toBe(false);
      expect(decision.displayMode).toBe('needs_input');
    } finally {
      if (previous == null) delete process.env.DECISION_CENTER_LOGIC_V2_ENABLED;
      else process.env.DECISION_CENTER_LOGIC_V2_ENABLED = previous;
    }
  });

  it('localizes all Decision Center v2 recipe prose for Portuguese locales', () => {
    const secretary = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      title: 'Long run conflict',
      body: 'Saturday long run conflicts with another event.',
      actions: [{ id: 'accept_reflow', label: 'Reorganizar', style: 'primary' }],
      relatedEntityType: 'secretary_agenda_item',
      relatedEntityId: 'agenda-pt',
      privacyClassification: 'standard',
      context: {
        entityTitle: 'Longão de sábado',
        currentStartAt: '2026-05-16T08:00:00.000Z',
        currentEndAt: '2026-05-16T10:00:00.000Z',
        recommendedStartAt: '2026-05-17T08:00:00.000Z',
        recommendedEndAt: '2026-05-17T10:00:00.000Z',
        locale: 'pt-PT',
        timezone: 'Europe/Lisbon',
      },
    });
    expect(secretary.problemStatement).toContain('precisa de uma decisão de agenda');
    expect(secretary.recommendation).toContain('escolha outro horário viável');
    expect(secretary.safePreviewBody).toMatch(/Amanhã|17\/05/);
    expect(secretary.safePreviewBody).toContain('09:00');
    expect(secretary.safePreviewBody).not.toContain('Abra o Nexus');

    const training = buildDecisionLogicV2({
      sourceSkill: 'training',
      type: 'missing_input',
      priority: 'active',
      title: 'Training plan needs race date',
      body: 'Race date is missing.',
      actions: [{ id: 'open_detail', label: 'Adicionar data', style: 'primary' }],
      relatedEntityType: null,
      relatedEntityId: null,
      privacyClassification: 'health',
      context: {
        explicitNoRelatedEntityReason: 'training profile is the affected entity',
        locale: 'pt-BR',
      },
    });
    expect(training.problemStatement).toContain('data da prova');
    expect(training.primaryActionLabel).toContain('Adicionar');

    const sync = buildDecisionLogicV2({
      sourceSkill: 'secretary',
      type: 'sync_failure',
      priority: 'active',
      title: 'Calendar sync incomplete',
      body: 'Outlook sync did not complete.',
      actions: [{ id: 'retry', label: 'Tentar sincronizar', style: 'primary' }],
      relatedEntityType: null,
      relatedEntityId: null,
      privacyClassification: 'standard',
      context: {
        providerName: 'Outlook',
        explicitNoRelatedEntityReason: 'sync failure is scoped to provider state',
        locale: 'pt-PT',
      },
    });
    expect(sync.problemStatement).toContain('não foi concluída');
    expect(sync.whySummary).toContain('sincronização com falha');

    const content = buildDecisionLogicV2({
      sourceSkill: 'content',
      type: 'approval_required',
      priority: 'active',
      title: 'Script ready',
      body: 'A script is ready for approval.',
      actions: [{ id: 'approve_script', label: 'Review', style: 'primary' }],
      relatedEntityType: 'content_workflow_object',
      relatedEntityId: 'content-pt',
      privacyClassification: 'private_content',
      context: {
        entityTitle: 'Roteiro semanal',
        locale: 'pt-PT',
      },
    });
    expect(content.title).toBe('Revisão de conteúdo');
    expect(content.problemStatement).toContain('pronto para aprovação');
    expect(content.primaryActionLabel).toBe('Aprovar');
    expect(content.safePreviewBody).toContain('aguarda aprovação');

    const finance = buildDecisionLogicV2({
      sourceSkill: 'finance',
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Payment due',
      body: 'A payment needs confirmation.',
      actions: [{ id: 'mark_paid', label: 'Review', style: 'primary' }],
      relatedEntityType: 'finance_transaction',
      relatedEntityId: 'finance-pt',
      privacyClassification: 'financial',
      context: { locale: 'pt-BR' },
    });
    expect(finance.title).toBe('Decisão financeira');
    expect(finance.problemStatement).toContain('item financeiro');
    expect(finance.primaryActionLabel).toBe('Confirmar');
    expect(finance.safePreviewBody).toContain('decisão financeira');

    const cooking = buildDecisionLogicV2({
      sourceSkill: 'cooking',
      type: 'decision_required',
      priority: 'active',
      title: 'Meal choice',
      body: 'Choose a meal update.',
      actions: [{ id: 'add_meal', label: 'Review', style: 'primary' }],
      relatedEntityType: 'meal_plan',
      relatedEntityId: 'meal-pt',
      privacyClassification: 'standard',
      context: { locale: 'pt-PT' },
    });
    expect(cooking.problemStatement).toContain('refeição');
    expect(cooking.primaryActionLabel).toBe('Adicionar refeição');
    expect(cooking.whatWillChange[0]?.verificationMethod).toContain('plano de refeições');

    const chat = buildDecisionLogicV2({
      sourceSkill: 'chat',
      type: 'decision_required',
      priority: 'active',
      title: 'Choose option',
      body: 'A chat action needs a choice.',
      actions: [{ id: 'option_a', label: 'Review', style: 'primary' }],
      relatedEntityType: 'chat_confirmation',
      relatedEntityId: 'chat-pt',
      privacyClassification: 'standard',
      context: { locale: 'pt-BR' },
    });
    expect(chat.title).toContain('Nexus precisa');
    expect(chat.problemStatement).toContain('ação do chat');
    expect(chat.safePreviewBody).toContain('Abra o Nexus');

    const generic = buildDecisionLogicV2({
      sourceSkill: 'system',
      type: 'decision_required',
      priority: 'active',
      title: 'Deployment choice',
      body: 'A deployment choice needs review.',
      safeBody: 'Resumo seguro.',
      actions: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
      relatedEntityType: 'system_decision',
      relatedEntityId: 'generic-pt',
      privacyClassification: 'standard',
      context: { locale: 'pt-PT' },
    });
    expect(generic.recommendation).toContain('Abra');
    expect(generic.whySummary).toContain('julgamento do usuário');
    expect(generic.safePreviewBody).toBe('Resumo seguro.');
  });

  it('localizes and redacts legacy fallback decisions when v2 is disabled', () => {
    const previous = process.env.DECISION_CENTER_LOGIC_V2_ENABLED;
    process.env.DECISION_CENTER_LOGIC_V2_ENABLED = 'false';
    try {
      const legacy = buildDecisionLogicV2({
        sourceSkill: 'finance',
        type: 'decision_required',
        priority: 'active',
        title: 'Pay $4,200 to Therapy Center',
        body: 'Pay $4,200 to Therapy Center before Friday.',
        actions: [{ id: 'mark_paid', label: 'Review', style: 'primary' }],
        relatedEntityType: null,
        relatedEntityId: null,
        privacyClassification: 'financial',
        context: {
          locale: 'pt-BR',
          explicitNoRelatedEntityReason: 'legacy fallback test',
        },
      });

      const rendered = [
        legacy.problemStatement,
        legacy.safePreviewTitle,
        legacy.safePreviewBody,
        legacy.recommendation,
        ...legacy.why.facts,
      ].join(' ');
      expect(legacy.problemStatement).toBe('Abra o Nexus para revisar esta decisão.');
      expect(legacy.safePreviewTitle).toBe('Decisão financeira');
      expect(legacy.safePreviewBody).toBe('Abra o Nexus para revisar esta decisão.');
      expect(legacy.recommendation).toContain('Abra');
      expect(rendered).not.toContain('4,200');
      expect(rendered).not.toContain('Therapy Center');
      expect(legacy.quality.safeForAPNs).toBe(false);
    } finally {
      if (previous == null) delete process.env.DECISION_CENTER_LOGIC_V2_ENABLED;
      else process.env.DECISION_CENTER_LOGIC_V2_ENABLED = previous;
    }
  });

  it('pins recipe confidence tiers so tuning is visible in review', () => {
    const cases = [
      buildDecisionLogicV2({
        sourceSkill: 'content',
        type: 'approval_required',
        priority: 'active',
        title: 'Script ready',
        body: 'A script is ready for approval.',
        actions: [{ id: 'approve_script', label: 'Approve', style: 'primary' }],
        relatedEntityType: 'content_workflow_object',
        relatedEntityId: 'content-1',
        privacyClassification: 'private_content',
      }).confidence,
      buildDecisionLogicV2({
        sourceSkill: 'chat',
        type: 'decision_required',
        priority: 'active',
        title: 'Choose option',
        body: 'A chat action needs a choice.',
        actions: [{ id: 'option_a', label: 'Option A', style: 'primary' }],
        relatedEntityType: 'chat_confirmation',
        relatedEntityId: 'chat-1',
        privacyClassification: 'standard',
      }).confidence,
      buildDecisionLogicV2({
        sourceSkill: 'secretary',
        type: 'sync_failure',
        priority: 'active',
        title: 'Calendar sync incomplete',
        body: 'Outlook sync did not complete.',
        actions: [{ id: 'retry', label: 'Retry sync', style: 'primary' }],
        relatedEntityType: null,
        relatedEntityId: null,
        privacyClassification: 'standard',
        context: { providerName: 'Outlook', explicitNoRelatedEntityReason: 'sync failure is scoped to provider state' },
      }).confidence,
    ];

    expect(cases).toEqual([0.88, 0.82, 0.78]);
  });
});
