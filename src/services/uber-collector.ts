// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { chromium, BrowserContext, Page, Browser } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { filePdf, PT_MONTHS, isInvoiceFilingConfigured } from './invoice-filer';
import { recordFiling, isDuplicate } from '../state/invoice-filings';

// ─── Types ──────────────────────────────────────────────────────────

export interface UberOrder {
  orderId: string;         // Uber's order UUID or short ID
  date: string;            // ISO "2026-02-15"
  amount: string | null;   // "€12.40" or null
  portal: 'rides' | 'eats';
}

export interface UberOrderResult {
  orderId: string;
  date: string;
  amount: string | null;
  portal: 'rides' | 'eats';
  status: 'filed' | 'duplicate' | 'error' | 'no_invoice';
  error?: string;
}

export interface UberCollectionResult {
  year: number;
  month: number;
  monthLabel: string;
  orders: UberOrderResult[];
  totalFiled: number;
  totalDuplicates: number;
  totalErrors: number;
  totalNoInvoice: number;
  loginRequired: boolean;
  twoFactorRequired: boolean;
  durationMs: number;
}

// ─── Reply Waiter (own copy — no coupling to Amazon) ────────────────

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
  const existing = pendingReplies.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve('__CANCELLED__');
    pendingReplies.delete(chatId);
    logger.warn({ chatId }, 'Uber: replaced existing reply waiter');
  }
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(chatId);
      reject(new Error('Timeout: Uber 2FA code not received'));
    }, timeoutMs);
    pendingReplies.set(chatId, { resolve, timer });
  });
}

/**
 * Resolve a pending reply waiter for a chat.
 * Called from bot.ts catch-all text handler.
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

// ─── Configuration Guard ─────────────────────────────────────────────

export function isUberConfigured(): boolean {
  return (
    config.invoices.uberEnabled &&
    config.invoices.uberEmail !== '' &&
    config.invoices.uberPassword !== ''
  );
}

// ─── Browser Context Options ─────────────────────────────────────────

const CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'Europe/Lisbon',
  viewport: { width: 1280, height: 800 },
};

// ─── Session Management ──────────────────────────────────────────────

async function loadOrCreateContext(browser: Browser): Promise<BrowserContext> {
  const sessionPath = config.invoices.uberSessionPath;
  try {
    if (fs.existsSync(sessionPath)) {
      logger.info({ sessionPath }, 'Loading saved Uber session');
      return await browser.newContext({ ...CONTEXT_OPTIONS, storageState: sessionPath });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load Uber session, creating fresh context');
  }
  return await browser.newContext(CONTEXT_OPTIONS);
}

async function saveSession(context: BrowserContext): Promise<void> {
  const sessionPath = config.invoices.uberSessionPath;
  try {
    const dir = path.dirname(sessionPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await context.storageState({ path: sessionPath });
    try { fs.chmodSync(sessionPath, 0o600); } catch { /* non-critical */ }
    logger.info({ sessionPath }, 'Uber session saved');
  } catch (err) {
    logger.warn({ err }, 'Failed to save Uber session');
  }
}

// ─── Login Detection ─────────────────────────────────────────────────

const AUTH_URL_PATTERNS = ['/login', '/otp', '/challenge', '/verification'];

function isAuthPage(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname.includes('auth.uber.com')) return true;
    return AUTH_URL_PATTERNS.some((p) => pathname.includes(p));
  } catch {
    return false;
  }
}

/** Try to dismiss the Uber Eats cookie consent banner so it doesn't block clicks. */
async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    // Common cookie banner button selectors on Uber Eats
    const rejectBtn = page.locator(
      'button:has-text("Reject"), button:has-text("Decline"), ' +
      'button:has-text("Reject all"), button:has-text("Reject All"), ' +
      'button:has-text("Only essential"), button:has-text("Recusar")'
    );
    if (await rejectBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await rejectBtn.first().click();
      logger.debug('Dismissed cookie banner (reject)');
      await page.waitForTimeout(500);
      return;
    }
    // Fallback: accept if no reject option
    const acceptBtn = page.locator(
      'button:has-text("Accept"), button:has-text("Accept all"), ' +
      'button:has-text("Accept All"), button:has-text("Aceitar"), ' +
      'button:has-text("Got it"), button:has-text("OK")'
    );
    if (await acceptBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await acceptBtn.first().click();
      logger.debug('Dismissed cookie banner (accept)');
      await page.waitForTimeout(500);
    }
  } catch {
    // Not critical — continue even if banner can't be dismissed
  }
}

// ─── Login Flow ──────────────────────────────────────────────────────

