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

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.PORTAL_TOKEN = originalToken;
    vi.resetModules();
  });

  it('refuses to boot with a token shorter than 16 chars', async () => {
    process.env.PORTAL_TOKEN = 'short';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/too weak/i);
  });

  it('refuses to boot with a well-known default token', async () => {
    // "changeme" is 8 chars AND on the block-list.
    process.env.PORTAL_TOKEN = 'changeme';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/too weak/i);
  });

  it('refuses to boot with repeated-char tokens (length >=16 but trivial)', async () => {
    // 16 'a's: length passes but /^(.)\1+$/ catches it.
    process.env.PORTAL_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const { createPortalServer } = await import('../../src/portal/server');
    expect(() => createPortalServer(null as any)).toThrow(/too weak/i);
  });

  it('accepts an empty token (falls back to localhost-only bypass)', async () => {
    process.env.PORTAL_TOKEN = '';
    const { createPortalServer } = await import('../../src/portal/server');
    // Empty token is NOT "weak" — it's a documented opt-in to the
    // localhost-only fallback. Must not throw on creation.
    expect(() => createPortalServer(null as any)).not.toThrow();
  });
});
