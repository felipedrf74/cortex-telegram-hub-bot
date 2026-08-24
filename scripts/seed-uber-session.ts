/**
// TODO: Rename server directory ~/telegram-hub-bot → ~/nexus-hub when server dir is renamed
 * Uber Session Seeder — run locally with a visible browser to:
 * 1. Log in to Uber (solve CAPTCHA, enter OTP, etc.)
 * 2. Save the session to a JSON file
 * 3. Upload the session file to the server
 *
 * Usage:
 *   npx tsx scripts/seed-uber-session.ts
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const SESSION_PATH = process.env.UBER_SESSION_PATH || './data/uber-session.json';
const UBER_EMAIL = process.env.UBER_EMAIL || '';

async function main() {
  console.log('🚀 Launching browser (headed mode) for Uber login...');
  console.log(`   Session will be saved to: ${SESSION_PATH}`);

  const browser = await chromium.launch({
    headless: false,  // VISIBLE — so you can solve CAPTCHA
    slowMo: 100,
  });

  // Load existing session if available
  let context;
  if (fs.existsSync(SESSION_PATH)) {
    console.log('📂 Loading existing session...');
    context = await browser.newContext({
      storageState: SESSION_PATH,
      locale: 'en-US',
      timezoneId: 'Europe/Lisbon',
      viewport: { width: 1280, height: 800 },
    });
  } else {
    context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'Europe/Lisbon',
      viewport: { width: 1280, height: 800 },
    });
  }

  const page = await context.newPage();

  // Navigate to Uber Eats orders (triggers login if needed)
  console.log('🌐 Navigating to Uber Eats...');
  await page.goto('https://www.ubereats.com/pt-en/orders', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Check if we need to log in
  const url = page.url();
  if (url.includes('auth.uber.com') || url.includes('/login')) {
    console.log('🔐 Login required. Please:');
    console.log('   1. Solve any CAPTCHA/puzzle');
    console.log('   2. Enter your email and password');
    console.log('   3. Complete any 2FA/OTP');
    console.log('   4. Wait until you see the orders page');
    console.log('');
    console.log('⏳ Waiting up to 5 minutes for you to complete login...');

    // Pre-fill email if available
    if (UBER_EMAIL) {
      try {
        const emailInput = page.locator('input[name="email"], input[type="email"], #useridInput');
        if (await emailInput.first().isVisible({ timeout: 3000 }).catch(() => false)) {
          await emailInput.first().fill(UBER_EMAIL);
          console.log(`   ✅ Pre-filled email: ${UBER_EMAIL}`);
        }
      } catch { /* ignore */ }
    }

    // Wait until we're on the orders page (or 5 min timeout)
    try {
      await page.waitForURL('**/orders**', { timeout: 300_000 });
      console.log('✅ Login successful!');
    } catch {
      console.log('⚠️  Timeout waiting for orders page. Saving session anyway...');
    }
  } else if (url.includes('/orders')) {
    console.log('✅ Already logged in!');
  } else {
    console.log(`📍 Current URL: ${url}`);
    console.log('   Please navigate to the orders page manually if needed.');
    console.log('   Press Ctrl+C when done, or wait 2 minutes...');
    await page.waitForTimeout(120_000);
  }

  // Save session
  const dir = path.dirname(SESSION_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const state = await context.storageState();
  fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
  console.log(`💾 Session saved to: ${SESSION_PATH}`);

  // Also check Uber Rides
  console.log('🚗 Checking Uber Rides portal...');
  await page.goto('https://riders.uber.com/trips', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Re-save with rides cookies too
  const finalState = await context.storageState();
  fs.writeFileSync(SESSION_PATH, JSON.stringify(finalState, null, 2));
  console.log(`💾 Final session saved (includes Rides cookies)`);

  await browser.close();

  console.log('');
  console.log('📤 Next step — upload to server:');
  console.log(`   scp ${SESSION_PATH} "$DEPLOY_SERVER":~/telegram-hub-bot/${SESSION_PATH}`);
  console.log('');
  console.log('Done! 🎉');
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