async function loginToUber(
  page: Page,
  sendTelegram?: (text: string) => Promise<void>,
  sendScreenshot?: (buffer: Buffer) => Promise<void>,
  waitForReply?: (timeoutMs: number) => Promise<string>,
): Promise<{ success: boolean; twoFactorRequired: boolean }> {
  logger.info('Starting Uber login flow');
  const hasInteractive = !!(sendTelegram && sendScreenshot && waitForReply);

  try {
    // Step 1: Navigate to Uber auth
    await page.goto('https://auth.uber.com/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    logger.debug({ url: page.url() }, 'Uber login page loaded');

    // Step 2: Fill email
    const emailInput = page.locator(
      'input[name="email"], input[type="email"], [data-testid="EMAIL_PASSWORD_INPUT"]'
    );
    if (await emailInput.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await emailInput.first().fill(config.invoices.uberEmail);
      const continueBtn = page.locator(
        '[data-testid="forward-button"], button[type="submit"], button:has-text("Continue"), button:has-text("Next")'
      );
      if (await continueBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.first().click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);
    }
    logger.debug({ url: page.url() }, 'After Uber email submission');

    // Step 3: Fill password (if presented — some accounts go to OTP directly)
    const passwordInput = page.locator(
      'input[name="password"], input[type="password"]'
    );
    if (await passwordInput.isVisible({ timeout: 4000 }).catch(() => false)) {
      await passwordInput.fill(config.invoices.uberPassword);
      const submitBtn = page.locator(
        '[data-testid="forward-button"], button[type="submit"]'
      );
      if (await submitBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.first().click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);
    }
    logger.debug({ url: page.url() }, 'After Uber password submission');

    // Step 4: OTP / 2FA challenge loop
    let challengeAttempts = 0;
    const MAX_CHALLENGE_ATTEMPTS = 3;

    while (isAuthPage(page.url()) && challengeAttempts < MAX_CHALLENGE_ATTEMPTS) {
      challengeAttempts++;
      logger.info({ url: page.url(), attempt: challengeAttempts }, 'Uber auth challenge detected');

      const otpInput = page.locator(
        'input[name="verificationCode"], input[name="otp"], input[type="tel"]'
      );
      const isOtp = await otpInput.first().isVisible({ timeout: 3000 }).catch(() => false);

      if (isOtp) {
        if (!hasInteractive) {
          logger.warn('Uber 2FA required but no interactive callbacks (cron mode)');
          return { success: false, twoFactorRequired: true };
        }

        await sendTelegram!('🔐 Uber necessita código de verificação (OTP). Envie o código:');
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
        await sendScreenshot!(screenshot);

        try {
          const otp = await waitForReply!(300_000); // 5 min
          if (otp === '__CANCELLED__') {
            logger.warn('Uber 2FA reply waiter was cancelled — aborting login');
            return { success: false, twoFactorRequired: true };
          }
          await otpInput.first().fill(otp.trim());
          const submitBtn = page.locator('[data-testid="forward-button"], button[type="submit"]');
          if (await submitBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
            await submitBtn.first().click();
          } else {
            await page.keyboard.press('Enter');
          }
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(3000);
        } catch (err) {
          logger.error({ err }, 'Uber 2FA flow failed');
          return { success: false, twoFactorRequired: true };
        }
        continue;
      }

      // Unknown challenge — send screenshot for manual intervention
      if (hasInteractive) {
        logger.warn({ url: page.url() }, 'Unknown Uber auth challenge');
        await sendTelegram!('⚠️ Uber mostra uma página de verificação desconhecida:');
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
        await sendScreenshot!(screenshot);
        try {
          const hint = await waitForReply!(300_000);
          if (hint === '__CANCELLED__') {
            logger.warn('Uber challenge reply waiter was cancelled — aborting login');
            return { success: false, twoFactorRequired: true };
          }
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

    // Step 5: Verify login
    const isLoggedIn = !isAuthPage(page.url());
    if (isLoggedIn) {
      logger.info('Uber login successful');
      if (sendTelegram) await sendTelegram('✅ Login Uber com sucesso!');
    } else {
      logger.warn({ url: page.url() }, 'Uber login verification failed');
      if (hasInteractive) {
        await sendTelegram!('⚠️ Login Uber pode ter falhado:');
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
        await sendScreenshot!(screenshot);
      }
    }

    return { success: isLoggedIn, twoFactorRequired: challengeAttempts > 0 };
  } catch (err) {
    logger.error({ err }, 'Uber login flow error');
    return { success: false, twoFactorRequired: false };
  }
}

// ─── Date Parsing ────────────────────────────────────────────────────
// Uber Eats shows: "05 Mar at 20:05" (DD Mon at HH:MM) — day-first!
// Uber Rides may show: "Feb 15", "February 15, 2026", or "15/02/2026"

function parseUberDate(rawDate: string, year: number): string | null {
  if (!rawDate) return null;

  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };

  const normalize = (str: string) =>
    str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const s = rawDate.trim();

  // "05 Mar at 20:05" or "28 Feb at 22:32" (Uber Eats format — day first!)
  const eatsMatch = s.match(/(\d{1,2})\s+(\w{3,})\s+at\s+\d{1,2}:\d{2}/i);
  if (eatsMatch) {
    const m = months[eatsMatch[2].toLowerCase()] ?? months[normalize(eatsMatch[2])];
    if (m) {
      return `${year}-${m.toString().padStart(2, '0')}-${eatsMatch[1].padStart(2, '0')}`;
    }
  }

  // "February 15, 2026" or "Feb 15, 2026"
  const fullMatch = s.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (fullMatch) {
    const m = months[fullMatch[1].toLowerCase()] ?? months[normalize(fullMatch[1])];
    if (m) {
      return `${fullMatch[3]}-${m.toString().padStart(2, '0')}-${fullMatch[2].padStart(2, '0')}`;
    }
  }

  // "Feb 15" (no year — infer from context)
  const shortMatch = s.match(/(\w+)\s+(\d{1,2})$/i);
  if (shortMatch) {
    const m = months[shortMatch[1].toLowerCase()] ?? months[normalize(shortMatch[1])];
    if (m) {
      return `${year}-${m.toString().padStart(2, '0')}-${shortMatch[2].padStart(2, '0')}`;
    }
  }

  // "15/02/2026" or "15-02-2026"
  const numMatch = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (numMatch) {
    const day = parseInt(numMatch[1], 10);
    const month = parseInt(numMatch[2], 10);
    const yr = parseInt(numMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${yr}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }

  return null;
}

// ─── Receipt Download ────────────────────────────────────────────────

/** Validate that a buffer starts with the PDF magic bytes (%PDF) */
function isValidPdf(buf: Buffer): boolean {
  return buf.length > 4 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

/**
 * Download an Eats invoice by clicking "Download Invoice" on the **orders list page**.
 *
 * The Uber Eats orders page renders each order as a card containing:
 *   "View receipt" (<a href="...modctx={UUID}...">)  +  "Download Invoice" (<a>, JS-triggered)
 *
 * We locate the order card via its "View receipt" link (matching the order UUID in the
 * modctx query param), then find the sibling "Download Invoice" link in the same container
 * and click it, intercepting the browser download event.
 *
 * The caller MUST ensure the orders page is loaded with the target orders visible in the DOM
 * (see `ensureEatsOrdersLoaded()`).
 */
async function downloadEatsInvoice(page: Page, orderId: string): Promise<Buffer | null> {
  try {
    // Find the "View receipt" link for this specific order
    const receiptLink = page.locator(`a[href*="modctx=${orderId}"]`);
    if (await receiptLink.count() === 0) {
      logger.warn({ orderId }, 'Order card not found on orders page');
      return null;
    }

    // Walk up DOM levels to find a container that also has "Download Invoice"
    // The link structure is: <div>...<a>View receipt</a>...<a>Download Invoice</a>...</div>
    let downloadLink = receiptLink.locator('..').locator('a:has-text("Download Invoice")');
    if (await downloadLink.count() === 0) {
      // Try one more level up (some order cards have deeper nesting)
      downloadLink = receiptLink.locator('../..').locator('a:has-text("Download Invoice")');
    }
    if (await downloadLink.count() === 0) {
      // Last resort: XPath ancestor search
      downloadLink = receiptLink.locator(
        'xpath=ancestor::div[.//a[contains(text(),"Download Invoice")]]'
      ).first().locator('a:has-text("Download Invoice")');
    }
    if (await downloadLink.count() === 0) {
      logger.warn({ orderId }, 'No "Download Invoice" link found near order card');
      return null;
    }

    // Scroll into view and click, intercepting the download event
    await downloadLink.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      downloadLink.first().click(),
    ]);

    const downloadPath = await download.path();
    if (!downloadPath) {
      logger.warn({ orderId }, 'Download event fired but no file path returned');
      return null;
    }

    try {
      const buffer = fs.readFileSync(downloadPath);
      if (isValidPdf(buffer)) {
        logger.debug({ orderId, size: buffer.length }, 'Downloaded Eats invoice PDF from orders page');
        return buffer;
      }
      logger.warn({ orderId, size: buffer.length }, 'Downloaded file is not a valid PDF');
      return null;
    } finally {
      try { fs.unlinkSync(downloadPath); } catch { /* ignore cleanup */ }
    }
  } catch (err) {
    logger.warn({ err, orderId }, 'Failed to download Eats invoice from orders page');
    return null;
  }
}

/**
 * Navigate to the Uber Eats orders page and scroll until all target order IDs
 * are visible in the DOM (or max scroll attempts exhausted).
 */
async function ensureEatsOrdersLoaded(page: Page, orderIds: string[]): Promise<void> {
  // Navigate to orders page if not already there
  if (!page.url().includes('ubereats.com') || !page.url().includes('/orders')) {
    await page.goto('https://www.ubereats.com/pt-en/orders', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  }
  await page.waitForTimeout(3000);

  // Dismiss cookie banner if present — it overlays the page and can block clicks
  await dismissCookieBanner(page);

  const idsToFind = new Set(orderIds);
  let scrollAttempts = 0;
  const MAX_SCROLL = 30;

  while (idsToFind.size > 0 && scrollAttempts < MAX_SCROLL) {
    // Check which target orders are now visible in the DOM
    for (const id of [...idsToFind]) {
      const count = await page.locator(`a[href*="modctx=${id}"]`).count();
      if (count > 0) idsToFind.delete(id);
    }
    if (idsToFind.size === 0) break;

    scrollAttempts++;
    const prevCount = await page.locator(EATS_RECEIPT_SELECTOR).count();
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2500);

    // Click "Load more" if visible
    const loadMore = page.locator('button:has-text("Load more"), button:has-text("Show more")');
    if (await loadMore.isVisible({ timeout: 1000 }).catch(() => false)) {
      await loadMore.click();
      await page.waitForTimeout(2000);
    }

    const newCount = await page.locator(EATS_RECEIPT_SELECTOR).count();
    if (newCount <= prevCount && scrollAttempts > 3) {
      logger.debug({ remaining: idsToFind.size, scrollAttempts }, 'No new orders loaded — stopping scroll');
      break;
    }
  }

  if (idsToFind.size > 0) {
    logger.warn(
      { missingIds: [...idsToFind], scrollAttempts },
      'Some Eats order cards not found after scrolling',
    );
  }
}

/**
 * Download a Rides receipt PDF from the trip detail page.
 * Strategy:
 *   1. Look for a direct "Download Invoice" / PDF download link
 *   2. Try a "Download PDF" / "Get receipt" button that triggers a download event
 *   3. Fall back to rendering the page as PDF with page.pdf()
 *   Returns null if nothing works.
 */
async function downloadRidesReceipt(page: Page, detailUrl: string): Promise<Buffer | null> {
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Strategy 1: Direct PDF download link
    const pdfLink = page.locator(
      'a:has-text("Download Invoice"), a:has-text("Download invoice"), ' +
      'a[href*=".pdf"], a[href*="invoice"], a[href*="receipt"][href*=".pdf"]'
    );
    if (await pdfLink.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = await pdfLink.first().getAttribute('href');
      if (href) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, page.url()).href;
        const response = await page.request.get(fullUrl, { timeout: 30000 });
        if (response.ok()) {
          const body = await response.body();
          if (isValidPdf(body)) {
            logger.debug({ detailUrl }, 'Downloaded PDF via direct link');
            return body;
          }
        }
      }

      // Try clicking and intercepting download
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 10000 }),
          pdfLink.first().click(),
        ]);
        const downloadPath = await download.path();
        if (downloadPath) {
          try {
            const buffer = fs.readFileSync(downloadPath);
            if (isValidPdf(buffer)) {
              logger.debug({ detailUrl }, 'Downloaded PDF via click+download event');
              return buffer;
            }
          } finally {
            try { fs.unlinkSync(downloadPath); } catch { /* ignore */ }
          }
        }
      } catch {
        // Download event didn't fire — continue
      }
    }

    // Strategy 2: "Get receipt" / "Download PDF" button
    const downloadBtn = page.locator(
      'button:has-text("Download PDF"), a:has-text("Download PDF"), ' +
      'button:has-text("Get receipt"), a:has-text("Get receipt"), ' +
      'button:has-text("View receipt"), a:has-text("View receipt")'
    );
    if (await downloadBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          downloadBtn.first().click(),
        ]);
        const downloadPath = await download.path();
        if (downloadPath) {
          try {
            const buffer = fs.readFileSync(downloadPath);
            if (isValidPdf(buffer)) {
              logger.debug({ detailUrl }, 'Downloaded PDF via receipt button');
              return buffer;
            }
          } finally {
            try { fs.unlinkSync(downloadPath); } catch { /* ignore */ }
          }
        }
      } catch {
        // No download triggered — fall through
      }
    }

    // Strategy 3: Render the page as PDF (fallback for Rides only)
    if (isAuthPage(page.url())) {
      logger.warn({ detailUrl, url: page.url() }, 'Redirected to auth page — skipping PDF render');
      return null;
    }
    logger.debug({ detailUrl }, 'No direct PDF found — rendering page as PDF (Rides fallback)');
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    return pdfBuffer;

  } catch (err) {
    logger.warn({ err, detailUrl }, 'Failed to download Rides receipt');
    return null;
  }
}

