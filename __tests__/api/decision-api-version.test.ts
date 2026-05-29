import { afterEach, describe, expect, it } from 'vitest';
import type { AuthenticatedRequest } from '../../src/api/auth-middleware';
import type { DecisionApiItem } from '../../src/services/decision-center';
import { buildDecisionCardSummary, resolveDecisionApiVersion } from '../../src/api/decision-api-version';

const reqWith = (header?: string, userId = 1): AuthenticatedRequest =>
  ({ headers: header ? { 'x-nexus-api-version': header } : {}, userId }) as unknown as AuthenticatedRequest;

const fullItem = (): DecisionApiItem => ({
  decisionId: 'd1',
  sourceSkill: 'training',
  type: 'decision_required',
  status: 'unread',
  effectiveStatus: 'needs_action',
  decisionKind: 'action_proposal',
  actionability: 'confirmation_required',
  urgency: 'today',
  timingLabel: 'Today',
  priorityScore: 70,
  sectionKey: 'today',
  groupKey: 'training:d1',
  displayMode: 'needs_input',
  frontendActionState: 'enabled',
  impactLevel: 'medium',
  safePreviewTitle: 'Move your session',
  safePreviewBody: 'It conflicts with a meeting.',
  recommendedActionLabel: 'Review options',
  primaryActionLabel: 'Review',
  deadlineAt: null,
  expiresAt: null,
  badgeContribution: true,
  confidence: 0.82,
  // many other full-item fields omitted — the projection must not require them
}) as unknown as DecisionApiItem;

describe('Decision API version negotiation', () => {
  afterEach(() => {
    delete process.env.DECISION_API_V2_ENABLED;
  });

  it('defaults to v1 unless the client asks for v2 AND the flag is opt-in', () => {
    expect(resolveDecisionApiVersion(reqWith()).version).toBe('v1');

    // header v2 but flag OFF → still v1
    expect(resolveDecisionApiVersion(reqWith('v2')).version).toBe('v1');

    // flag ON but no header → v1
    process.env.DECISION_API_V2_ENABLED = 'true';
    expect(resolveDecisionApiVersion(reqWith()).version).toBe('v1');

    // header v2 + flag ON → v2
    const v2 = resolveDecisionApiVersion(reqWith('v2'));
    expect(v2.version).toBe('v2');
    expect(v2.schemaVersion).toBe('decision-center.v2');
    expect(resolveDecisionApiVersion(reqWith()).schemaVersion).toBe('decision-center.v1');
  });

  it('projects a full item to a compact v2 card', () => {
    const card = buildDecisionCardSummary(fullItem());
    expect(card.schemaVersion).toBe('decision-center.v2');
    expect(card.decisionId).toBe('d1');
    expect(card.effectiveStatus).toBe('needs_action');
    expect(card.decisionKind).toBe('action_proposal');
    expect(card.actionability).toBe('confirmation_required');
    expect(card.safePreviewTitle).toBe('Move your session');
    expect(card.confidence).toBe(0.82);
    // the card is compact: full-only fields are not carried over
    expect((card as Record<string, unknown>).whyDetails).toBeUndefined();
    expect((card as Record<string, unknown>).explanation).toBeUndefined();
    expect((card as Record<string, unknown>).actionTruthTableEntry).toBeUndefined();
  });
});
