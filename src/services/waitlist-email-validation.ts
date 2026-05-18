// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { promises as dns } from 'dns';

const MAX_EMAIL_LENGTH = 254;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  'dispostable.com',
  'getnada.com',
  'guerrillamail.com',
  'mail.tm',
  'mailinator.com',
  'sharklasers.com',
  'temp-mail.org',
  'temp-mail.io',
  'tempmail.com',
  'tempmail.net',
  'throwawaymail.com',
  'yopmail.com',
]);

export interface PublicEmailValidationResult {
  ok: boolean;
  normalizedEmail?: string;
  reason?: 'format' | 'disposable' | 'mx';
}

export function normalizePublicEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > MAX_EMAIL_LENGTH) return null;
  return normalized;
}

export function isPublicEmailSyntaxValid(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

export async function validatePublicEmail(email: unknown): Promise<PublicEmailValidationResult> {
  const normalizedEmail = normalizePublicEmail(email);
  if (!normalizedEmail || !isPublicEmailSyntaxValid(normalizedEmail)) {
    return { ok: false, reason: 'format' };
  }

  const domain = normalizedEmail.split('@')[1] ?? '';
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, reason: 'disposable' };
  }

  if (process.env.WAITLIST_SKIP_MX_CHECK === '1') {
    return { ok: true, normalizedEmail };
  }

  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length === 0) return { ok: false, reason: 'mx' };
    return { ok: true, normalizedEmail };
  } catch {
    return { ok: false, reason: 'mx' };
  }
}
