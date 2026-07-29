// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { chromium, BrowserContext, Page, Browser } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { filePdf, PT_MONTHS, isInvoiceFilingConfigured } from './invoice-filer';
import { recordFiling, isDuplicate, isEmailAlreadyFiled } from '../state/invoice-filings';
import { assertGlobalInvoiceCollectorOwnerScope } from './invoice-collector-scope';

// ─── Types ──────────────────────────────────────────────────────────

export interface AmazonOrder {
  orderId: string;       // "405-1234567-8901234"
  date: string;          // "2026-02-15" ISO format
  total: string | null;  // "€ 45,90" or null
}

export interface AmazonOrderResult {
  orderId: string;
  date: string;
  total: string | null;
  status: 'filed' | 'duplicate' | 'error' | 'no_invoice';
  error?: string;
}

export interface AmazonCollectionResult {
  year: number;
  month: number;
  monthLabel: string;
  orders: AmazonOrderResult[];
  totalFiled: number;
  totalDuplicates: number;
  totalErrors: number;
  totalNoInvoice: number;
  loginRequired: boolean;
  twoFactorRequired: boolean;
  durationMs: number;
}

// ─── Reply Waiter (for interactive 2FA via Telegram) ────────────────

interface PendingReply {
  resolve: (msg: string) => void;
  timer: NodeJS.Timeout;
}

const pendingReplies = new Map<number, PendingReply>();

/**
 * Register a waiter for the next text reply from a specific chat.
 * Used during interactive 2FA: bot sends screenshot, waits for OTP.
 */
export function registerReplyWaiter(chatId: number, timeoutMs: number): Promise<string> {
  // Reject any existing waiter for this chat so the previous caller gets an error
  const existing = pendingReplies.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve('__CANCELLED__'); // resolve (not reject) to avoid unhandled rejection noise
    pendingReplies.delete(chatId);
    logger.warn({ chatId }, 'Replaced existing reply waiter');
  }

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(chatId);
      reject(new Error('Timeout: 2FA code not received within time limit'));
    }, timeoutMs);

    pendingReplies.set(chatId, { resolve, timer });
  });
}

/**
 * Try to resolve a pending reply waiter. Returns true if a waiter consumed the message.
 * Called from bot.ts message handler to intercept replies during 2FA flow.
 */
export function resolveReply(chatId: number, text: string): boolean {
  const pending = pendingReplies.get(chatId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingReplies.delete(chatId);
    pending.resolve(text);
    return true;
  }
  return false;
}

// ─── Configuration Guard ────────────────────────────────────────────

export function isAmazonConfigured(): boolean {
  return (
    config.invoices.amazonEnabled &&
    config.invoices.amazonEmail !== '' &&
    config.invoices.amazonPassword !== ''
  );
}

// ─── Anti-Detection Context Options ─────────────────────────────────

/** Browser context options that reduce headless detection by Amazon. */
export const AMAZON_BROWSER_LOCALE = 'en-US';

const CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: AMAZON_BROWSER_LOCALE,
  timezoneId: 'Europe/Madrid',
  viewport: { width: 1280, height: 800 },
};

// ─── Session Management ─────────────────────────────────────────────

async function loadOrCreateContext(browser: Browser): Promise<BrowserContext> {
  const sessionPath = config.invoices.amazonSessionPath;

  try {
    if (fs.existsSync(sessionPath)) {
      logger.info({ sessionPath }, 'Loading saved Amazon session');
      return await browser.newContext({ ...CONTEXT_OPTIONS, storageState: sessionPath });
    }
  } catch (err) {
    logger.warn({ err, sessionPath }, 'Failed to load saved session, creating fresh context');
  }

  return await browser.newContext(CONTEXT_OPTIONS);
}

