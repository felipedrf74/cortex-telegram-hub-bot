import { describe, expect, it } from 'vitest';

import {
  evaluateWriteSuccessClaim,
} from '../../src/services/chat-core-v2/write-verification-policy';

describe('ChatCoreV2 write verification policy', () => {
  it('allows success claims only for verified write readback', () => {
    expect(evaluateWriteSuccessClaim('verified')).toBe('may_claim_verified_success');
  });

  it('downgrades partial verification instead of claiming full success', () => {
    expect(evaluateWriteSuccessClaim('partial')).toBe('must_claim_partial');
  });

  it('blocks success claims for failed or indeterminate verification', () => {
    expect(evaluateWriteSuccessClaim('failed')).toBe('must_not_claim_success');
    expect(evaluateWriteSuccessClaim('indeterminate')).toBe('must_not_claim_success');
  });
});
