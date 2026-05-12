import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const financeCommandSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/handlers/commands/finance.ts'),
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

describe('finance browser collectors tenant safety', () => {
  it('gates Amazon collection to the owner before touching global collector state', () => {
    const block = commandBlock('amazon');

    const ownerGate = block.indexOf('isOwnerScopedCollectorUser(userId)');
    expect(ownerGate).toBeGreaterThanOrEqual(0);
    expect(ownerGate).toBeLessThan(block.indexOf('isAmazonConfigured()'));
    expect(ownerGate).toBeLessThan(block.indexOf('collectAmazonInvoices('));
    expect(block).toContain("replyGlobalCollectorOwnerOnly(ctx, 'Amazon')");
  });

  it('gates Uber collection to the owner before touching global collector state', () => {
    const block = commandBlock('uber');

    const ownerGate = block.indexOf('isOwnerScopedCollectorUser(userId)');
    expect(ownerGate).toBeGreaterThanOrEqual(0);
    expect(ownerGate).toBeLessThan(block.indexOf('isUberConfigured()'));
    expect(ownerGate).toBeLessThan(block.indexOf('collectUberInvoices('));
    expect(block).toContain("replyGlobalCollectorOwnerOnly(ctx, 'Uber')");
  });
});
