// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import jwt from 'jsonwebtoken';
import { config } from '../config';
import { parseIosJwtExpirySeconds } from './ios-jwt-expiry';

export { parseIosJwtExpirySeconds } from './ios-jwt-expiry';

const DEFAULT_IOS_JWT_KID = 'ios-api-current';
const IOS_JWT_SECRET_MIN_BYTES = 32;
const IOS_JWT_PLACEHOLDER_PATTERN = /(change[-_ ]?me|changeme|stub)/i;

export interface IosJwtPayload {
  userId?: unknown;
  tenantId?: unknown;
  deviceId?: unknown;
  [key: string]: unknown;
}

export interface IosJwtKeyEntry {
  kid: string;
  secret: string;
  active?: boolean;
  verifyUntil?: string | null;
}

export interface IosJwtKeyring {
  activeKid: string;
  activeSecret: string;
  legacySecret: string;
  keys: IosJwtKeyEntry[];
}

export interface SignIosJwtOptions {
  expiresIn?: string;
}

function readLegacySecret(): string {
  return process.env.IOS_API_JWT_SECRET || config.ios.jwtSecret;
}

function readJwtExpiry(): string {
  return process.env.IOS_JWT_EXPIRY || config.ios.jwtExpiry || '7d';
}

function normalizeKeyEntry(kid: string, value: unknown): IosJwtKeyEntry {
  if (kid.trim().length === 0 || kid !== kid.trim()) {
    throw new Error('Invalid iOS JWT key entry: missing kid');
  }
  if (typeof value === 'string') {
    return { kid, secret: assertStrongIosJwtSecret(value, kid) };
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid iOS JWT key entry for kid ${kid}`);
  }

  const raw = value as Partial<IosJwtKeyEntry>;
  if (typeof raw.secret !== 'string' || raw.secret.length === 0) {
    throw new Error(`Invalid iOS JWT key entry for kid ${kid}: missing secret`);
  }
  if (raw.verifyUntil !== undefined
    && raw.verifyUntil !== null
    && typeof raw.verifyUntil !== 'string') {
    throw new Error(`Invalid iOS JWT verification cutoff for kid ${kid}`);
  }
  if (raw.verifyUntil === '') {
    throw new Error(`Invalid iOS JWT verification cutoff for kid ${kid}`);
  }
  return {
    kid,
    secret: assertStrongIosJwtSecret(raw.secret, kid),
    active: raw.active === true,
    verifyUntil: raw.verifyUntil ?? null,
  };
}

function verificationCutoff(entry: IosJwtKeyEntry): number | null {
  if (entry.verifyUntil == null) return null;
  const cutoff = Date.parse(entry.verifyUntil);
  if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== entry.verifyUntil) {
    throw new Error(`Invalid iOS JWT verification cutoff for kid ${entry.kid}`);
  }
  return cutoff;
}

export function assertStrongIosJwtSecret(secret: string, kid = 'IOS_API_JWT_SECRET'): string {
  if (
    Buffer.byteLength(secret, 'utf8') < IOS_JWT_SECRET_MIN_BYTES
    || IOS_JWT_PLACEHOLDER_PATTERN.test(secret)
  ) {
    throw new Error(
      `iOS JWT secret for kid ${kid} must be at least 32 bytes and cannot contain known placeholder text.`,
    );
  }
  return secret;
}

function parseConfiguredKeys(raw: string | undefined): IosJwtKeyEntry[] {
  if (!raw || raw.trim().length === 0) return [];

  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error('Invalid iOS JWT key entry');
      }
      const rawEntry = entry as Partial<IosJwtKeyEntry>;
      if (typeof rawEntry.kid !== 'string' || rawEntry.kid.trim().length === 0) {
        throw new Error('Invalid iOS JWT key entry: missing kid');
      }
      return normalizeKeyEntry(rawEntry.kid, rawEntry);
    });
  }

  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed as Record<string, unknown>).map(([kid, value]) =>
      normalizeKeyEntry(kid, value),
    );
  }

  throw new Error('IOS_API_JWT_KEYS must be a JSON object or array');
}

export function getIosJwtKeyring(nowMs: number = Date.now()): IosJwtKeyring {
  const legacySecret = readLegacySecret();
  const configuredKeys = parseConfiguredKeys(process.env.IOS_API_JWT_KEYS);
  const activeKidRaw = process.env.IOS_API_JWT_ACTIVE_KID;
  if (activeKidRaw != null && activeKidRaw.length > 0 && activeKidRaw !== activeKidRaw.trim()) {
    throw new Error('IOS_API_JWT_ACTIVE_KID must be a non-empty trimmed key id');
  }
  const activeKidFromEnv = activeKidRaw || undefined;
  if (!legacySecret) {
    throw new Error('IOS_API_JWT_SECRET is required for legacy no-kid token verification');
  }
  const validatedLegacySecret = assertStrongIosJwtSecret(legacySecret);

  const keys = configuredKeys.length > 0
    ? configuredKeys
    : [{
        kid: activeKidFromEnv || DEFAULT_IOS_JWT_KID,
        secret: validatedLegacySecret,
        active: true,
      }];

  const uniqueKids = new Set(keys.map((entry) => entry.kid));
  if (uniqueKids.size !== keys.length) {
    throw new Error('IOS_API_JWT_KEYS contains duplicate kid values');
  }
  for (const entry of keys) verificationCutoff(entry);

  const markedActive = keys.filter((entry) => entry.active === true);
  if (markedActive.length > 1) {
    throw new Error('IOS_API_JWT_KEYS must not mark more than one active signing key');
  }

  let active: IosJwtKeyEntry | undefined;
  if (activeKidFromEnv) {
    active = keys.find((entry) => entry.kid === activeKidFromEnv);
    if (!active) {
      throw new Error(`IOS_API_JWT_ACTIVE_KID does not match a configured key: ${activeKidFromEnv}`);
    }
    if (markedActive.length === 1 && markedActive[0].kid !== activeKidFromEnv) {
      throw new Error('IOS_API_JWT_ACTIVE_KID conflicts with the key marked active');
    }
  } else if (configuredKeys.length > 0) {
    if (markedActive.length !== 1) {
      throw new Error('IOS_API_JWT_KEYS must mark exactly one active signing key');
    }
    [active] = markedActive;
  } else {
    [active] = keys;
  }

  if (!active) {
    throw new Error('No iOS JWT signing key configured');
  }
  if (verificationCutoff(active) != null) {
    throw new Error(`Active iOS JWT signing key must not have a verification cutoff: ${active.kid}`);
  }
  for (const entry of keys) {
    if (entry.kid !== active.kid && verificationCutoff(entry) == null) {
      throw new Error(`Inactive iOS JWT verification key must have a finite cutoff: ${entry.kid}`);
    }
  }

  return {
    activeKid: active.kid,
    activeSecret: active.secret,
    legacySecret: validatedLegacySecret,
    keys,
  };
}

function keyStillVerifies(entry: IosJwtKeyEntry, nowMs: number): boolean {
  const cutoff = verificationCutoff(entry);
  return cutoff == null || nowMs <= cutoff;
}

export function validateIosJwtConfiguration(nowMs: number = Date.now()): void {
  parseIosJwtExpirySeconds(readJwtExpiry());
  getIosJwtKeyring(nowMs);
  if (process.env.IOS_API_JWT_KEYS?.trim()) {
    const appleAccountTokenSecret = process.env.APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET;
    if (!appleAccountTokenSecret) {
      throw new Error('APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET must be pinned before enabling the iOS JWT keyring');
    }
    assertStrongIosJwtSecret(appleAccountTokenSecret, 'APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET');
    const confirmationSecret = process.env.CHAT_CONFIRMATION_HMAC_SECRET;
    if (!confirmationSecret) {
      throw new Error('CHAT_CONFIRMATION_HMAC_SECRET must be pinned before enabling the iOS JWT keyring');
    }
    assertStrongIosJwtSecret(confirmationSecret, 'CHAT_CONFIRMATION_HMAC_SECRET');
    const evidenceSecret = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET;
    if (!evidenceSecret) {
      throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET must be pinned before enabling the iOS JWT keyring');
    }
    assertStrongIosJwtSecret(evidenceSecret, 'CHAT_V2_EVIDENCE_HMAC_SECRET');
  }
}

export function getIosJwtTokenLifetimeSeconds(token: string): number {
  const decoded = jwt.decode(token) as { iat?: unknown; exp?: unknown } | null;
  if (!decoded || typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') {
    throw new Error('Signed iOS JWT is missing a numeric iat/exp lifetime');
  }
  const lifetime = decoded.exp - decoded.iat;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) {
    throw new Error('Signed iOS JWT has an invalid lifetime');
  }
  return lifetime;
}

export function signIosJwt(payload: IosJwtPayload, options: SignIosJwtOptions = {}): string {
  const expiresInSeconds = parseIosJwtExpirySeconds(options.expiresIn ?? readJwtExpiry());
  const keyring = getIosJwtKeyring();
  return jwt.sign(payload, keyring.activeSecret, {
    expiresIn: expiresInSeconds,
    header: { alg: 'HS256', kid: keyring.activeKid },
  });
}

export function verifyIosJwt(token: string, nowMs: number = Date.now()): IosJwtPayload {
  const decoded = jwt.decode(token, { complete: true }) as { header?: { kid?: unknown } } | null;
  const kid = decoded?.header?.kid;
  const keyring = getIosJwtKeyring(nowMs);

  if (typeof kid === 'string' && kid.length > 0) {
    const entry = keyring.keys.find((candidate) => candidate.kid === kid);
    if (!entry || !keyStillVerifies(entry, nowMs)) {
      throw new Error(`iOS JWT kid is not active for verification: ${kid}`);
    }
    return jwt.verify(token, entry.secret) as IosJwtPayload;
  }

  // Migration compatibility: tokens minted before Batch 21 have no `kid`.
  // They continue to verify with the legacy IOS_API_JWT_SECRET until natural
  // expiry, while all newly-issued tokens carry an explicit key id.
  return jwt.verify(token, keyring.legacySecret) as IosJwtPayload;
}

export function getIosJwtKeyStatus(nowMs: number = Date.now()): {
  activeKid: string;
  configuredKids: Array<{ kid: string; active: boolean; verifies: boolean }>;
  legacyNoKidFallback: boolean;
} {
  const keyring = getIosJwtKeyring(nowMs);
  return {
    activeKid: keyring.activeKid,
    configuredKids: keyring.keys.map((entry) => ({
      kid: entry.kid,
      active: entry.kid === keyring.activeKid,
      verifies: keyStillVerifies(entry, nowMs),
    })),
    legacyNoKidFallback: Boolean(keyring.legacySecret),
  };
}
