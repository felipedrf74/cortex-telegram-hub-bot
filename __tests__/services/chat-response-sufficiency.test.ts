import { describe, expect, it } from 'vitest';

import { trackPendingChatConfirmation } from '../../src/services/chat-pending-confirmations';
import { buildChatResponseSufficiencyMetadata } from '../../src/services/chat-response-sufficiency';

describe('chat response sufficiency metadata', () => {
  it('includes action status and unresolved blockers for pending confirmations', () => {
    const pending = trackPendingChatConfirmation({
      userId: 7,
      tenantId: 10,
      actionSummary: 'Cancel that plan and clear the calendar',
      involvedSkills: ['secretary', 'training'],
      reasonCodes: ['destructive_or_external_side_effect'],
      sourceMessageId: 'msg-user-1',
      now: new Date('2026-04-29T10:00:00.000Z'),
    });
    const metadata = buildChatResponseSufficiencyMetadata({
      actionStatus: 'needs_confirmation',
      requiresConfirmation: true,
      unresolvedBlockers: ['target_identity_required'],
    });

    expect(pending).toMatchObject({
      tenantId: 10,
      userId: 7,
      involvedSkills: ['secretary', 'training'],
      sourceMessageId: 'msg-user-1',
    });
    expect(metadata).toMatchObject({
      actionStatus: 'needs_confirmation',
      responseSufficient: false,
      requiresConfirmation: true,
      unresolvedBlockers: expect.arrayContaining([
        'explicit_confirmation_required',
        'target_identity_required',
      ]),
    });
  });

  it('marks missing context and unsafe ambiguity as unresolved blockers', () => {
    const metadata = buildChatResponseSufficiencyMetadata({
      actionStatus: 'needs_clarification',
      needsClarification: true,
      weakSignals: [
        { code: 'memory_recall_without_memory' },
        { code: 'unsafe_ambiguous_action' },
      ],
    });

    expect(metadata.responseSufficient).toBe(false);
    expect(metadata.unresolvedBlockers).toEqual(expect.arrayContaining([
      'targeted_clarification_required',
      'missing_memory_context',
      'ambiguous_reference',
    ]));
    expect(metadata.weakContextSignals).toEqual([
      'memory_recall_without_memory',
      'unsafe_ambiguous_action',
    ]);
  });

  it('records source attribution for sufficient responses without leaking content', () => {
    const metadata = buildChatResponseSufficiencyMetadata({
      actionStatus: 'none',
      contextItems: [
        {
          source: 'shared_memory',
          freshness: 'recent',
          confidence: 0.72,
          reason: 'Preference memory can change the plan and must be attributed.',
        },
      ],
    });

    expect(metadata.responseSufficient).toBe(true);
    expect(metadata.contextSources).toEqual([
      {
        source: 'shared_memory',
        freshness: 'recent',
        confidence: 0.72,
        reason: 'Preference memory can change the plan and must be attributed.',
      },
    ]);
  });
});