async function saveSession(context: BrowserContext): Promise<void> {
  const sessionPath = config.invoices.amazonSessionPath;

  try {
    // Ensure directory exists
    const dir = path.dirname(sessionPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await context.storageState({ path: sessionPath });
    // Restrict session file permissions (contains auth cookies)
    try { fs.chmodSync(sessionPath, 0o600); } catch { /* non-critical */ }
    logger.info({ sessionPath }, 'Amazon session saved');
  } catch (err) {
    logger.warn({ err }, 'Failed to save Amazon session');
  }
}

// ─── Login Flow ─────────────────────────────────────────────────────

/** URL patterns that indicate we're still on an auth page (not logged in). */
const AUTH_URL_PATTERNS = ['/ap/signin', '/ap/mfa', '/ap/cvf', '/ax/claim'];

/** Check if the current page URL is an Amazon auth-related page. */
function isAuthPage(url: string): boolean {
  return AUTH_URL_PATTERNS.some((p) => url.includes(p));
}

/**
 * Attempt to log in to Amazon.es.
 *
 * Amazon.es (as of early 2026) uses a multi-step flow:
 *   1. Email page  — field `#ap_email_login` or `#ap_email`, submit button
 *   2. Password page — field `#ap_password`, button `#signInSubmit`
 *   3. Possible challenges:
 *      a. Grid CAPTCHA / visual puzzle at `/ap/cvf/request`
 *      b. OTP / 2FA code at `/ap/mfa`
 *      c. Text CAPTCHA at the sign-in page itself
 *      d. "Approve on another device" notification
 *
 * When interactive Telegram callbacks are provided, challenges are forwarded
 * to the user as screenshots; the user replies and the bot fills the answer.
 */
async function loginToAmazon(
  page: Page,
  sendTelegram?: (text: string) => Promise<void>,
  sendScreenshot?: (buffer: Buffer) => Promise<void>,
  waitForReply?: (timeoutMs: number) => Promise<string>,
): Promise<{ success: boolean; twoFactorRequired: boolean }> {
  logger.info('Starting Amazon.es login flow');

  const hasInteractive = !!(sendTelegram && sendScreenshot && waitForReply);

  try {
    // ── Step 1: Navigate to sign-in ────────────────────────────
    await page.goto(
      'https://www.amazon.es/ap/signin?openid.pape.max_auth_age=0' +
        '&openid.return_to=https%3A%2F%2Fwww.amazon.es%2F' +
        '&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select' +
        '&openid.assoc_handle=esflex&openid.mode=checkid_setup' +
        '&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select' +
        '&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
      { waitUntil: 'domcontentloaded', timeout: 30000 },
    );
    logger.debug({ url: page.url() }, 'Sign-in page loaded');

    // ── Step 2: Fill email ─────────────────────────────────────
    // New Amazon.es flow uses `#ap_email_login`; fallback to `#ap_email`
    const emailInput = page.locator('#ap_email_login, #ap_email');
    if (await emailInput.first().isVisible({ timeout: 5000 })) {
      await emailInput.first().fill(config.invoices.amazonEmail);

      // Submit email — use generic submit (the button text varies)
      const submitBtn = page.locator('input[type="submit"]').first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);
    }
    logger.debug({ url: page.url() }, 'After email submission');

    // ── Step 3: Fill password ──────────────────────────────────
    const passwordInput = page.locator('#ap_password');
    if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await passwordInput.fill(config.invoices.amazonPassword);

      const signInBtn = page.locator('#signInSubmit');
      if (await signInBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);
    }
    logger.debug({ url: page.url() }, 'After password submission');

    // ── Check for wrong-password error ─────────────────────────
    const errorBox = page.locator('#auth-error-message-box, .a-alert-content');
    const errorVisible = await errorBox.first().isVisible({ timeout: 1000 }).catch(() => false);
    if (errorVisible) {
      const errorText = (await errorBox.first().textContent().catch(() => '')) || '';
      logger.error({ errorText: errorText.trim() }, 'Amazon login error message');
      if (sendTelegram) {
        await sendTelegram(`❌ Amazon login falhou: ${errorText.trim().substring(0, 200)}`);
      }
      return { success: false, twoFactorRequired: false };
    }

    // ── Step 4: Handle challenges (loop, as Amazon may chain them) ──
    let challengeAttempts = 0;
    const MAX_CHALLENGE_ATTEMPTS = 3;

    while (isAuthPage(page.url()) && challengeAttempts < MAX_CHALLENGE_ATTEMPTS) {
      challengeAttempts++;
      const currentUrl = page.url();
      logger.info({ url: currentUrl, attempt: challengeAttempts }, 'Detected auth challenge page');

      // 4a. Grid CAPTCHA / visual puzzle — `/ap/cvf`
      if (currentUrl.includes('/ap/cvf')) {
        logger.info('CVF challenge page detected (visual puzzle or verification)');

        if (!hasInteractive) {
          logger.warn('CVF challenge requires interactive solving — no callbacks in cron mode');
          return { success: false, twoFactorRequired: true };
        }

        // Wait for page to fully render (it uses JS to load the puzzle)
        await page.waitForTimeout(4000);

        await sendTelegram!(
          '🧩 Amazon pede verificação de identidade.\n' +
            'Vou enviar uma captura de ecrã. ' +
            'Por favor diga-me o que preciso fazer (ex: os números das imagens a selecionar, um código, etc.):',
        );
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
        await sendScreenshot!(screenshot);

        try {
          const userReply = await waitForReply!(300_000); // 5 min
          const handled = await handleCvfChallenge(page, userReply);
          if (!handled) {
            await sendTelegram!('⚠️ Não consegui aplicar a resposta. Vou enviar outro screenshot.');
            // Send updated screenshot for another round
            const retryScreen = await page.screenshot({ type: 'jpeg', quality: 80 });
            await sendScreenshot!(retryScreen);
            continue;
          }
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(3000);
        } catch (err) {
          logger.error({ err }, 'CVF interactive flow failed');
          return { success: false, twoFactorRequired: true };
        }
        continue;
      }

      // 4b. OTP / 2FA code
      const otpInput = page.locator('#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code');
      const is2FA = await otpInput.first().isVisible({ timeout: 2000 }).catch(() => false);
      if (is2FA) {
        logger.info('OTP/2FA prompt detected');

        if (!hasInteractive) {
          logger.warn('2FA required but no interactive callbacks (cron mode)');
          return { success: false, twoFactorRequired: true };
        }

        await sendTelegram!('🔐 Amazon necessita código de verificação. Envie o código:');
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
        await sendScreenshot!(screenshot);

        try {
          const otp = await waitForReply!(300_000);
          if (otp === '__CANCELLED__') {
            logger.info('Amazon 2FA cancelled by new collection request');
            return { success: false, twoFactorRequired: true };
          }
          const cleanOtp = otp.trim().replace(/\s+/g, '');
          await otpInput.first().fill(cleanOtp);

          // Check "Remember this device"
          const remember = page.locator('#auth-mfa-remember-device, input[name="rememberDevice"]');
          if (await remember.isVisible({ timeout: 1000 }).catch(() => false)) {
            await remember.check();
          }

          // Submit
          const submitBtn = page.locator(
            '#auth-signin-button, #auth-signin-button-announce, input[type="submit"]',
          );
          if (await submitBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
            await submitBtn.first().click();
          } else {
            await page.keyboard.press('Enter');
          }
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(3000);
        } catch (err) {
          logger.error({ err }, '2FA flow failed');
          return { success: false, twoFactorRequired: true };
        }
        continue;
      }

      // 4c. Text CAPTCHA
      const captchaInput = page.locator('#auth-captcha-guess');
      const isCaptcha = await captchaInput.isVisible({ timeout: 1000 }).catch(() => false);
      if (isCaptcha) {
        logger.info('Text CAPTCHA detected');

        if (!hasInteractive) {
          return { success: false, twoFactorRequired: true };
        }

        await sendTelegram!('🧩 Amazon apresenta um CAPTCHA de texto. Envie o texto da imagem:');
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
        await sendScreenshot!(screenshot);

        try {
          const answer = await waitForReply!(300_000);
          if (answer === '__CANCELLED__') {
            logger.info('Amazon CAPTCHA cancelled by new collection request');
            return { success: false, twoFactorRequired: true };
          }
          await captchaInput.fill(answer.trim());
          await page.keyboard.press('Enter');
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(2000);
        } catch {
          return { success: false, twoFactorRequired: true };
        }
        continue;
      }

      // 4d. Unknown challenge — send screenshot for manual help
      logger.warn({ url: currentUrl }, 'Unknown auth challenge page');
      if (hasInteractive) {
        await sendTelegram!('⚠️ Amazon mostra uma página de verificação desconhecida:');
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
        await sendScreenshot!(screenshot);
        try {
          const hint = await waitForReply!(300_000);
          if (hint === '__CANCELLED__') {
            logger.info('Amazon challenge cancelled by new collection request');
            return { success: false, twoFactorRequired: true };
          }
          // Try typing the hint into any visible input
          const anyInput = page.locator('input[type="text"]:visible, input[type="tel"]:visible');
          if (await anyInput.first().isVisible({ timeout: 1000 }).catch(() => false)) {
            await anyInput.first().fill(hint.trim());
            await page.keyboard.press('Enter');
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(3000);
          }
        } catch {
          return { success: false, twoFactorRequired: true };
        }
      } else {
        return { success: false, twoFactorRequired: true };
      }
    }

    // ── Step 5: Verify login ───────────────────────────────────
    const isLoggedIn = await checkLoggedIn(page);
    if (isLoggedIn) {
      logger.info('Amazon.es login successful');
      if (sendTelegram) await sendTelegram('✅ Login Amazon.es com sucesso!');
    } else {
      logger.warn({ url: page.url() }, 'Login verification failed after all challenge attempts');
      if (hasInteractive) {
        await sendTelegram!('⚠️ Login pode ter falhado. Estado atual:');
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
        await sendScreenshot!(screenshot);
      }
    }

    return { success: isLoggedIn, twoFactorRequired: challengeAttempts > 0 };
  } catch (err) {
    logger.error({ err }, 'Amazon login flow error');
    return { success: false, twoFactorRequired: false };
  }
}

