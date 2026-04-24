import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function applyOperatorAlertsMigration(db: Database.Database): void {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../migrations/076_operator_alerts.sql'),
    'utf8',
  );
  db.exec(sql);
}

describe('operator alerts', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyOperatorAlertsMigration(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  it('creates a durable open alert', async () => {
    const { recordOperatorAlert, listOperatorAlerts } = await import('../../src/services/operator-alerts');

    const result = recordOperatorAlert({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: 'integration:google:degraded',
      title: 'Integração google degradada',
      detail: 'invalid_grant',
      metadata: { provider: 'google', failureStreak: 3 },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('created');
    const alerts = listOperatorAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: 'integration:google:degraded',
      title: 'Integração google degradada',
      detail: 'invalid_grant',
      status: 'open',
      occurrenceCount: 1,
      metadata: { provider: 'google', failureStreak: 3 },
    });
  });

  it('dedupes repeated open alerts by dedupe key', async () => {
    const { recordOperatorAlert, listOperatorAlerts } = await import('../../src/services/operator-alerts');

    recordOperatorAlert({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: 'integration:google:degraded',
      title: 'First title',
    });
    const result = recordOperatorAlert({
      severity: 'critical',
      source: 'integration_health',
      dedupeKey: 'integration:google:degraded',
      title: 'Updated title',
      detail: 'still failing',
      metadata: { failureStreak: 4 },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('updated');
    const alerts = listOperatorAlerts({ status: 'all' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'critical',
      title: 'Updated title',
      detail: 'still failing',
      occurrenceCount: 2,
      metadata: { failureStreak: 4 },
    });
  });

  it('allows a fresh open alert after the previous one is acknowledged', async () => {
    const { acknowledgeOperatorAlert, recordOperatorAlert, listOperatorAlerts } = await import('../../src/services/operator-alerts');

    const created = recordOperatorAlert({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: 'integration:outlook:degraded',
      title: 'Integração outlook degradada',
    });
    expect(created.alert?.id).toBeGreaterThan(0);
    expect(acknowledgeOperatorAlert(created.alert!.id, 'operator@nexushub.me')).toBe(true);

    const second = recordOperatorAlert({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: 'integration:outlook:degraded',
      title: 'Integração outlook degradada novamente',
    });

    expect(second.action).toBe('created');
    expect(listOperatorAlerts({ status: 'all' })).toHaveLength(2);
    expect(listOperatorAlerts({ status: 'open' })).toHaveLength(1);
    expect(listOperatorAlerts({ status: 'acknowledged' })).toHaveLength(1);
  });

  it('fails closed on invalid input', async () => {
    const { recordOperatorAlert, listOperatorAlerts } = await import('../../src/services/operator-alerts');

    const result = recordOperatorAlert({
      severity: 'warning',
      source: '',
      dedupeKey: '',
      title: '',
    });

    expect(result).toEqual({ ok: false, reason: 'validation_failed' });
    expect(listOperatorAlerts()).toEqual([]);
  });

  it('does not throw when the schema is unavailable', async () => {
    const { recordOperatorAlert } = await import('../../src/services/operator-alerts');
    testDb.exec('DROP TABLE operator_alerts');

    const result = recordOperatorAlert({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: 'integration:google:degraded',
      title: 'Integração google degradada',
    });

    expect(result).toEqual({ ok: false, reason: 'persist_failed' });
  });
});
