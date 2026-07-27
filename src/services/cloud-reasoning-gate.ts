// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cloud Reasoning Gate — quality + privacy gate for the
 * `'approved_cloud_reasoning'` sentinel fallback target.
 *
 * Two checks happen in this order:
 *   1. Quality gate.
 *      - `CLOUD_REASONING_FALLBACK_ENABLED` must be true.
 *      - `CLOUD_REASONING_MODEL` must NOT match any
 *        `DISALLOWED_COMPLEX_FALLBACK_MODELS` substring (this check
 *        ALWAYS overrides `APPROVED_REASONING_MODELS` — operators must
 *        not be able to bypass safety by adding a flash-class model to
 *        the approved list).
 *      - When `CLOUD_REASONING_REQUIRE_APPROVED_MODEL=true` (default),
 *        the configured model must be in `APPROVED_REASONING_MODELS`.
 *      - Preview models are blocked unless
 *        `CLOUD_REASONING_ALLOW_PREVIEW_MODELS=true`.
 *
 *   2. Privacy gate (v3.1 — `redacted_only` removed; fail-closed
 *      everywhere unless operator explicitly opts in to raw).
 *
 *      History: v1.0-v2.9 asked the local model to produce a redacted
 *      summary and tried to sanitize its output with a growing
 *      deny-list. v3.0 replaced that with a static regex PII scrubber.
 *      Codex broke both architectures in 5 of 6 review rounds because
 *      EVERY attempt to "redact-then-forward" treats unmatched bytes
 *      as safe — and PII coverage is infinite. The v3.0 round-6 audit
 *      reproduced raw AWS keys, IBANs, and other PII reaching the
 *      cloud SDK boundary via patterns the regex didn't anticipate.
 *
 *      v3.1 takes the honest posture: we do not have a redactor we
 *      trust enough to ship. The `redacted_only` mode therefore
 *      ALWAYS REJECTS in v3.1, identical in effect to `mode='never'`
 *      but with a distinct warning so operators understand why their
 *      legacy config no longer escalates.
 *
 *      The caller must explicitly classify every request. A missing or
 *      non-boolean `containsPrivateData` value is rejected as unknown; it
 *      never defaults to public.
 *
 *      Behavior for `containsPrivateData=true` requests:
 *      - `mode='never'`                     → REJECT (privacy_never)
 *      - missing `allowCloudEscalation`     → REJECT (request_disallows_cloud)
 *      - `mode='redacted_only'`             → REJECT (redaction_unsupported)
 *      - `mode='allow_raw'`
 *          + `allowRawPrivateData=true`     → FORWARD raw (explicit opt-in)
 *      - otherwise                          → REJECT (privacy_default_block)
 *
 *      Callers that have pre-redacted their content before calling the
 *      gate should pass `containsPrivateData=false` — that signals
 *      "the operator has already taken responsibility for redaction."
 *
 * On rejection, callers honor `CLOUD_REASONING_ON_UNAPPROVED_MODEL`:
 *   - `return_local_result_with_warning` (default)
 *   - `fail_visibly`
 *   - `allow` (DEFENSIVE: forced to default in production unless
 *     `CLOUD_REASONING_ALLOW_UNAPPROVED_IN_PROD=true`).
 *
 * See plan Revision 4, items 9 + A8 + A10, plus Codex round-6 audit notes.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { AIProvider } from './ai-provider';
import { createHash } from 'crypto';
import { isAnthropicRuntimeEnabled } from './runtime-flags';
// v3.0/v3.1: `OllamaProvider` is kept as a type-only import for
// backwards-compat in the `selectApprovedCloudReasoningProvider`
// signature. The local model is NOT on the privacy escalation path in
// any form — see the docblock above for the v3.1 rationale.
import type { OllamaProvider } from './ollama-provider';

export interface CloudReasoningRequest {
  prompt: string;
  containsPrivateData: boolean;
  allowCloudEscalation?: boolean;
  /**
   * v3.1: kept in the type for backwards-compat with existing callers,
   * but no longer changes gate behavior. Setting this on a private-data
   * request reaches the same `redaction_unsupported` rejection as the
   * `redacted_only` mode — there is no "redact and forward" path in v3.1.
   */
  redactionRequired?: boolean;
}