/**
 * Handle a CVF (Customer Verification Flow) challenge page.
 *
 * Amazon's CVF can be:
 *  - A visual grid puzzle ("Select all hats") — user provides grid numbers 1-9
 *  - A text code sent via SMS/email — user provides the code
 *  - A notification approval — user confirms on their phone
 *
 * The user's reply is interpreted as either:
 *  - Comma-separated numbers → click those grid cells (e.g. "1,3,5,7")
 *  - Plain text/digits → fill into any visible input field
 */
async function handleCvfChallenge(page: Page, userReply: string): Promise<boolean> {
  const reply = userReply.trim();

  // Check if reply looks like grid positions (e.g. "1,3,5,7" or "1 3 5 7")
  const gridNumbers = reply
    .split(/[\s,;]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => n >= 1 && n <= 9);

  if (gridNumbers.length > 0 && gridNumbers.length === reply.split(/[\s,;]+/).filter(Boolean).length) {
    // User provided grid cell numbers — click each one
    logger.info({ gridNumbers }, 'Clicking grid cells for visual puzzle');

    // Find all clickable images in the puzzle grid.
    // The evaluate() callback runs in browser context (DOM available).
    const gridImages: { x: number; y: number }[] = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const doc = (globalThis as any).document;
      const imgs: any[] = Array.from(doc.querySelectorAll('img'));
      // Filter to puzzle images: medium-sized, in a grid layout
      const puzzleImgs = imgs.filter((img: any) => {
        const rect = img.getBoundingClientRect();
        return rect.width >= 60 && rect.width <= 250 && rect.height >= 60 && rect.height <= 250;
      });

      // Sort by position: top-to-bottom, left-to-right (row-major)
      puzzleImgs.sort((a: any, b: any) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (Math.abs(ra.top - rb.top) > 30) return ra.top - rb.top;
        return ra.left - rb.left;
      });

      return puzzleImgs.map((img: any) => {
        const rect = img.getBoundingClientRect();
        return {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
      });
    });

    logger.info({ gridSize: gridImages.length }, 'Found puzzle grid images');

    if (gridImages.length === 0) {
      logger.warn('No puzzle grid images found');
      return false;
    }

    // Click each selected cell
    for (const num of gridNumbers) {
      const idx = num - 1; // Convert 1-based to 0-based
      if (idx >= 0 && idx < gridImages.length) {
        const { x, y } = gridImages[idx];
        await page.mouse.click(x, y);
        logger.debug({ num, x, y }, 'Clicked grid cell');
        await page.waitForTimeout(300);
      }
    }

    // Click "Confirmar" or submit button
    await page.waitForTimeout(500);
    const confirmBtn = page.locator(
      'button:has-text("Confirmar"), button:has-text("Continuar"), ' +
        'input[type="submit"]:visible, button[type="submit"]:visible',
    );
    if (await confirmBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.first().click();
      logger.info('Clicked confirm button after grid selection');
    }
    return true;
  }

  // Not grid numbers — try filling into a visible input (code / text answer)
  const codeInput = page.locator(
    '#cvf-input-code, input[type="text"]:visible, input[type="tel"]:visible, input[type="number"]:visible',
  );
  if (await codeInput.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await codeInput.first().fill(reply);
    await page.keyboard.press('Enter');
    logger.info('Filled CVF input with user reply');
    return true;
  }

  logger.warn('Could not find any interactive element to fill on CVF page');
  return false;
}

