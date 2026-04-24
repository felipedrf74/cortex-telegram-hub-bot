// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Preview the welcome email body (the one sent on paid-tier upgrade)
 * to /tmp for visual inspection. No network, no API key needed.
 *
 * Unlike a previous hardcoded snapshot, this script calls the *real*
 * template renderer from src/services/mailer.ts — so "what I see in
 * /tmp" is bit-for-bit what a real recipient will get.
 *
 * Usage:
 *   npx ts-node scripts/render-welcome-email-preview.ts
 *   open /tmp/nexus-welcome-email-preview.html
 *
 * Env overrides (optional):
 *   PREVIEW_TIER=max|pro|paid
 *   PREVIEW_FIRST_NAME=Felipe
 */

import fs from 'fs';

// Force noop backend so no network / API key is touched during preview.
process.env.MAGIC_LINK_MAILER = 'noop';

// Import AFTER setting env (mailer reads env at call time but this is
// defensive — other callsites may snapshot config at import time).
import { __previewRenderTransactional } from '../src/services/mailer';

const firstName = process.env.PREVIEW_FIRST_NAME || 'Felipe';
const tier = process.env.PREVIEW_TIER || 'pro';
// OI-WELCOME-201b (2026-04-24): CTA is a magic-login URL, not a
// bare /console link. Clicking it in the email mints a web-session
// JWT + redirects to /console with the user already signed in.
const consoleUrl = 'https://nexushub.me/magic-login?token=TOKEN_A_REAL_RANDOM_BASE64URL_VALUE_GOES_HERE';

const rendered = __previewRenderTransactional({
  template: 'welcome.paid_upgrade',
  to: 'preview@example.com',
  subject: `Welcome to Nexus Hub — your ${tier === 'max' ? 'Max' : 'Pro'} plan is active`,
  context: { firstName, tier, consoleUrl },
});

const htmlOut = '/tmp/nexus-welcome-email-preview.html';
const textOut = '/tmp/nexus-welcome-email-preview.txt';
fs.writeFileSync(htmlOut, rendered.html);
fs.writeFileSync(textOut, rendered.text);
// eslint-disable-next-line no-console
console.log(`[preview] HTML → ${htmlOut}`);
// eslint-disable-next-line no-console
console.log(`[preview] TEXT → ${textOut}`);
// eslint-disable-next-line no-console
console.log(`[preview] Subject: ${rendered.subject}`);
// eslint-disable-next-line no-console
console.log(`[preview] Context: firstName="${firstName}", tier="${tier}"`);
// eslint-disable-next-line no-console
console.log(`[preview] Open with: open ${htmlOut}`);
