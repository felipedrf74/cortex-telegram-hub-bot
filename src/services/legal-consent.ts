// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { Request } from 'express';
import { getDb } from './database';

export type LegalDocumentKey = 'terms' | 'privacy';

export interface LegalDocumentMetadata {
  key: LegalDocumentKey;
  version: string;
  url: string;
  title: string;
  lawyerReviewRequired: boolean;
}

export interface LegalAcceptanceInput {
  accepted?: unknown;
  termsVersion?: unknown;
  privacyVersion?: unknown;
}

export interface LegalConsentContext {
  source: string;
  locale?: string | null;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const SUPPORT_EMAIL = 'support@nexushub.me';

// TODO(lawyer-review): Versions identify the legal copy shown to users.
// Do not treat these docs as approved legal language until counsel signs off.
export const CURRENT_LEGAL_DOCUMENTS: Record<LegalDocumentKey, LegalDocumentMetadata> = {
  terms: {
    key: 'terms',
    version: '2026-06-04',
    url: 'https://nexushub.me/terms',
    title: 'Terms of Service',
    lawyerReviewRequired: true,
  },
  privacy: {
    key: 'privacy',
    version: '2026-06-04',
    url: 'https://nexushub.me/privacy',
    title: 'Privacy Policy',
    lawyerReviewRequired: true,
  },
};

export function getCurrentLegalMetadata() {
  return {
    supportEmail: SUPPORT_EMAIL,
    documents: CURRENT_LEGAL_DOCUMENTS,
  };
}

export function validateCurrentLegalAcceptance(input: LegalAcceptanceInput | null | undefined): {
  ok: boolean;
  reason?: string;
} {
  if (!input || input.accepted !== true) {
    return { ok: false, reason: 'acceptedLegal.accepted must be true' };
  }
  if (input.termsVersion !== CURRENT_LEGAL_DOCUMENTS.terms.version) {
    return { ok: false, reason: 'acceptedLegal.termsVersion is not current' };
  }
  if (input.privacyVersion !== CURRENT_LEGAL_DOCUMENTS.privacy.version) {
    return { ok: false, reason: 'acceptedLegal.privacyVersion is not current' };
  }
  return { ok: true };
}

function hashOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function legalConsentContextFromRequest(
  req: Request,
  source: string,
  locale?: string | null,
  deviceId?: string | null,
): LegalConsentContext {
  return {
    source,
    locale,
    deviceId,
    ipAddress: (req.ip || req.socket?.remoteAddress) ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent']
      : null,
  };
}

export function recordCurrentLegalConsentForUser(
  userId: number,
  input: LegalAcceptanceInput,
  context: LegalConsentContext,
): void {
  const validation = validateCurrentLegalAcceptance(input);
  if (!validation.ok) {
    throw new Error(validation.reason || 'Legal consent is not current');
  }

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO user_legal_consents (
      user_id, document_key, document_version, document_url, locale, source,
      device_id, ip_hash, user_agent_hash, accepted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, document_key, document_version) DO NOTHING
  `);

  for (const document of Object.values(CURRENT_LEGAL_DOCUMENTS)) {
    stmt.run(
      userId,
      document.key,
      document.version,
      document.url,
      context.locale ?? null,
      context.source,
      context.deviceId ?? null,
      hashOptional(context.ipAddress),
      hashOptional(context.userAgent),
    );
  }
}

export function hasCurrentLegalConsent(userId: number): boolean {
  const db = getDb();
  const rows = db.prepare(`
    SELECT document_key
    FROM user_legal_consents
    WHERE user_id = ?
      AND (
        (document_key = 'terms' AND document_version = ?)
        OR (document_key = 'privacy' AND document_version = ?)
      )
  `).all(
    userId,
    CURRENT_LEGAL_DOCUMENTS.terms.version,
    CURRENT_LEGAL_DOCUMENTS.privacy.version,
  ) as Array<{ document_key: LegalDocumentKey }>;

  const keys = new Set(rows.map((row) => row.document_key));
  return keys.has('terms') && keys.has('privacy');
}