// ─── Eats Order Scraper ──────────────────────────────────────────────
//
// Uber Eats order page DOM structure (discovered via diagnostics):
//   - "View receipt" links are <a> with href like:
//       /pt-en/orders?mod=orderReceipt&modctx={UUID}&ps=1
//   - The order UUID lives in the `modctx` query parameter
//   - Each receipt link sits inside a <div> with text like:
//       "3 items for €39.69 • 05 Mar at 20:05 • View receipt • Download Invoice"
//   - "Download Invoice" links have no href (JS-triggered)
//   - Order cards are <div> containers, NOT <a> wrapping elements

/** Selector for "View receipt" links — the anchor of each order card */
const EATS_RECEIPT_SELECTOR = 'a[href*="orderReceipt"]';

async function scrapeEatsOrders(page: Page, year: number, month: number): Promise<UberOrder[]> {
  const orders: UberOrder[] = [];
  const targetPrefix = `${year}-${month.toString().padStart(2, '0')}`;

  logger.info({ targetMonth: targetPrefix }, 'Navigating to Uber Eats order history');
  await page.goto('https://www.ubereats.com/pt-en/orders', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  // Wait for React SPA to render order cards (networkidle never fires on Uber Eats)
  await page.waitForTimeout(5000);

  // Dismiss cookie banner early so it doesn't interfere with scraping/clicks
  await dismissCookieBanner(page);

  const receiptCount = await page.locator(EATS_RECEIPT_SELECTOR).count();
  logger.info({ url: page.url(), receiptLinks: receiptCount }, 'Uber Eats page loaded');

  let reachedOlderMonth = false;
  let scrollAttempts = 0;
  const MAX_SCROLL_ATTEMPTS = 30;
  const seenIds = new Set<string>();

  while (!reachedOlderMonth && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
    scrollAttempts++;

    // "View receipt" links contain the order UUID in the modctx query param
    const receiptLinks = await page.locator(EATS_RECEIPT_SELECTOR).all();

    for (const link of receiptLinks) {
      try {
        const href = await link.getAttribute('href');
        if (!href) continue;

        // Extract UUID from ?modctx={UUID} query parameter
        const modctxMatch = href.match(/modctx=([a-f0-9-]+)/i);
        if (!modctxMatch) continue;
        const orderId = modctxMatch[1];

        // Skip already-seen IDs (infinite scroll may re-render existing cards)
        if (seenIds.has(orderId)) continue;
        seenIds.add(orderId);

        // The receipt link lives inside a container div with date + amount text
        // Walk up to the parent container to extract order info
        const parentDiv = link.locator('..');
        const cardText = await parentDiv.textContent().catch(() => '') || '';

        // Parse date from text like "05 Mar at 20:05" or "28 Feb at 22:32"
        const dateTimeMatch = cardText.match(/(\d{1,2})\s+(\w{3,})\s+at\s+\d{1,2}:\d{2}/);
        let date: string | null = null;
        if (dateTimeMatch) {
          // Build "Feb 28" format for our existing parser
          date = parseUberDate(`${dateTimeMatch[2]} ${dateTimeMatch[1]}`, year);
        }
        if (!date) {
          // Fallback: try the generic parser on the full card text
          date = parseUberDate(cardText, year);
        }
        if (!date) {
          logger.debug({ orderId, cardText: cardText.substring(0, 100) }, 'Could not parse date from Eats order');
          continue;
        }

        // Stop if we've gone past the target month
        if (date < targetPrefix + '-01') {
          reachedOlderMonth = true;
          break;
        }

        // Skip if it's a later month
        if (!date.startsWith(targetPrefix)) continue;

        // Extract amount from text like "3 items for €39.69"
        const amountMatch = cardText.match(/(?:€|EUR)\s*[\d.,]+|[\d.,]+\s*(?:€|EUR)/);
        const amount = amountMatch ? amountMatch[0].trim() : null;

        orders.push({ orderId, date, amount, portal: 'eats' });
        logger.debug({ orderId, date, amount }, 'Found Uber Eats order');
      } catch (err) {
        logger.warn({ err }, 'Error parsing Uber Eats order card');
      }
    }

    if (reachedOlderMonth) break;

    // Infinite scroll: scroll to bottom and wait for new content
    const previousLinkCount = await page.locator(EATS_RECEIPT_SELECTOR).count();
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2500);

    // Check for "Load more" button
    const loadMoreBtn = page.locator('button:has-text("Load more"), button:has-text("Show more")');
    if (await loadMoreBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await loadMoreBtn.click();
      await page.waitForTimeout(2000);
    }

    // Check if new content loaded (compare DOM counts, not seenIds)
    const newLinkCount = await page.locator(EATS_RECEIPT_SELECTOR).count();
    if (newLinkCount <= previousLinkCount && scrollAttempts > 2) break;
  }

  logger.info({ ordersFound: orders.length, year, month }, 'Uber Eats scraping complete');
  return orders;
}