/**
 * Check if we're logged in by verifying we're NOT on an auth page
 * and the Amazon nav shows a greeting.
 *
 * Supports multiple languages — Amazon.es can be set to English, Spanish,
 * Portuguese, etc. The nav greeting changes accordingly:
 *   ES: "Hola, Felipe"  |  EN: "Hello, Felipe"  |  PT: "Olá, Felipe"
 */
async function checkLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();

    // If still on any auth page, not logged in
    if (isAuthPage(url)) {
      return false;
    }

    // Check for greeting in any language (nav shows "Hello/Hola/Olá, Name")
    const accountLink = page.locator('#nav-link-accountList-nav-line-1');
    const text = await accountLink.textContent({ timeout: 5000 }).catch(() => '');
    if (text && /Hola|Hello|Olá|Bonjour|Ciao/i.test(text)) {
      return true;
    }

    // Fallback: check if we're on a normal Amazon page (nav belt is present)
    const navBelt = page.locator('#nav-belt, #navbar, #nav-main, #nav-xshop');
    return await navBelt.isVisible({ timeout: 3000 }).catch(() => false);
  } catch {
    return false;
  }
}

// ─── Order History Scraping ─────────────────────────────────────────

/**
 * Parse a localized date string to ISO format.
 * Supports Spanish, Portuguese, English, French, Italian, and German month names —
 * Amazon.es allows users to change their UI language, so we must handle any of these.
 *
 * Common formats:
 *   - "15 de febrero de 2026"  (ES)
 *   - "6 de março de 2026"     (PT)
 *   - "March 6, 2026"          (EN)
 *   - "15/02/2026"             (numeric)
 */
