// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type LearningCaseLifecycle = 'observed' | 'candidate' | 'reviewed' | 'golden' | 'retired';
export type LearningPrivacyClass = 'public' | 'redacted-product' | 'sensitive-no-export';

export interface LearningCase {
  id: string;
  tenantId: number;
  owner: string;
  lifecycle: LearningCaseLifecycle;
  privacyClass: LearningPrivacyClass;
  redactedInput: Record<string, unknown>;
  expectedContract: Record<string, unknown>;
  evidenceReferences: string[];
  observedAt: string;
  reviewedAt?: string;
  expiresAt?: string;
}

const FORBIDDEN_KEYS = /(?:email|phone|calendar|token|secret|password|raw[_-]?content)/i;

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => FORBIDDEN_KEYS.test(key) || containsForbiddenKey(nested));
}

export function validateLearningCase(candidate: LearningCase): string[] {
  const errors: string[] = [];
  if (!candidate.id.trim()) errors.push('id_required');
  if (!Number.isInteger(candidate.tenantId) || candidate.tenantId <= 0) errors.push('tenant_scope_required');
  if (!candidate.owner.trim()) errors.push('owner_required');
  if (containsForbiddenKey(candidate.redactedInput)) errors.push('redaction_failed');
  if (candidate.lifecycle === 'golden') {
    if (!candidate.reviewedAt) errors.push('golden_requires_review');
    if (candidate.evidenceReferences.length === 0) errors.push('golden_requires_evidence');
    if (candidate.privacyClass === 'sensitive-no-export') errors.push('sensitive_case_cannot_be_golden');
  }
  return errors;
}

export function promoteLearningCase(
  candidate: LearningCase,
  lifecycle: Exclude<LearningCaseLifecycle, 'observed'>,
  reviewedAt = new Date().toISOString(),
): LearningCase {
  const promoted = { ...candidate, lifecycle, reviewedAt };
  const errors = validateLearningCase(promoted);
  if (errors.length) throw new Error(`invalid learning case: ${errors.join(', ')}`);
  return promoted;
}
