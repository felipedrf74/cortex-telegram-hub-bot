// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-19 — privacy-first loader that turns the persisted shadow-replay rows
 * (`chat_v2_replay_bundles`, id `chatv2-shadow-replay:%`) into a LABELED recall
 * corpus, with NO raw message text surviving into the loaded corpus or any
 * downstream artifact.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PRIVACY CONTRACT (§5.F / OD-4 — the BLOCKING item this WP closes)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 1. DROP TEXT (OD-4 preferred terminal state).
 *    A loaded shadow corpus item carries ONLY:
 *      - `expectedCapabilityIds`  — the classifier's ground-truth-proxy labels
 *                                   (the shadow row's `guessedCapabilities`),
 *      - `candidateCapabilityIds` — the prepass/route candidate ids the selector
 *                                   already produced at shadow time
 *                                   (`selectedCapabilityIds`),
 *      - `messageToken`           — a tenant+user-SALTED HMAC of the message,
 *      - `locale`                 — a coarse language tag, and
 *      - `turnId`                 — an opaque turn id (already non-PII).
 *    It NEVER carries the raw message, a message preview, a message prefix, or
 *    any user/account text. A recall corpus needs the candidate ids and the
 *    ground-truth labels ONLY — it does not need the message text to score
 *    recall@k — so the selector is effectively "already run" (its output is the
 *    persisted `selectedCapabilityIds`) and the raw text is dropped outright.
 *
 *    Crucially, the source shadow rows ALREADY store no raw text: the shadow
 *    route hook (`shadow-route-hook.ts`) persists only `messageHash` (a salted
 *    HMAC) + the guessed/selected capability ids, never the message. This loader
 *    preserves that invariant end-to-end and asserts it structurally
 *    (`assertNoRawTextInLoadedItem`), so a regression in the writer cannot leak
 *    text through the loader.
 *
 * 2. TENANT+USER-SALTED HMAC, NEVER global-unsalted (§5.F house standard).
 *    The carried `messageToken` is the shadow row's existing
 *    `contextPack.messageHash`, which the writer computes as
 *    `HMAC(secret, "${tenantId}:${userId}:message:${text}")` — tenant+user
 *    salted, matching `prepass-miss-log.ts:38` and `cloud-allowlist-packet.ts`
 *    `hmacTenantScopedEntityId`. The token therefore differs for identical text
 *    across tenants OR users (no cross-tenant message-equality leak). A
 *    global-unsalted `HMAC(text, secret)` is FORBIDDEN and never produced here.
 *
 * 3. HMAC SECRET MANDATORY — HARD FAIL on a real DB (§5.F).
 *    `hmacSecret` is REQUIRED (this loader THROWS) whenever the source DB is NOT
 *    an in-memory fixture (`db.name !== ':memory:'`). A missing/empty secret
 *    against a real on-disk DB is a hard error — the loader never silently
 *    proceeds. An in-memory fixture (`:memory:`) is allowed without a secret so
 *    unit tests can seed/read deterministically; the CI workflow additionally
 *    fails the job when `CORPUS_EVAL_HMAC_SECRET` is empty while `DATABASE_PATH`
 *    points at a real DB, so the real-DB path can never run unsecured.
 *
 *    HONESTY: HMAC is pseudonymisation, not anonymisation. The secret gates
 *    whether this loader may run against a real DB at all; the drop-text design
 *    (1) is what actually removes the reversible dictionary-attack risk class,
 *    because no raw text is ever loaded or persisted to be reversed.
 *
 * Read-only: this module only SELECTs from `chat_v2_replay_bundles`. It performs
 * no provider calls and no network IO.
 */

import { createHmac } from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from '../database';
import { ensureChatCoreV2AuditTables } from './model-run-audit';

export const CHAT_CORE_V2_SHADOW_CORPUS_LOADER_VERSION = 'chat_core_v2_shadow_corpus_loader@1.0.0';

/** Shadow replay rows are written with this id prefix (see `shadow-replay.ts`). */
const SHADOW_BUNDLE_ID_LIKE = 'chatv2-shadow-replay:%';
/** A salted HMAC token must be 64 lowercase hex chars (sha256). */
const HMAC_HEX_64 = /^[a-f0-9]{64}$/;

/** Default lookback window for the weekly loader. */
export const DEFAULT_SHADOW_CORPUS_WINDOW_DAYS = 30;
/** Default hard cap on loaded items (bounded artifact size). */
export const DEFAULT_SHADOW_CORPUS_LIMIT = 5000;

export interface LoadShadowReplayCorpusOptions {
  /** Only load rows created within this many days. Default 30. */
  windowDays?: number;
  /** Hard cap on the number of loaded items. Default 5000. */
  limit?: number;
  /**
   * MANDATORY whenever the source DB is not an in-memory fixture. Used ONLY to
   * re-salt and verify the carried token construction in tests / debug builds;
   * the loaded item's `messageToken` is the row's existing salted HMAC, never a
   * re-hash of raw text (which the loader does not have). A missing/empty secret
   * on a real DB is a HARD ERROR.
   */
  hmacSecret?: string;
  /** Override "now" for deterministic window cutoffs in tests. */
  now?: Date;
}

/**
 * A single loaded shadow corpus item. DROP-TEXT by construction: there is no
 * `message`, `messagePreview`, or any raw-text field — only labels, a salted
 * token, a locale, and an opaque turn id.
 */
export interface ShadowReplayCorpusItem {
  /** Opaque shadow turn id (already non-PII). */
  turnId: string;
  /** Ground-truth-proxy capability labels (the shadow `guessedCapabilities`). */
  expectedCapabilityIds: string[];
  /** Candidate capability ids the selector produced at shadow time. */
  candidateCapabilityIds: string[];
  /** Tenant+user-SALTED HMAC of the message (NEVER the raw message). */
  messageToken: string;
  /** Coarse language tag (no free text). */
  locale: string;
}

export interface LoadShadowReplayCorpusResult {
  version: string;
  windowDays: number;
  /** Rows inspected within the window (before drop/skip filtering). */
  inspected: number;
  /** Rows skipped because they carried no usable ground-truth labels. */
  skippedNoLabels: number;
  /** Rows skipped because they lacked precomputed candidate ids from the selector. */
  skippedNoCandidates: number;
  /** Rows skipped because they lacked the safe salted-token shape. */
  skippedNoToken: number;
  /** The loaded, drop-text corpus items. */
  items: ShadowReplayCorpusItem[];
}

/**
 * Thrown when `hmacSecret` is missing/empty against a real (non-`:memory:`) DB.
 * Distinct error type so the CI workflow / script can fail loudly and explicitly
 * on the blocking privacy condition.
 */
export class ShadowCorpusHmacSecretRequiredError extends Error {
  constructor(dbName: string) {
    super(
      `shadow-corpus-loader: hmacSecret is MANDATORY against a real DB ("${dbName}"). `
        + 'Set CORPUS_EVAL_HMAC_SECRET. A missing/empty secret is a hard failure (§5.F); '
        + 'only an in-memory (:memory:) fixture may load without a secret.',
    );
    this.name = 'ShadowCorpusHmacSecretRequiredError';
  }
}

/**
 * Load the shadow-replay corpus as DROP-TEXT items. See the module header for
 * the full privacy contract. Hard-fails when `hmacSecret` is empty on a real DB.
 */
export function loadShadowReplayCorpusItems(
  db: Database.Database = getDb(),
  options: LoadShadowReplayCorpusOptions = {},
): LoadShadowReplayCorpusResult {
  const windowDays = normalizeWindowDays(options.windowDays);
  const limit = normalizeLimit(options.limit);

  // ── BLOCKING privacy gate: the secret is MANDATORY on a real DB. ──────────
  // An in-memory fixture (`:memory:`) is the only DB allowed to load without a
  // secret, so unit tests can seed/read deterministically. Any real on-disk DB
  // with an empty secret throws — never silently proceeds.
  const isInMemory = db.name === ':memory:';
  const secret = (options.hmacSecret ?? '').trim();
  if (!isInMemory && secret.length === 0) {
    throw new ShadowCorpusHmacSecretRequiredError(db.name);
  }

  ensureChatCoreV2AuditTables(db);

  const cutoffIso = computeWindowCutoffIso(windowDays, options.now);
  const rows = db
    .prepare(
      `SELECT turn_id, redacted_bundle_json, created_at
         FROM chat_v2_replay_bundles
        WHERE replay_bundle_id LIKE ?
          AND created_at >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(SHADOW_BUNDLE_ID_LIKE, cutoffIso, limit) as Array<{
      turn_id: string;
      redacted_bundle_json: string;
      created_at: string;
    }>;

  let skippedNoLabels = 0;
  let skippedNoCandidates = 0;
  let skippedNoToken = 0;
  const items: ShadowReplayCorpusItem[] = [];

  for (const row of rows) {
    const parsed = safeParseObject(row.redacted_bundle_json);
    if (!parsed) {
      skippedNoLabels += 1;
      continue;
    }

    const contextPack = asObject(parsed.contextPack);
    const response = asObject(parsed.response);

    // Ground-truth-proxy labels: the classifier's guessed capabilities. A row
    // with no labels cannot contribute to recall and is skipped (not an error).
    const expectedCapabilityIds = normalizeCapabilityIds(contextPack?.guessedCapabilities);
    if (expectedCapabilityIds.length === 0) {
      skippedNoLabels += 1;
      continue;
    }

    // Candidate ids the selector produced at shadow time. Do NOT fall back to
    // guessedCapabilities: using the expected labels as candidates would let a
    // malformed legacy row self-label as a recall hit and inflate the gate.
    const candidateCapabilityIds = normalizeCapabilityIds(response?.selectedCapabilityIds);
    if (candidateCapabilityIds.length === 0) {
      skippedNoCandidates += 1;
      continue;
    }

    // The carried token MUST be the existing tenant+user-salted HMAC. A row
    // without a 64-hex token shape is skipped: we never substitute raw text and
    // never emit an unsalted token.
    const messageToken =
      typeof contextPack?.messageHash === 'string' ? contextPack.messageHash : '';
    if (!HMAC_HEX_64.test(messageToken)) {
      skippedNoToken += 1;
      continue;
    }

    const locale = typeof contextPack?.locale === 'string' && contextPack.locale.trim()
      ? contextPack.locale.trim()
      : 'unknown';

    const item: ShadowReplayCorpusItem = {
      turnId: typeof row.turn_id === 'string' ? row.turn_id : '',
      expectedCapabilityIds,
      candidateCapabilityIds,
      messageToken,
      locale,
    };

    // Defense-in-depth: structurally prove no raw text survived into the item
    // before it is admitted to the corpus. Throws on any string field that is
    // not the salted token / locale / turn id / capability id.
    assertNoRawTextInLoadedItem(item);
    items.push(item);
  }

  return {
    version: CHAT_CORE_V2_SHADOW_CORPUS_LOADER_VERSION,
    windowDays,
    inspected: rows.length,
    skippedNoLabels,
    skippedNoCandidates,
    skippedNoToken,
    items,
  };
}

/**
 * Recompute the house-standard tenant+user-salted token for a known
 * (tenantId,userId,message) triple. EXPORTED for tests and for any debug build
 * that needs to verify the writer's token construction — it is NOT used to
 * tokenise raw text inside the loader (the loader has no raw text). This is the
 * exact construction the shadow route hook uses
 * (`HMAC(secret, "${tenantId}:${userId}:message:${text}")`), so a test can prove
 * the salting property (different tenant OR user → different token).
 */
export function computeTenantUserSaltedMessageToken(input: {
  hmacSecret: string;
  tenantId: string | number;
  userId: string | number;
  message: string;
}): string {
  const secret = input.hmacSecret.trim();
  if (secret.length === 0) {
    throw new Error('computeTenantUserSaltedMessageToken: hmacSecret must be non-empty');
  }
  return createHmac('sha256', secret)
    .update(`${input.tenantId}:${input.userId}:message:${input.message}`)
    .digest('hex');
}

/**
 * Structural drop-text guard. Throws if a loaded item contains any string value
 * that is not an allowlisted safe field (salted token, locale, turn id, or a
 * capability id). Capability ids are dotted lowercase identifiers, never free
 * text. A raw message — which contains spaces, punctuation, or arbitrary casing
 * — would fail every allowlist and trip this guard.
 */
export function assertNoRawTextInLoadedItem(item: ShadowReplayCorpusItem): void {
  if (!HMAC_HEX_64.test(item.messageToken)) {
    throw new Error('shadow-corpus-loader: messageToken is not a 64-hex salted HMAC (possible raw-text leak)');
  }
  const capabilityLike = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;
  for (const id of [...item.expectedCapabilityIds, ...item.candidateCapabilityIds]) {
    if (!capabilityLike.test(id)) {
      throw new Error(`shadow-corpus-loader: capability id "${id}" is not a safe identifier (possible raw-text leak)`);
    }
  }
  // Locale is a coarse tag; reject anything that looks like a sentence.
  if (/\s/.test(item.locale) || item.locale.length > 16) {
    throw new Error('shadow-corpus-loader: locale field carries unexpected free text (possible raw-text leak)');
  }
}

function normalizeWindowDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SHADOW_CORPUS_WINDOW_DAYS;
  return Math.max(1, Math.min(365, Math.trunc(value as number)));
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SHADOW_CORPUS_LIMIT;
  return Math.max(1, Math.min(50000, Math.trunc(value as number)));
}

function computeWindowCutoffIso(windowDays: number, now: Date | undefined): string {
  const base = now ?? new Date();
  return new Date(base.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeCapabilityIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))];
}

function safeParseObject(json: string): Record<string, unknown> | null {
  return asObject(safeParse(json));
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