export interface CloudReasoningSelection {
  rejected: false;
  provider: AIProvider;
  model: string;
  /**
   * v3.1: the only valid value is `'sent_raw'`. The `'sent_redacted'`
   * action has been removed because no redactor in v1.0-v3.0 survived
   * adversarial review. Callers should not branch on this in v3.1; it
   * is retained as a discriminant for potential future re-introduction.
   */
  privacyAction: 'sent_raw';
  warning?: string;
}

export interface CloudReasoningRejection {
  rejected: true;
  reason:
    | 'disabled'
    | 'unconfigured'
    | 'disallowed_substring'
    | 'not_in_approved_list'
    | 'preview_blocked'
    | 'provider_model_mismatch'
    | 'provider_identity_mismatch'
    | 'provider_unavailable'
    | 'structured_generation_unsupported'
    | 'privacy_never'
    | 'request_disallows_cloud'
    | 'redaction_unsupported'  // v3.1: replaces v3.0's 'redaction_failed'
    | 'privacy_default_block';
  warning: string;
}

export type CloudReasoningResolution = CloudReasoningSelection | CloudReasoningRejection;

/** The complete, normalized payload covered by a ScriptGen cloud approval. */
export interface CloudScriptGenerationApprovalPayload {
  description: string;
  targetPath?: string;
  domainContext?: string;
  userId?: number;
  tenantId?: number;
  runId?: string;
  containsPrivateData: boolean;
  allowCloudEscalation?: boolean;
  redactionRequired?: boolean;
}

/**
 * Runtime-opaque, one-use approval. The object has no meaningful public
 * properties; authenticity and payload binding live in the module-private
 * WeakMap below. A structural cast cannot manufacture a usable permit.
 */
export type ApprovedCloudScriptGenerationPermit = Readonly<{
  readonly __nexusCloudScriptGenerationPermit: unique symbol;
}>;

export interface CloudScriptGenerationApproval {
  rejected: false;
  permit: ApprovedCloudScriptGenerationPermit;
  providerName: string;
  model: string;
  privacyAction: 'sent_raw';
}

export type CloudScriptGenerationApprovalResolution =
  | CloudScriptGenerationApproval
  | CloudReasoningRejection;

export interface ConsumedCloudScriptGenerationApproval {
  payloadDigest: string;
  provider: AIProvider;
  model: string;
  privacyAction: 'sent_raw';
}

const cloudScriptGenerationApprovals = new WeakMap<object, ConsumedCloudScriptGenerationApproval>();

function stableCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cloud script approval payload contains a non-finite number');
    return value;
  }
  if (value === undefined) return { $type: 'undefined' };
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableCanonicalValue((value as Record<string, unknown>)[key])]);
  }
  throw new Error('cloud script approval payload contains an unsupported value');
}

function cloudScriptGenerationPayloadDigest(payload: CloudScriptGenerationApprovalPayload): string {
  return createHash('sha256')
    .update(JSON.stringify(stableCanonicalValue(payload)))
    .digest('hex');
}

/** Canonical form of every caller-controlled byte that ScriptGen sends. */
export function canonicalCloudScriptGenerationOutboundInput(
  payload: CloudScriptGenerationApprovalPayload,
): string {
  return JSON.stringify(stableCanonicalValue({
    description: payload.description,
    ...(payload.domainContext !== undefined ? { domainContext: payload.domainContext } : {}),
  }));
}

/** Canonical form of every caller-controlled byte generic reasoning sends. */
export function canonicalCloudLocalReasoningOutboundInput(payload: {
  prompt: string;
  systemContext?: string;
  outputSchema?: unknown;
}): string {
  return JSON.stringify(stableCanonicalValue({
    prompt: payload.prompt,
    ...(payload.systemContext !== undefined ? { systemContext: payload.systemContext } : {}),
    ...(payload.outputSchema !== undefined ? { outputSchema: payload.outputSchema } : {}),
  }));
}

