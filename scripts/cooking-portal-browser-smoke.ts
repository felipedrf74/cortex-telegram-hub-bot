#!/usr/bin/env npx tsx

import { chromium, type Page } from 'playwright';

interface SmokeArgs {
  baseUrl: string;
  userId: number;
  tenantId: number;
  forgedTenantId: number;
  headed: boolean;
  allowModelCalls: boolean;
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const withEquals = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return withEquals?.slice(name.length + 3);
}

function readNumber(name: string, fallback: number): number {
  const raw = readArg(name) ?? process.env[`COOKING_PORTAL_SMOKE_${name.toUpperCase().replace(/-/g, '_')}`];
  const parsed = Number.parseInt(String(raw ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}; expected a positive integer`);
  }
  return parsed;
}

function parseArgs(): SmokeArgs {
  const userId = readNumber('user-id', 2);
  const tenantId = readNumber('tenant-id', userId);
  const forgedTenantId = readNumber('forged-tenant-id', tenantId + 9000);
  return {
    baseUrl: (readArg('base-url') ?? process.env.COOKING_PORTAL_SMOKE_BASE_URL ?? 'http://127.0.0.1:8200').replace(/\/+$/, ''),
    userId,
    tenantId,
    forgedTenantId,
    headed: process.argv.includes('--headed') || process.env.COOKING_PORTAL_SMOKE_HEADED === '1',
    allowModelCalls: process.argv.includes('--allow-model-calls'),
  };
}

async function visibleText(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  return (await locator.innerText()).trim();
}

async function waitForText(page: Page, selector: string, expected: RegExp, label: string): Promise<string> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(
    ({ selector: innerSelector, source, flags }) => {
      const el = document.querySelector(innerSelector);
      return !!el && new RegExp(source, flags).test(el.textContent ?? '');
    },
    { selector, source: expected.source, flags: expected.flags },
    { timeout: 10_000 },
  );
  const text = (await locator.innerText()).trim();
  if (!expected.test(text)) {
    throw new Error(`${label} did not match ${expected}; actual=${JSON.stringify(text)}`);
  }
  return text;
}

async function clickAndWaitForCookingResponses(page: Page, action: () => Promise<void>): Promise<void> {
  const preferenceResponse = page.waitForResponse(response => response.url().includes('/cooking/preferences'), { timeout: 10_000 });
  const pantryResponse = page.waitForResponse(response => response.url().includes('/cooking/pantry'), { timeout: 10_000 });
  await action();
  await Promise.all([preferenceResponse, pantryResponse]);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.allowModelCalls && process.env.NEXUS_LOCAL_ALLOW_MODEL_CALLS === '1') {
    throw new Error('Refusing to run portal smoke with NEXUS_LOCAL_ALLOW_MODEL_CALLS=1. Pass --allow-model-calls only for controlled provider sampling.');
  }

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Europe/Lisbon',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('response', response => {
    const url = response.url();
    const status = response.status();
    const isExpectedForgedTenantFailure = status === 403
      && url.includes('/cooking/')
      && url.includes(`tenantId=${args.forgedTenantId}`);
    if (status >= 400 && !isExpectedForgedTenantFailure) {
      failedRequests.push(`${status} ${url}`);
    }
  });
  page.on('requestfailed', request => {
    failedRequests.push(`request failed ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
  });

  try {
    await page.goto(`${args.baseUrl}/portal`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const loginOverlay = page.locator('#login-overlay');
    if (await loginOverlay.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await page.fill('#login-token', 'local-cooking-portal-smoke-token');
      await page.click('#login-btn');
      await loginOverlay.waitFor({ state: 'hidden', timeout: 10_000 });
    }
    await page.locator('[data-nav="cooking"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-nav="cooking"]').click();
    await page.locator('[data-section="cooking"].active').waitFor({ state: 'visible', timeout: 10_000 });

    await page.fill('#cooking-target-user-id', String(args.userId));
    await page.fill('#cooking-target-tenant-id', String(args.tenantId));
    await clickAndWaitForCookingResponses(page, () => page.click('#cooking-load-btn'));
    const initialScope = await waitForText(
      page,
      '#cooking-scope-status',
      new RegExp(`User\\s+${args.userId}\\s+·\\s+tenant\\s+${args.tenantId}`),
      'initial Cooking portal scope',
    );

    const preferenceValue = 'sesame';
    await page.selectOption('#cooking-preference-kind', 'allergy');
    await page.fill('#cooking-preference-value', preferenceValue);
    await page.locator('#cooking-preference-correction').setChecked(true);
    await clickAndWaitForCookingResponses(page, () => page.click('#cooking-save-preference-btn'));
    await waitForText(page, '#cooking-preferences-list', /allergy/, 'Cooking preference table');
    const preferenceKpi = await visibleText(page, '#cooking-kpi-preferences');

    const pantryName = `Codex smoke oats ${Date.now()}`;
    await page.fill('#cooking-pantry-name', pantryName);
    await page.fill('#cooking-pantry-quantity', '1');
    await page.fill('#cooking-pantry-unit', 'bag');
    await page.fill('#cooking-pantry-category', 'pantry');
    await page.selectOption('#cooking-pantry-freshness', 'fresh');
    await page.fill('#cooking-pantry-notes', 'portal smoke fixture');
    await clickAndWaitForCookingResponses(page, () => page.click('#cooking-save-pantry-btn'));
    await waitForText(page, '#cooking-pantry-list', new RegExp(pantryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Cooking pantry table');
    const pantryKpi = await visibleText(page, '#cooking-kpi-pantry');

    await page.fill('#cooking-target-tenant-id', String(args.forgedTenantId));
    await clickAndWaitForCookingResponses(page, () => page.click('#cooking-load-btn'));
    const forgedScope = await waitForText(page, '#cooking-scope-status', /Load failed/, 'forged tenant fail-closed state');
    await waitForText(page, '#cooking-preferences-list', /Failed to load Cooking preferences/, 'forged tenant preference failure');

    if (pageErrors.length) {
      throw new Error(`Page errors observed: ${pageErrors.join(' | ')}`);
    }
    if (failedRequests.length) {
      throw new Error(`Unexpected failed requests observed: ${failedRequests.join(' | ')}`);
    }

    console.log(JSON.stringify({
      ok: true,
      baseUrl: args.baseUrl,
      userId: args.userId,
      tenantId: args.tenantId,
      forgedTenantId: args.forgedTenantId,
      initialScope,
      preferenceKpi,
      pantryKpi,
      forgedScope,
      providerCallsAllowed: process.env.NEXUS_LOCAL_ALLOW_MODEL_CALLS === '1',
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(`Cooking portal browser smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
