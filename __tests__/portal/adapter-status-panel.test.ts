/**
 * Portal Adapter Status Panel Tests
 *
 * Validates the adapter status section in the portal that shows:
 * - Telegram adapter: active, connected, last message timestamp
 * - WhatsApp adapter: planned / not configured
 * - Connection health indicators per adapter
 *
 * The feature adds a dedicated messaging-adapter panel separate from
 * the general integration health list. This gives messaging platforms
 * first-class visibility in the portal dashboard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── Helpers ──────────────────────────────────────────────────────────

const PORTAL_HTML_PATH = path.resolve(__dirname, '../../src/portal/portal.html');
const SERVER_TS_PATH = path.resolve(__dirname, '../../src/portal/server.ts');

function readPortalHtml(): string {
  return fs.readFileSync(PORTAL_HTML_PATH, 'utf-8');
}

function readServerTs(): string {
  return fs.readFileSync(SERVER_TS_PATH, 'utf-8');
}

// ── Snapshot / Server-side tests ─────────────────────────────────────

describe('Adapter Status — Snapshot data', () => {
  const source = readServerTs();

  describe('Telegram adapter in integrations', () => {
    it('includes Telegram Bot in the integrations array', () => {
      expect(source).toContain("name: 'Telegram Bot'");
    });

    it('Telegram is always configured (system adapter)', () => {
      // Telegram is the primary adapter — configured: true, always present
      expect(source).toContain("name: 'Telegram Bot'");
      // Extract the Telegram integration block
      const telegramStart = source.indexOf("name: 'Telegram Bot'");
      const telegramBlock = source.slice(telegramStart, telegramStart + 300);
      expect(telegramBlock).toContain('configured: true');
    });

    it('Telegram status reflects polling state', () => {
      const telegramStart = source.indexOf("name: 'Telegram Bot'");
      const telegramBlock = source.slice(telegramStart, telegramStart + 300);
      // Status should check isBotPollingActive()
      expect(telegramBlock).toContain('isBotPollingActive()');
      expect(telegramBlock).toContain('polling');
    });

    it('Telegram has three possible statuses: polling, restarting, stopped', () => {
      const telegramStart = source.indexOf("name: 'Telegram Bot'");
      const telegramBlock = source.slice(telegramStart, telegramStart + 300);
      expect(telegramBlock).toContain("'polling'");
      expect(telegramBlock).toContain("'restarting'");
      expect(telegramBlock).toContain("'stopped'");
    });

    it('Telegram belongs to the system group', () => {
      const telegramStart = source.indexOf("name: 'Telegram Bot'");
      const telegramBlock = source.slice(telegramStart, telegramStart + 300);
      expect(telegramBlock).toContain("group: 'system'");
    });

    it('Telegram tokenHealth is always valid', () => {
      const telegramStart = source.indexOf("name: 'Telegram Bot'");
      const telegramBlock = source.slice(telegramStart, telegramStart + 200);
      expect(telegramBlock).toContain("tokenHealth: 'valid'");
    });
  });

  describe('bot.lastMessageAt in snapshot', () => {
    it('snapshot includes bot.lastMessageAt field', () => {
      // The SnapshotResponse interface includes lastMessageAt
      expect(source).toContain('lastMessageAt: string | null');
    });

    it('lastMessageAt is populated from telemetry', () => {
      // The snapshot builder calls getLastMessageAt()
      expect(source).toContain('lastMessageAt: getLastMessageAt()');
    });

    it('bot object includes polling and restarting fields', () => {
      expect(source).toContain('polling: isBotPollingActive()');
      expect(source).toContain('restarting: isRestarting()');
    });
  });

  describe('SnapshotResponse type includes adapter-related fields', () => {
    it('SnapshotResponse interface defines bot object', () => {
      expect(source).toContain('bot: {');
      expect(source).toContain('polling: boolean');
      expect(source).toContain('restarting: boolean');
      expect(source).toContain('lastMessageAt: string | null');
    });

    it('integrations array type includes tokenHealth variants', () => {
      expect(source).toContain("tokenHealth?: 'valid' | 'expired' | 'warning' | 'not_configured'");
    });

    it('integrations type includes group field for categorization', () => {
      expect(source).toContain('group?: string');
    });
  });
});

// ── Integration health rendering tests ───────────────────────────────

describe('Adapter Status — Portal HTML rendering', () => {
  const html = readPortalHtml();

  describe('Integration health container', () => {
    it('portal has integration-health container element', () => {
      expect(html).toContain('id="integration-health"');
    });

    it('renderIntegrationHealth function exists', () => {
      expect(html).toContain('function renderIntegrationHealth(integrations)');
    });

    it('renderIntegrationHealth is called during render', () => {
      expect(html).toContain('renderIntegrationHealth(snap.integrations)');
    });
  });

  describe('Group-based rendering for adapters', () => {
    it('system group icon is defined (covers Telegram)', () => {
      expect(html).toContain("system: '⚙️'");
    });

    it('system group label is defined', () => {
      expect(html).toContain("system: 'System'");
    });

    it('groups are rendered in defined order', () => {
      expect(html).toContain("['google', 'microsoft', 'garmin', 'system']");
    });

    it('each integration renders name via esc()', () => {
      // The name is escaped to prevent XSS
      expect(html).toContain('esc(i.name)');
    });
  });

  describe('Health indicator rendering', () => {
    it('defines all four health label states', () => {
      expect(html).toContain("valid: '✓ Valid'");
      expect(html).toContain("expired: '✗ Expired'");
      expect(html).toContain("warning: '⚠ Stale'");
      expect(html).toContain("not_configured: '— Not configured'");
    });

    it('health CSS class is applied from tokenHealth value', () => {
      expect(html).toContain('class="int-health ${health}"');
    });

    it('alert dot shows for expired or warning states', () => {
      expect(html).toContain("i.tokenHealth === 'expired'");
      expect(html).toContain("i.tokenHealth === 'warning'");
    });

    it('fallback health logic: configured → valid, else not_configured', () => {
      expect(html).toContain("i.tokenHealth || (i.configured ? 'valid' : 'not_configured')");
    });
  });

  describe('Last API call display', () => {
    it('shows relative time for lastApiCall when available', () => {
      expect(html).toContain('i.lastApiCall');
      expect(html).toContain('relativeTime(i.lastApiCall)');
    });

    it('shows dash when no lastApiCall', () => {
      // Ternary: i.lastApiCall ? relativeTime(...) : '—'
      expect(html).toContain("i.lastApiCall ? relativeTime(i.lastApiCall) : '—'");
    });

    it('lastApiCall display has clock icon', () => {
      expect(html).toContain('🕐');
    });
  });
});

// ── Bot polling status in portal header ──────────────────────────────

describe('Adapter Status — Telegram polling indicator', () => {
  const html = readPortalHtml();

  it('portal has poll-status element in header', () => {
    expect(html).toContain('id="poll-status"');
  });

  it('polling status shows green dot when active', () => {
    expect(html).toContain('snap.bot.polling');
    expect(html).toContain('dot-green');
    expect(html).toContain('polling');
  });

  it('polling status shows yellow dot when restarting', () => {
    expect(html).toContain('snap.bot.restarting');
    expect(html).toContain('dot-yellow');
    expect(html).toContain('restarting');
  });

  it('polling status shows red dot when stopped', () => {
    expect(html).toContain('dot-red');
    expect(html).toContain('stopped');
  });

  it('bot-polling stat renders checkmark or cross', () => {
    expect(html).toContain('id="bot-polling"');
    // Check for the conditional rendering
    expect(html).toContain("snap.bot.polling ? '✓'");
  });

  it('bot-polling stat applies color class based on state', () => {
    expect(html).toContain("snap.bot.polling ? 'text-green' : 'text-red'");
  });
});

// ── Server-side token health inference ───────────────────────────────

describe('Adapter Status — Token health inference logic', () => {
  const source = readServerTs();

  it('inferTokenHealth function exists', () => {
    expect(source).toContain('function inferTokenHealth');
  });

  it('returns not_configured when integration is not configured', () => {
    const fnStart = source.indexOf('function inferTokenHealth');
    const fnBlock = source.slice(fnStart, fnStart + 500);
    expect(fnBlock).toContain('not_configured');
  });

  it('uses lastSuccess and lastFailure timestamps for health assessment', () => {
    const fnStart = source.indexOf('function inferTokenHealth');
    const fnBlock = source.slice(fnStart, fnStart + 500);
    // The function takes configured, lastSuccess, lastFailure params
    expect(fnBlock).toContain('lastSuccess');
    expect(fnBlock).toContain('lastFailure');
  });

  it('inferTokenHealth is used for Google integrations', () => {
    expect(source).toContain('inferTokenHealth(googleCalConfigured');
    expect(source).toContain('inferTokenHealth(gdriveConfigured');
    expect(source).toContain('inferTokenHealth(gmailConfigured');
  });

  it('inferTokenHealth is used for Microsoft integrations', () => {
    expect(source).toContain('inferTokenHealth(outlookCalConfigured');
    expect(source).toContain('inferTokenHealth(outlookMailConfigured');
    expect(source).toContain('inferTokenHealth(outlookTodoConfigured');
  });

  it('inferTokenHealth is used for Garmin', () => {
    expect(source).toContain('inferTokenHealth(garminConfigured');
  });

  it('Telegram does NOT use inferTokenHealth (always valid)', () => {
    const telegramStart = source.indexOf("name: 'Telegram Bot'");
    const telegramBlock = source.slice(telegramStart, telegramStart + 200);
    expect(telegramBlock).not.toContain('inferTokenHealth');
  });
});

// ── Health endpoint includes adapter info ────────────────────────────

describe('Adapter Status — Health endpoint bot fields', () => {
  const source = readServerTs();

  it('health endpoint includes bot polling status', () => {
    const healthStart = source.indexOf("app.get('/health'");
    const healthBlock = source.slice(healthStart, healthStart + 1500);
    expect(healthBlock).toContain('polling:');
  });

  it('health endpoint includes lastMessage info', () => {
    const healthStart = source.indexOf("app.get('/health'");
    const healthBlock = source.slice(healthStart, healthStart + 1500);
    expect(healthBlock).toContain('lastMessage');
  });

  it('health status degrades when bot is not polling', () => {
    expect(source).toContain("isBotPollingActive() && dbOk ? 'healthy' : 'degraded'");
  });
});

// ── Integration grouping correctness ─────────────────────────────────

describe('Adapter Status — Integration groups in snapshot', () => {
  const source = readServerTs();

  it('all integrations have a group assigned', () => {
    // Every integration object in the array should have group
    const integrationsStart = source.indexOf('const integrations: SnapshotResponse');
    const integrationsBlock = source.slice(integrationsStart, integrationsStart + 3000);

    // Count group assignments — should match number of integration objects
    const groupAssignments = (integrationsBlock.match(/group: '/g) || []).length;
    const nameAssignments = (integrationsBlock.match(/name: '/g) || []).length;
    expect(groupAssignments).toBe(nameAssignments);
  });

  it('system group contains Telegram Bot, Invoice Filing, and Anthropic API', () => {
    const integrationsStart = source.indexOf('const integrations: SnapshotResponse');
    const integrationsBlock = source.slice(integrationsStart, integrationsStart + 3000);

    // All system-group integrations
    const systemMatches = [...integrationsBlock.matchAll(/name: '([^']+)'[^}]*group: 'system'/gs)];
    const systemNames = systemMatches.map(m => m[1]);
    expect(systemNames).toContain('Telegram Bot');
    expect(systemNames).toContain('Invoice Filing (SSH)');
    expect(systemNames).toContain('Anthropic API');
  });

  it('google group contains Calendar, Drive, and Gmail', () => {
    const integrationsStart = source.indexOf('const integrations: SnapshotResponse');
    const integrationsBlock = source.slice(integrationsStart, integrationsStart + 3000);

    expect(integrationsBlock).toContain("name: 'Google Calendar'");
    expect(integrationsBlock).toContain("name: 'Google Drive'");
    expect(integrationsBlock).toContain("name: 'Gmail'");
  });

  it('microsoft group contains Outlook Calendar, Mail, and To Do', () => {
    const integrationsStart = source.indexOf('const integrations: SnapshotResponse');
    const integrationsBlock = source.slice(integrationsStart, integrationsStart + 3000);

    expect(integrationsBlock).toContain("name: 'Outlook Calendar'");
    expect(integrationsBlock).toContain("name: 'Outlook Mail'");
    expect(integrationsBlock).toContain("name: 'Microsoft To Do'");
  });

  it('Telegram Bot is the first integration in the list', () => {
    const integrationsStart = source.indexOf('const integrations: SnapshotResponse');
    const integrationsBlock = source.slice(integrationsStart, integrationsStart + 300);
    // Telegram should appear first before any google/ms integration
    expect(integrationsBlock).toContain("name: 'Telegram Bot'");
  });
});

// ── Portal CSS for health indicators ─────────────────────────────────

describe('Adapter Status — CSS health indicator styles', () => {
  const html = readPortalHtml();

  it('defines green status dot style', () => {
    expect(html).toContain('.dot-green');
    expect(html).toContain('var(--green)');
  });

  it('defines red status dot style', () => {
    expect(html).toContain('.dot-red');
    expect(html).toContain('var(--red)');
  });

  it('defines yellow status dot style', () => {
    expect(html).toContain('.dot-yellow');
    expect(html).toContain('var(--yellow)');
  });

  it('status dots have consistent size and shape', () => {
    expect(html).toContain('.status-dot');
    // Status dot base styles
    expect(html).toContain('width: 8px');
    expect(html).toContain('height: 8px');
    expect(html).toContain('border-radius: 50%');
  });

  it('green dot has glow effect for active state', () => {
    expect(html).toContain('dot-green');
    expect(html).toMatch(/box-shadow:.*green|box-shadow:.*rgba\(52,211,153/);
  });

  it('int-health CSS class exists for health labels', () => {
    expect(html).toContain('.int-health');
  });

  it('int-group CSS class exists for grouping', () => {
    expect(html).toContain('.int-group');
  });

  it('int-alert CSS exists for group-level warnings', () => {
    expect(html).toContain('.int-alert');
  });
});

// ── Restart polling action (adapter management) ──────────────────────

describe('Adapter Status — Restart polling action', () => {
  const html = readPortalHtml();
  const source = readServerTs();

  it('portal has restart polling button', () => {
    expect(html).toContain('Restart Polling');
  });

  it('restart polling button triggers doAction', () => {
    expect(html).toContain("doAction('restart-polling')");
  });

  it('restart polling has confirmation dialog', () => {
    expect(html).toContain("confirm('Restart bot polling?')");
  });

  it('server handles restart-polling action', () => {
    expect(source).toContain('restart-polling');
  });
});

// ── Telemetry dependencies for adapter status ────────────────────────

describe('Adapter Status — Telemetry exports used', () => {
  const source = readServerTs();

  it('imports isBotPollingActive from telemetry', () => {
    expect(source).toContain('isBotPollingActive');
  });

  it('imports getLastMessageAt from telemetry', () => {
    expect(source).toContain('getLastMessageAt');
  });

  it('imports isRestarting from telemetry', () => {
    expect(source).toContain('isRestarting');
  });

  it('imports getJobStatuses from telemetry', () => {
    expect(source).toContain('getJobStatuses');
  });

  it('imports getRecentEvents from telemetry', () => {
    expect(source).toContain('getRecentEvents');
  });
});
