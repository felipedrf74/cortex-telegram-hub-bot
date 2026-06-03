import { afterEach, describe, expect, it } from 'vitest';
import type { AuthenticatedRequest } from '../../src/api/auth-middleware';
import type { DecisionApiItem } from '../../src/services/decision-center';
import { buildDecisionCardSummary, deriveEvidenceStrengthLabel, resolveDecisionApiVersion } from '../../src/api/decision-api-version';

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
  recommendedAction: { id: 'accept_reflow', label: 'Review options', style: 'primary' },
  alternativeActions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
  actionEffectiveStatuses: [
    { actionId: 'accept_reflow', effective: 'enabled', implemented: true, capabilityReason: null },
    { actionId: 'dismiss', effective: 'enabled', implemented: true, capabilityReason: null },
  ],
  analysis: {
    whyNow: 'The current slot conflicts with a protected session.',
    costOfDelay: 'Waiting risks losing the safer window.',
  },
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
    expect(card.whyNow).toBe('The current slot conflicts with a protected session.');
    expect(card.costOfDelay).toBe('Waiting risks losing the safer window.');
    expect(card.primaryAction).toMatchObject({
      actionId: 'accept_reflow',
      label: 'Review options',
      effectiveStatus: 'enabled',
      implemented: true,
    });
    expect(card.secondaryActions?.[0]).toMatchObject({
      actionId: 'dismiss',
      label: 'Dismiss',
      effectiveStatus: 'enabled',
    });
    // the card is compact: full-only fields are not carried over
    expect((card as Record<string, unknown>).whyDetails).toBeUndefined();
    expect((card as Record<string, unknown>).explanation).toBeUndefined();
    expect((card as Record<string, unknown>).actionTruthTableEntry).toBeUndefined();
  });
});

describe('Card evidence-strength label (API v2)', () => {
  it('derives a compact label where stale/unknown freshness dominates confidence', () => {
    expect(deriveEvidenceStrengthLabel(undefined)).toBeUndefined();
    expect(deriveEvidenceStrengthLabel({ label: 'high', sourceFreshness: 'fresh' })).toBe('strong');
    expect(deriveEvidenceStrengthLabel({ label: 'medium', sourceFreshness: 'live' })).toBe('moderate');
    expect(deriveEvidenceStrengthLabel({ label: 'low', sourceFreshness: 'fresh' })).toBe('weak');
    // freshness dominates: even high-confidence stale evidence is labelled 'stale', unknown -> 'unverified'.
    expect(deriveEvidenceStrengthLabel({ label: 'high', sourceFreshness: 'stale' })).toBe('stale');
    expect(deriveEvidenceStrengthLabel({ label: 'high', sourceFreshness: 'unknown' })).toBe('unverified');
  });

  it('carries the label onto the card only when the item has a confidenceExplanation', () => {
    // fullItem() has no confidenceExplanation -> the label is omitted (Codable-stable).
    expect((buildDecisionCardSummary(fullItem()) as Record<string, unknown>).evidenceStrengthLabel).toBeUndefined();
    const withConfidence = { ...fullItem(), confidenceExplanation: { value: 0.9, label: 'high', basis: [], uncertainty: [], sourceFreshness: 'fresh' } } as unknown as DecisionApiItem;
    expect(buildDecisionCardSummary(withConfidence).evidenceStrengthLabel).toBe('strong');
  });
});
