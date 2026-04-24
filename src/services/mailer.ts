// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-NAV-203b — pluggable email mailer for magic-link flows
 * (2026-04-24).
 *
 * Pluggable on purpose: the final email-provider decision is
 * deferred to a product discussion (Resend / Postmark / SMTP /
 * Amazon SES), and we don't want to force that choice to ship
 * the token machinery. This module exposes a minimal interface
 * (`sendMagicLink`) with three backends, selected by the
 * `MAGIC_LINK_MAILER` environment variable:
 *
 *   - 'console' (default in dev + test) — logs the magic link to
 *     the pino logger at INFO level. Useful during development
 *     and tests; the link is also returned in the API response
 *     for dev-only debugging (see the route handler).
 *   - 'noop' — silently drops the send. Used in automated tests
 *     that want zero log noise.
 *   - 'smtp' | 'resend' | 'postmark' — reserved identifiers. They
 *     currently THROW with a clear error. Wiring them up is
 *     OI-NAV-203c (product-decision follow-up).
 *
 * The interface deliberately doesn't promise delivery guarantees.
 * A successful `sendMagicLink` call means "handed off to the
 * backend"; downstream bounces / spam-folder delivery / provider
 * outages are outside this abstraction's contract.
 */

import { logger } from '../utils/logger';

export type MailerBackend = 'console' | 'noop' | 'smtp' | 'resend' | 'postmark';

export interface MagicLinkEmail {
  /** The recipient's email address. */
  to: string;
  /** Full URL the link resolves to (caller builds this; includes token). */
  url: string;
  /** Human-readable purpose — "Accept invite", "Sign in", etc. */
  intentLabel: string;
  /** ISO-8601 expiry for the token; surfaces in the email body. */
  expiresAt: string;
  /** Optional tenant name, if the link is tenant-scoped. */
  tenantName?: string;
}

export interface MailerSendResult {
  backend: MailerBackend;
  delivered: boolean;
  /** Dev-only: the link URL echoed back so tests/dev-UI can verify. */
  debugUrl?: string;
}

export class MailerError extends Error {
  constructor(
    public readonly code: 'UNCONFIGURED_BACKEND' | 'BACKEND_UNIMPLEMENTED' | 'SEND_FAILED',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MailerError';
  }
}

/** Env-driven backend selection. Exported for tests that want to force a backend. */
export function resolveBackend(envValue: string | undefined | null = process.env.MAGIC_LINK_MAILER): MailerBackend {
  const v = (envValue || '').toLowerCase().trim();
  if (v === 'console') return 'console';
  if (v === 'noop') return 'noop';
  if (v === 'smtp') return 'smtp';
  if (v === 'resend') return 'resend';
  if (v === 'postmark') return 'postmark';
  // Default: console in dev + test, noop in test if NODE_ENV=test
  // AND no backend override (so tests don't spam the log). We check
  // VITEST directly (survives NODE_ENV stubs — same reasoning as
  // src/config.ts's dotenv gate landed in the 2026-04-24 hardening).
  if (process.env.VITEST === 'true') return 'noop';
  return 'console';
}

/** Build a compact log line — no raw token, just enough for dev to click. */
function logMagicLink(email: MagicLinkEmail): void {
  logger.info(
    {
      event: 'magic_link.send',
      backend: 'console',
      to: email.to,
      intent: email.intentLabel,
      expiresAt: email.expiresAt,
      // Full URL includes the raw token. This is DEV ONLY — the
      // logger.info call is gated by backend=console, and prod
      // should set MAGIC_LINK_MAILER=smtp|resend|postmark (or
      // 'noop' for strictly-no-email environments).
      url: email.url,
      tenantName: email.tenantName,
    },
    `[magic-link] (${email.intentLabel}) → ${email.to} · expires ${email.expiresAt}`,
  );
}

// ─── Resend backend (OI-NAV-203c tail, 2026-04-24) ───────────────────
//
// Resend (resend.com) chosen for:
//   - Simple JSON API (no SDK required — plain fetch).
//   - Modern free tier (3k emails/mo) covers dev + early prod.
//   - Domain verification via DNS TXT/CNAME records — tractable
//     for a single-domain setup like nexushub.me.
//   - React Email / plain HTML bodies both supported.
//
// Required env to actually send (not set → backend throws):
//   RESEND_API_KEY       — server-side API key from resend.com.
//   MAGIC_LINK_FROM      — e.g. 'Nexus Hub <welcome@nexushub.me>'.
//                          Falls back to 'welcome@nexushub.me'.
//   MAGIC_LINK_REPLY_TO  — optional; falls back to MAGIC_LINK_FROM.
//
// Prerequisite DNS on nexushub.me (one-time, done via your DNS
// provider; Resend's dashboard surfaces the exact records):
//   - SPF: TXT @  v=spf1 include:_spf.resend.com ~all
//   - DKIM: 2× CNAME records Resend generates per-domain
//   - DMARC (recommended): TXT _dmarc v=DMARC1; p=none; ...
//
// Without those, Resend will EITHER refuse to send (400 with a
// clear "domain not verified" error) OR the email will land in
// the recipient's spam. Enforcement lives at Resend, not here —
// we just surface the Resend error verbatim.

