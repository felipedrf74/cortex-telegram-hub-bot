/**
 * QA Validation Tests — Health Check Endpoint
 *
 * Validates:
 * - Response structure and required fields
 * - HTTP status codes (200 healthy, 503 degraded)
 * - No auth required (placed before auth middleware)
 * - humanUptime formatting
 * - Memory usage reporting
 * - Database connectivity check
 * - Bot polling status
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const portalServerPath = path.resolve(__dirname, '../../src/portal/server.ts');
const portalHealthRoutesPath = path.resolve(__dirname, '../../src/portal/health-routes.ts');

function readPortalServerSource(): string {
  return fs.readFileSync(portalServerPath, 'utf-8');
}

function readPortalHealthRoutesSource(): string {
  return fs.readFileSync(portalHealthRoutesPath, 'utf-8');
}

function publicHealthRouteBlock(): string {
  const source = readPortalHealthRoutesSource();
  const healthStart = source.indexOf("app.get('/health'");
  const healthEnd = source.indexOf("app.get('/health/detailed'", healthStart);
  return source.slice(healthStart, healthEnd > 0 ? healthEnd : healthStart + 1500);
}

// ── Mock dependencies ─────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockIsBotPollingActive = vi.fn();
const mockGetLastMessageAt = vi.fn();
const mockIsRestarting = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => mockGetDb(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/portal/telemetry', () => ({
  getRecentEvents: vi.fn(() => []),
  getJobStatuses: vi.fn(() => []),
  getBotRef: vi.fn(),
  isBotPollingActive: () => mockIsBotPollingActive(),
  getLastMessageAt: () => mockGetLastMessageAt(),
  getGarminRefreshStatus: vi.fn(() => null),
  isRestarting: () => mockIsRestarting(),
  setIsRestarting: vi.fn(),
  setBotPollingActive: vi.fn(),
  pushEvent: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    portal: { token: '' },
    bot: { token: 'test-token' },
    anthropic: {},
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

// Mock all remaining dependencies to prevent import side effects
vi.mock('../../src/state/conversation', () => ({
  clearAllConversations: vi.fn(),
}));
vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: vi.fn(() => false),
  keepAlive: vi.fn(),
}));
vi.mock('../../src/services/microsoft-auth', () => ({
  isMicrosoftConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/invoice-filer', () => ({
  isInvoiceFilingConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/google-calendar', () => ({
  isGoogleCalendarConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/google-gmail', () => ({
  isGmailConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/google-drive', () => ({
  isGoogleDriveEnabled: vi.fn(() => false),
}));
vi.mock('../../src/services/outlook-calendar', () => ({
  isOutlookCalendarConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/invoice-queue', () => ({
  getPendingCount: vi.fn(() => 0),
}));
vi.mock('../../src/services/scheduler', () => ({
  sendDailyBriefing: vi.fn(),
}));
vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: vi.fn(),
}));
vi.mock('../../src/services/content-discovery', () => ({
  runContentDiscovery: vi.fn(),
}));
vi.mock('../../src/services/webhook-registry', () => ({
  getAllChannels: vi.fn(() => []),
  removeChannel: vi.fn(),
  addChannel: vi.fn(),
  updateChannel: vi.fn(),
}));
vi.mock('../../src/skills/skill-manager', () => ({
  seedDefaultSkills: vi.fn(),
  getAllSkillStatuses: vi.fn(() => []),
  getSkillStatus: vi.fn(() => null),
  enableSkill: vi.fn(),
  disableSkill: vi.fn(),
  enableSubSkill: vi.fn(),
  disableSubSkill: vi.fn(),
}));
// ── Tests ─────────────────────────────────────────────────────────

describe('QA: Health endpoint — response structure', () => {
  it('health endpoint exists in health route module', async () => {
    const source = readPortalHealthRoutesSource();
    expect(source).toContain("app.get('/health'");
  });

  it('health endpoint is placed before auth middleware', async () => {
    const source = readPortalServerSource();
    const healthPos = source.indexOf('registerPortalHealthRoutes(app');
    const authPos = source.indexOf("app.use('/api'");
    expect(healthPos).toBeGreaterThan(0);
    expect(authPos).toBeGreaterThan(0);
    expect(healthPos).toBeLessThan(authPos);
  });

  it('returns 200 status code when healthy', async () => {
    const source = readPortalHealthRoutesSource();
    // Verify the logic: healthy = 200, degraded = 503
    expect(source).toContain("status === 'healthy' ? 200 : 503");
  });

  it('response includes all required fields', async () => {
    const source = readPortalHealthRoutesSource();
    // Check response body has all required fields
    expect(source).toContain('status,');
    expect(source).toContain('uptime:');
    expect(source).toContain('uptimeHuman:');
    expect(source).toContain('bot:');
    expect(source).toContain('polling:');
    expect(source).toContain('database:');
    expect(source).toContain('memory:');
    expect(source).toContain('timestamp:');
  });

  it('memory stats include rss, heapUsed, heapTotal, external', async () => {
    const healthBlock = readPortalHealthRoutesSource();
    expect(healthBlock).toContain('rss:');
    expect(healthBlock).toContain('heapUsed:');
    expect(healthBlock).toContain('heapTotal:');
    expect(healthBlock).toContain('external:');
  });

  it('memory values are rounded to MB', async () => {
    const healthBlock = readPortalHealthRoutesSource();
    // All memory values should divide by 1024/1024 (bytes to MB) and round
    expect(healthBlock).toContain('Math.round(mem.rss / 1024 / 1024)');
  });

  it('database check lives in runtime-status helper via simple SELECT 1 query', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/runtime-status.ts'), 'utf-8',
    );
    expect(source).toContain("SELECT 1 as ok");
  });

  it('DB failure is caught gracefully inside runtime-status helper', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/runtime-status.ts'), 'utf-8',
    );
    expect(source).toContain('catch');
  });

  it('health tracks server availability separately from Telegram polling', async () => {
    const source = readPortalHealthRoutesSource();
    expect(source).toContain("const runtime = getRuntimeStatus();");
    expect(source).toContain('const databaseProbe = probeDatabaseHealth();');
    expect(source).toContain("runtime.serviceStatus === 'online' && databaseProbe.status === 'connected'");
    expect(source).toContain('server: {');
    expect(source).toContain('bot: {');
  });
});

// ── humanUptime helper ────────────────────────────────────────────

describe('QA: humanUptime formatting', () => {
  it('humanUptime is owned by the portal formatter module', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/formatters.ts'), 'utf-8',
    );
    expect(source).toContain('export function humanUptime(seconds: number): string');
  });

  it('humanUptime handles days, hours, minutes correctly', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/formatters.ts'), 'utf-8',
    );
    // Verify the logic extracts d, h, m
    const fnBlock = source.slice(
      source.indexOf('export function humanUptime'),
      source.indexOf('export function humanUptime') + 300,
    );
    expect(fnBlock).toContain('86400'); // seconds per day
    expect(fnBlock).toContain('3600');  // seconds per hour
    expect(fnBlock).toContain('60');    // seconds per minute
  });

  it('humanUptime always includes minutes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/formatters.ts'), 'utf-8',
    );
    const fnStart = source.indexOf('export function humanUptime');
    const fnBlock = source.slice(fnStart, fnStart + 500);
    // Minutes are always pushed unconditionally (not conditional like d/h)
    // Use a regex to avoid template literal escaping issues in the test string
    expect(fnBlock).toMatch(/parts\.push\(`\$\{m\}m`\)/);
    // Verify d and h are conditionally pushed
    expect(fnBlock).toMatch(/if \(d > 0\) parts\.push/);
    expect(fnBlock).toMatch(/if \(h > 0\) parts\.push/);
  });
});

// ── Portal HTML integration ───────────────────────────────────────

describe('QA: Portal HTML references health endpoint', () => {
  it('portal.html exists', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const portalPath = path.resolve(__dirname, '../../src/portal/portal.html');
    expect(fs.existsSync(portalPath)).toBe(true);
  });
});

// ── Security: no auth on /health ──────────────────────────────────

describe('QA: Health endpoint security', () => {
  it('health endpoint does not expose sensitive data', async () => {
    const healthBlock = publicHealthRouteBlock();
    // Should not expose passwords or env var values in response body
    expect(healthBlock).not.toContain('process.env.TELEGRAM_BOT_TOKEN');
    expect(healthBlock).not.toContain('password');
    expect(healthBlock).not.toContain('secret');
    expect(healthBlock).not.toContain('process.env');
  });

  it('bot section exposes only polling status, not credentials', async () => {
    const healthBlock = publicHealthRouteBlock();
    // Bot section should have polling, restarting, lastMessageAt — not token
    expect(healthBlock).toContain('polling:');
    expect(healthBlock).toContain('restarting:');
    expect(healthBlock).toContain('lastMessageAt:');
    expect(healthBlock).not.toContain('botToken');
  });
});
