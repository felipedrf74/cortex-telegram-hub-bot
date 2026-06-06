// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';

export function normalizeEmailForIdentity(email: string): string {
  return email.trim().toLowerCase();
}

export function hashEmail(email: string, length = 64): string {
  return crypto
    .createHash('sha256')
    .update(normalizeEmailForIdentity(email), 'utf8')
    .digest('hex')
    .slice(0, length);
}
