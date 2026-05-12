import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const financeCommandSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/handlers/commands/finance.ts'),
  'utf8',
);
const amazonCollectorSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/services/amazon-collector.ts'),
  'utf8',
);
const uberCollectorSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/services/uber-collector.ts'),
  'utf8',
);

function commandBlock(name: 'amazon' | 'uber'): string {
  const start = financeCommandSource.indexOf(`bot.command('${name}'`);
  const nextCommand = financeCommandSource.indexOf('bot.command(', start + 1);
  const callback = financeCommandSource.indexOf('bot.callbackQuery(', start + 1);
  const end = nextCommand >= 0 ? nextCommand : callback;
  expect(start, `${name} command should be registered`).toBeGreaterThanOrEqual(0);
  expect(end, `${name} command should be followed by another command or callback`).toBeGreaterThan(start);
  return financeCommandSource.slice(start, end);
}

function collectorFunctionBlock(source: string, name: 'collectAmazonInvoices' | 'collectUberInvoices'): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} should be exported`).toBeGreaterThanOrEqual(0);
  return source.slice(start);
}

describe('finance browser collectors tenant safety', () => {
  it('gates Amazon collection to the owner before touching global collector state', () => {
    const block = commandBlock('amazon');

    const ownerGate = block.indexOf('isOwnerScopedCollectorUser(userId)');
    expect(ownerGate).toBeGreaterThanOrEqual(0);
    expect(ownerGate).toBeLessThan(block.indexOf('isAmazonConfigured()'));
    expect(ownerGate).toBeLessThan(block.indexOf('collectAmazonInvoices('));
    expect(block).toContain("replyGlobalCollectorOwnerOnly(ctx, 'Amazon')");
  });

  it('enforces Amazon owner scope inside the collector service before global session/browser state', () => {
    const block = collectorFunctionBlock(amazonCollectorSource, 'collectAmazonInvoices');

    const ownerGuard = block.indexOf("assertGlobalInvoiceCollectorOwnerScope('Amazon', userId)");
    expect(ownerGuard).toBeGreaterThanOrEqual(0);
    expect(ownerGuard).toBeLessThan(block.indexOf('isAmazonConfigured()'));
    expect(ownerGuard).toBeLessThan(block.indexOf('chromium.launch('));
    expect(ownerGuard).toBeLessThan(block.indexOf('loadOrCreateContext(browser)'));
  });

  it('gates Uber collection to the owner before touching global collector state', () => {
    const block = commandBlock('uber');

    const ownerGate = block.indexOf('isOwnerScopedCollectorUser(userId)');
    expect(ownerGate).toBeGreaterThanOrEqual(0);
    expect(ownerGate).toBeLessThan(block.indexOf('isUberConfigured()'));
    expect(ownerGate).toBeLessThan(block.indexOf('collectUberInvoices('));
    expect(block).toContain("replyGlobalCollectorOwnerOnly(ctx, 'Uber')");
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