/** Provider/model families are paired before any provider object is returned. */
export function isProviderCompatibleReasoningModel(providerName: string, model: string): boolean {
  const normalizedProvider = providerName.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  if (normalizedProvider === 'gemini') return /^gemini(?:[-.:]|$)/.test(normalizedModel);
  if (normalizedProvider === 'anthropic') return /^claude(?:[-.:]|$)/.test(normalizedModel);
  if (normalizedProvider === 'openai') return /^(?:gpt|chatgpt|o[1-9])(?:[-.:]|$)/.test(normalizedModel);
  return false;
}

/**
 * Resolve the gate against the active request and config. Returns either
 * a `CloudReasoningSelection` (the caller invokes
 * the provider's isolated structured-generation capability with the exact
 * selected model)
 * or a `CloudReasoningRejection` (the caller applies the configured
 * `onUnapproved` policy).
 *
 * Pure-function aside from optional local-model redaction. `getProvider`
 * is injected to avoid a hard dependency on `provider-registry` at
 * module-load time.
 */
export async function selectApprovedCloudReasoningProvider(
  request: CloudReasoningRequest,
  getProvider: (name: string) => AIProvider | null,
  ollama?: OllamaProvider | null,
): Promise<CloudReasoningResolution> {
  const cfg = config.cloudReasoningFallback;

  // ── Quality gate ────────────────────────────────────────────────
  if (!cfg.enabled) {
    return { rejected: true, reason: 'disabled', warning: 'cloud_reasoning_fallback_disabled' };
  }
  if (!cfg.provider || !cfg.model) {
    return { rejected: true, reason: 'unconfigured', warning: 'no_approved_cloud_reasoning_model_configured' };
  }

  const modelLower = cfg.model.toLowerCase();
  if (matchesDisallowedSubstring(modelLower, cfg.disallowedSubstrings)) {
    return {
      rejected: true,
      reason: 'disallowed_substring',
      warning: 'configured_cloud_model_matches_disallowed_substring',
    };
  }
  if (cfg.requireApprovedModel) {
    // v2.6 (angry-QA-found): approved-list comparison was case-sensitive,
    // so 'Gemini-2.5-Pro' (operator typo) silently fell through to
    // 'not_in_approved_list'. Normalize both sides to lowercase before
    // comparing.
    const approvedLower = cfg.approvedReasoningModels.map(m => m.toLowerCase());
    if (!approvedLower.includes(modelLower)) {
      return {
        rejected: true,
        reason: 'not_in_approved_list',
        warning: 'configured_cloud_model_not_in_approved_list',
      };
    }
  }
  // v2.6 / v2.7 / v2.8 / v2.9 (angry-QA-found, four iterations):
  //   v2.6: naive `includes('preview')`. Fixed via token-boundary matcher.
  //   v2.7: token-boundary matcher rejected `gemini-non-preview`.
  //         Codex flagged this as wrong (compound negation).
  //   v2.8: added `/\b(non|not|no)-preview\b/` test as a boolean escape.
  //   v2.9: Codex demonstrated that the boolean check allows model
  //         names with BOTH a real preview token AND a separate
  //         non-preview token (e.g., `gemini-pro-preview-non-preview`).
  //         The bypass: the boolean evaluates true because SOMETHING
  //         in the string contains `non-preview`, but the actual
  //         standalone `preview` token elsewhere should still block.
  //   v2.9 fix: find EVERY 'preview' token (token-boundary anchored),
  //         and for EACH, check whether THIS specific occurrence is
  //         immediately preceded by 'non-' / 'not-' / 'no-'. If any
  //         occurrence is NOT negated, block. If all are negated (or
  //         there are no preview tokens), allow.
  if (!cfg.allowPreviewModels && hasNonNegatedPreviewToken(modelLower)) {
    return { rejected: true, reason: 'preview_blocked', warning: 'preview_model_blocked' };
  }
  if (!isProviderCompatibleReasoningModel(cfg.provider, cfg.model)) {
    return {
      rejected: true,
      reason: 'provider_model_mismatch',
      warning: 'configured_cloud_provider_model_mismatch',
    };
  }
  if (cfg.provider === 'anthropic' && !isAnthropicRuntimeEnabled()) {
    return { rejected: true, reason: 'provider_unavailable', warning: 'cloud_provider_unavailable' };
  }
  const provider = getProvider(cfg.provider);
  if (!provider) {
    return { rejected: true, reason: 'provider_unavailable', warning: 'cloud_provider_unavailable' };
  }
  if (provider.name.trim().toLowerCase() !== cfg.provider.trim().toLowerCase()) {
    return {
      rejected: true,
      reason: 'provider_identity_mismatch',
      warning: 'configured_cloud_provider_identity_mismatch',
    };
  }

  // ── Privacy gate (v3.1 — `redacted_only` removed) ───────────────
  //
  // History: v1.0-v2.9 asked the local model for a redacted summary;
  // v3.0 ran a static regex PII scrubber. Codex broke both designs in
  // 5 of 6 rounds because EVERY "redact-then-forward" approach treats
  // unmatched bytes as safe — and PII coverage is structurally
  // infinite (AWS keys, IBANs, OpenSSH key markers, full names,
  // addresses, DOBs, passport numbers, IBANs, JWT tokens, base64
  // payloads, URL/JS-escape encoded patterns... no regex closes them
  // all). v3.0 round-6 reproduced raw AWS keys and IBANs reaching the
  // cloud SDK boundary.
  //
  // v3.1 takes the honest posture: we do not have a redactor we trust
  // enough to ship, so the redacting path is removed entirely. The
  // gate's policy when `containsPrivateData=true`:
  //   - `mode='never'`                       -> REJECT
  //   - missing `allowCloudEscalation`       -> REJECT
  //   - `mode='redacted_only'`               -> REJECT (was leaky)
  //   - `mode='allow_raw'`
  //       + `allowRawPrivateData=true`       -> FORWARD raw (opt-in)
  //   - otherwise                            -> REJECT
  //
  // Callers that have pre-redacted their content before calling the
  // gate should pass `containsPrivateData=false` — that signals the
  // operator has already taken responsibility for redaction.
  if (typeof request.containsPrivateData !== 'boolean') {
    return {
      rejected: true,
      reason: 'privacy_default_block',
      warning: 'privacy_classification_required',
    };
  }
  if (request.containsPrivateData) {
    // `ollama` and `redactionRequired` are kept in the signature/request
    // type for backwards-compat but no longer change behavior in v3.1.
    void ollama;
    void request.redactionRequired;

    if (cfg.privacy.mode === 'never') {
      return { rejected: true, reason: 'privacy_never', warning: 'privacy_mode_blocks_cloud' };
    }
    if (!request.allowCloudEscalation) {
      return { rejected: true, reason: 'request_disallows_cloud', warning: 'request_does_not_allow_cloud_escalation' };
    }
    if (cfg.privacy.mode === 'redacted_only') {
      // v3.1: explicit, distinct rejection so operators see why their
      // legacy `redacted_only` config stopped escalating. No raw prompt
      // content is logged — only the policy decision.
      logger.warn(
        {
          policy: 'redacted_only',
          decision: 'reject',
          reasonCode: 'redaction_unsupported',
        },
        'cloud-reasoning-gate: redacted_only mode is no longer supported (v3.1) — set mode=allow_raw + allowRawPrivateData=true to forward raw, or mode=never to block',
      );
      return { rejected: true, reason: 'redaction_unsupported', warning: 'redaction_path_disabled_v3_1' };
    }
    if (cfg.privacy.mode === 'allow_raw' && cfg.privacy.allowRawPrivateData) {
      return {
        rejected: false,
        provider,
        model: cfg.model,
        privacyAction: 'sent_raw',
      };
    }
    return { rejected: true, reason: 'privacy_default_block', warning: 'privacy_default_block' };
  }

  return {
    rejected: false,
    provider,
    model: cfg.model,
    privacyAction: 'sent_raw',
  };
}

