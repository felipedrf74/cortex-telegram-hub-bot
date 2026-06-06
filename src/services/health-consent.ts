// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Health-data privacy & consent — slice A4p of the Week-Level
 * Adaptability + Periodization plan (v2.1).
 *
 * Composes the per-signal consent + deletion primitives from A0b
 * (adaptation-ledger redaction) and A0c (readiness/health event
 * deletion) into a single privacy-aware orchestration layer.
 *
 * Hard guarantees (from the v2.1 critique):
 *
 *   1. **Per-signal opt-in.** Menstrual, RED-S, illness, injury, and
 *      pain require explicit user authorization separately. Opting
 *      into pain does NOT opt-in to menstrual tracking.
 *
 *   2. **User-visible explanation.** Every consent grant carries a
 *      brief explanation of how that signal will affect training.
 *      The string lives here (single source of truth for support +
 *      iOS surfaces).
 *
 *   3. **Right to delete.** `deleteAllHealthDataForUser(userId)`
 *      cascades across the A0c readiness/health event tables AND
 *      redacts sensitive trigger payloads in the A0b adaptation
 *      ledger. Ledger ROWS are preserved (for audit + the
 *      ScientificPolicyVersion contract); only sensitive content is
 *      redacted.
 *
 *   4. **Access controls.** Operator/support views read with
 *      `ViewerRole = 'support'` so the ledger module redacts
 *      health-sensitive triggers automatically. Owners and admins
 *      see raw payloads. This is enforced at the read layer (A0b's
 *      `redactRowIfNeeded`), not at the write layer — write
 *      semantics never silently drop data.
 *
 *   5. **Retention policy** (defaults configurable per env):
 *      - Sensitive data (pain location, illness symptoms,
 *        menstrual status, RED-S indicators): 12 months active.
 *      - Non-sensitive readiness data: indefinite (still useful
 *        for long-term CTL/ATL reconstruction).
 *      - Ledger rows: preserved indefinitely; sensitive content
 *        redacted on user request.
 *
 *   6. **RED-S framing.** Always 'risk screening', never
 *      'diagnosis'. IOC 2023 REDs CAT2 is a clinical tool — the
 *      app flags risk and recommends professional support.
 */

import { logger } from '../utils/logger';
import { getDb } from './database';
import {
  deleteHealthHistoryForUser,
} from './health-signals';
import {
  deleteReadinessHistoryForUser,
} from './readiness-events';
import {
  purgeSensitivePayloadsForUser,
} from './training-plan-adaptations';

export type ConsentScope =
  | 'readiness_basic'
  | 'hrv_status'
  | 'resting_hr'
  | 'pain'
  | 'illness'
  | 'injury'
  | 'menstrual'
  | 'red_s_screening';

/**
 * Per-scope explanation surfaced in iOS consent UI and support views.
 * Single source of truth — never duplicate this copy in iOS or
 * marketing surfaces.
 */
export const CONSENT_EXPLANATIONS: Record<ConsentScope, string> = {
  readiness_basic:
    'Sleep hours and subjective stress, used to estimate daily readiness and adjust ' +
    'session intensity. Default opt-in; you can turn it off any time.',
  hrv_status:
    'Heart-rate variability status from your wearable, used as one signal among several ' +
    'for fatigue detection. Never used alone — must combine with sleep, RHR, or perceived ' +
    'fatigue to suggest changes.',
  resting_hr:
    'Resting heart rate trend, used to detect early signs of overreaching or illness.',
  pain:
    'Pain score and location, used to gate strength progression and recommend professional ' +
    'support when warranted. Never used to diagnose any condition.',
  illness:
    'Illness symptoms (fever, fatigue, cough, etc.), used to adjust the return-from-gap ramp ' +
    'and recommend professional support for febrile or systemic symptoms.',
  injury:
    'Injury status, used to select a conservative return-to-training protocol when applicable. ' +
    'Localized injury and post-exertional symptom risk get different ramps.',
  menstrual:
    'Menstrual cycle status and symptoms, used (when you opt in) only as a symptom-aware preference ' +
    "signal. The app does NOT predict performance from cycle phase — evidence is mixed and we won't " +
    'pretend to know more than the research does.',
  red_s_screening:
    'Energy availability risk screening (Relative Energy Deficiency in Sport). This is a SCREENING ' +
    'flag, not a diagnosis. High risk triggers a recommendation to consult a sports dietitian and ' +
    'sports-medicine physician — never an automated diagnosis.',
};

