import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { filterAlreadyAppliedAddColumnStatements } from '../../src/services/database';
import fs from 'fs';
import path from 'path';

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('migrations 313-315 (portal observability)', () => {
  it('creates runtime_logs, http_request_log and issues with the expected columns and indexes', () => {
    const db = createMigratedTestDatabase();
    expect(columns(db, 'runtime_logs')).toEqual(['id', 'ts', 'level', 'src', 'req_id', 'user_id', 'msg', 'data']);
    expect(columns(db, 'http_request_log')).toEqual(expect.arrayContaining(['req_id', 'surface', 'route', 'status', 'duration_ms', 'ip_hash', 'sampled']));
    expect(columns(db, 'issues')).toEqual(expect.arrayContaining(['fingerprint', 'kind', 'status', 'occurrence_count', 'regressed_at', 'last_alert_id']));
    expect(columns(db, 'error_log')).toEqual(expect.arrayContaining(['req_id', 'issue_id']));
    expect(columns(db, 'client_errors')).toEqual(expect.arrayContaining(['req_id', 'issue_id']));
    expect(columns(db, 'support_tickets')).toEqual(expect.arrayContaining(['ref', 'kind', 'status', 'priority', 'source', 'issue_id', 'alert_id', 'req_id', 'created_by']));
    expect(columns(db, 'support_ticket_events')).toEqual(expect.arrayContaining(['ticket_id', 'actor', 'type', 'meta_json']));
    expect(() => db.prepare("INSERT INTO support_tickets (ref, kind, source, title, created_by) VALUES ('x', 'nope', 'operator', 't', 'o')").run()).toThrow();
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_runtime_logs_req', 'idx_http_request_log_req', 'idx_issues_status_last', 'idx_error_log_issue', 'idx_client_errors_issue']));
    expect(() => db.prepare("INSERT INTO issues (fingerprint, kind, source, title, level, status) VALUES ('f', 'bogus', 's', 't', 'error', 'open')").run()).toThrow();
    db.close();
  });

  it('rolls back cleanly through the down migrations', () => {
    const db = createMigratedTestDatabase();
    for (const file of ['315_issues.sql', '314_http_request_log.sql', '313_runtime_logs.sql']) {
      db.exec(fs.readFileSync(path.resolve(__dirname, `../../migrations/down/${file}`), 'utf8'));
    }
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).not.toEqual(expect.arrayContaining(['runtime_logs', 'http_request_log', 'issues']));
    expect(columns(db, 'error_log')).not.toContain('issue_id');
    expect(columns(db, 'client_errors')).not.toContain('req_id');
    db.close();
  });

  it('keeps the additive ALTER TABLE statements idempotent through the production filter', () => {
    const db = createMigratedTestDatabase();
    const sql = fs.readFileSync(path.resolve(__dirname, '../../migrations/315_issues.sql'), 'utf8');
    const filtered = filterAlreadyAppliedAddColumnStatements(sql, (table, column) => columns(db, table).includes(column));
    expect(filtered).not.toMatch(/ALTER TABLE error_log ADD COLUMN req_id/);
    expect(() => db.exec(filtered)).not.toThrow();
    db.close();
  });
});
