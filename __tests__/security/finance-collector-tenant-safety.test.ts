import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const amazonCollectorSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/services/amazon-collector.ts'),
  'utf8',
);
const uberCollectorSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/services/uber-collector.ts'),
  'utf8',
);

function collectorFunctionBlock(source: string, name: 'collectAmazonInvoices' | 'collectUberInvoices'): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} should be exported`).toBeGreaterThanOrEqual(0);
  return source.slice(start);
}

describe('finance browser collectors tenant safety', () => {
  it('enforces Amazon owner scope inside the collector service before global session/browser state', () => {
    const block = collectorFunctionBlock(amazonCollectorSource, 'collectAmazonInvoices');

    const ownerGuard = block.indexOf("assertGlobalInvoiceCollectorOwnerScope('Amazon', userId)");
    expect(ownerGuard).toBeGreaterThanOrEqual(0);
    expect(ownerGuard).toBeLessThan(block.indexOf('isAmazonConfigured()'));
    expect(ownerGuard).toBeLessThan(block.indexOf('chromium.launch('));
    expect(ownerGuard).toBeLessThan(block.indexOf('loadOrCreateContext(browser)'));
  });

  it('enforces Uber owner scope inside the collector service before global session/browser state', () => {
    const block = collectorFunctionBlock(uberCollectorSource, 'collectUberInvoices');

    const ownerGuard = block.indexOf("assertGlobalInvoiceCollectorOwnerScope('Uber', userId)");
    expect(ownerGuard).toBeGreaterThanOrEqual(0);
    expect(ownerGuard).toBeLessThan(block.indexOf('isUberConfigured()'));
    expect(ownerGuard).toBeLessThan(block.indexOf('chromium.launch('));
    expect(ownerGuard).toBeLessThan(block.indexOf('loadOrCreateContext(browser)'));
  });
});
