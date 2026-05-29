import { describe, expect, it } from 'vitest';

import {
  COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
  validateComposedAnswerDraft,
  type ComposedAnswerDraft,
  type EvidenceBoundFactualClaim,
} from '../../src/services/chat-core-v2/answer-composition';
import {
  CHAT_CORE_V2_BACKFILL_EVIDENCE_ID_CAP,
  CHAT_CORE_V2_MAX_PROMPT_EVIDENCE_CHARS,
  CHAT_CORE_V2_UNTRUSTED_EVIDENCE_END,
  CHAT_CORE_V2_UNTRUSTED_EVIDENCE_START,
  assertEvidenceScopedToTurn,
  backfillChatCoreV2SupportedClaimEvidence,
  buildChatCoreV2EvidenceItem,
  buildChatCoreV2InjectedEvidenceBundle,
  isEvidenceInjectionEnabled,
  type ChatCoreV2DomainEvidenceTaxonomy,
} from '../../src/services/chat-core-v2/evidence-policy';
import type { ChatCoreV2EvidenceItem } from '../../src/services/chat-core-v2/types';

const TURN = { tenantId: 1, userId: 10 } as const;

function buildItem(overrides: { tenantId?: number; userId?: number; sourceId?: string; content?: string } = {}): ChatCoreV2EvidenceItem {
  return buildChatCoreV2EvidenceItem({
    tenantId: overrides.tenantId ?? TURN.tenantId,
    userId: overrides.userId ?? TURN.userId,
    sourceType: 'read_model',
    sourceId: overrides.sourceId ?? 'tasks:tasks.today_summary',
    sourceLabel: 'Tasks today',
    domain: 'tasks',
    content: overrides.content ?? '2 tasks due today.',
    sensitivity: 'personal',
  });
}

function draftWith(claims: EvidenceBoundFactualClaim[]): ComposedAnswerDraft {
  return {
    schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
    mode: 'model_constrained',
    locale: 'en',
    text: 'You have 2 tasks due today.',
    factualClaims: claims,
    reasonCodes: ['local_chat_llm'],
  };
}