function parseLocalizedDate(dateStr: string): string | null {
  // Consolidated month-name → number map (ES, PT, EN, FR, IT, DE + abbreviations).
  // Duplicates across languages removed (e.g. "agosto" is both ES and PT).
  const months: Record<string, number> = {
    // ── January ──
    enero: 1, janeiro: 1, january: 1, janvier: 1, gennaio: 1, januar: 1, jan: 1,
    // ── February ──
    febrero: 2, fevereiro: 2, february: 2, février: 2, febbraio: 2, feb: 2,
    // ── March ──
    marzo: 3, março: 3, march: 3, mars: 3, marz: 3, mar: 3,
    // ── April ──
    abril: 4, april: 4, avril: 4, aprile: 4, abr: 4,
    // ── May ──
    mayo: 5, maio: 5, may: 5, mai: 5, maggio: 5,
    // ── June ──
    junio: 6, junho: 6, june: 6, juin: 6, giugno: 6, juni: 6, jun: 6,
    // ── July ──
    julio: 7, julho: 7, july: 7, juillet: 7, luglio: 7, juli: 7, jul: 7,
    // ── August ──
    agosto: 8, august: 8, août: 8, ago: 8,
    // ── September ──
    septiembre: 9, setembro: 9, september: 9, septembre: 9, settembre: 9, set: 9,
    // ── October ──
    octubre: 10, outubro: 10, october: 10, octobre: 10, ottobre: 10, oktober: 10, oct: 10, out: 10,
    // ── November ──
    noviembre: 11, novembro: 11, november: 11, novembre: 11, nov: 11,
    // ── December ──
    diciembre: 12, dezembro: 12, december: 12, décembre: 12, dicembre: 12, dezember: 12,
    dic: 12, dez: 12, dec: 12,
  };

  // Normalize: remove accents for matching, but try exact first
  const normalize = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // ── Pattern 1: "15 de febrero de 2026" / "6 de março de 2026" / "15 febrero 2026"
  const longMatch = dateStr.match(/(\d{1,2})\s+(?:de\s+)?(\w+)\s+(?:de\s+)?(\d{4})/i);
  if (longMatch) {
    const day = parseInt(longMatch[1], 10);
    const monthName = longMatch[2].toLowerCase();
    const year = parseInt(longMatch[3], 10);
    const month = months[monthName] ?? months[normalize(monthName)];
    if (month) {
      return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }

  // ── Pattern 2: English "March 6, 2026" / "February 15, 2026"
  const enMatch = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (enMatch) {
    const monthName = enMatch[1].toLowerCase();
    const day = parseInt(enMatch[2], 10);
    const year = parseInt(enMatch[3], 10);
    const month = months[monthName] ?? months[normalize(monthName)];
    if (month) {
      return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }

  // ── Pattern 3: "15/02/2026" or "15-02-2026" (DD/MM/YYYY, European)
  const numMatch = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (numMatch) {
    const day = parseInt(numMatch[1], 10);
    const month = parseInt(numMatch[2], 10);
    const year = parseInt(numMatch[3], 10);
    if (month >= 1 && month <= 12) {
      return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }

  return null;
}

/**
 * Scrape order history for a given year, filtering to the target month.
 * Handles pagination by clicking "Next" until no more pages.
 */
async function scrapeOrders(page: Page, year: number, month: number): Promise<AmazonOrder[]> {
  const orders: AmazonOrder[] = [];
  const monthStr = month.toString().padStart(2, '0');
  const targetPrefix = `${year}-${monthStr}`;

  // Navigate to order history for the year
  const url = `https://www.amazon.es/gp/your-account/order-history?orderFilter=year-${year}`;
  logger.info({ url, targetMonth: targetPrefix }, 'Navigating to Amazon order history');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  let pageNum = 1;
  const maxPages = 80; // Back-months can require many pages; early-stop below keeps this bounded.

  while (pageNum <= maxPages) {
    logger.info({ pageNum }, 'Scraping order history page');
    let datedCards = 0;
    let olderThanTargetCards = 0;
    let targetMonthCards = 0;

    // ── Find all order cards on this page ─────────────────────
    // Amazon uses various class structures depending on the locale / UI version.
    // We try multiple selectors; the broadest reliable one is `.a-box-group`
    // which wraps each order card on the order-history page.
    const orderCards = await page
      .locator('.order-card, .a-box-group.order, [class*="order-card"], .order')
      .all();

    // Fallback: if standard selectors found nothing, try the broadest
    // approach — each order block is an `.a-box-group` within the page.
    let cards = orderCards;
    if (cards.length === 0) {
      logger.info('Primary selectors found no order cards — trying .a-box-group fallback');
      cards = await page.locator('.a-box-group').all();
    }

    if (cards.length === 0) {
      // Last resort: dump page info for debugging
      const pageText = (await page.textContent('body') || '').replace(/\s+/g, ' ').substring(0, 400);
      logger.info({ pageText }, 'No order cards found on page (debug excerpt)');
      break;
    }

    logger.info({ cardsFound: cards.length }, 'Order cards found on page');

    for (const card of cards) {
      try {
        const cardText = await card.textContent() || '';

        // ── Extract order ID ──────────────────────────────────
        let orderId: string | null = null;

        // Try data attribute first
        orderId = await card.getAttribute('data-orderid').catch(() => null);

        // Try extracting from text (order ID pattern: XXX-XXXXXXX-XXXXXXX)
        if (!orderId) {
          const orderIdMatch = cardText.match(/\b(\d{3}-\d{7}-\d{7})\b/);
          if (orderIdMatch) orderId = orderIdMatch[1];
        }

        if (!orderId) {
          // This box-group is not an order card (e.g. sidebar, header)
          continue;
        }

        // ── Extract date ──────────────────────────────────────
        // We specifically need the ORDER date (not delivery date).
        // Amazon card text: "Order placed 6 March 2026 Total €23.16 ..."
        //                   "Pedido efetuado 6 de março de 2026 ..."
        //                   "Pedido realizado el 15 de febrero de 2026 ..."
        let date: string | null = null;

        // Strategy 1 (best): Find the date prefixed by "Order placed" / "Pedido"
        // EN: "Order placed 6 March 2026"
        const enOrderDateMatch = cardText.match(
          /(?:Order\s+placed|Ordered)\s+(\d{1,2}\s+\w+\s+\d{4})/i,
        );
        if (enOrderDateMatch) {
          date = parseLocalizedDate(enOrderDateMatch[1]);
        }
        // ES/PT: "Pedido realizado/efetuado [el] 6 de marzo de 2026"
        if (!date) {
          const esOrderDateMatch = cardText.match(
            /(?:Pedido\s+(?:realizado|efetuado))\s+(?:el\s+)?(\d{1,2}\s+(?:de\s+)?\w+\s+(?:de\s+)?\d{4})/i,
          );
          if (esOrderDateMatch) {
            date = parseLocalizedDate(esOrderDateMatch[1]);
          }
        }

        // Strategy 2: Look in the order-header sub-element
        if (!date) {
          const headerEl = card.locator(
            '[class*="order-header"], [class*="order-he"], .a-color-offset-background',
          );
          const headerText = await headerEl.first().textContent({ timeout: 1000 }).catch(() => '');
          if (headerText) {
            date = parseLocalizedDate(headerText);
          }
        }

        // Strategy 3: Generic date regex on full card text
        if (!date) {
          // "DAY [de] MONTH [de] YEAR" (ES/PT/EN)
          const dateRegex =
            /(\d{1,2})\s+(?:de\s+)?([a-záéíóúàèìòùãõâêîôûçñA-Za-z]+)\s+(?:de\s+)?(\d{4})/i;
          const dateMatch = cardText.match(dateRegex);
          if (dateMatch) {
            date = parseLocalizedDate(dateMatch[0]);
          }
        }
        if (!date) {
          // EN format: "March 6, 2026"
          const enDateRegex = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/;
          const enMatch = cardText.match(enDateRegex);
          if (enMatch) {
            date = parseLocalizedDate(enMatch[0]);
          }
        }

        // If no date found, skip (can't determine month)
        if (!date) {
          logger.debug({ orderId }, 'Could not extract date from order card');
          continue;
        }
        datedCards += 1;
        if (date.startsWith(targetPrefix)) targetMonthCards += 1;
        if (date < `${targetPrefix}-01`) olderThanTargetCards += 1;

        // Filter to target month
        if (!date.startsWith(targetPrefix)) {
          continue;
        }

        // ── Extract total ─────────────────────────────────────
        let total: string | null = null;
        // Match "TOTAL 297,24 €" or "Total: €45.90" or "€ 45,90"
        const totalMatch = cardText.match(
          /(?:Total|Importe|TOTAL)[:\s]*([\d.,]+\s*[€$£]|[€$£]\s*[\d.,]+)/i,
        );
        if (totalMatch) {
          total = totalMatch[1].trim();
        } else {
          // Broader: any euro amount
          const euroMatch = cardText.match(/([\d.,]+\s*€|€\s*[\d.,]+)/);
          if (euroMatch) total = euroMatch[1].trim();
        }

        orders.push({ orderId, date, total });
        logger.debug({ orderId, date, total }, 'Found order');
      } catch (err) {
        logger.warn({ err }, 'Error parsing order card');
      }
    }

    if (datedCards > 0 && targetMonthCards === 0 && olderThanTargetCards === datedCards) {
      logger.info(
        { pageNum, targetMonth: targetPrefix, datedCards },
        'Stopping Amazon pagination: page is entirely older than target month',
      );
      break;
    }

    // ── Pagination ─────────────────────────────────────────────
    // Multilingual: ES "Siguiente", PT "Seguinte", EN "Next"
    const nextBtn = page.locator(
      '.a-pagination .a-last a, ' +
      'a[aria-label="Siguiente"], a[aria-label="Seguinte"], a[aria-label="Next"]',
    );
    const hasNext = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasNext) {
      await nextBtn.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);
      pageNum++;
    } else {
      break;
    }
  }

  logger.info({ totalOrders: orders.length, year, month }, 'Order scraping complete');
  return orders;
}

// ─── Invoice Download ───────────────────────────────────────────────

/** Represents a single downloadable invoice PDF discovered in the popover. */
interface InvoiceLink {
  label: string;   // "Invoice 1", "Fatura 2", etc.
  url: string;     // Full absolute URL to the PDF
  index: number;   // 1-based index
}

/**
 * Fetch the invoice popover for an order and extract actual invoice PDF URLs.
 *
 * Amazon's order history shows an "Invoice" / "Fatura" dropdown that loads
 * via AJAX. The popover contains:
 *   - "Printable Order Summary" → order summary page (NOT a tax invoice)
 *   - "Invoice 1" / "Fatura 1" → actual seller invoice PDF
 *   - "Invoice 2" / "Fatura 2" → another seller invoice PDF
 *   - "Request Invoice" → link to request one (no PDF)
 *
 * We use Playwright's request API to fetch the popover HTML and parse it
 * for `documents/download/UUID/invoice.pdf` links — the real invoices.
 */
async function fetchInvoiceUrls(page: Page, orderId: string): Promise<InvoiceLink[]> {
  const popoverUrl =
    `https://www.amazon.es/your-orders/invoice/popover?orderId=${orderId}`;

  try {
    const response = await page.request.get(popoverUrl, { timeout: 15000 });

    if (!response.ok()) {
      logger.warn({ orderId, status: response.status() }, 'Invoice popover request failed');
      return [];
    }

    const html = await response.text();

    // Extract all "documents/download/UUID/invoice.pdf" links
    const linkRegex = /href="([^"]*documents\/download[^"]*)"/g;
    const links: InvoiceLink[] = [];
    let match: RegExpExecArray | null;
    let idx = 1;

    while ((match = linkRegex.exec(html)) !== null) {
      let href = match[1].replace(/&amp;/g, '&');
      // Make absolute
      if (href.startsWith('/')) {
        href = `https://www.amazon.es${href}`;
      }
      links.push({ label: `Invoice ${idx}`, url: href, index: idx });
      idx++;
    }

    logger.info({ orderId, invoiceCount: links.length }, 'Fetched invoice URLs from popover');
    return links;
  } catch (err) {
    logger.warn({ err, orderId }, 'Failed to fetch invoice popover');
    return [];
  }
}

/**
 * Download an invoice PDF from a direct Amazon download URL.
 *
 * Uses Playwright's request API (shares browser context cookies)
 * to download the file as a Buffer. This avoids navigating
 * the page and triggering Playwright's download-interception.
 */
async function downloadInvoicePdf(page: Page, url: string): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await page.request.get(url, { timeout: 30000 });

      if (!response.ok()) {
        const status = response.status();
        logger.warn({ url, status, attempt }, 'Invoice PDF download failed');
        if ((status === 429 || status === 502 || status === 503 || status === 504) && attempt < 3) {
          await page.waitForTimeout(500 * attempt + Math.random() * 500);
          continue;
        }
        return null;
      }

      const contentType = response.headers()['content-type'] || '';
      const body = await response.body();

      // Verify we got a PDF (content-type or magic bytes)
      const isPdf = contentType.includes('pdf') ||
        (body.length > 4 && body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46);
      // %PDF magic bytes

      if (!isPdf) {
        logger.warn(
          { url, contentType, bodyLen: body.length },
          'Invoice download did not return a PDF',
        );
        return null;
      }

      logger.info({ url: url.substring(0, 80), sizeKB: Math.round(body.length / 1024) }, 'Invoice PDF downloaded');
      return body;
    } catch (err) {
      logger.warn({ err, url: url.substring(0, 80), attempt }, 'Failed to download invoice PDF');
      if (attempt < 3) {
        await page.waitForTimeout(500 * attempt + Math.random() * 500);
        continue;
      }
      return null;
    }
  }
  return null;
}

