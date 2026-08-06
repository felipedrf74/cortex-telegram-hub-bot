// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * R4 P2 / R5 P2 — CompletionFeedbackV2 idempotency hash helper.
 *
 * Why this exists as its own module:
 *
 *   - The /training/complete and tool-executor `log_training_completion`
 *     paths both need the same canonical-value fingerprint to keep
 *     event-outbox dedup correct.
 *   - R3 P2 added a presence-only hash (e.g. `hasRir: rir != null`).
 *     Codex caught (R4 P2) that this collapsed any two payloads with the
 *     same *shape* onto a single idempotency key, even when their values
 *     were different (e.g. `{ painScore: 1, rir: 2 }` and
 *     `{ painScore: 9, rir: 0 }` collided).
 *   - R5 P2 — Codex then found a concrete collision in the 32-bit
 *     FNV-1a string fingerprint: `painLocation: "3gdr5fzx"` and
 *     `"5bp434lq"` both produce `790060a4`. Replaced both the
 *     string fingerprint AND the outer hash with SHA-256 over a
 *     canonical JSON summary, taking the first 16 hex chars (64 bits)
 *     as the dedup discriminator. 64-bit collision space is ~5B^2
 *     birthday-resistant — well past anything an event outbox will
 *     encounter in practice.
 *
 * Pure, deterministic, no I/O beyond `node:crypto`. Easy to unit test.
 *
 * Privacy: string fields contribute a length-bounded hex digest, not
 * the raw value. So an operator reading the idempotency key cannot
 * reconstruct the user's pain location / missed reason text.
 */

import { createHash } from 'node:crypto';

export interface V2CompletionFieldsForHash {
  notes?: string | null;
  rpe?: number | null;
  rir?: number | null;
  painScore?: number | null;
  painLocation?: string | null;
  technicalSuccessScore?: number | null;
  missedReason?: string | null;
  externalTrainingDeclared?: boolean | null;
  completedDurationSec?: number | null;
  completedDistanceMeters?: number | null;
  completedSetsJson?: string | null;
  completedRepsJson?: string | null;
  completedLoadJson?: string | null;
  // rerun-5 S12 — the route now persists the iOS wellbeing fields, so
  // they join the hash basis (two payloads differing only in energy or
  // soreness must not collapse onto one idempotency key — the R4 P2
  // lesson). Adding keys shifts the canonical JSON for every payload
  // once at deploy; the full idempotency key still scopes per
  // user/row/status, so the shift cannot dedupe across entities.
  energyLevel?: number | null;
  sorenessLevel?: number | null;
  completionState?: string | null;
  readinessLevel?: number | null;
  difficultyFeedback?: string | null;
  durationFeedback?: string | null;
  discomfortFlag?: boolean | null;
  discomfortFlagsJson?: string | null;
  discomfortLocationsJson?: string | null;
  discomfortDetails?: string | null;
  substitutionsUsedJson?: string | null;
  feltTooHard?: boolean | null;
  feltTooEasy?: boolean | null;
  feltTooLong?: boolean | null;
  feltTooShort?: boolean | null;
  modality?: string | null;
  sessionRole?: string | null;
}

/**
 * Length-bounded SHA-256-derived fingerprint for a string field.
 * Returns an empty string for null/undefined/empty inputs so two
 * missing-field payloads collapse to the same hash. Non-string inputs
 * fall through to empty to keep the function total — the validator at
 * the call site already rejects non-strings before this point.
 *
 * Format: `l<length>h<first-12-hex>` — length-prefixed so two distinct
 * strings of equal length don't share a hash bucket purely on length.
 * 48-bit hex per string is comfortably collision-resistant for the
 * field values we accept (≤ 8KB JSON / ≤ 256 char text).
 *
 * Why SHA-256 (not Blake2/xxhash): node ships it without a dep, and
 * we don't need crypto-grade security here — only enough entropy to
 * make adversarial collisions infeasible AND to eliminate the
 * accidental collisions FNV-1a/32-bit was producing.
 */
function stringFingerprint(s: unknown): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  const digest = createHash('sha256').update(s, 'utf8').digest('hex');
  return `l${s.length}h${digest.slice(0, 12)}`;
}

/**
 * Numeric field is canonicalized to either a finite number or null.
 * NaN/Infinity get coerced to null — they should never reach this point
 * (validator rejects them), but keeping the function total prevents a
 * future regression from emitting noisy hash bases.
 */
function canonicalNumber(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

/**
 * Build the canonical summary used as the hash basis. Exposed for tests
 * so the canonicalization step is independently verifiable.
 */
export function buildV2CanonicalSummary(
  fields: V2CompletionFieldsForHash,
): Record<string, number | string | boolean | null> {
  return {
    notes: stringFingerprint(fields.notes),
    rpe: canonicalNumber(fields.rpe),
    rir: canonicalNumber(fields.rir),
    painScore: canonicalNumber(fields.painScore),
    painLocation: stringFingerprint(fields.painLocation),
    technicalSuccessScore: canonicalNumber(fields.technicalSuccessScore),
    missedReason: stringFingerprint(fields.missedReason),
    externalTrainingDeclared: fields.externalTrainingDeclared === true,
    completedDurationSec: canonicalNumber(fields.completedDurationSec),
    completedDistanceMeters: canonicalNumber(fields.completedDistanceMeters),
    completedSetsJson: stringFingerprint(fields.completedSetsJson),
    completedRepsJson: stringFingerprint(fields.completedRepsJson),
    completedLoadJson: stringFingerprint(fields.completedLoadJson),
    energyLevel: canonicalNumber(fields.energyLevel),
    sorenessLevel: canonicalNumber(fields.sorenessLevel),
    completionState: stringFingerprint(fields.completionState),
    readinessLevel: canonicalNumber(fields.readinessLevel),
    difficultyFeedback: stringFingerprint(fields.difficultyFeedback),
    durationFeedback: stringFingerprint(fields.durationFeedback),
    discomfortFlag: fields.discomfortFlag === true,
    discomfortFlagsJson: stringFingerprint(fields.discomfortFlagsJson),
    discomfortLocationsJson: stringFingerprint(fields.discomfortLocationsJson),
    discomfortDetails: stringFingerprint(fields.discomfortDetails),
    substitutionsUsedJson: stringFingerprint(fields.substitutionsUsedJson),
    feltTooHard: fields.feltTooHard === true,
    feltTooEasy: fields.feltTooEasy === true,
    feltTooLong: fields.feltTooLong === true,
    feltTooShort: fields.feltTooShort === true,
    modality: stringFingerprint(fields.modality),
    sessionRole: stringFingerprint(fields.sessionRole),
  };
}

/**
 * Stable hex hash of the canonical summary. Used as the `v2-<hex>`
 * suffix of the training.feedback.recorded idempotency key.
 *
 * R5 P2 — replaced the prior 32-bit rolling hash (which Codex found
 * collisions in) with the first 64 bits of a SHA-256 over the
 * canonical-summary JSON. Two payloads with identical canonical
 * values produce identical hex; two payloads that differ in any
 * captured value produce different hex with negligible collision
 * probability (~2^32 birthday bound — out of reach for event-outbox
 * traffic).
 */
export function computeV2IdempotencyHashHex(
  fields: V2CompletionFieldsForHash,
): string {
  const basis = JSON.stringify(buildV2CanonicalSummary(fields));
  return createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 16);
}
