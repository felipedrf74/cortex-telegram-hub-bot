/**
 * Tests for src/utils/telegram-templates.ts
 *
 * Validates the Telegram HTML message template system:
 * - Typography components (header, section, muted, code)
 * - Layout components (bullet, kv, divider)
 * - Stat components (stat, statRow, progress)
 * - Status components (statusBadge, statusLine)
 * - Table rendering
 * - Message builder
 * - Pre-built templates (reportHeader, summaryCard, alertBlock)
 * - HTML escaping in all components
 */

import { describe, it, expect } from 'vitest';
import {
  header, section, muted, code, link,
  bullet, kv, kvCode, divider, spacer,
  stat, statRow, progress,
  statusBadge, statusLine,
  table, buildMessage,
  reportHeader, summaryCard, alertBlock, actionFooter,
  escapeHtml,
} from '../../src/utils/telegram-templates';

describe('Typography components', () => {
  it('header wraps in bold', () => {
    expect(header('Hello')).toBe('<b>Hello</b>');
  });

  it('header with emoji prefix', () => {
    expect(header('Tasks', '📋')).toBe('📋 <b>Tasks</b>');
  });

  it('header escapes HTML', () => {
    expect(header('A & B')).toBe('<b>A &amp; B</b>');
  });

  it('section adds newline prefix', () => {
    expect(section('Overview', '📊')).toBe('\n📊 <b>Overview</b>');
  });

  it('muted wraps in italic', () => {
    expect(muted('hint text')).toBe('<i>hint text</i>');
  });

  it('code wraps in code tags', () => {
    expect(code('R$500.00')).toBe('<code>R$500.00</code>');
  });

  it('link creates anchor tag', () => {
    expect(link('Click', 'https://example.com')).toBe('<a href="https://example.com">Click</a>');
  });
});

describe('Layout components', () => {
  it('bullet with default marker', () => {
    expect(bullet('item')).toBe('  • item');
  });

  it('bullet with custom emoji', () => {
    expect(bullet('step 1', '▸')).toBe('  ▸ step 1');
  });

  it('kv formats key-value pair', () => {
    expect(kv('Status', 'Active')).toBe('  <b>Status:</b> Active');
  });

  it('kvCode formats value as code', () => {
    expect(kvCode('Amount', 'R$500')).toBe('  <b>Amount:</b> <code>R$500</code>');
  });

  it('divider returns line', () => {
    expect(divider()).toContain('━');
  });

  it('spacer returns empty string', () => {
    expect(spacer()).toBe('');
  });
});

describe('Stat components', () => {
  it('stat formats label:value', () => {
    expect(stat('Messages', 42)).toBe('Messages: <b>42</b>');
  });

  it('stat with emoji', () => {
    expect(stat('Cost', '$1.50', '💰')).toBe('💰 Cost: <b>$1.50</b>');
  });

  it('statRow joins multiple stats', () => {
    const result = statRow(
      { label: 'Sent', value: 5 },
      { label: 'Failed', value: 0 },
    );
    expect(result).toContain('Sent: <b>5</b>');
    expect(result).toContain('Failed: <b>0</b>');
    expect(result).toContain('·');
  });

  it('progress shows bar and percentage', () => {
    const result = progress(3, 5, 'steps');
    expect(result).toContain('3/5');
    expect(result).toContain('60%');
    expect(result).toContain('▓');
    expect(result).toContain('░');
    expect(result).toContain('steps');
  });

  it('progress handles zero total', () => {
    const result = progress(0, 0);
    expect(result).toContain('0/0');
    expect(result).toContain('0%');
  });
});

describe('Status components', () => {
  it('statusBadge returns correct emoji', () => {
    expect(statusBadge('ok')).toBe('✅');
    expect(statusBadge('warning')).toBe('⚠️');
    expect(statusBadge('error')).toBe('❌');
    expect(statusBadge('info')).toBe('ℹ️');
    expect(statusBadge('pending')).toBe('⏳');
  });

  it('statusLine combines badge with text', () => {
    expect(statusLine('ok', 'All tests pass')).toBe('✅ All tests pass');
  });
});

describe('Table component', () => {
  it('renders a simple table in pre block', () => {
    const result = table(
      ['Name', 'Value'],
      [['Alpha', '100'], ['Beta', '200']],
    );
    expect(result).toContain('<pre>');
    expect(result).toContain('</pre>');
    expect(result).toContain('Alpha');
    expect(result).toContain('Beta');
    expect(result).toContain('─');
  });

  it('handles empty rows', () => {
    const result = table(['Col'], []);
    expect(result).toContain('<pre>');
    expect(result).toContain('Col');
  });
});

describe('Message builder', () => {
  it('joins lines with newlines', () => {
    const msg = buildMessage(
      header('Report', '📊'),
      spacer(),
      bullet('Item 1'),
      bullet('Item 2'),
    );
    expect(msg).toContain('📊 <b>Report</b>');
    expect(msg).toContain('  • Item 1');
    expect(msg).toContain('  • Item 2');
    expect(msg.split('\n').length).toBe(4);
  });

  it('flattens nested arrays', () => {
    const msg = buildMessage(
      header('Title'),
      [bullet('A'), bullet('B')],
    );
    expect(msg.split('\n').length).toBe(3);
  });
});

describe('Pre-built templates', () => {
  it('reportHeader with title and subtitle', () => {
    const result = reportHeader('Daily Report', '📊', 'Generated at 09:00');
    expect(result).toContain('📊 <b>Daily Report</b>');
    expect(result).toContain('<i>Generated at 09:00</i>');
  });

  it('summaryCard renders section with kv pairs', () => {
    const result = summaryCard('Summary', '📋', [
      { key: 'Tasks', value: '5' },
      { key: 'Done', value: '3' },
    ]);
    expect(result).toContain('📋 <b>Summary</b>');
    expect(result).toContain('<b>Tasks:</b> 5');
    expect(result).toContain('<b>Done:</b> 3');
  });

  it('alertBlock with details', () => {
    const result = alertBlock('warning', 'Low disk space', ['90% used', 'Consider cleanup']);
    expect(result).toContain('⚠️ Low disk space');
    expect(result).toContain('90% used');
  });

  it('actionFooter joins commands', () => {
    expect(actionFooter(['/help', '/status', '/clear'])).toContain('/help · /status · /clear');
  });
});

describe('HTML safety', () => {
  it('escapes < > & in all components', () => {
    expect(header('<script>')).toContain('&lt;script&gt;');
    expect(kv('Key', 'A & B')).toContain('A &amp; B');
    expect(stat('Label', '<b>hack</b>')).toContain('&lt;b&gt;');
    expect(statusLine('ok', '<img>')).toContain('&lt;img&gt;');
  });
});