/**
 * Run the normal quality/privacy gate for the complete normalized ScriptGen
 * payload and mint a one-use permit bound to every byte of that payload.
 * The permit, rather than a caller-constructible provider/model object, is the
 * only input accepted by the ScriptGen cloud adapter.
 */
export async function approveCloudScriptGeneration(
  payload: CloudScriptGenerationApprovalPayload,
  getProvider: (name: string) => AIProvider | null,
): Promise<CloudScriptGenerationApprovalResolution> {
  // Script generation is an optional large-reasoning workload, not a raw
  // private-data transport. Its adapter boundary is deliberately stricter
  // than the generic gate: operator allow_raw drift can never authorize it.
  if (payload.containsPrivateData) {
    return {
      rejected: true,
      reason: 'privacy_never',
      warning: 'private_script_generation_cloud_forbidden',
    };
  }
  const selection = await selectApprovedCloudReasoningProvider(
    {
      prompt: canonicalCloudScriptGenerationOutboundInput(payload),
      containsPrivateData: payload.containsPrivateData,
      allowCloudEscalation: payload.allowCloudEscalation,
      redactionRequired: payload.redactionRequired,
    },
    getProvider,
    null,
  );
  if (selection.rejected) return selection;
  if (!config.cloudReasoningFallback.approvedReasoningModels
    .some((model) => model.toLowerCase() === selection.model.toLowerCase())) {
    return {
      rejected: true,
      reason: 'not_in_approved_list',
      warning: 'configured_cloud_model_not_in_approved_list',
    };
  }
  if (typeof selection.provider.callStructuredGeneration !== 'function') {
    return {
      rejected: true,
      reason: 'structured_generation_unsupported',
      warning: 'approved_cloud_provider_lacks_structured_generation',
    };
  }

  const permit = Object.freeze(Object.create(null)) as ApprovedCloudScriptGenerationPermit;
  cloudScriptGenerationApprovals.set(permit, {
    payloadDigest: cloudScriptGenerationPayloadDigest(payload),
    provider: selection.provider,
    model: selection.model,
    privacyAction: selection.privacyAction,
  });
  return {
    rejected: false,
    permit,
    providerName: selection.provider.name,
    model: selection.model,
    privacyAction: selection.privacyAction,
  };
}

