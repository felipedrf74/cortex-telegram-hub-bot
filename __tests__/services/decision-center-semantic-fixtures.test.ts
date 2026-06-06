import { describe, expect, it } from 'vitest';
import { decisionSemanticFixtures } from '../fixtures/decision-center/semantic-fixtures';
import { buildDecisionLogicV2 } from '../../src/services/decision-center-logic-v2';
import {
  isDecisionActionExecutable,
  listDecisionActionTruthTable,
} from '../../src/services/decision-center-action-truth-table';

const GENERIC_USER_FACING_COPY = [
  /^Secretary$/i,
  /^Review$/i,
  /needs your attention/i,
  /open Nexus to view details/i,
  /Nexus found a schedule or capacity conflict/i,
];

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

describe('Decision Center semantic fixture pack', () => {
  it('has stable unique fixture ids across the required product matrix', () => {
    const ids = decisionSemanticFixtures.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'training-long-run-conflict',
      'training-missing-race-date',
      'content-approval-due',
      'cooking-fueling-suggestion',
      'finance-payment-reminder-private',
      'chat-clarification-subtasks',
      'calendar-sync-partial-failure',
      'generic-invalid-secretary-attention',
      'handled-by-nexus-calendar-retry',
      'owner-admin-model-fallback-invalid',
      'overcapacity-week-priority-choice',
      'stale-superseded-decision',
      'offline-details-unavailable',
      'user-switch-privacy-redacted',
    ]);
  });

  it('pins quality-gate behavior, concrete UI copy, privacy, and source-trace expectations', () => {
    for (const fixture of decisionSemanticFixtures) {
      const logic = buildDecisionLogicV2(fixture.intent);
      expect(logic.quality.status, fixture.id).toBe(fixture.expected.qualityStatus);
      expect(logic.quality.safeToShowUser, fixture.id).toBe(fixture.expected.userFacing);
      expect(logic.privacyClassification, fixture.id).toBe(fixture.expected.privacy.classification);
      expect(logic.visibilityScope, fixture.id).toBe(fixture.expected.privacy.visibilityScope);

      if (fixture.expected.userFacing) {
        expect(logic.title, fixture.id).toContain(fixture.expected.card.title);
        expect(logic.problemStatement, fixture.id).toContain(fixture.expected.card.problemIncludes);
        expect(logic.recommendation, fixture.id).toContain(fixture.expected.card.recommendationIncludes);
        expect(logic.why.rules.join(' ').toLowerCase(), fixture.id).toContain(fixture.expected.detail.whyRuleIncludes.toLowerCase());
        expect(matchesAny(logic.problemStatement, GENERIC_USER_FACING_COPY), fixture.id).toBe(false);
        expect(matchesAny(logic.recommendation, GENERIC_USER_FACING_COPY), fixture.id).toBe(false);
      } else {
        expect(logic.displayMode, fixture.id).toBe('details_unavailable');
        expect(logic.frontendActionState, fixture.id).toBe('disabled_missing_details');
      }

      if (fixture.expected.detail.whatWillChangeTarget) {
        expect(logic.whatWillChange.some((change) => change.targetSkill === fixture.expected.detail.whatWillChangeTarget), fixture.id).toBe(true);
      }

      for (const privateNeedle of fixture.expected.privacy.safePreviewMustNotContain) {
        expect(logic.safePreviewTitle, fixture.id).not.toContain(privateNeedle);
        expect(logic.safePreviewBody, fixture.id).not.toContain(privateNeedle);
      }

      if (fixture.expected.apnsEligibility === 'blocked') {
        expect(logic.quality.safeForAPNs, fixture.id).toBe(false);
      }
      if (fixture.expected.apnsEligibility === 'visible_allowed') {
        expect(logic.quality.safeForAPNs, fixture.id).toBe(true);
      }

      expect(fixture.sourceTrace.originatingSkill, fixture.id).toBe(fixture.intent.sourceSkill);
      expect(fixture.sourceTrace.originatingSignal, fixture.id).toBe(fixture.intent.type);
      if (fixture.expected.action.outcome !== 'handled_history') {
        expect(fixture.sourceTrace.verifier, fixture.id).toBe(fixture.expected.action.verifier);
      }
    }
  });

  it('separates fixture-only unsupported actions from executable user-facing actions', () => {
    for (const fixture of decisionSemanticFixtures) {
      const primaryActionId = fixture.expected.action.primaryActionId;
      if (!primaryActionId) continue;
      if (fixture.expected.action.outcome === 'disabled' && fixture.productionStatus === 'fixture_only') {
        expect(isDecisionActionExecutable(primaryActionId), fixture.id).toBe(false);
      } else if (fixture.expected.userFacing && fixture.expected.action.outcome !== 'disabled') {
        expect(isDecisionActionExecutable(primaryActionId), fixture.id).toBe(true);
      }
    }
  });

  it('keeps every implemented mutating action backed by a verifier and honest UI states', () => {
    const entries = listDecisionActionTruthTable();
    expect(entries.length).toBeGreaterThan(10);
    for (const entry of entries) {
      if (entry.implemented && entry.mutating) {
        expect(entry.verifier, entry.actionType).toBeTruthy();
        expect(entry.successUi, entry.actionType).not.toMatch(/fake|pretend/i);
      }
      if (!entry.implemented) {
        expect(entry.retryAvailable, entry.actionType).toBe(false);
        expect(entry.apnsActionAllowed, entry.actionType).toBe(false);
      }
    }
  });
});
