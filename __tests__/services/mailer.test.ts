// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for the pluggable mailer (OI-NAV-203b, 2026-04-24).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterAll(() => {
  vi.doUnmock('../../src/utils/logger');
  vi.resetModules();
});

// Capture log calls for the console backend test.
const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
logSpy.child = vi.fn().mockReturnValue(logSpy);
vi.mock('../../src/utils/logger', () => ({ logger: logSpy }));

describe('resolveBackend', () => {
  const originalMagicEnv = process.env.MAGIC_LINK_MAILER;
  const originalVitest = process.env.VITEST;

  afterEach(() => {
    process.env.MAGIC_LINK_MAILER = originalMagicEnv;
    process.env.VITEST = originalVitest;
  });

  it('returns explicit env value when set', async () => {
    const { resolveBackend } = await import('../../src/services/mailer');
    expect(resolveBackend('console')).toBe('console');
    expect(resolveBackend('noop')).toBe('noop');
    expect(resolveBackend('smtp')).toBe('smtp');
    expect(resolveBackend('resend')).toBe('resend');
    expect(resolveBackend('postmark')).toBe('postmark');
  });

  it('case-insensitive + trims whitespace', async () => {
    const { resolveBackend } = await import('../../src/services/mailer');
    expect(resolveBackend('  CONSOLE ')).toBe('console');
    expect(resolveBackend('NoOp')).toBe('noop');
  });

  it('falls back to noop under vitest (no log spam)', async () => {
    const { resolveBackend } = await import('../../src/services/mailer');
    process.env.VITEST = 'true';
    expect(resolveBackend('')).toBe('noop');
    expect(resolveBackend(undefined)).toBe('noop');
  });

  it('falls back to console outside vitest when unset', async () => {
    const { resolveBackend } = await import('../../src/services/mailer');
    delete process.env.VITEST;
    expect(resolveBackend('')).toBe('console');
    expect(resolveBackend(null)).toBe('console');
  });

  it('unknown values fall through to the test/dev default', async () => {
    const { resolveBackend } = await import('../../src/services/mailer');
    process.env.VITEST = 'true';
    // Unknown 'sendgrid' → falls through to VITEST check → noop.
    expect(resolveBackend('sendgrid')).toBe('noop');
  });
});

describe('sendMagicLink — console backend', () => {
  const originalEnv = process.env.MAGIC_LINK_MAILER;

  beforeEach(() => {
    logSpy.info.mockReset();
    process.env.MAGIC_LINK_MAILER = 'console';
  });
  afterEach(() => {
    process.env.MAGIC_LINK_MAILER = originalEnv;
  });

  it('logs the magic link with to + url + expiresAt + intent label', async () => {
    const { sendMagicLink } = await import('../../src/services/mailer');
    const result = await sendMagicLink({
      to: 'user@example.com',
      url: 'https://nexus.example.com/invite/accept?code=abc&magic=xyz',
      intentLabel: 'Accept invite to Acme',
      expiresAt: '2026-04-24T11:00:00Z',
      tenantName: 'Acme',
    });
    expect(result.backend).toBe('console');
    expect(result.delivered).toBe(true);
    expect(result.debugUrl).toContain('magic=xyz');
    expect(logSpy.info).toHaveBeenCalledTimes(1);
    const logArgs = logSpy.info.mock.calls[0];
    expect(logArgs[0]).toMatchObject({
      event: 'magic_link.send',
      backend: 'console',
      to: 'user@example.com',
      intent: 'Accept invite to Acme',
      tenantName: 'Acme',
    });
  });
});

describe('sendMagicLink — noop backend', () => {
  const originalEnv = process.env.MAGIC_LINK_MAILER;

  beforeEach(() => {
    logSpy.info.mockReset();
    process.env.MAGIC_LINK_MAILER = 'noop';
  });
  afterEach(() => {
    process.env.MAGIC_LINK_MAILER = originalEnv;
  });

  it('returns delivered:true without logging', async () => {
    const { sendMagicLink } = await import('../../src/services/mailer');
    const result = await sendMagicLink({
      to: 'user@example.com',
      url: 'https://x.com/a',
      intentLabel: 'Test',
      expiresAt: '2026-04-24T11:00:00Z',
    });
    expect(result.backend).toBe('noop');
    expect(result.delivered).toBe(true);
    expect(result.debugUrl).toBeUndefined();
    expect(logSpy.info).not.toHaveBeenCalled();
  });
});

describe('sendMagicLink — reserved backends throw MailerError', () => {
  const originalEnv = process.env.MAGIC_LINK_MAILER;
  afterEach(() => {
    process.env.MAGIC_LINK_MAILER = originalEnv;
  });

  for (const backend of ['smtp', 'resend', 'postmark']) {
    it(`throws BACKEND_UNIMPLEMENTED for '${backend}'`, async () => {
      const { sendMagicLink, MailerError } = await import('../../src/services/mailer');
      process.env.MAGIC_LINK_MAILER = backend;
      try {
        await sendMagicLink({
          to: 'user@example.com',
          url: 'https://x.com/a',
          intentLabel: 'Test',
          expiresAt: '2026-04-24T11:00:00Z',
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MailerError);
        expect((e as { code: string }).code).toBe('BACKEND_UNIMPLEMENTED');
        expect((e as { message: string }).message).toContain(backend);
      }
    });
  }
});
