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

// ─── Transactional email dispatcher (OI-WELCOME-201, 2026-04-24) ───
//
// Generalisation of sendMagicLink for non-magic-link transactional
// sends (welcome, password-reset, etc.). Same backend routing —
// just a different template-to-body path. Templates are simple
// inline functions; no external templating engine.
//
// Add a new template by:
//   1. Declaring its type in `TransactionalTemplate`.
//   2. Adding a `case` to `renderTransactional` that returns
//      { subject, html, text }.

export type TransactionalTemplate =
  | 'welcome.paid_upgrade'
  | 'admin.magic_login';   // OI-SEC-001a (2026-04-24)

export interface TransactionalEmailInput {
  template: TransactionalTemplate;
  to: string;
  subject: string;
  /** Template-specific context. Shape validated per-template at render time. */
  context: Record<string, unknown>;
}

interface RenderedBodies {
  subject: string;
  html: string;
  text: string;
  /** Tag list for Resend analytics — e.g. [{ name: 'template', value: 'welcome_paid_upgrade' }].
   *  Values must be [A-Za-z0-9_-] (Resend 422s on dots/spaces/etc.) —
   *  sanitizeResendTag enforces this at the send boundary. */
  tags: Array<{ name: string; value: string }>;
}

/**
 * Render a feature row as a 2-column <tr> — used inside the welcome
 * email's "What Nexus Hub does for you" block. Named + described so
 * the feature list stays readable when the surrounding template grows.
 * Kept at module scope (not inlined in the template string) so the
 * 5 call-sites stay skimmable.
 */
function featureRow(name: string, desc: string): string {
  return `<tr>
                  <td style="padding: 10px 0; vertical-align: top; width: 110px;">
                    <span class="feature-name" style="font-size: 14px; font-weight: 600; color: #111827;">${escapeHtml(name)}</span>
                  </td>
                  <td style="padding: 10px 0 10px 8px; vertical-align: top;">
                    <span class="feature-desc" style="font-size: 14px; color: #6b7280; line-height: 1.5;">${escapeHtml(desc)}</span>
                  </td>
                </tr>`;
}

/**
 * Internal renderer — NOT public API. Exported with the `__` prefix
 * only so the preview script (`scripts/render-welcome-email-preview.ts`)
 * and structural tests can invoke the exact same render path a real
 * send would take, without sending. External callers should use
 * `sendTransactionalEmail`.
 */
export function __previewRenderTransactional(input: TransactionalEmailInput): RenderedBodies {
  return renderTransactional(input);
}