// ─── Main Collection Orchestrator ───────────────────────────────────

/**
 * Collect Amazon.es invoices for a given year/month.
 *
 * Called by:
 *   - Monthly cron (no interactive callbacks → 2FA fails gracefully)
 *   - Manual `/amazon [YYYY-MM]` command (with Telegram callbacks for 2FA)
 */
export async function collectAmazonInvoices(
  userId: number,
  year: number,
  month: number,
  sendTelegram?: (text: string) => Promise<void>,
  sendScreenshot?: (buffer: Buffer) => Promise<void>,
  waitForReply?: (timeoutMs: number) => Promise<string>,
): Promise<AmazonCollectionResult> {
  assertGlobalInvoiceCollectorOwnerScope('Amazon', userId);

  const startTime = Date.now();
  const OVERALL_TIMEOUT_MS = 5 * 60 * 1000; // 5-minute hard limit
  const monthFolder = `${PT_MONTHS[month]}-${year}`;

  const result: AmazonCollectionResult = {
    year,
    month,
    monthLabel: monthFolder,
    orders: [],
    totalFiled: 0,
    totalDuplicates: 0,
    totalErrors: 0,
    totalNoInvoice: 0,
    loginRequired: false,
    twoFactorRequired: false,
    durationMs: 0,
  };

  if (!isAmazonConfigured()) {
    logger.warn('Amazon collection not configured');
    result.durationMs = Date.now() - startTime;
    return result;
  }

  if (!isInvoiceFilingConfigured()) {
    logger.error('Amazon: invoice object storage not configured');
    result.durationMs = Date.now() - startTime;
    return result;
  }

  let browser: Browser | null = null;

  try {
    // Launch browser
    browser = await chromium.launch({
      headless: config.invoices.amazonHeadless,
    });

    const context = await loadOrCreateContext(browser);
    const page = await context.newPage();

    // Block unnecessary resources to speed up scraping and reduce bandwidth
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    // Check if we're already logged in
    await page.goto('https://www.amazon.es/gp/css/order-history', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    let isLoggedIn = await checkLoggedIn(page);

    if (!isLoggedIn) {
      // Need to log in
      result.loginRequired = true;
      const loginResult = await loginToAmazon(page, sendTelegram, sendScreenshot, waitForReply);

      if (!loginResult.success) {
        result.twoFactorRequired = loginResult.twoFactorRequired;
        result.durationMs = Date.now() - startTime;
        return result;
      }

      result.twoFactorRequired = loginResult.twoFactorRequired;

      // Save session after successful login
      await saveSession(context);
    }

    // Scrape orders for the target month
    if (sendTelegram) {
      await sendTelegram(`🔍 A procurar encomendas de ${monthFolder}...`);
    }

    const orders = await scrapeOrders(page, year, month);

    if (orders.length === 0) {
      logger.info({ year, month }, 'No orders found for target month');
      if (sendTelegram) await sendTelegram(`📭 Nenhuma encomenda encontrada para ${monthFolder}.`);
      await saveSession(context);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    if (sendTelegram) {
      await sendTelegram(`📦 ${orders.length} encomenda(s) encontrada(s). A descarregar faturas...`);
    }

    // Process each order — fetch invoice URLs and download actual PDFs
    for (const order of orders) {
      const orderResult: AmazonOrderResult = {
        orderId: order.orderId,
        date: order.date,
        total: order.total,
        status: 'error',
      };

      // Overall timeout guard — stop processing further orders if we're past the limit
      if (Date.now() - startTime > OVERALL_TIMEOUT_MS) {
        logger.warn({ elapsed: Date.now() - startTime, ordersProcessed: result.orders.length }, 'Amazon collection timed out');
        break;
      }

      try {
        // Check for duplicates (use orderId as the base reference)
        if (isDuplicate('Amazon.es', order.orderId, userId) || isEmailAlreadyFiled(order.orderId, userId)) {
          orderResult.status = 'duplicate';
          result.totalDuplicates++;
          result.orders.push(orderResult);
          logger.debug({ orderId: order.orderId }, 'Amazon order already filed (duplicate)');
          continue;
        }

        // Fetch the invoice popover to discover actual PDF download URLs
        const invoiceLinks = await fetchInvoiceUrls(page, order.orderId);

        if (invoiceLinks.length === 0) {
          orderResult.status = 'no_invoice';
          result.totalNoInvoice++;
          result.orders.push(orderResult);
          recordFiling({
            vendor: 'Amazon.es',
            document_date: order.date,
            invoice_number: order.orderId,
            source: 'amazon',
            source_ref: order.orderId,
            status: 'failed',
            error_message: 'No invoice PDFs found in popover',
            user_id: userId,
            tenant_id: userId,
          });
          continue;
        }

        // Download and file each invoice PDF (orders can have multiple from different sellers)
        let filedCount = 0;
        let errorCount = 0;

        for (const inv of invoiceLinks) {
          // Build a unique reference: "404-xxx-yyy_Inv1", "404-xxx-yyy_Inv2"
          const invoiceRef = invoiceLinks.length === 1
            ? order.orderId
            : `${order.orderId}_Inv${inv.index}`;

          // Check if THIS specific invoice was already filed
          if (isDuplicate('Amazon.es', invoiceRef, userId) || isEmailAlreadyFiled(invoiceRef, userId)) {
            logger.debug({ invoiceRef }, 'Invoice already filed (duplicate)');
            result.totalDuplicates++;
            continue;
          }

          const pdfBuffer = await downloadInvoicePdf(page, inv.url);

          if (!pdfBuffer) {
            logger.warn({ orderId: order.orderId, invoice: inv.label }, 'Failed to download invoice PDF');
            errorCount++;
            continue;
          }

          const filingResult = await filePdf(
            pdfBuffer,
            'Amazon.es',
            order.date,
            invoiceRef,
            `${invoiceRef}.pdf`,
            { tenantId: userId, userId, mime: 'application/pdf' },
          );

          if (filingResult.success) {
            filedCount++;
            result.totalFiled++;

            recordFiling({
              vendor: 'Amazon.es',
              amount: order.total,
              document_date: order.date,
              invoice_number: invoiceRef,
              source: 'amazon',
              source_ref: invoiceRef,
              remote_path: filingResult.filePath,
              folder_path: filingResult.folderPath,
              filename: filingResult.filename,
              file_size_bytes: pdfBuffer.length,
              object_key: filingResult.objectKey ?? null,
              checksum: filingResult.checksum ?? null,
              mime: filingResult.mime ?? 'application/pdf',
              bytes: filingResult.bytes ?? pdfBuffer.length,
              storage_backend: filingResult.storageBackend ?? null,
              status: 'filed',
              user_id: userId,
              tenant_id: userId,
            });
          } else {
            errorCount++;
            result.totalErrors++;

            recordFiling({
              vendor: 'Amazon.es',
              document_date: order.date,
              invoice_number: invoiceRef,
              source: 'amazon',
              source_ref: invoiceRef,
              status: 'failed',
              error_message: filingResult.error,
              user_id: userId,
              tenant_id: userId,
            });
          }

          // Brief pause between downloads
          await page.waitForTimeout(500 + Math.random() * 500);
        }

        // Set order result status based on outcomes
        if (filedCount > 0) {
          orderResult.status = 'filed';
        } else if (errorCount > 0) {
          orderResult.status = 'error';
          orderResult.error = `${errorCount} invoice(s) failed to download`;
        } else {
          orderResult.status = 'no_invoice';
          result.totalNoInvoice++;
        }
      } catch (err) {
        orderResult.status = 'error';
        orderResult.error = err instanceof Error ? err.message : 'Unknown error';
        result.totalErrors++;
        logger.error({ err, orderId: order.orderId }, 'Failed to process Amazon order');
      }

      result.orders.push(orderResult);

      // Rate limiting: pause between orders to avoid detection
      await page.waitForTimeout(1500 + Math.random() * 1000);
    }

    // Save session before closing
    await saveSession(context);
  } catch (err) {
    logger.error({ err }, 'Amazon collection failed');
    result.totalErrors++;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (err) { logger.warn({ err }, 'Failed to close browser'); }
    }
  }

  result.durationMs = Date.now() - startTime;

  logger.info(
    {
      year, month,
      filed: result.totalFiled,
      duplicates: result.totalDuplicates,
      errors: result.totalErrors,
      noInvoice: result.totalNoInvoice,
      durationMs: result.durationMs,
    },
    'Amazon invoice collection complete',
  );

  return result;
}

// ─── Telegram Notification Formatter ────────────────────────────────

/** Format Amazon collection results as a Portuguese Telegram notification. */
export function formatAmazonNotification(result: AmazonCollectionResult): string {
  const lines: string[] = [
    `🛒 <b>Amazon.es — ${result.monthLabel}</b>`,
    '',
  ];

  if (result.twoFactorRequired && result.totalFiled === 0 && result.orders.length === 0) {
    lines.push('⚠️ Sessão expirada e 2FA necessário.');
    lines.push(`Use <code>/amazon ${result.year}-${result.month.toString().padStart(2, '0')}</code> para recolher manualmente.`);
    return lines.join('\n');
  }

  if (result.orders.length === 0) {
    lines.push('📭 Nenhuma encomenda encontrada.');
    lines.push(`⏱ ${Math.round(result.durationMs / 1000)}s`);
    return lines.join('\n');
  }

  // Summary
  const parts: string[] = [];
  if (result.totalFiled > 0) parts.push(`✅ ${result.totalFiled} arquivada(s)`);
  if (result.totalDuplicates > 0) parts.push(`⏭ ${result.totalDuplicates} duplicada(s)`);
  if (result.totalNoInvoice > 0) parts.push(`📭 ${result.totalNoInvoice} sem fatura`);
  if (result.totalErrors > 0) parts.push(`⚠️ ${result.totalErrors} erro(s)`);
  lines.push(parts.join(' · '));
  lines.push('');

  // Order details (limit to 10 to avoid Telegram message limits)
  const displayOrders = result.orders.slice(0, 10);
  lines.push('📋 <b>Encomendas:</b>');
  for (const o of displayOrders) {
    const icon = o.status === 'filed' ? '✅' :
                 o.status === 'duplicate' ? '⏭' :
                 o.status === 'no_invoice' ? '📭' : '⚠️';
    const totalStr = o.total ? ` — ${o.total}` : '';
    lines.push(`  ${icon} ${o.orderId}${totalStr}`);
  }
  if (result.orders.length > 10) {
    lines.push(`  <i>...e mais ${result.orders.length - 10}</i>`);
  }

  lines.push('');
  if (result.loginRequired) {
    lines.push(result.twoFactorRequired ? '🔐 Login + 2FA necessário' : '🔑 Login necessário');
  }
  lines.push(`⏱ ${Math.round(result.durationMs / 1000)}s`);

  return lines.join('\n');
}
