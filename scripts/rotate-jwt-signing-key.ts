#!/usr/bin/env npx tsx

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { parseIosJwtExpirySeconds } from '../src/services/ios-jwt-expiry';

interface JwtKeyConfig {
  kid: string;
  secret: string;
  active?: boolean;
  verifyUntil?: string;
}

interface RotationPlan {
  activeKid: string;
  keys: JwtKeyConfig[];
  verifyUntil: string;
}

const DEFAULT_IOS_JWT_EXPIRY = '7d';
const DEFAULT_IOS_JWT_KID = 'ios-api-current';
const MINIMUM_ROTATION_WINDOW_HOURS = 8 * 24;
const ROTATION_SAFETY_BUFFER_HOURS = 24;
const PLACEHOLDER_PATTERN = /(change[-_ ]?me|changeme|stub)/i;

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function assertKid(kid: unknown, label: string): string {
  if (typeof kid !== 'string' || kid.length === 0 || kid !== kid.trim()) {
    throw new Error(`${label} must be a non-empty trimmed key id`);
  }
  return kid;
}

function assertSecret(secret: unknown, kid: string): string {
  if (
    typeof secret !== 'string'
    || Buffer.byteLength(secret, 'utf8') < 32
    || PLACEHOLDER_PATTERN.test(secret)
  ) {
    throw new Error(`Signing secret for ${kid} must be at least 32 bytes and non-placeholder`);
  }
  return secret;
}

function assertIsoCutoff(raw: unknown, kid: string): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`Verification cutoff for ${kid} must be a finite ISO-8601 timestamp`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new Error(`Verification cutoff for ${kid} must be a finite ISO-8601 timestamp`);
  }
  return raw;
}

export function parseKeys(raw: string | undefined): JwtKeyConfig[] {
  if (!raw || raw.trim().length === 0) return [];
  const parsed = JSON.parse(raw) as unknown;
  const candidates: JwtKeyConfig[] = Array.isArray(parsed)
    ? parsed as JwtKeyConfig[]
    : parsed && typeof parsed === 'object'
      ? Object.entries(parsed as Record<string, any>).map(([kid, value]) => ({
          kid,
          secret: typeof value === 'string' ? value : value?.secret,
          active: typeof value === 'object' && value?.active === true,
          verifyUntil: typeof value === 'object' ? value?.verifyUntil : undefined,
        }))
      : (() => { throw new Error('IOS_API_JWT_KEYS must be a JSON object or array'); })();

  const keys = candidates.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid iOS JWT key entry');
    const kid = assertKid(entry.kid, 'Configured kid');
    return {
      kid,
      secret: assertSecret(entry.secret, kid),
      active: entry.active === true,
      verifyUntil: assertIsoCutoff(entry.verifyUntil, kid),
    };
  });
  if (new Set(keys.map((entry) => entry.kid)).size !== keys.length) {
    throw new Error('IOS_API_JWT_KEYS contains duplicate kid values');
  }
  return keys;
}

export function parseJwtExpiryHours(raw: string): number {
  return parseIosJwtExpirySeconds(raw) / 3600;
}

export function minimumRotationWindowHours(expiry: string): number {
  return Math.max(
    MINIMUM_ROTATION_WINDOW_HOURS,
    Math.ceil(parseJwtExpiryHours(expiry) + ROTATION_SAFETY_BUFFER_HOURS),
  );
}

function parseRotationHours(raw: string, minimumHours: number, jwtExpiry: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error('--rotation-hours must be a positive whole number of hours');
  }
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours < minimumHours) {
    throw new Error(
      `--rotation-hours must be at least ${minimumHours} hours for IOS_JWT_EXPIRY=${jwtExpiry}`,
    );
  }
  return hours;
}