/**
 * Consume a permit exactly once and verify it covers the exact normalized
 * payload the adapter is about to send. The stored provider/model never come
 * from caller-controlled permit properties.
 */
export function consumeCloudScriptGenerationApproval(
  permit: ApprovedCloudScriptGenerationPermit,
  payload: CloudScriptGenerationApprovalPayload,
): ConsumedCloudScriptGenerationApproval {
  if (!permit || typeof permit !== 'object') {
    throw new Error('cloud_script_generation_approval_invalid');
  }
  const approval = cloudScriptGenerationApprovals.get(permit);
  if (!approval) throw new Error('cloud_script_generation_approval_invalid');

  // One-use even on a digest mismatch: a tamper attempt invalidates the grant.
  cloudScriptGenerationApprovals.delete(permit);
  if (approval.payloadDigest !== cloudScriptGenerationPayloadDigest(payload)) {
    throw new Error('cloud_script_generation_approval_payload_mismatch');
  }
  return approval;
}

/**
 * v2.9 (angry-QA-found, round 4): per-token preview negation check.
 *
 * Returns true if the model name contains at least ONE 'preview' token
 * that is NOT immediately preceded by `non-`, `not-`, or `no-`. I.e.,
 * the model is a real preview model and should be blocked.
 *
 * Examples:
 *   'gemini-pro-preview'                → true   (single un-negated)
 *   'gemini-non-preview'                → false  (only negated occurrence)
 *   'gemini-not-preview'                → false
 *   'gemini-no-preview'                 → false
 *   'gemini-pro-preview-non-preview'    → true   (first preview un-negated)
 *   'gemini-pro-non-preview-preview'    → true   (second preview un-negated)
 *   'gemini-non-preview-not-preview'    → false  (both negated)
 *   'gemini-2.5-pro'                    → false  (no preview at all)
 *   'previewer'                         → false  (no preview-token boundary)
 */