// ─── Rides Scraper ────────────────────────────────────────────────────

async function scrapeRides(page: Page, year: number, month: number): Promise<UberOrder[]> {
  const trips: UberOrder[] = [];
  const targetPrefix = `${year}-${month.toString().padStart(2, '0')}`;

  logger.info({ targetMonth: targetPrefix }, 'Navigating to Uber rides history');
  await page.goto('https://riders.uber.com/trips', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(3000);

  let reachedOlderMonth = false;
  let scrollAttempts = 0;
  const MAX_SCROLL_ATTEMPTS = 30;
  const seenIds = new Set<string>();

  while (!reachedOlderMonth && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
    scrollAttempts++;

    // Trip cards — look for links to /trips/{id}
    const tripLinks = await page.locator('a[href*="/trips/"]').all();

    for (const link of tripLinks) {
      try {
        const href = await link.getAttribute('href');
        if (!href) continue;

        const tripIdMatch = href.match(/\/trips\/([^/?]+)/);
        if (!tripIdMatch) continue;
        const tripId = tripIdMatch[1];

        if (seenIds.has(tripId)) continue;
        seenIds.add(tripId);

        const cardText = await link.textContent().catch(() => '');
        const date = parseUberDate(cardText || '', year);
        if (!date) continue;

        if (date < targetPrefix + '-01') {
          reachedOlderMonth = true;
          break;
        }

        if (!date.startsWith(targetPrefix)) continue;

        const amountMatch = (cardText || '').match(/(€|EUR|£|\$)\s*[\d.,]+|[\d.,]+\s*(€|EUR)/);
        const amount = amountMatch ? amountMatch[0].trim() : null;

        trips.push({ orderId: tripId, date, amount, portal: 'rides' });
      } catch (err) {
        logger.warn({ err }, 'Error parsing Uber ride card');
      }
    }

    if (reachedOlderMonth) break;

    // Infinite scroll
    const previousLinkCount = await page.locator('a[href*="/trips/"]').count();
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);

    const newLinkCount = await page.locator('a[href*="/trips/"]').count();
    if (newLinkCount <= previousLinkCount && scrollAttempts > 2) break;
  }

  logger.info({ tripsFound: trips.length, year, month }, 'Uber rides scraping complete');
  return trips;
}

