import { describe, expect, it, vi } from 'vitest';
import {
  adviseSecretaryDecision,
  buildDecisionLogicV2,
  evaluateAutopilotPolicy,
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
    expect(decision.quality.missingFields).toContain('concreteCopy');
    expect(decision.quality.missingFields).toContain('relatedEntity');
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
    expect(decision.problemStatement).toContain('Saturday long run');
    expect(decision.recommendation).toContain('Sun, May 17');
    expect(decision.recommendation).not.toContain('2026-05-17T08:00:00.000Z');
    expect(decision.problemStatement).not.toContain('2026-05-16T08:00:00.000Z');
    expect(decision.expectedEffect).toContain('verify');
    expect(decision.why.facts.length).toBeGreaterThan(0);
    expect(decision.whatWillChange[0]).toMatchObject({
      targetSkill: 'secretary',
      verificationMethod: 'Read secretary_agenda_items after the action.',
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
