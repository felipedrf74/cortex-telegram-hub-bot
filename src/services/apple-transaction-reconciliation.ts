// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Scheduled App Store reconciliation (plan §3, NH-0041).
 *
 * The durable notification inbox is the primary fulfillment path; this pass
 * is the independent check behind it: every recently granted Apple pack lot
 * is re-verified against the App Store Server API so a refund or revocation
 * the inbox never received still lands in the ledger (per-lot revocation —
 * plan §2: reversals affect only the originating lot).
 *
 * Credential posture: the App Store Server API requires the NH-0036 issuer
 * id / key id / .p8 key. Until those exist in the environment the pass
 * reports skipped_missing_credentials and does nothing — the job is wired,
 * observable, and inert. Tests inject a client; production builds one that
 * signs ES256 JWTs with the configured key.
 */

import { createPrivateKey, createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { verifyAppleJws } from './apple-jws-verifier';
import { revokeAiCreditLot } from './ai-credit-ledger';
import { isApplePackFulfillmentActive } from './hybrid-runtime-kill-switches';
import { recordOperatorAlert } from './operator-alerts';

export interface AppleTransactionInfoClient {
  getTransactionInfo(transactionId: string): Promise<
    | { kind: 'found'; signedTransactionInfo: string }
    | { kind: 'not_found' }
  >;
}

export interface AppleReconciliationReadiness {
  ready: boolean;
  missing: string[];
}

export function getAppleReconciliationReadiness(): AppleReconciliationReadiness {
  const cfg = config.appleAppStoreServerApi;
  const missing: string[] = [];
  if (!cfg?.issuerId) missing.push('APP_STORE_SERVER_API_ISSUER_ID');
  if (!cfg?.keyId) missing.push('APP_STORE_SERVER_API_KEY_ID');
  if (!cfg?.privateKeyPath) missing.push('APP_STORE_SERVER_API_PRIVATE_KEY_PATH');
  if (!cfg?.bundleId) missing.push('APPLE_BUNDLE_ID');
  return { ready: missing.length === 0, missing };
}

export type AppleReconciliationResult =
  | { kind: 'skipped_fulfillment_disabled' }
  | { kind: 'skipped_missing_credentials'; missing: string[] }
  | {
    kind: 'completed';
    checked: number;
    revoked: number;
    missingTransactions: number;
    errors: number;
  };

interface ReconcilableLotRow {
  id: number;
  user_id: number;
  provider_transaction_id: string;
}

/**
 * Reconcile recently granted, still-active Apple pack lots against the App
 * Store Server API. Revocations revoke the originating lot only; unknown
 * transactions and API errors raise an operator alert instead of guessing.
 */
export async function runAppleTransactionReconciliation(options: {
  client?: AppleTransactionInfoClient;
  windowDays?: number;
  limit?: number;
  now?: Date;
} = {}): Promise<AppleReconciliationResult> {
  if (!isApplePackFulfillmentActive()) {
    return { kind: 'skipped_fulfillment_disabled' };
  }
  let client = options.client;
  if (!client) {
    const readiness = getAppleReconciliationReadiness();
    if (!readiness.ready) {
      logger.info({ missing: readiness.missing }, 'apple-reconciliation: skipped, credentials not provisioned');
      return { kind: 'skipped_missing_credentials', missing: readiness.missing };
    }
    client = buildAppStoreServerApiClient();
  }

  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 30;
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000);
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const lots = getDb().prepare(`
    SELECT id, user_id, provider_transaction_id
    FROM ai_credit_lots
    WHERE provider = 'apple' AND status = 'active'
      AND provider_transaction_id IS NOT NULL AND granted_at >= ?
    ORDER BY id LIMIT ?
  `).all(since, limit) as ReconcilableLotRow[];

  let revoked = 0;
  let missingTransactions = 0;
  let errors = 0;
  for (const lot of lots) {
    try {
      const info = await client.getTransactionInfo(lot.provider_transaction_id);
      if (info.kind === 'not_found') {
        missingTransactions += 1;
        continue;
      }
      const payload = verifyAppleJws(info.signedTransactionInfo, { requireX5c: true })
        .payload as Record<string, any>;
      const revokedAt = payload.revocationDate;
      if (typeof revokedAt === 'number' && revokedAt > 0) {
        const result = revokeAiCreditLot({
          lotId: lot.id,
          reason: 'apple_reconciliation_revocation',
          now,
        });
        if (result.kind === 'revoked') revoked += 1;
      }
    } catch (err) {
      errors += 1;
      logger.warn({ err, lotId: lot.id }, 'apple-reconciliation: transaction check failed');
    }
  }

  if (revoked > 0 || missingTransactions > 0 || errors > 0) {
    recordOperatorAlert({
      severity: 'warning',
      source: 'apple-transaction-reconciliation',
      dedupeKey: `apple_reconciliation:${now.toISOString().slice(0, 10)}`,
      title: 'App Store reconciliation findings',
      detail: `checked=${lots.length} revoked=${revoked} missing=${missingTransactions} errors=${errors}`,
      metadata: { checked: lots.length, revoked, missingTransactions, errors },
      suspectedArea: 'billing',
    });
  }
  logger.info(
    { checked: lots.length, revoked, missingTransactions, errors },
    'apple-reconciliation: pass complete',
  );
  return { kind: 'completed', checked: lots.length, revoked, missingTransactions, errors };
}

/** ES256-signed App Store Server API client (production credential path). */
function buildAppStoreServerApiClient(): AppleTransactionInfoClient {
  const cfg = config.appleAppStoreServerApi;
  const host = cfg.environment === 'Sandbox'
    ? 'https://api.storekit-sandbox.itunes.apple.com'
    : 'https://api.storekit.itunes.apple.com';
  return {
    async getTransactionInfo(transactionId: string) {
      const response = await fetch(`${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: `Bearer ${signAppStoreServerApiJwt()}` },
      });
      if (response.status === 404) return { kind: 'not_found' as const };
      if (!response.ok) {
        throw new Error(`app store server api responded ${response.status}`);
      }
      const body = await response.json() as { signedTransactionInfo?: string };
      if (typeof body.signedTransactionInfo !== 'string' || !body.signedTransactionInfo) {
        throw new Error('app store server api returned no signedTransactionInfo');
      }
      return { kind: 'found' as const, signedTransactionInfo: body.signedTransactionInfo };
    },
  };
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signAppStoreServerApiJwt(): string {
  const cfg = config.appleAppStoreServerApi;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: cfg.issuerId,
    iat: nowSeconds,
    exp: nowSeconds + 5 * 60,
    aud: 'appstoreconnect-v1',
    bid: cfg.bundleId,
    jti: randomUUID(),
  }));
  const key = createPrivateKey(readFileSync(cfg.privateKeyPath, 'utf8'));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${base64Url(signature)}`;
}