// ─── Main Collection Orchestrator ────────────────────────────────────

export async function collectUberInvoices(
  year: number,
  month: number,
  sendTelegram?: (text: string) => Promise<void>,
  sendScreenshot?: (buffer: Buffer) => Promise<void>,
  waitForReply?: (timeoutMs: number) => Promise<string>,
): Promise<UberCollectionResult> {
  const startTime = Date.now();
  const OVERALL_TIMEOUT_MS = 8 * 60 * 1000; // 8 min (two portals)
  const monthFolder = `${PT_MONTHS[month]}-${year}`;

  const result: UberCollectionResult = {
    year, month,
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

  if (!isUberConfigured()) {
    logger.warn('Uber collection not configured');
    result.durationMs = Date.now() - startTime;
    return result;
  }

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: config.invoices.uberHeadless });
    const context = await loadOrCreateContext(browser);
    const page = await context.newPage();

    // Block unnecessary resources (keep images — Uber layout depends on them)
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['font', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    // Check if existing session is still valid by navigating to orders page
    await page.goto('https://www.ubereats.com/pt-en/orders', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    let isLoggedIn = !isAuthPage(page.url());

    if (!isLoggedIn) {
      result.loginRequired = true;
      const loginResult = await loginToUber(page, sendTelegram, sendScreenshot, waitForReply);

      if (!loginResult.success) {
        result.twoFactorRequired = loginResult.twoFactorRequired;
        result.durationMs = Date.now() - startTime;
        return result;
      }

      result.twoFactorRequired = loginResult.twoFactorRequired;
      await saveSession(context);
    }

    if (sendTelegram) {
      await sendTelegram(`🔍 A procurar pedidos Uber de ${monthFolder}...`);
    }

    // Collect from configured portals
    const allOrders: UberOrder[] = [];

    if (config.invoices.uberEatsEnabled) {
      try {
        const eatsOrders = await scrapeEatsOrders(page, year, month);
        allOrders.push(...eatsOrders);
      } catch (err) {
        logger.error({ err }, 'Uber Eats scraping failed');
        if (sendTelegram) await sendTelegram('⚠️ Erro ao procurar pedidos Uber Eats.');
      }
    }

    if (config.invoices.uberRidesEnabled) {
      try {
        const rides = await scrapeRides(page, year, month);
        allOrders.push(...rides);
      } catch (err) {
        logger.error({ err }, 'Uber rides scraping failed');
        if (sendTelegram) await sendTelegram('⚠️ Erro ao procurar viagens Uber.');
      }
    }

    if (allOrders.length === 0) {
      logger.info({ year, month }, 'No Uber orders found for target month');
      if (sendTelegram) await sendTelegram(`📭 Nenhum pedido Uber encontrado para ${monthFolder}.`);
      await saveSession(context);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    if (sendTelegram) {
      await sendTelegram(`🚗 ${allOrders.length} pedido(s) encontrado(s). A descarregar faturas...`);
    }

    // Pre-flight: verify filing infrastructure is configured before downloading PDFs
    if (!isInvoiceFilingConfigured()) {
      const errMsg = '⚠️ Filing não configurado: faltam variáveis INVOICE_SSH_HOST / INVOICE_REMOTE_PATH no .env do servidor.';
      logger.error('Uber: invoice filing is NOT configured — missing INVOICE_SSH_HOST / INVOICE_REMOTE_PATH. Cannot file PDFs.');
      if (sendTelegram) await sendTelegram(errMsg);
      // Mark all orders as errors
      for (const order of allOrders) {
        result.orders.push({
          orderId: order.orderId, date: order.date, amount: order.amount,
          portal: order.portal, status: 'error', error: 'Filing not configured',
        });
        result.totalErrors++;
      }
      await saveSession(context);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Split orders by portal — eats downloads come from the orders list page,
    // rides downloads come from individual trip detail pages
    const eatsOrders = allOrders.filter(o => o.portal === 'eats');
    const ridesOrders = allOrders.filter(o => o.portal === 'rides');

    // ── Eats: download invoices from orders list page ──────────────
    if (eatsOrders.length > 0) {
      // Filter to non-duplicate eats orders so we only scroll for orders we actually need
      const eatsToProcess = eatsOrders.filter(o => !isDuplicate('Uber', o.orderId));
      const eatsDuplicates = eatsOrders.filter(o => isDuplicate('Uber', o.orderId));

      // Record duplicates immediately
      for (const dup of eatsDuplicates) {
        result.orders.push({
          orderId: dup.orderId, date: dup.date, amount: dup.amount,
          portal: dup.portal, status: 'duplicate',
        });
        result.totalDuplicates++;
      }

      if (eatsToProcess.length > 0) {
        // Load the orders page and scroll until all target order cards are visible
        await ensureEatsOrdersLoaded(page, eatsToProcess.map(o => o.orderId));

        for (const order of eatsToProcess) {
          if (Date.now() - startTime > OVERALL_TIMEOUT_MS) {
            logger.warn({ elapsed: Date.now() - startTime }, 'Uber collection timed out');
            break;
          }

          const orderResult: UberOrderResult = {
            orderId: order.orderId, date: order.date, amount: order.amount,
            portal: order.portal, status: 'error',
          };

          try {
            const pdfBuffer = await downloadEatsInvoice(page, order.orderId);

            if (!pdfBuffer) {
              orderResult.status = 'no_invoice';
              result.totalNoInvoice++;
              recordFiling({
                vendor: 'Uber', document_date: order.date,
                invoice_number: order.orderId, source: 'uber',
                source_ref: `eats:${order.orderId}`,
                status: 'failed', error_message: 'No invoice PDF downloaded',
              });
            } else {
              const filingResult = await filePdf(pdfBuffer, 'Uber', order.date, order.orderId);

              if (filingResult.success) {
                orderResult.status = 'filed';
                result.totalFiled++;
                recordFiling({
                  vendor: 'Uber', amount: order.amount,
                  document_date: order.date, invoice_number: order.orderId,
                  source: 'uber', source_ref: `eats:${order.orderId}`,
                  remote_path: filingResult.filePath, folder_path: filingResult.folderPath,
                  filename: filingResult.filename, file_size_bytes: pdfBuffer.length,
                  status: 'filed',
                });
              } else {
                orderResult.error = filingResult.error;
                result.totalErrors++;
                logger.error({ orderId: order.orderId, error: filingResult.error }, 'Failed to file Eats invoice');
                recordFiling({
                  vendor: 'Uber', document_date: order.date,
                  invoice_number: order.orderId, source: 'uber',
                  source_ref: `eats:${order.orderId}`,
                  status: 'failed', error_message: filingResult.error,
                });
              }
            }
          } catch (err) {
            orderResult.error = err instanceof Error ? err.message : 'Unknown error';
            result.totalErrors++;
            logger.error({ err, orderId: order.orderId }, 'Failed to process Eats order');
          }

          result.orders.push(orderResult);
          await page.waitForTimeout(1500 + Math.random() * 1000);
        }
      }
    }

    // ── Rides: download receipts from individual trip pages ────────
    for (const order of ridesOrders) {
      if (Date.now() - startTime > OVERALL_TIMEOUT_MS) {
        logger.warn({ elapsed: Date.now() - startTime }, 'Uber collection timed out');
        break;
      }

      const orderResult: UberOrderResult = {
        orderId: order.orderId, date: order.date, amount: order.amount,
        portal: order.portal, status: 'error',
      };

      try {
        if (isDuplicate('Uber', order.orderId)) {
          orderResult.status = 'duplicate';
          result.totalDuplicates++;
          result.orders.push(orderResult);
          continue;
        }

        const detailUrl = `https://riders.uber.com/trips/${order.orderId}`;
        const pdfBuffer = await downloadRidesReceipt(page, detailUrl);

        if (!pdfBuffer) {
          orderResult.status = 'no_invoice';
          result.totalNoInvoice++;
          recordFiling({
            vendor: 'Uber', document_date: order.date,
            invoice_number: order.orderId, source: 'uber',
            source_ref: `rides:${order.orderId}`,
            status: 'failed', error_message: 'No receipt PDF found',
          });
          result.orders.push(orderResult);
          continue;
        }

        const filingResult = await filePdf(pdfBuffer, 'Uber', order.date, order.orderId);

        if (filingResult.success) {
          orderResult.status = 'filed';
          result.totalFiled++;
          recordFiling({
            vendor: 'Uber', amount: order.amount,
            document_date: order.date, invoice_number: order.orderId,
            source: 'uber', source_ref: `rides:${order.orderId}`,
            remote_path: filingResult.filePath, folder_path: filingResult.folderPath,
            filename: filingResult.filename, file_size_bytes: pdfBuffer.length,
            status: 'filed',
          });
        } else {
          orderResult.error = filingResult.error;
          result.totalErrors++;
          logger.error({ orderId: order.orderId, error: filingResult.error }, 'Failed to file Rides receipt');
          recordFiling({
            vendor: 'Uber', document_date: order.date,
            invoice_number: order.orderId, source: 'uber',
            source_ref: `rides:${order.orderId}`,
            status: 'failed', error_message: filingResult.error,
          });
        }
      } catch (err) {
        orderResult.error = err instanceof Error ? err.message : 'Unknown error';
        result.totalErrors++;
        logger.error({ err, orderId: order.orderId }, 'Failed to process Rides order');
      }

      result.orders.push(orderResult);
      await page.waitForTimeout(1500 + Math.random() * 1000);
    }

    await saveSession(context);
  } catch (err) {
    logger.error({ err }, 'Uber collection failed');
    result.totalErrors++;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (err) { logger.warn({ err }, 'Failed to close browser'); }
    }
  }

  result.durationMs = Date.now() - startTime;
  logger.info(
    { year, month, filed: result.totalFiled, duplicates: result.totalDuplicates,
      errors: result.totalErrors, noInvoice: result.totalNoInvoice, durationMs: result.durationMs },
    'Uber invoice collection complete',
  );
  return result;
}

// ─── Telegram Notification Formatter ────────────────────────────────

export function formatUberNotification(result: UberCollectionResult): string {
  const lines: string[] = [
    `🚗 <b>Uber — ${result.monthLabel}</b>`,
    '',
  ];

  if (result.twoFactorRequired && result.totalFiled === 0 && result.orders.length === 0) {
    lines.push('⚠️ Sessão expirada e 2FA necessário.');
    lines.push(`Use <code>/uber ${result.year}-${result.month.toString().padStart(2, '0')}</code> para recolher manualmente.`);
    return lines.join('\n');
  }

  if (result.orders.length === 0) {
    lines.push('📭 Nenhum pedido encontrado.');
    lines.push(`⏱ ${Math.round(result.durationMs / 1000)}s`);
    return lines.join('\n');
  }

  const parts: string[] = [];
  if (result.totalFiled > 0) parts.push(`✅ ${result.totalFiled} arquivado(s)`);
  if (result.totalDuplicates > 0) parts.push(`⏭ ${result.totalDuplicates} duplicado(s)`);
  if (result.totalNoInvoice > 0) parts.push(`📭 ${result.totalNoInvoice} sem fatura`);
  if (result.totalErrors > 0) parts.push(`⚠️ ${result.totalErrors} erro(s)`);
  lines.push(parts.join(' · '));
  lines.push('');

  // Per-portal breakdown
  const rides = result.orders.filter((o) => o.portal === 'rides');
  const eats = result.orders.filter((o) => o.portal === 'eats');
  if (rides.length > 0) lines.push(`🚗 Rides: ${rides.filter((o) => o.status === 'filed').length}/${rides.length} arquivados`);
  if (eats.length > 0) lines.push(`🍔 Eats: ${eats.filter((o) => o.status === 'filed').length}/${eats.length} arquivados`);

  // Individual order lines (capped at 20 to avoid Telegram limit)
  const SHOW_MAX = 20;
  lines.push('');
  for (const o of result.orders.slice(0, SHOW_MAX)) {
    const icon = o.status === 'filed' ? '✅'
      : o.status === 'duplicate' ? '⏭'
      : o.status === 'no_invoice' ? '📭' : '⚠️';
    const portalTag = o.portal === 'rides' ? '🚗' : '🍔';
    const idShort = o.orderId.length > 12 ? o.orderId.slice(0, 12) + '…' : o.orderId;
    lines.push(`${icon} ${portalTag} ${idShort} — ${o.date}${o.amount ? ` — ${o.amount}` : ''}`);
  }
  if (result.orders.length > SHOW_MAX) {
    lines.push(`... e mais ${result.orders.length - SHOW_MAX}`);
  }

  lines.push('');
  lines.push(`⏱ ${Math.round(result.durationMs / 1000)}s`);
  return lines.join('\n');
}
