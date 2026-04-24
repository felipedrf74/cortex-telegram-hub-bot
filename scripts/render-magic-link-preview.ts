// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Render the magic-link email body to /tmp for visual preview —
 * no API calls, no network, pure HTML generation. Use to verify
 * the email looks right before pointing Resend at a live domain.
 *
 * Usage:
 *   npx ts-node scripts/render-magic-link-preview.ts
 *   open /tmp/nexus-magic-link-preview.html
 */

import fs from 'fs';

// Import renderMagicLinkBodies indirectly by going through the
// public sendMagicLink with the 'console' backend + capturing the
// URL only isn't enough — we need the HTML. So we re-render
// inline, using the same escape helper as the mailer.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

const email = {
  to: 'felipedrf74@gmail.com',
  url: 'https://nexushub.me/invite/accept?code=TEST_CODE_123&magic=TEST_MAGIC_TOKEN_xyz',
  intentLabel: 'Welcome to Nexus Hub — accept your invite',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  tenantName: 'Nexus Hub',
};

const tenant = email.tenantName || 'a Nexus Hub workspace';
const html = `<!DOCTYPE html>
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
`;

const out = '/tmp/nexus-magic-link-preview.html';
fs.writeFileSync(out, html);
console.log(`[preview] Wrote email HTML to ${out}`);
console.log(`[preview] Preview: file://${out}`);
console.log(`[preview] To send for real:`);
console.log(`  export RESEND_API_KEY=re_xxxxx`);
console.log(`  export MAGIC_LINK_MAILER=resend`);
console.log(`  export MAGIC_LINK_FROM='Nexus Hub <welcome@nexushub.me>'`);
console.log(`  npx ts-node scripts/send-test-magic-link-email.ts ${email.to}`);
