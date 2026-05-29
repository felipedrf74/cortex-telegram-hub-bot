// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainAdapterVerificationVerdict } from './domain-adapter';

export type ChatCoreV2WriteSuccessClaimVerdict =
  | 'may_claim_verified_success'
  | 'must_claim_partial'
  | 'must_not_claim_success';

export function evaluateWriteSuccessClaim(
  verificationVerdict: DomainAdapterVerificationVerdict,
): ChatCoreV2WriteSuccessClaimVerdict {
  if (verificationVerdict === 'verified') return 'may_claim_verified_success';
  if (verificationVerdict === 'partial') return 'must_claim_partial';
  return 'must_not_claim_success';
}
