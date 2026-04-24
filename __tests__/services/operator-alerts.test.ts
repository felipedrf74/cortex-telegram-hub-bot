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
  for (const file of ['076_operator_alerts.sql', '077_operator_alert_delivery.sql']) {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations', file),
      'utf8',
    );
    db.exec(sql);
  }
}

describe('operator alerts', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyOperatorAlertsMigration(testDb);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const mod = await import('../../src/services/operator-alerts');
    mod._setOperatorAlertDeliverySenderForTests(null);
    mod._setOperatorAlertDeliveryConfigForTests(null);
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
      deliveryStatus: 'pending',
      occurrenceCount: 1,
      metadata: { provider: 'google', failureStreak: 3 },
      owner: 'ops',
      suspectedArea: 'integration_health',
      userImpact: 'Integração google degradada',
      runbookUrl: 'docs/OBSERVABILITY-ONCALL.md',
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

  it('delivers due alerts through the configured sender', async () => {
    const {
      _setOperatorAlertDeliverySenderForTests,
      processDueOperatorAlertDeliveries,
      recordOperatorAlert,
      listOperatorAlerts,
    } = await import('../../src/services/operator-alerts');
    const sender = vi.fn().mockResolvedValue({ ok: true, statusCode: 202, detail: 'accepted' });
    _setOperatorAlertDeliverySenderForTests(sender);

    const created = recordOperatorAlert({
      severity: 'critical',
      source: 'scheduler',
      dedupeKey: 'job:task_sync:failed',
      title: 'Task Provider Sync failed',
      owner: 'ops',
      suspectedArea: 'integration_sync',
      userImpact: 'Task data may be stale.',
      runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#scheduled-job-failures',
    });

    const results = await processDueOperatorAlertDeliveries();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, status: 'delivered' });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({
      id: created.alert?.id,
      title: 'Task Provider Sync failed',
      suspectedArea: 'integration_sync',
      userImpact: 'Task data may be stale.',
    }));
    expect(listOperatorAlerts()[0]).toMatchObject({
      deliveryStatus: 'delivered',
      deliveryAttemptCount: 1,
      lastDeliveryError: null,
    });
    _setOperatorAlertDeliverySenderForTests(null);
  });

  it('retries failed delivery attempts before dead-lettering', async () => {
    const {
      _setOperatorAlertDeliveryConfigForTests,
      _setOperatorAlertDeliverySenderForTests,
      deliverOperatorAlert,
      recordOperatorAlert,
      retryOperatorAlertDelivery,
      listOperatorAlerts,
    } = await import('../../src/services/operator-alerts');
    _setOperatorAlertDeliveryConfigForTests({ maxAttempts: 2, retryBaseMs: 1 });
    _setOperatorAlertDeliverySenderForTests(vi.fn().mockResolvedValue({ ok: false, statusCode: 503, detail: 'pager unavailable' }));

    const created = recordOperatorAlert({
      severity: 'critical',
      source: 'error_monitor:api',
      dedupeKey: 'error:api:boom',
      title: 'ERROR in api',
    });
    const id = created.alert!.id;

    const first = await deliverOperatorAlert(id);
    expect(first).toMatchObject({ ok: false, status: 'failed', reason: 'delivery_failed' });
    expect(first.nextAttemptAt).toBeTruthy();

    expect(retryOperatorAlertDelivery(id)).toBe(true);
    const second = await deliverOperatorAlert(id);
    expect(second).toMatchObject({ ok: false, status: 'dead_letter', reason: 'delivery_failed' });

    const alert = listOperatorAlerts()[0];
    expect(alert.deliveryStatus).toBe('dead_letter');
    expect(alert.deliveryAttemptCount).toBe(2);
    expect(alert.deadLetteredAt).toBeTruthy();

    _setOperatorAlertDeliverySenderForTests(null);
    _setOperatorAlertDeliveryConfigForTests(null);
  });

  it('marks delivery as not configured when no on-call webhook is present', async () => {
    const {
      _setOperatorAlertDeliverySenderForTests,
      deliverOperatorAlert,
      recordOperatorAlert,
      listOperatorAlerts,
    } = await import('../../src/services/operator-alerts');
    _setOperatorAlertDeliverySenderForTests(null);
    const previousUrl = process.env.OPERATOR_ALERT_WEBHOOK_URL;
    delete process.env.OPERATOR_ALERT_WEBHOOK_URL;

    const created = recordOperatorAlert({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: 'integration:outlook:degraded',
      title: 'Outlook degraded',
    });

    const result = await deliverOperatorAlert(created.alert!.id);

    expect(result).toMatchObject({ ok: false, status: 'not_configured', reason: 'not_configured' });
    expect(listOperatorAlerts()[0]).toMatchObject({
      deliveryStatus: 'not_configured',
      lastDeliveryError: 'OPERATOR_ALERT_WEBHOOK_URL not configured',
    });

    if (previousUrl) process.env.OPERATOR_ALERT_WEBHOOK_URL = previousUrl;
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

  it('tracks acknowledgement and resolution as a durable lifecycle', async () => {
    const {
      acknowledgeOperatorAlert,
      recordOperatorAlert,
      resolveOperatorAlert,
      listOperatorAlerts,
    } = await import('../../src/services/operator-alerts');

    const created = recordOperatorAlert({
      severity: 'critical',
      source: 'api_degraded_response',
      dedupeKey: 'api_degraded:INTERNAL:500',
      title: 'Backend degraded API response',
    });
    const id = created.alert!.id;

    expect(acknowledgeOperatorAlert(id, 'operator@nexushub.me')).toBe(true);
    expect(listOperatorAlerts({ status: 'acknowledged' })[0]).toMatchObject({
      id,
      status: 'acknowledged',
      acknowledgedBy: 'operator@nexushub.me',
    });

    expect(resolveOperatorAlert(id, 'operator@nexushub.me')).toBe(true);
    expect(listOperatorAlerts({ status: 'resolved' })[0]).toMatchObject({
      id,
      status: 'resolved',
      acknowledgedBy: 'operator@nexushub.me',
    });
    expect(listOperatorAlerts({ status: 'open' })).toEqual([]);
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
