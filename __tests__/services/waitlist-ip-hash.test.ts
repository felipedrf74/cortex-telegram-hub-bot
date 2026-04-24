// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  hashWaitlistIpAddress,
  resolveWaitlistIpSalt,
} from '../../src/services/waitlist-ip-hash';

describe('waitlist IP hashing', () => {
  it('uses a configured salt as the persistent source of truth', () => {
    expect(resolveWaitlistIpSalt('  stable-secret  ', 'fallback')).toEqual({
      salt: 'stable-secret',
      source: 'configured',
      persistent: true,
    });
  });

  it('falls back explicitly to an ephemeral salt when not configured', () => {
    const resolution = resolveWaitlistIpSalt('', 'fallback-secret');

    expect(resolution).toEqual({
      salt: 'fallback-secret',
      source: 'ephemeral',
      persistent: false,
      warning: 'WAITLIST_IP_SALT is not configured; waitlist IP hashes rotate on process restart.',
    });
  });

  it('hashes IPs deterministically for the same salt and differently after salt rotation', () => {
    const ip = '203.0.113.42';
    const first = hashWaitlistIpAddress(ip, 'salt-a');
    const repeated = hashWaitlistIpAddress(ip, 'salt-a');
    const rotated = hashWaitlistIpAddress(ip, 'salt-b');

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(repeated).toBe(first);
    expect(rotated).not.toBe(first);
  });

  it('keeps WAITLIST_IP_SALT ownership out of the public route layer', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/waitlist.ts'),
      'utf8',
    );

    expect(source).not.toContain('process.env.WAITLIST_IP_SALT');
  });
});
