import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRotationPlan,
  minimumRotationWindowHours,
  parseJwtExpiryHours,
} from '../../scripts/rotate-jwt-signing-key';
import { getIosJwtKeyring, verifyIosJwt } from '../../src/services/ios-jwt';

const NOW = new Date('2026-07-13T12:00:00.000Z');
const LEGACY_SECRET = 'legacy-secret-00000000000000000000000000000000';
const OLD_SECRET = 'old-secret-000000000000000000000000000000000';
const NEW_SECRET = 'new-secret-000000000000000000000000000000000';

afterEach(() => vi.unstubAllEnvs());

describe('iOS JWT rotation helper', () => {
  it('requires an eight-day overlap for the seven-day production token lifetime', () => {
    expect(parseJwtExpiryHours('7d')).toBe(168);
    expect(minimumRotationWindowHours('7d')).toBe(192);
  });

  it('derives a longer overlap when configured tokens live longer than seven days', () => {
    expect(minimumRotationWindowHours('30d')).toBe(31 * 24);
  });

  it('rejects ambiguous unitless expiry values', () => {
    expect(() => minimumRotationWindowHours('604800')).toThrow(/explicit positive s, m, h, or d/);
  });

  it('refuses to generate a plan without proven current signing material', () => {
    expect(() => buildRotationPlan({
      newKid: 'next',
      newSecret: NEW_SECRET,
      jwtExpiry: '7d',
      rotationHoursRaw: '192',
      now: NOW,
    })).toThrow(/Cannot prove current iOS JWT signing material/);
  });

  it('derives the marked active key and extends its retirement window safely', () => {
    const plan = buildRotationPlan({
      existingKeysRaw: JSON.stringify([
        {
          kid: 'actual-active',
          secret: OLD_SECRET,
          active: true,
          verifyUntil: '2026-07-13T13:00:00.000Z',
        },
      ]),
      newKid: 'next',
      newSecret: NEW_SECRET,
      jwtExpiry: '7d',
      rotationHoursRaw: '192',
      now: NOW,
    });

    expect(plan.keys).toEqual([
      {
        kid: 'actual-active',
        secret: OLD_SECRET,
        active: false,
        verifyUntil: '2026-07-21T12:00:00.000Z',
      },
      { kid: 'next', secret: NEW_SECRET, active: true },
    ]);
  });

  it('rejects suffix-junk rotation hours and blank or duplicate new kids', () => {
    const base = {
      legacySecret: LEGACY_SECRET,
      newSecret: NEW_SECRET,
      jwtExpiry: '7d',
      now: NOW,
    };
    expect(() => buildRotationPlan({ ...base, newKid: 'next', rotationHoursRaw: '192hours' }))
      .toThrow(/whole number/);
    expect(() => buildRotationPlan({ ...base, newKid: '', rotationHoursRaw: '192' }))
      .toThrow(/New kid/);
    expect(() => buildRotationPlan({
      ...base,
      existingKeysRaw: JSON.stringify([{ kid: 'next', secret: OLD_SECRET, active: true }]),
      newKid: 'next',
      rotationHoursRaw: '192',
    })).toThrow(/already exists/);
  });

  it('keeps both pre-keyring kid tokens and legacy no-kid tokens valid after first rotation', () => {
    const plan = buildRotationPlan({
      legacySecret: LEGACY_SECRET,
      newKid: 'next',
      newSecret: NEW_SECRET,
      jwtExpiry: '7d',
      rotationHoursRaw: '192',
      now: NOW,
    });
    vi.stubEnv('IOS_API_JWT_SECRET', LEGACY_SECRET);
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify(plan.keys));
    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', plan.activeKid);
    vi.stubEnv('IOS_JWT_EXPIRY', '7d');

    expect(getIosJwtKeyring(NOW.getTime()).activeKid).toBe('next');
    const oldKidToken = jwt.sign(
      { userId: 1 },
      LEGACY_SECRET,
      { expiresIn: '7d', header: { kid: 'ios-api-current' } },
    );
    const noKidToken = jwt.sign({ userId: 2 }, LEGACY_SECRET, { expiresIn: '7d' });
    expect(verifyIosJwt(oldKidToken, NOW.getTime())).toMatchObject({ userId: 1 });
    expect(verifyIosJwt(noKidToken, NOW.getTime())).toMatchObject({ userId: 2 });
  });

  it('fails its real CLI path when current signing material is absent', () => {
    const tsx = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    const script = path.resolve(__dirname, '../../scripts/rotate-jwt-signing-key.ts');
    const {
      IOS_API_JWT_SECRET: _secret,
      IOS_API_JWT_KEYS: _keys,
      IOS_API_JWT_ACTIVE_KID: _active,
      ...cleanEnv
    } = process.env;
    const result = spawnSync(tsx, [script, '--kid=next', '--rotation-hours=192'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...cleanEnv, IOS_JWT_EXPIRY: '7d' },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Cannot prove current iOS JWT signing material');
  });

  it('emits a dotenv value that the runtime can parse without double decoding', () => {
    const tsx = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    const script = path.resolve(__dirname, '../../scripts/rotate-jwt-signing-key.ts');
    const result = spawnSync(tsx, [script, '--kid=next', '--rotation-hours=192'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        IOS_API_JWT_SECRET: LEGACY_SECRET,
        IOS_JWT_EXPIRY: '7d',
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const output = dotenv.parse(result.stdout);
    expect(output.IOS_API_JWT_ACTIVE_KID).toBe('next');
    const keys = JSON.parse(output.IOS_API_JWT_KEYS);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatchObject({ kid: 'next', active: true });

    vi.stubEnv('IOS_API_JWT_KEYS', output.IOS_API_JWT_KEYS);
    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', output.IOS_API_JWT_ACTIVE_KID);
    vi.stubEnv('IOS_API_JWT_SECRET', LEGACY_SECRET);
    vi.stubEnv('IOS_JWT_EXPIRY', '7d');
    expect(() => getIosJwtKeyring(NOW.getTime())).not.toThrow();
  });
});
