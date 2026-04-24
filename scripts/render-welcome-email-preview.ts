// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Preview the welcome email body (the one sent on paid-tier upgrade)
 * to /tmp for visual inspection. No network, no API key needed.
 *
 * Usage:
 *   npx ts-node scripts/render-welcome-email-preview.ts
 *   open /tmp/nexus-welcome-email-preview.html
 */

import fs from 'fs';

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

const firstName = 'Felipe';
const tier: string = 'pro';
const tierLabel = tier === 'max' ? 'Max' : tier === 'pro' ? 'Pro' : 'paid';
const consoleUrl = 'https://nexushub.me/console';

const html = `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 24px auto; color: #1f2937; line-height: 1.5;">
    <h2 style="color: #111827; font-size: 20px; margin: 0 0 12px;">Welcome, ${escapeHtml(firstName)}</h2>
    <p style="margin: 0 0 16px;">Your Nexus Hub <strong>${escapeHtml(tierLabel)}</strong> plan is active.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(consoleUrl)}"
         style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">
        Open your workspace
      </a>
    </p>
    <h3 style="font-size: 15px; color: #111827; margin: 24px 0 8px;">What to do next</h3>
    <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151;">
      <li style="margin-bottom: 8px;">Open the User Console and set up your tenant (it's already created — just walk through the first-run checklist).</li>
      <li style="margin-bottom: 8px;">Configure each of your five skills (Content, Secretary, Training, Finance, Cooking) — they read tenant-level config for context.</li>
      <li style="margin-bottom: 8px;">Install the iOS app when you're ready — it's the primary mobile interface.</li>
    </ol>
    <p style="margin: 24px 0 0; font-size: 14px; color: #6b7280;">
      If you need anything, just reply to this email — we read every message.
    </p>
    <p style="margin: 8px 0 0; font-size: 13px; color: #9ca3af;">— The Nexus Hub team</p>
  </body>
</html>
`;

const out = '/tmp/nexus-welcome-email-preview.html';
fs.writeFileSync(out, html);
console.log(`[preview] Wrote welcome email HTML to ${out}`);
console.log(`[preview] Preview: file://${out}`);
console.log(`[preview] Simulated context: firstName="${firstName}", tier="${tier}", consoleUrl="${consoleUrl}"`);