function renderTransactional(input: TransactionalEmailInput): RenderedBodies {
  switch (input.template) {
    case 'welcome.paid_upgrade': {
      const firstName = typeof input.context.firstName === 'string' ? input.context.firstName : 'there';
      const tier = typeof input.context.tier === 'string' ? input.context.tier : 'paid';
      const consoleUrl = typeof input.context.consoleUrl === 'string'
        ? input.context.consoleUrl
        : 'https://nexushub.me/console';
      const tierLabel = tier === 'max' ? 'Max' : tier === 'pro' ? 'Pro' : 'paid';
      // Tier-specific greeting — Max users get a more premium tone.
      const hero = tier === 'max'
        ? `You're in — and you picked the Max plan. That means every skill is unlocked, with the highest daily quotas we offer.`
        : `You're in. Your Pro plan is active, and your workspace is ready to set up.`;

      // ── PLAINTEXT fallback ─────────────────────────────────
      const text = [
        `Welcome to Nexus Hub, ${firstName}.`,
        '',
        hero,
        '',
        `→ Open your workspace: ${consoleUrl}`,
        '',
        'What Nexus Hub does for you',
        '',
        '• Content — Generate scripts, posts, and research briefs in your voice.',
        '• Secretary — Inbox triage, calendar management, task capture.',
        '• Training — Coaching for gym, running, cycling, swim.',
        '• Finance — Budget tracking + spend coaching.',
        '• Cooking — Meal planning around your dietary constraints.',
        '',
        'Each skill reads context you configure once — no repeating yourself across sessions.',
        '',
        `This one-click login link expires in 24 hours. If it lapses, we'll send a fresh one the next time you visit.`,
        '',
        'Questions? Just reply — every email reaches a human on our team.',
        '',
        '— The Nexus Hub team',
        '',
        'https://nexushub.me',
      ].join('\n');

      // ── HTML (responsive, dark-mode-aware) ─────────────────
      // Preheader text: what the inbox preview shows next to the
      // subject. Hidden from the visible body but indexed by every
      // major client (Gmail, Apple Mail, Outlook). The non-breaking
      // spaces at the end pad out any client that concatenates the
      // next text line into the preview.
      const preheader = `Your ${tierLabel} plan is active. One click to open your workspace.`;

      const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Welcome to Nexus Hub</title>
  <style>
    /* Scoped styles that support clients that honor <style>.
       All critical layout ALSO has inline styles below so plainer
       clients (older Outlook, Gmail mobile app) still render ok. */
    @media (max-width: 480px) {
      .container { width: 100% !important; padding: 16px !important; }
      .cta-button { display: block !important; width: auto !important; }
      .hero-title { font-size: 24px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .bg { background-color: #0b0f14 !important; }
      .container { background-color: #111827 !important; }
      .hero-title, .section-title { color: #f9fafb !important; }
      .body-text { color: #d1d5db !important; }
      .muted { color: #9ca3af !important; }
      .divider { border-color: #1f2937 !important; }
      .feature-name { color: #f3f4f6 !important; }
      .feature-desc { color: #9ca3af !important; }
      .tier-pill { background-color: #1e3a8a !important; color: #bfdbfe !important; }
    }
  </style>
</head>
<body class="bg" style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937; line-height: 1.55;">

  <!-- Preheader: indexed by inbox previews, hidden from the body. -->
  <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: #f3f4f6;">
    ${escapeHtml(preheader)}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  </div>

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" class="container" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width: 560px; width: 100%; background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden;">

          <!-- Header band: wordmark only, no image. -->
          <tr>
            <td style="padding: 24px 32px 0 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td align="left" style="font-size: 15px; font-weight: 700; color: #111827; letter-spacing: -0.2px;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: #3b82f6; border-radius: 50%; vertical-align: middle; margin-right: 8px;"></span>Nexus Hub
                  </td>
                  <td align="right" class="tier-pill" style="font-size: 11px; font-weight: 600; color: #1e3a8a; background-color: #dbeafe; padding: 4px 10px; border-radius: 999px; letter-spacing: 0.3px; text-transform: uppercase;">
                    ${escapeHtml(tierLabel)} plan
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero -->
          <tr>
            <td style="padding: 32px 32px 8px 32px;">
              <h1 class="hero-title" style="margin: 0 0 12px 0; font-size: 28px; line-height: 1.2; font-weight: 700; color: #111827; letter-spacing: -0.5px;">
                Welcome, ${escapeHtml(firstName)}.
              </h1>
              <p class="body-text" style="margin: 0 0 24px 0; font-size: 16px; color: #374151; line-height: 1.6;">
                ${escapeHtml(hero)}
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" bgcolor="#3b82f6" style="border-radius: 8px; background-color: #3b82f6; box-shadow: 0 1px 2px rgba(59, 130, 246, 0.3);">
                    <a href="${escapeHtml(consoleUrl)}" class="cta-button"
                       style="display: inline-block; padding: 14px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; line-height: 1;">
                      Open your workspace →
                    </a>
                  </td>
                </tr>
              </table>
              <p class="muted" style="margin: 12px 0 0 0; font-size: 12px; color: #9ca3af;">
                One-click sign-in · link expires in 24 hours
              </p>
            </td>
          </tr>

          <tr><td style="padding: 32px;"><hr class="divider" style="border: 0; border-top: 1px solid #e5e7eb; margin: 0;"></td></tr>

          <!-- Features -->
          <tr>
            <td style="padding: 0 32px 8px 32px;">
              <h2 class="section-title" style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; color: #111827; text-transform: uppercase; letter-spacing: 0.8px;">
                What Nexus Hub does for you
              </h2>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                ${featureRow('Content', 'Generate scripts, posts, and research briefs in your voice.')}
                ${featureRow('Secretary', 'Inbox triage, calendar management, and task capture — fully automated.')}
                ${featureRow('Training', 'Coaching for gym, running, cycling, and swim — personalised to your goals.')}
                ${featureRow('Finance', 'Budget tracking with spend coaching that respects your rules.')}
                ${featureRow('Cooking', 'Meal planning around your dietary constraints and pantry.')}
              </table>
              <p class="muted" style="margin: 16px 0 0 0; font-size: 13px; color: #6b7280; line-height: 1.6;">
                Each skill reads context you configure once — no repeating yourself across sessions.
              </p>
            </td>
          </tr>

          <tr><td style="padding: 32px;"><hr class="divider" style="border: 0; border-top: 1px solid #e5e7eb; margin: 0;"></td></tr>

          <!-- Closing -->
          <tr>
            <td style="padding: 0 32px 32px 32px;">
              <p class="body-text" style="margin: 0 0 8px 0; font-size: 14px; color: #374151; line-height: 1.6;">
                Questions? Just reply — every email reaches a human on our team.
              </p>
              <p class="muted" style="margin: 16px 0 0 0; font-size: 13px; color: #9ca3af;">
                — The Nexus Hub team
              </p>
            </td>
          </tr>

        </table>

        <!-- Footer (outside card) -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width: 560px; width: 100%;">
          <tr>
            <td align="center" style="padding: 16px 16px 0 16px; font-size: 11px; color: #9ca3af; line-height: 1.6;">
              You're getting this because your Nexus Hub ${escapeHtml(tierLabel)} plan just activated.<br>
              <a href="https://nexushub.me" style="color: #9ca3af; text-decoration: underline;">nexushub.me</a>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`.trim();
      return {
        subject: input.subject,
        html,
        text,
        tags: [
          // Resend tag values must be [A-Za-z0-9_-] — underscore, not dot.
          // (Defended at the Resend send boundary via sanitizeResendTag,
          // but keeping source tags compliant keeps dashboards readable.)
          { name: 'template', value: 'welcome_paid_upgrade' },
          { name: 'tier', value: tier },
          { name: 'source', value: 'nexus-hub-portal' },
        ],
      };
    }

    // OI-SEC-001a (2026-04-24): admin magic-link email. Sent to a
    // platform admin who requested a sign-in link. The email MUST
    // be brutally simple — one button, one sentence, no tier pill
    // or marketing — because:
    //   1. It's a security-sensitive credential handoff; cruft
    //      around the link is phishing-shaped.
    //   2. Admins often open mail on mobile; a plain body
    //      renders identically across clients.
    //   3. Any rendering bug on the admin auth path locks the
    //      admin out — minimal HTML keeps the blast radius small.
    case 'admin.magic_login': {
      const firstName = typeof input.context.firstName === 'string' && input.context.firstName.trim()
        ? input.context.firstName.trim()
        : null;
      const consoleUrl = typeof input.context.consoleUrl === 'string'
        ? input.context.consoleUrl
        : 'https://nexushub.me/admin';
      const expiresInMinutes = typeof input.context.expiresInMinutes === 'number'
        && input.context.expiresInMinutes > 0
        ? Math.floor(input.context.expiresInMinutes)
        : 15;

      const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

      const text = [
        greeting,
        '',
        `Click the link below to sign in to the Nexus Hub Admin Console. The link is valid for ${expiresInMinutes} minutes and single-use.`,
        '',
        consoleUrl,
        '',
        `If you didn't request this, you can safely ignore this email — the link will expire on its own.`,
        '',
        '— Nexus Hub security',
      ].join('\n');

      const html = `<!DOCTYPE html>
<html>
  <body style="margin: 0; padding: 24px; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; line-height: 1.55;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 10px; border: 1px solid #e5e7eb;">
      <tr>
        <td style="padding: 28px 32px 8px 32px; font-size: 16px;">
          <p style="margin: 0 0 12px 0;">${escapeHtml(greeting)}</p>
          <p style="margin: 0 0 20px 0;">Click the button below to sign in to the <strong>Nexus Hub Admin Console</strong>. The link is valid for <strong>${escapeHtml(String(expiresInMinutes))} minutes</strong> and can only be used once.</p>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding: 0 32px 8px 32px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td align="center" bgcolor="#111827" style="border-radius: 8px; background-color: #111827;">
                <a href="${escapeHtml(consoleUrl)}"
                   style="display: inline-block; padding: 14px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; line-height: 1;">
                  Sign in to Admin Console
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding: 12px 32px 24px 32px; font-size: 13px; color: #6b7280;">
          <p style="margin: 8px 0 0 0;">If you didn't request this, you can safely ignore this email — the link will expire on its own.</p>
          <p style="margin: 16px 0 0 0; font-size: 12px; color: #9ca3af;">— Nexus Hub security</p>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();
      return {
        subject: input.subject,
        html,
        text,
        tags: [
          { name: 'template', value: 'admin_magic_login' },
          { name: 'source', value: 'nexus-hub-portal' },
        ],
      };
    }

    default: {
      const never: never = input.template;
      throw new MailerError(
        'UNCONFIGURED_BACKEND',
        `Unknown transactional template: ${String(never)}`,
      );
    }
  }
}

/**
 * Send a transactional email (welcome, etc.). Returns the same
 * shape as sendMagicLink. Backend is selected the same way via
 * `MAGIC_LINK_MAILER` (env var is shared — a single mailer config
 * covers all transactional sends).
 */
export async function sendTransactionalEmail(input: TransactionalEmailInput): Promise<MailerSendResult> {
  const rendered = renderTransactional(input);
  const backend = resolveBackend();
  switch (backend) {
    case 'console':
      logger.info(
        {
          event: 'transactional.send',
          backend: 'console',
          to: input.to,
          template: input.template,
          subject: rendered.subject,
        },
        `[transactional] (${input.template}) → ${input.to}`,
      );
      return { backend, delivered: true };
    case 'noop':
      return { backend, delivered: true };
    case 'resend':
      return sendViaResendGeneric({
        to: input.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tags: rendered.tags,
      });
    case 'smtp':
    case 'postmark':
      throw new MailerError(
        'BACKEND_UNIMPLEMENTED',
        `Mailer backend '${backend}' is reserved but not yet implemented.`,
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

/**
 * Sanitize a Resend tag name or value. Resend rejects (HTTP 422) any
 * tag containing characters outside [A-Za-z0-9_-]. We replace
 * disallowed chars with `_` so "welcome.paid_upgrade" becomes
 * "welcome_paid_upgrade" rather than crashing the send.
 *
 * Defense in depth: source tags SHOULD already be clean (the
 * renderers produce compliant values), but a malformed tag is a
 * latent footgun — quietly normalizing it here prevents a rogue
 * template from bricking the welcome-email pipeline for every
 * paid-upgrade event.
 */
function sanitizeResendTag(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || '_';
}

/** Generic Resend send — shared by sendMagicLink + sendTransactionalEmail. */
async function sendViaResendGeneric(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: string; value: string }>;
}): Promise<MailerSendResult> {
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
  const payload: ResendPayload = {
    from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    reply_to: replyTo,
    tags: input.tags.map((t) => ({
      name: sanitizeResendTag(t.name),
      value: sanitizeResendTag(t.value),
    })),
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
    logger.error({ err: networkErr, to: input.to }, 'mailer[resend]: network failure');
    throw new MailerError(
      'SEND_FAILED',
      'Resend API network error — check outbound connectivity.',
      { backend: 'resend' },
    );
  }
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ''); }
    logger.error({ status: res.status, body, to: input.to }, 'mailer[resend]: non-2xx from Resend API');
    throw new MailerError(
      'SEND_FAILED',
      `Resend API returned ${res.status}. See logs for the full response.`,
      { backend: 'resend', status: res.status, body },
    );
  }
  let parsed: { id?: string } | null = null;
  try { parsed = await res.json() as { id?: string }; } catch { /* no body is fine on success */ }
  logger.info(
    { to: input.to, subject: input.subject, messageId: parsed?.id },
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