describe('Chat Core v2 evidence binding (WP-05)', () => {
  describe('unsupported_factual_claim branch', () => {
    it('FIRES for a supported claim with empty evidenceIds', () => {
      const issues = validateComposedAnswerDraft(
        draftWith([{ claimId: 'c1', text: '2 tasks due today', evidenceIds: [], support: 'supported' }]),
      );
      expect(issues).toContain('unsupported_factual_claim');
    });

    it('does NOT fire when a supported claim already carries evidenceIds', () => {
      const issues = validateComposedAnswerDraft(
        draftWith([{ claimId: 'c1', text: '2 tasks due today', evidenceIds: ['evidence:abc'], support: 'supported' }]),
      );
      expect(issues).not.toContain('unsupported_factual_claim');
    });

    it('does NOT fire for assumption / clarification_needed claims with empty evidenceIds', () => {
      const issues = validateComposedAnswerDraft(
        draftWith([
          { claimId: 'c1', text: 'Probably 2 tasks', evidenceIds: [], support: 'assumption' },
          { claimId: 'c2', text: 'Which list?', evidenceIds: [], support: 'clarification_needed' },
        ]),
      );
      expect(issues).not.toContain('unsupported_factual_claim');
    });

    it('back-fill makes the unsupported branch pass when in-scope evidence exists', () => {
      const claims: EvidenceBoundFactualClaim[] = [
        { claimId: 'c1', text: '2 tasks due today', evidenceIds: [], support: 'supported' },
      ];
      const before = validateComposedAnswerDraft(draftWith(claims));
      expect(before).toContain('unsupported_factual_claim');

      const backfilled = backfillChatCoreV2SupportedClaimEvidence(claims, [buildItem()]);
      const after = validateComposedAnswerDraft(draftWith(backfilled));
      expect(after).not.toContain('unsupported_factual_claim');
    });
  });

  describe('backfillChatCoreV2SupportedClaimEvidence', () => {
    it('caps assigned evidenceIds at 3', () => {
      const items = [
        buildItem({ sourceId: 's1', content: 'a' }),
        buildItem({ sourceId: 's2', content: 'b' }),
        buildItem({ sourceId: 's3', content: 'c' }),
        buildItem({ sourceId: 's4', content: 'd' }),
        buildItem({ sourceId: 's5', content: 'e' }),
      ];
      const [claim] = backfillChatCoreV2SupportedClaimEvidence(
        [{ claimId: 'c1', text: 'x', evidenceIds: [], support: 'supported' }],
        items,
      );
      expect(CHAT_CORE_V2_BACKFILL_EVIDENCE_ID_CAP).toBe(3);
      expect(claim.evidenceIds).toHaveLength(3);
      expect(claim.evidenceIds).toEqual(items.slice(0, 3).map((item) => item.evidenceId));
    });

    it('only touches supported claims that have empty evidenceIds', () => {
      const items = [buildItem({ sourceId: 's1' })];
      const result = backfillChatCoreV2SupportedClaimEvidence(
        [
          { claimId: 'supported-empty', text: 'x', evidenceIds: [], support: 'supported' },
          { claimId: 'supported-bound', text: 'y', evidenceIds: ['evidence:existing'], support: 'supported' },
          { claimId: 'assumption', text: 'z', evidenceIds: [], support: 'assumption' },
          { claimId: 'clarify', text: 'w', evidenceIds: [], support: 'clarification_needed' },
        ],
        items,
      );
      expect(result.find((c) => c.claimId === 'supported-empty')?.evidenceIds).toEqual([items[0].evidenceId]);
      expect(result.find((c) => c.claimId === 'supported-bound')?.evidenceIds).toEqual(['evidence:existing']);
      expect(result.find((c) => c.claimId === 'assumption')?.evidenceIds).toEqual([]);
      expect(result.find((c) => c.claimId === 'clarify')?.evidenceIds).toEqual([]);
    });

    it('leaves claims unchanged when no in-scope evidence is available', () => {
      const claims: EvidenceBoundFactualClaim[] = [
        { claimId: 'c1', text: 'x', evidenceIds: [], support: 'supported' },
      ];
      const result = backfillChatCoreV2SupportedClaimEvidence(claims, []);
      expect(result[0].evidenceIds).toEqual([]);
    });
  });

  describe('isEvidenceInjectionEnabled (master kill-switch dominates)', () => {
    it('is false when mode is absent (defaults to off) even with the flag = 1', () => {
      expect(isEvidenceInjectionEnabled({ CHAT_CORE_V2_EVIDENCE_INJECTION_ENABLED: '1' })).toBe(false);
    });

    it('is false when mode is explicitly off even with the flag = 1', () => {
      expect(
        isEvidenceInjectionEnabled({
          CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
          CHAT_CORE_V2_EVIDENCE_INJECTION_ENABLED: '1',
        }),
      ).toBe(false);
    });

    it('is false when mode is on but the flag is unset', () => {
      expect(isEvidenceInjectionEnabled({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' })).toBe(false);
    });

    it('is false when mode is on but the flag is not exactly "1"', () => {
      expect(
        isEvidenceInjectionEnabled({
          CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
          CHAT_CORE_V2_EVIDENCE_INJECTION_ENABLED: 'true',
        }),
      ).toBe(false);
    });

    it('is true only when mode != off AND flag = "1"', () => {
      for (const mode of ['shadow', 'canary', 'on'] as const) {
        expect(
          isEvidenceInjectionEnabled({
            CHAT_CORE_V2_ORCHESTRATOR_MODE: mode,
            CHAT_CORE_V2_EVIDENCE_INJECTION_ENABLED: '1',
          }),
        ).toBe(true);
      }
    });
  });

  describe('buildChatCoreV2InjectedEvidenceBundle', () => {
    const enabledEnv = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
      CHAT_CORE_V2_EVIDENCE_INJECTION_ENABLED: '1',
    } as const;

    it('injects NOTHING (returns null) when injection is disabled', () => {
      expect(buildChatCoreV2InjectedEvidenceBundle([buildItem()], TURN, { env: {} })).toBeNull();
      expect(
        buildChatCoreV2InjectedEvidenceBundle([buildItem()], TURN, {
          env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off', CHAT_CORE_V2_EVIDENCE_INJECTION_ENABLED: '1' },
        }),
      ).toBeNull();
    });

    it('wraps in-scope evidence in the untrusted-evidence sentinel when enabled', () => {
      const result = buildChatCoreV2InjectedEvidenceBundle([buildItem()], TURN, {
        env: enabledEnv,
        generatedAt: '2026-05-30T00:00:00.000Z',
      });
      expect(result).not.toBeNull();
      expect(result?.renderedText).toContain(`[${CHAT_CORE_V2_UNTRUSTED_EVIDENCE_START}`);
      expect(result?.renderedText).toContain(`[${CHAT_CORE_V2_UNTRUSTED_EVIDENCE_END}`);
      expect(result?.renderedText).toContain('2 tasks due today.');
      expect(result?.bundle.tenantId).toBe(TURN.tenantId);
      expect(result?.bundle.userId).toBe(TURN.userId);
    });

    it('truncates total rendered evidence text to the configured cap', () => {
      const big = buildItem({ content: 'x'.repeat(5000) });
      const result = buildChatCoreV2InjectedEvidenceBundle([big], TURN, {
        env: enabledEnv,
        maxRenderedChars: 200,
      });
      expect(result?.truncated).toBe(true);
      expect(result?.renderedText.endsWith('[truncated]')).toBe(true);
      // 200 chars + the truncation suffix.
      expect(result?.renderedText.length).toBeLessThanOrEqual(200 + '\n[truncated]'.length);
      expect(CHAT_CORE_V2_MAX_PROMPT_EVIDENCE_CHARS).toBe(2000);
    });

    it('drops cross-tenant items before they can reach the bundle', () => {
      const inScope = buildItem({ sourceId: 'mine' });
      const otherTenant = buildItem({ tenantId: 999, sourceId: 'other-tenant' });
      const result = buildChatCoreV2InjectedEvidenceBundle([inScope, otherTenant], TURN, {
        env: enabledEnv,
      });
      expect(result?.rejectedCount).toBe(1);
      expect(result?.bundle.items.map((i) => i.sourceId)).toEqual(['mine']);
      expect(result?.renderedText).not.toContain('other-tenant');
    });
  });

  describe('assertEvidenceScopedToTurn (CROSS-TENANT REJECTION — load-bearing privacy guard)', () => {
    it('drops an item whose tenantId differs and an item whose userId differs, keeps the matching one', () => {
      const matching = buildItem({ sourceId: 'matching' });
      const wrongTenant = buildItem({ tenantId: 2, userId: 10, sourceId: 'wrong-tenant' });
      const wrongUser = buildItem({ tenantId: 1, userId: 999, sourceId: 'wrong-user' });

      const result = assertEvidenceScopedToTurn([matching, wrongTenant, wrongUser], TURN);

      expect(result.inScope).toEqual([matching]);
      expect(result.rejectedCount).toBe(2);
      const inScopeIds = result.inScope.map((item) => item.sourceId);
      expect(inScopeIds).toContain('matching');
      // Cross-tenant and cross-user items are NOT in the returned in-scope set
      // and therefore can never reach the prompt bundle.
      expect(inScopeIds).not.toContain('wrong-tenant');
      expect(inScopeIds).not.toContain('wrong-user');
      expect(result.rejected.map((item) => item.sourceId).sort()).toEqual(['wrong-tenant', 'wrong-user']);
    });

    it('keeps all items when every item matches the turn scope', () => {
      const items = [buildItem({ sourceId: 'a' }), buildItem({ sourceId: 'b' })];
      const result = assertEvidenceScopedToTurn(items, TURN);
      expect(result.inScope).toHaveLength(2);
      expect(result.rejectedCount).toBe(0);
    });

    it('is pure: cross-tenant evidence is filtered out, never thrown into a hot path', () => {
      const otherTenant = buildItem({ tenantId: 42, sourceId: 'other' });
      expect(() => assertEvidenceScopedToTurn([otherTenant], TURN)).not.toThrow();
      expect(assertEvidenceScopedToTurn([otherTenant], TURN).inScope).toEqual([]);
    });
  });

  describe('ChatCoreV2DomainEvidenceTaxonomy', () => {
    it('covers secretary/training/cooking/tasks/finance', () => {
      const taxonomy: ChatCoreV2DomainEvidenceTaxonomy = {
        secretary: ['read_model'],
        training: ['read_model'],
        cooking: ['read_model'],
        tasks: ['read_model'],
        finance: ['read_model'],
      };
      expect(Object.keys(taxonomy).sort()).toEqual(['cooking', 'finance', 'secretary', 'tasks', 'training']);
    });
  });
});
