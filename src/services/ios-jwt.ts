// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import jwt from 'jsonwebtoken';
import { config } from '../config';

const DEFAULT_IOS_JWT_KID = 'ios-api-current';

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
  verifyUntil?: string | number | null;
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
  if (typeof value === 'string') {
    return { kid, secret: value };
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid iOS JWT key entry for kid ${kid}`);
  }

  const raw = value as Partial<IosJwtKeyEntry>;
  if (typeof raw.secret !== 'string' || raw.secret.length === 0) {
    throw new Error(`Invalid iOS JWT key entry for kid ${kid}: missing secret`);
  }
  return {
    kid,
    secret: raw.secret,
    active: raw.active === true,
    verifyUntil: raw.verifyUntil ?? null,
  };
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
      if (typeof rawEntry.kid !== 'string' || rawEntry.kid.length === 0) {
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

export function getIosJwtKeyring(): IosJwtKeyring {
  const legacySecret = readLegacySecret();
  const configuredKeys = parseConfiguredKeys(process.env.IOS_API_JWT_KEYS);
  const activeKidFromEnv = process.env.IOS_API_JWT_ACTIVE_KID?.trim();

  const keys = configuredKeys.length > 0
    ? configuredKeys
    : [{
        kid: activeKidFromEnv || DEFAULT_IOS_JWT_KID,
        secret: legacySecret,
        active: true,
      }];

  const active = (activeKidFromEnv
    ? keys.find((entry) => entry.kid === activeKidFromEnv)
    : keys.find((entry) => entry.active === true)) ?? keys[0];

  if (!active) {
    throw new Error('No iOS JWT signing key configured');
  }

  return {
    activeKid: active.kid,
    activeSecret: active.secret,
    legacySecret,
    keys,
  };
}

function keyStillVerifies(entry: IosJwtKeyEntry, nowMs: number): boolean {
  if (entry.verifyUntil == null || entry.verifyUntil === '') return true;
  const cutoff = typeof entry.verifyUntil === 'number'
    ? entry.verifyUntil
    : Date.parse(entry.verifyUntil);
  return Number.isFinite(cutoff) && nowMs <= cutoff;
}

export function signIosJwt(payload: IosJwtPayload, options: SignIosJwtOptions = {}): string {
  const keyring = getIosJwtKeyring();
  return jwt.sign(payload, keyring.activeSecret, {
    expiresIn: (options.expiresIn ?? readJwtExpiry()) as any,
    header: { alg: 'HS256', kid: keyring.activeKid },
  });
}

export function verifyIosJwt(token: string, nowMs: number = Date.now()): IosJwtPayload {
  const decoded = jwt.decode(token, { complete: true }) as { header?: { kid?: unknown } } | null;
  const kid = decoded?.header?.kid;
  const keyring = getIosJwtKeyring();

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
  const keyring = getIosJwtKeyring();
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