function resolveCurrentActive(
  existing: JwtKeyConfig[],
  activeKidFromEnv: string | undefined,
  legacySecret: string | undefined,
): JwtKeyConfig {
  if (existing.length === 0) {
    const kid = activeKidFromEnv
      ? assertKid(activeKidFromEnv, 'IOS_API_JWT_ACTIVE_KID')
      : DEFAULT_IOS_JWT_KID;
    if (!legacySecret) {
      throw new Error(
        'Cannot prove current iOS JWT signing material: export IOS_API_JWT_SECRET/IOS_API_JWT_KEYS or use --env-file',
      );
    }
    return { kid, secret: assertSecret(legacySecret, kid), active: true };
  }

  const marked = existing.filter((entry) => entry.active === true);
  if (marked.length > 1) {
    throw new Error('IOS_API_JWT_KEYS must not mark more than one active signing key');
  }
  if (activeKidFromEnv) {
    const activeKid = assertKid(activeKidFromEnv, 'IOS_API_JWT_ACTIVE_KID');
    const matched = existing.find((entry) => entry.kid === activeKid);
    if (!matched) throw new Error(`IOS_API_JWT_ACTIVE_KID does not match a configured key: ${activeKid}`);
    if (marked.length === 1 && marked[0].kid !== activeKid) {
      throw new Error('IOS_API_JWT_ACTIVE_KID conflicts with the key marked active');
    }
    return matched;
  }
  if (marked.length !== 1) {
    throw new Error('IOS_API_JWT_KEYS must mark exactly one active key when IOS_API_JWT_ACTIVE_KID is unset');
  }
  return marked[0];
}

function laterIso(left: string | undefined, right: string): string {
  if (!left) return right;
  return Date.parse(left) > Date.parse(right) ? left : right;
}

export function buildRotationPlan(input: {
  existingKeysRaw?: string;
  activeKid?: string;
  legacySecret?: string;
  newKid: string;
  newSecret: string;
  jwtExpiry: string;
  rotationHoursRaw: string;
  now: Date;
}): RotationPlan {
  const minimumHours = minimumRotationWindowHours(input.jwtExpiry);
  const rotationHours = parseRotationHours(input.rotationHoursRaw, minimumHours, input.jwtExpiry);
  const existing = parseKeys(input.existingKeysRaw);
  const current = resolveCurrentActive(existing, input.activeKid, input.legacySecret);
  const newKid = assertKid(input.newKid, 'New kid');
  const newSecret = assertSecret(input.newSecret, newKid);
  if (existing.some((entry) => entry.kid === newKid) || current.kid === newKid) {
    throw new Error(`New kid already exists in the keyring: ${newKid}`);
  }

  const verifyUntil = new Date(
    input.now.getTime() + rotationHours * 60 * 60 * 1000,
  ).toISOString();
  const startingKeys = existing.length > 0 ? existing : [current];
  const normalized = startingKeys.map((entry) => ({
    ...entry,
    active: false,
    verifyUntil: entry.kid === current.kid
      ? laterIso(entry.verifyUntil, verifyUntil)
      : entry.verifyUntil ?? verifyUntil,
  }));
  normalized.push({ kid: newKid, secret: newSecret, active: true });

  return { activeKid: newKid, keys: normalized, verifyUntil };
}

function loadExplicitEnvFile(): void {
  const envFile = readArg('env-file');
  if (!envFile) return;
  const resolved = path.resolve(envFile);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error('--env-file must be a regular file with no group/world permissions');
  }
  const result = dotenv.config({ path: resolved, override: false, quiet: true });
  if (result.error) throw result.error;
}

export function main(): void {
  loadExplicitEnvFile();
  const now = new Date();
  const jwtExpiry = process.env.IOS_JWT_EXPIRY || DEFAULT_IOS_JWT_EXPIRY;
  const minimumHours = minimumRotationWindowHours(jwtExpiry);
  const plan = buildRotationPlan({
    existingKeysRaw: process.env.IOS_API_JWT_KEYS,
    activeKid: process.env.IOS_API_JWT_ACTIVE_KID,
    legacySecret: process.env.IOS_API_JWT_SECRET,
    newKid: readArg('kid') ?? `ios-api-${now.toISOString().slice(0, 10)}-${now.getTime()}`,
    newSecret: crypto.randomBytes(64).toString('hex'),
    jwtExpiry,
    rotationHoursRaw: readArg('rotation-hours')
      ?? process.env.IOS_JWT_ROTATION_WINDOW_HOURS
      ?? String(minimumHours),
    now,
  });

  console.log('# Sensitive rotation output. Store in a mode-600 file; do not paste into logs.');
  console.log(`# Previous active key verifies until ${plan.verifyUntil}.`);
  console.log(`IOS_API_JWT_ACTIVE_KID=${JSON.stringify(plan.activeKid)}`);
  console.log(`IOS_API_JWT_KEYS=${JSON.stringify(plan.keys)}`);
}

if (require.main === module) main();