const RESEND_API_ENDPOINT = 'https://api.resend.com/emails';

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  tags?: Array<{ name: string; value: string }>;
}

/** Build the HTML + plaintext bodies from a MagicLinkEmail. */
function renderMagicLinkBodies(email: MagicLinkEmail): { html: string; text: string } {
  const tenant = email.tenantName || 'a Nexus Hub workspace';
  // Plaintext fallback — some clients prefer this; also useful for
  // spam-filter scoring (clients with no HTML look thin).
  const text = [
    `You've been invited to ${tenant}.`,
    '',
    'Click the link below to accept and set up your account:',
    email.url,
    '',
    `This link expires at ${email.expiresAt}. If you didn't request it, you can safely ignore this email.`,
    '',
    '— The Nexus Hub team',
  ].join('\n');
  // HTML version — plain, unopinionated, works in every client.
  const html = `
<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 24px auto; color: #1f2937; line-height: 1.5;">
    <h2 style="color: #111827; font-size: 20px; margin: 0 0 12px;">Join ${escapeHtml(tenant)}</h2>
    <p style="margin: 0 0 16px;">You've been invited to a Nexus Hub workspace. Click the button below to accept and set up your account — no password needed.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(email.url)}"
         style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">
        ${escapeHtml(email.intentLabel)}
      </a>
    </p>
    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">
      Or copy &amp; paste this link into your browser:<br>
      <a href="${escapeHtml(email.url)}" style="color: #3b82f6; word-break: break-all;">${escapeHtml(email.url)}</a>
    </p>
    <p style="margin: 24px 0 0; font-size: 13px; color: #9ca3af;">
      This link expires at ${escapeHtml(email.expiresAt)}. If you didn't request it, you can safely ignore this email.
    </p>
  </body>
</html>
`.trim();
  return { html, text };
}

/** Minimal HTML escape for the body template. */
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

/** Call the Resend API. Throws MailerError on any non-2xx. */
async function sendViaResend(email: MagicLinkEmail): Promise<MailerSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new MailerError(
      'BACKEND_UNIMPLEMENTED',
      'RESEND_API_KEY is not set. Configure the key or switch MAGIC_LINK_MAILER=console for dev.',
      { backend: 'resend' },
    );
  }
  const from = process.env.MAGIC_LINK_FROM || 'welcome@nexushub.me';
  const replyTo = process.env.MAGIC_LINK_REPLY_TO || from;
  const { html, text } = renderMagicLinkBodies(email);
  const payload: ResendPayload = {
    from,
    to: [email.to],
    subject: email.intentLabel,
    html,
    text,
    reply_to: replyTo,
    tags: [
      { name: 'intent', value: 'magic_link' },
      { name: 'source', value: 'nexus-hub-portal' },
    ],
  };
  let res: Response;
  try {
    res = await fetch(RESEND_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    logger.error({ err: networkErr, to: email.to }, 'mailer[resend]: network failure');
    throw new MailerError(
      'SEND_FAILED',
      'Resend API network error — check outbound connectivity.',
      { backend: 'resend' },
    );
  }
  if (!res.ok) {
    // Resend returns JSON error payloads like
    // { name, message, statusCode } — surface them verbatim so
    // ops can diagnose domain-verification / rate-limit / API-key
    // issues without log scraping.
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ''); }
    logger.error({ status: res.status, body, to: email.to }, 'mailer[resend]: non-2xx from Resend API');
    throw new MailerError(
      'SEND_FAILED',
      `Resend API returned ${res.status}. See logs for the full response.`,
      { backend: 'resend', status: res.status, body },
    );
  }
  let parsed: { id?: string } | null = null;
  try { parsed = await res.json() as { id?: string }; } catch { /* no body is fine on success */ }
  logger.info(
    { to: email.to, intent: email.intentLabel, messageId: parsed?.id },
    'mailer[resend]: sent',
  );
  return { backend: 'resend', delivered: true };
}

/**
 * Send a magic-link email. Pure side-effect dispatcher — the backend
 * is chosen at call time from `MAGIC_LINK_MAILER` so env-var changes
 * affect future calls without re-importing.
 */
export async function sendMagicLink(email: MagicLinkEmail): Promise<MailerSendResult> {
  const backend = resolveBackend();
  switch (backend) {
    case 'console':
      logMagicLink(email);
      return { backend, delivered: true, debugUrl: email.url };
    case 'noop':
      // Used by tests that don't want log noise; also used in
      // environments that want to generate tokens but not send
      // mail (e.g. a worker that hands the URL to another
      // delivery system).
      return { backend, delivered: true };
    case 'resend':
      return sendViaResend(email);
    case 'smtp':
    case 'postmark':
      // Reserved; wire these when a reason appears. Resend is the
      // default transactional choice for nexushub.me.
      throw new MailerError(
        'BACKEND_UNIMPLEMENTED',
        `Mailer backend '${backend}' is reserved but not yet implemented. Set MAGIC_LINK_MAILER=resend (with RESEND_API_KEY) for prod, or MAGIC_LINK_MAILER=console for dev.`,
        { backend },
      );
    default:
      throw new MailerError(
        'UNCONFIGURED_BACKEND',
        `Unknown MAGIC_LINK_MAILER backend: ${String(backend)}`,
        { backend },
      );
  }
}
