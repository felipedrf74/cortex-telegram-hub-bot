import { describe, expect, it } from 'vitest';

import {
  evaluateChatCoreV2BatchPolicy,
  getChatCoreV2Capability,
  listChatCoreV2ModelVisibleCapabilities,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 batch policy', () => {
  it('declares a batch policy for every model-visible write or preview capability', () => {
    const writable = listChatCoreV2ModelVisibleCapabilities()
      .filter((capability) => capability.support.preview !== 'not_applicable' || capability.support.execute !== 'not_applicable');

    expect(writable.length).toBeGreaterThan(0);
    for (const capability of writable) {
      expect(capability.batchPolicy, capability.capabilityId).toBeDefined();
      expect(capability.batchPolicy?.requiresDiffPreview, capability.capabilityId).toBe(true);
      expect(capability.batchPolicy?.maxItemsAbsolute, capability.capabilityId).toBeGreaterThanOrEqual(0);
    }
  });

  it('allows single-item commands without special confirmation', () => {
    const capability = mustCapability('tasks.create');

    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 1,
      stage: 'confirmation',
    })).toMatchObject({
      ok: true,
      reason: 'single_item',
      requiresSpecialConfirmation: false,
      requiresDiffPreview: false,
    });
  });

  it('requires itemized diffs before previewing multi-item writes', () => {
    const capability = mustCapability('tasks.create');

    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 3,
      stage: 'preview',
      diffPreviewItemCount: 2,
    })).toMatchObject({
      ok: false,
      reason: 'diff_preview_required',
      requiresDiffPreview: true,
    });

    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 3,
      stage: 'preview',
      diffPreviewItemCount: 3,
    })).toMatchObject({
      ok: true,
      reason: 'batch_allowed',
      requiresSpecialConfirmation: false,
    });
  });

  it('requires typed confirmation when a low-risk batch exceeds the soft threshold', () => {
    const capability = mustCapability('tasks.create');

    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 8,
      stage: 'confirmation',
      diffPreviewItemCount: 8,
      typedConfirmationText: 'confirm',
    })).toMatchObject({
      ok: false,
      reason: 'typed_confirmation_required',
      requiredTypedConfirmationText: 'Confirm 8 changes',
    });

    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 8,
      stage: 'confirmation',
      diffPreviewItemCount: 8,
      typedConfirmationText: ' confirm   8 changes ',
    })).toMatchObject({
      ok: true,
      reason: 'batch_allowed',
      requiresSpecialConfirmation: true,
      requiredTypedConfirmationText: 'Confirm 8 changes',
    });
  });

  it('hard-stops batches above the absolute limit before confirmation text matters', () => {
    const capability = mustCapability('tasks.create');

    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 26,
      stage: 'proposal',
      typedConfirmationText: 'Confirm 26 changes',
    })).toMatchObject({
      ok: false,
      reason: 'too_large_batch',
      maxItemsAbsolute: 25,
    });
  });

  it('uses stricter defaults for medium-risk preview-only domains', () => {
    const capability = mustCapability('training.modify_session_preview');

    expect(capability.batchPolicy).toMatchObject({
      maxItemsWithoutSpecialConfirmation: 1,
      maxItemsAbsolute: 5,
    });
    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 6,
      stage: 'proposal',
    })).toMatchObject({
      ok: false,
      reason: 'too_large_batch',
    });
  });

  it('blocks restricted capabilities from batching at all', () => {
    const capability = mustCapability('finance.payment_or_tax_action_blocked');

    expect(evaluateChatCoreV2BatchPolicy({
      capability,
      itemCount: 2,
      stage: 'proposal',
    })).toMatchObject({
      ok: false,
      reason: 'too_large_batch',
      maxItemsAbsolute: 0,
      requiredTypedConfirmationText: 'manual_review_required',
    });
  });

  it('fails closed when a future capability forgets to declare a batch policy', () => {
    expect(evaluateChatCoreV2BatchPolicy({
      capability: {
        capabilityId: 'future.write',
        risk: 'low',
        batchPolicy: undefined,
      },
      itemCount: 2,
      stage: 'proposal',
    })).toMatchObject({
      ok: false,
      reason: 'batch_policy_missing',
    });
  });
});

function mustCapability(capabilityId: string) {
  const capability = getChatCoreV2Capability(capabilityId);
  if (!capability) throw new Error(`Missing capability ${capabilityId}`);
  return capability;
}
