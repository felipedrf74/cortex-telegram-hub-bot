// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * One-shot: send a test magic-link email via the configured mailer.
 *
 * Usage (dev — log to console only):
 *   MAGIC_LINK_MAILER=console \
 *   npx ts-node scripts/send-test-magic-link-email.ts felipedrf74@gmail.com
 *
 * Usage (prod — actually send via Resend):
 *   MAGIC_LINK_MAILER=resend \
 *   RESEND_API_KEY=re_xxxxx \
 *   MAGIC_LINK_FROM='Nexus Hub <welcome@nexushub.me>' \
 *   npx ts-node scripts/send-test-magic-link-email.ts felipedrf74@gmail.com
 *
 * Notes:
 *   - The email body mirrors the real magic-link flow output. The
 *     URL is a synthetic non-functional one ("#test-send") so
 *     there's no chance of a clicked test-email consuming a real
 *     token.
 *   - Domain `nexushub.me` must be verified in Resend (dashboard →
 *     Domains → Add nexushub.me → create the SPF + DKIM DNS records
 *     it shows you, then click "Verify"). Without verification,
 *     Resend returns 400 with "The domain is not verified."
 *   - Free-tier Resend allows unlimited sends to addresses at your
 *     verified domain owner's email (the one you signed up with).
 *     Sends to arbitrary addresses like gmail.com require the full
 *     domain verification above.
 */

import { sendMagicLink, resolveBackend, MailerError } from '../src/services/mailer';

async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to || !to.includes('@')) {
    console.error('Usage: npx ts-node scripts/send-test-magic-link-email.ts <recipient@example.com>');
    process.exit(1);
  }
  const backend = resolveBackend();
  console.error(`[send-test] Using mailer backend: ${backend}`);
  if (backend === 'console' || backend === 'noop') {
    console.error(
      '[send-test] NOTE: this backend does NOT actually send email. To send via Resend:\n' +
      '    export RESEND_API_KEY=re_xxxxx\n' +
      '    export MAGIC_LINK_MAILER=resend\n' +
      '    export MAGIC_LINK_FROM=\'Nexus Hub <welcome@nexushub.me>\'\n',
    );
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const url = 'https://nexushub.me/invite/accept?code=TEST_CODE_123&magic=TEST_MAGIC_TOKEN_xyz';

  try {
    const result = await sendMagicLink({
      to,
      url,
      intentLabel: 'Welcome to Nexus Hub — accept your invite',
      expiresAt,
      tenantName: 'Nexus Hub (test tenant)',
    });
    console.error(`[send-test] OK — backend=${result.backend} delivered=${result.delivered}`);
    if (result.debugUrl) {
      console.error(`[send-test] debugUrl (dev only): ${result.debugUrl}`);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof MailerError) {
      console.error(`[send-test] MailerError ${err.code}: ${err.message}`);
      if (err.details) {
        console.error(`[send-test] details: ${JSON.stringify(err.details, null, 2)}`);
      }
      process.exit(2);
    }
    console.error(`[send-test] Unexpected error:`, err);
    process.exit(3);
  }
}

main();
