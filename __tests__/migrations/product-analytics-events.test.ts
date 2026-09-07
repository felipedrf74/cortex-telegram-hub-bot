import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('migration 317 product analytics events', () => {
  it('creates the locked event table and rejects unknown event names', () => {
    const db = createMigratedTestDatabase();
    const columns = (db.prepare("PRAGMA table_info('product_analytics_events')").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'event_id',
      'user_id',
      'tenant_id',
      'event_name',
      'properties_json',
      'source',
      'idempotency_key',
      'created_at',
    ]));
    expect(() => db.prepare(`
      INSERT INTO product_analytics_events (event_id, user_id, tenant_id, event_name, properties_json)
      VALUES ('e1', 1, 1, 'session_start', '{}')
    `).run()).toThrow();
    db.prepare(`
      INSERT INTO product_analytics_events (event_id, user_id, tenant_id, event_name, properties_json)
      VALUES ('e2', 1, 1, 'app_open', '{"surface":"ios"}')
    `).run();
    db.close();
  });

  it('rolls back through the down migration', () => {
    const db = createMigratedTestDatabase();
    db.exec(readFileSync(resolve(__dirname, '../../migrations/down/317_product_analytics_events.sql'), 'utf8'));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(tables).not.toContain('product_analytics_events');
    db.close();
  });
});
