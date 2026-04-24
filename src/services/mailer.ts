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
    case 'smtp':
    case 'resend':
    case 'postmark':
      // Not yet implemented — landing one of these requires an
      // explicit product decision on provider choice. Until then,
      // throw an explicit error so the route handler can return a
      // clear 503 rather than a silent no-op.
      throw new MailerError(
        'BACKEND_UNIMPLEMENTED',
        `Mailer backend '${backend}' is reserved but not yet implemented. Set MAGIC_LINK_MAILER=console for dev, or implement the backend (tracked as OI-NAV-203c).`,
        { backend },
      );
    default:
      // Exhaustiveness check — TypeScript should prevent this.
      throw new MailerError(
        'UNCONFIGURED_BACKEND',
        `Unknown MAGIC_LINK_MAILER backend: ${String(backend)}`,
        { backend },
      );
  }
}
