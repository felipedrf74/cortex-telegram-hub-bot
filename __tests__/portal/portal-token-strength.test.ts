// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract test: portal refuses to boot with a weak token.
 *
 * The portal admin surface is gated by a SINGLE static Bearer token.
 * No session system, no per-admin scope — the entire security model
 * is "does this request carry the right string?" So the threat model
 * reduces to "how hard is the string to guess?" Historical accidents
 * include shipping defaults like "changeme" or "admin" that never got
 * rotated.
 *
 * This test pins the boot-time strength check: `createPortalServer`
 * MUST throw when `PORTAL_TOKEN` is too short or on a block-list of
 * known-weak values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('portal boot — PORTAL_TOKEN strength gate (M-3)', () => {
  const originalToken = process.env.PORTAL_TOKEN;
  const originalReadToken = process.env.PORTAL_READ_TOKEN;
  const originalWriteToken = process.env.PORTAL_WRITE_TOKEN;
  const originalAdminToken = process.env.PORTAL_ADMIN_TOKEN;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.PORTAL_TOKEN = originalToken;
    process.env.PORTAL_READ_TOKEN = originalReadToken;
    process.env.PORTAL_WRITE_TOKEN = originalWriteToken;
    process.env.PORTAL_ADMIN_TOKEN = originalAdminToken;
    vi.resetModules();
  });

  it('refuses to boot with a token shorter than 12 chars', async () => {
    process.env.PORTAL_TOKEN = 'short';  // 5 chars — under the 12 floor
    process.env.PORTAL_READ_TOKEN = '';
    process.env.PORTAL_WRITE_TOKEN = '';
    process.env.PORTAL_ADMIN_TOKEN = '';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/too weak/i);
  });

  it('refuses to boot with a well-known default token', async () => {
    // "changeme" is 8 chars AND on the block-list.
    process.env.PORTAL_TOKEN = 'changeme';
    process.env.PORTAL_READ_TOKEN = '';
    process.env.PORTAL_WRITE_TOKEN = '';
    process.env.PORTAL_ADMIN_TOKEN = '';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/too weak/i);
  });

  it('refuses to boot with repeated-char tokens (length >=12 but trivial)', async () => {
    // 20 'a's: length passes the 12-char floor but /^(.)\1+$/ catches it.
    process.env.PORTAL_TOKEN = 'aaaaaaaaaaaaaaaaaaaa';
    process.env.PORTAL_READ_TOKEN = '';
    process.env.PORTAL_WRITE_TOKEN = '';
    process.env.PORTAL_ADMIN_TOKEN = '';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/too weak/i);
  });

  it('accepts an empty token (auth behavior is handled separately at request time)', async () => {
    process.env.PORTAL_TOKEN = '';
    process.env.PORTAL_READ_TOKEN = '';
    process.env.PORTAL_WRITE_TOKEN = '';
    process.env.PORTAL_ADMIN_TOKEN = '';
    const { createPortalServer } = await import('../../src/portal/server');
    // Empty token is NOT "weak" — boot should still succeed so local
    // diagnostics can run, while request-time middleware decides whether
    // explicit loopback bypass is allowed.
    expect(() => createPortalServer(null as any)).not.toThrow();
  });

  it('refuses to boot with a weak scoped read token', async () => {
    process.env.PORTAL_TOKEN = '';
    process.env.PORTAL_READ_TOKEN = 'short';
    process.env.PORTAL_WRITE_TOKEN = '';
    process.env.PORTAL_ADMIN_TOKEN = '';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/PORTAL_READ_TOKEN is too weak/i);
  });

  it('refuses to boot with a weak scoped write token', async () => {
    process.env.PORTAL_TOKEN = '';
    process.env.PORTAL_READ_TOKEN = '';
    process.env.PORTAL_WRITE_TOKEN = 'short';
    process.env.PORTAL_ADMIN_TOKEN = '';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/PORTAL_WRITE_TOKEN is too weak/i);
  });

  it('refuses to boot with a weak scoped admin token', async () => {
    process.env.PORTAL_TOKEN = '';
    process.env.PORTAL_READ_TOKEN = '';
    process.env.PORTAL_WRITE_TOKEN = '';
    process.env.PORTAL_ADMIN_TOKEN = 'short';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/PORTAL_ADMIN_TOKEN is too weak/i);
  });
});
