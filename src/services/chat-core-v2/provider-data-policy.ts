// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AuditSensitivity, ChatCoreV2Domain } from './types';

export interface ProviderDataPolicyInput {
  domain: ChatCoreV2Domain;
  sensitivity: AuditSensitivity;
  backgroundModeRequested?: boolean;
  storeRequested?: boolean;
}

export interface ProviderDataPolicy {
  store: boolean;
  allowBackgroundMode: boolean;
  allowRawSensitiveContext: boolean;
  requiresDataProcessingReview: boolean;
}

const BACKGROUND_ALLOWED_DOMAINS = new Set<ChatCoreV2Domain>(['content', 'training']);
const RAW_SENSITIVE_BLOCKED = new Set<AuditSensitivity>([
  'financial',
  'credential_adjacent',
]);

export function resolveProviderDataPolicy(input: ProviderDataPolicyInput): ProviderDataPolicy {
  const sensitive = RAW_SENSITIVE_BLOCKED.has(input.sensitivity);
  const backgroundAllowed = Boolean(input.backgroundModeRequested)
    && BACKGROUND_ALLOWED_DOMAINS.has(input.domain)
    && !sensitive;

  return {
    store: Boolean(input.storeRequested) && !sensitive,
    allowBackgroundMode: backgroundAllowed,
    allowRawSensitiveContext: !sensitive,
    requiresDataProcessingReview: sensitive || (input.backgroundModeRequested === true && !backgroundAllowed),
  };
}
