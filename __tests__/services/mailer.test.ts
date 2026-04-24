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

describe('sendMagicLink — reserved-but-unimplemented backends', () => {
  const originalEnv = process.env.MAGIC_LINK_MAILER;
  afterEach(() => {
    process.env.MAGIC_LINK_MAILER = originalEnv;
  });

  // Resend is now IMPLEMENTED — only smtp + postmark remain reserved.
  for (const backend of ['smtp', 'postmark']) {
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

// ─── Resend backend — OI-NAV-203c tail (2026-04-24) ─────────────
describe('sendMagicLink — Resend backend', () => {
  const originalMailer = process.env.MAGIC_LINK_MAILER;
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.MAGIC_LINK_FROM;
  const originalFetch = global.fetch;

  beforeEach(() => {
    logSpy.info.mockReset();
    logSpy.error.mockReset();
    process.env.MAGIC_LINK_MAILER = 'resend';
  });
  afterEach(() => {
    process.env.MAGIC_LINK_MAILER = originalMailer;
    process.env.RESEND_API_KEY = originalKey;
    process.env.MAGIC_LINK_FROM = originalFrom;
    global.fetch = originalFetch;
  });

  it('throws BACKEND_UNIMPLEMENTED when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendMagicLink, MailerError } = await import('../../src/services/mailer');
    try {
      await sendMagicLink({
        to: 'u@e.com', url: 'https://x.com/a', intentLabel: 'Test', expiresAt: '2026-04-24T11:00:00Z',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MailerError);
      expect((e as { code: string }).code).toBe('BACKEND_UNIMPLEMENTED');
      expect((e as { message: string }).message).toContain('RESEND_API_KEY');
    }
  });

  it('POSTs to Resend with Bearer auth + JSON payload when key is set', async () => {
    process.env.RESEND_API_KEY = 're_test_key_12345';
    process.env.MAGIC_LINK_FROM = 'Nexus Hub <welcome@nexushub.me>';
    let captured: { url?: string; init?: RequestInit } = {};
    global.fetch = vi.fn(async (url: any, init?: any) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ id: 'msg_test_abc' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as any;
    const { sendMagicLink } = await import('../../src/services/mailer');
    const result = await sendMagicLink({
      to: 'felipedrf74@gmail.com',
      url: 'https://nexushub.me/invite/accept?code=A&magic=B',
      intentLabel: 'Welcome to Nexus Hub',
      expiresAt: '2026-04-24T11:00:00Z',
      tenantName: 'Nexus Hub',
    });
    expect(result.backend).toBe('resend');
    expect(result.delivered).toBe(true);
    expect(captured.url).toBe('https://api.resend.com/emails');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer re_test_key_12345');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(captured.init?.body as string);
    expect(body.from).toBe('Nexus Hub <welcome@nexushub.me>');
    expect(body.to).toEqual(['felipedrf74@gmail.com']);
    expect(body.subject).toBe('Welcome to Nexus Hub');
    // Body must include HTML + plaintext + the URL (HTML escapes & to &amp;).
    expect(body.html).toContain('Nexus Hub');
    expect(body.html).toContain('https://nexushub.me/invite/accept?code=A&amp;magic=B');
    // Plaintext is not HTML-escaped.
    expect(body.text).toContain('https://nexushub.me/invite/accept?code=A&magic=B');
    expect(body.tags).toEqual(
      expect.arrayContaining([
        { name: 'intent', value: 'magic_link' },
        { name: 'source', value: 'nexus-hub-portal' },
      ]),
    );
  });

  it('falls back to welcome@nexushub.me when MAGIC_LINK_FROM is unset', async () => {
    process.env.RESEND_API_KEY = 're_test_key_12345';
    delete process.env.MAGIC_LINK_FROM;
    let capturedBody: any;
    global.fetch = vi.fn(async (_url: any, init?: any) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: 'msg_test' }), { status: 200 });
    }) as any;
    const { sendMagicLink } = await import('../../src/services/mailer');
    await sendMagicLink({
      to: 'u@e.com', url: 'https://x/a', intentLabel: 'T', expiresAt: '2026-04-24T11:00:00Z',
    });
    expect(capturedBody.from).toBe('welcome@nexushub.me');
  });

  it('HTML body escapes user-controlled strings (defense in depth)', async () => {
    process.env.RESEND_API_KEY = 're_test_key_12345';
    let capturedBody: any;
    global.fetch = vi.fn(async (_url: any, init?: any) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: 'msg_test' }), { status: 200 });
    }) as any;
    const { sendMagicLink } = await import('../../src/services/mailer');
    await sendMagicLink({
      to: 'u@e.com',
      url: 'https://x/a?q=<script>',
      intentLabel: 'Welcome <script>',
      expiresAt: '2026-04-24T11:00:00Z',
      tenantName: '<evil>Tenant</evil>',
    });
    // None of the raw `<script>` / `<evil>` should appear in the HTML body.
    expect(capturedBody.html).not.toContain('<script>');
    expect(capturedBody.html).not.toContain('<evil>');
    // But the escaped forms should:
    expect(capturedBody.html).toContain('&lt;script&gt;');
    expect(capturedBody.html).toContain('&lt;evil&gt;');
  });

  it('surfaces Resend 4xx errors as SEND_FAILED with status + body', async () => {
    process.env.RESEND_API_KEY = 're_test_key_12345';
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ name: 'validation_error', message: 'The domain is not verified.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;
    const { sendMagicLink, MailerError } = await import('../../src/services/mailer');
    try {
      await sendMagicLink({
        to: 'u@e.com', url: 'https://x/a', intentLabel: 'T', expiresAt: '2026-04-24T11:00:00Z',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MailerError);
      const me = e as { code: string; message: string; details?: any };
      expect(me.code).toBe('SEND_FAILED');
      expect(me.message).toContain('400');
      expect(me.details?.body?.message).toContain('not verified');
    }
  });

  it('surfaces network errors as SEND_FAILED (not bare fetch throws)', async () => {
    process.env.RESEND_API_KEY = 're_test_key_12345';
    global.fetch = vi.fn(async () => { throw new TypeError('network down'); }) as any;
    const { sendMagicLink, MailerError } = await import('../../src/services/mailer');
    try {
      await sendMagicLink({
        to: 'u@e.com', url: 'https://x/a', intentLabel: 'T', expiresAt: '2026-04-24T11:00:00Z',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MailerError);
      expect((e as { code: string }).code).toBe('SEND_FAILED');
      expect((e as { message: string }).message).toContain('network');
    }
  });
});