export function hasNonNegatedPreviewToken(modelLower: string): boolean {
  let start = 0;
  while (true) {
    const idx = modelLower.indexOf('preview', start);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : modelLower[idx - 1];
    const after = idx + 'preview'.length >= modelLower.length ? '' : modelLower[idx + 'preview'.length];
    const beforeIsBoundary = before === '' || !/[a-z0-9]/.test(before);
    const afterIsBoundary = after === '' || !/[a-z0-9]/.test(after);
    if (!beforeIsBoundary || !afterIsBoundary) {
      // Not a free-standing 'preview' token (e.g., 'previewer' or
      // 'spreview'). Move past and keep looking.
      start = idx + 1;
      continue;
    }
    // Is THIS occurrence preceded by 'non-', 'not-', or 'no-'?
    const before4 = modelLower.slice(Math.max(0, idx - 4), idx);
    const before3 = modelLower.slice(Math.max(0, idx - 3), idx);
    if (before4 === 'non-' || before4 === 'not-' || before3 === 'no-') {
      // This particular preview is negated; keep looking for an un-negated one.
      start = idx + 1;
      continue;
    }
    // Free-standing un-negated 'preview' token. This is a real preview model.
    return true;
  }
}

/**
 * Token-boundary disallow check. Replaces naive `.includes()` which had a
 * critical bug discovered in the staging vitest run (2026-05-26): the
 * substring 'mini' matched 'geMINI' inside 'gemini-2.5-pro' and rejected
 * the operator's approved Pro model. The fix: require a non-alphanumeric
 * boundary on BOTH sides of the match (start of string, end of string,
 * or any of `-`, `.`, `/`, `_`, `:`, space). Model tag tiers are always
 * surrounded by hyphens or other punctuation, never embedded inside a
 * word.
 */
export function matchesDisallowedSubstring(
  modelLower: string,
  substrings: ReadonlyArray<string>,
): boolean {
  for (const s of substrings) {
    if (!s) continue;
    let start = 0;
    while (true) {
      const idx = modelLower.indexOf(s, start);
      if (idx < 0) break;
      const before = idx === 0 ? '' : modelLower[idx - 1];
      const after = idx + s.length >= modelLower.length ? '' : modelLower[idx + s.length];
      const beforeIsBoundary = before === '' || !/[a-z0-9]/.test(before);
      const afterIsBoundary = after === '' || !/[a-z0-9]/.test(after);
      // Both sides must be a boundary so the substring is a free-standing
      // token like 'mini' in 'gpt-5-mini', not a fragment like 'mini'
      // inside 'gemini'.
      if (beforeIsBoundary && afterIsBoundary) return true;
      start = idx + 1;
    }
  }
  return false;
}


/**
 * In production, the `allow` escape hatch is dangerous. Returns the
 * effective `onUnapproved` policy after applying the production safety
 * override (plan A8).
 */
export function effectiveOnUnapprovedPolicy(): 'return_local_result_with_warning' | 'fail_visibly' | 'allow' {
  const requested = config.cloudReasoningFallback.onUnapproved;
  if (requested !== 'allow') return requested;
  // v2.7 (angry-QA-found): the production signal MUST be
  // `config.isStaging === false`, not `NODE_ENV === 'production'`. This
  // codebase runs staging with `NODE_ENV=production` (per ecosystem
  // config) and distinguishes via `IS_STAGING`. The previous OR-combined
  // check treated staging AS production, downgrading the `allow` escape
  // hatch even on staging — slightly more conservative but inconsistent
  // with the documented semantics of the operator's `is staging` flag.
  // Use ONLY the structured signal so behavior is predictable.
  const isProduction = (config as { isStaging?: boolean }).isStaging === false;
  const explicit = (process.env.CLOUD_REASONING_ALLOW_UNAPPROVED_IN_PROD || 'false') === 'true';
  if (isProduction && !explicit) {
    logger.warn('cloud-reasoning-gate: CLOUD_REASONING_ON_UNAPPROVED_MODEL=allow ignored in production (set CLOUD_REASONING_ALLOW_UNAPPROVED_IN_PROD=true to opt in)');
    return 'return_local_result_with_warning';
  }
  return 'allow';
}