export interface HealthDataDeletionResult {
  userId: number;
  readinessEventsDeleted: number;
  healthSignalsDeleted: number;
  ledgerRowsRedacted: number;
  /** Wall-clock seconds the operation took. Useful for support SLA tracking. */
  elapsedSeconds: number;
}

/**
 * Delete all health and readiness history for a user across the
 * three storage layers:
 *
 *   - athlete_readiness_events  (A0c)
 *   - athlete_health_signals    (A0c)
 *   - training_plan_adaptations (A0b) — ledger ROWS preserved,
 *                                       sensitive payloads redacted
 *
 * **Transactional** (Codex P2 fix). All three operations run inside
 * a single BEGIN/COMMIT so a crash mid-flow rolls back the entire
 * deletion — never leaves health-sensitive ledger payloads behind
 * after the source rows are gone. Order within the transaction:
 *
 *   1. Redact ledger payloads FIRST (removes the most-likely-leaked
 *      surface — the support-readable adaptation ledger).
 *   2. Delete health_signals (more sensitive than readiness).
 *   3. Delete readiness_events.
 *
 * If any step throws, better-sqlite3 rolls all three back so the
 * caller sees either "everything deleted" or "nothing deleted",
 * never a partial state with sensitive content stranded somewhere.
 *
 * Per the v2.1 critique, this is the canonical "right to be
 * forgotten" primitive for health-sensitive content.
 */
export function deleteAllHealthDataForUser(
  userId: number,
): HealthDataDeletionResult {
  const start = Date.now();
  const db = getDb();

  let readinessEventsDeleted = 0;
  let healthSignalsDeleted = 0;
  let ledgerRowsRedacted = 0;

  const txn = db.transaction((): void => {
    // 1. Redact ledger payloads FIRST (Codex P2 — safer order).
    ledgerRowsRedacted = purgeSensitivePayloadsForUser(userId);
    // 2. Delete health signals next.
    healthSignalsDeleted = deleteHealthHistoryForUser(userId);
    // 3. Delete readiness events last.
    readinessEventsDeleted = deleteReadinessHistoryForUser(userId);
  });
  txn();

  const result: HealthDataDeletionResult = {
    userId,
    readinessEventsDeleted,
    healthSignalsDeleted,
    ledgerRowsRedacted,
    elapsedSeconds: (Date.now() - start) / 1000,
  };

  logger.info(result, 'health_consent.delete_all');
  return result;
}

/**
 * Validate that a consent-scope set is well-formed. Returns an array
 * of validation errors (empty when valid). Caller decides whether to
 * reject the request or warn the user.
 */
export function validateConsentScopes(scopes: readonly string[]): string[] {
  const errors: string[] = [];
  const known = new Set<ConsentScope>(Object.keys(CONSENT_EXPLANATIONS) as ConsentScope[]);
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!known.has(scope as ConsentScope)) {
      errors.push(`unknown consent scope: ${scope}`);
    }
    if (seen.has(scope)) {
      errors.push(`duplicate consent scope: ${scope}`);
    }
    seen.add(scope);
  }
  return errors;
}

/**
 * Default retention windows (days) per scope. Operators can override
 * via env config when the plan ships; this module exposes the
 * declarative defaults so support and the iOS UI agree.
 */
export const DEFAULT_RETENTION_DAYS: Record<ConsentScope, number> = {
  readiness_basic: 0,        // 0 = indefinite (still useful for long-term CTL/ATL)
  hrv_status: 0,             // indefinite
  resting_hr: 0,              // indefinite
  pain: 365,                  // 12 months active
  illness: 365,
  injury: 365,
  menstrual: 365,
  red_s_screening: 365,
};

/**
 * Per-scope severity for support-view redaction. Used by A0b's
 * `redactRowIfNeeded` to decide which ledger payloads to hide from
 * non-admin viewers.
 */
export const SCOPE_SUPPORT_REDACTED: Record<ConsentScope, boolean> = {
  readiness_basic: false,
  hrv_status: false,
  resting_hr: false,
  pain: true,
  illness: true,
  injury: true,
  menstrual: true,
  red_s_screening: true,
};
