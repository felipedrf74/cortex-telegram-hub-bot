import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getContentWorkspaceRolloutPreflightStatus,
} from '../../src/services/content-workspace-rollout-preflight';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'content-workspace-rollout-preflight-'));
  roots.push(root);
  const dbPath = join(root, 'bot.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      tier TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO users (id, tier, status) VALUES (41, 'owner', 'active');
  `);
  db.close();
  return { dbPath };
}

function writeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    CONTENT_WORKSPACE_V1_MODE: 'write',
    CONTENT_WORKSPACE_V1_GLOBAL_WRITE: 'false',
    CONTENT_WORKSPACE_V1_USER_IDS: '41',
    CONTENT_WORKSPACE_V1_TENANT_IDS: '',
    CONTENT_WORKSPACE_V1_CORE_WRITES: 'true',
    CONTENT_WORKSPACE_V1_REVISION_WRITES: 'true',
    CONTENT_WORKSPACE_V1_LINEAGE_WRITES: 'true',
    CONTENT_WORKSPACE_V1_AGENT_WRITES: 'true',
    CONTENT_WORKSPACE_V1_SCHEDULE_WRITES: 'true',
    CONTENT_WORKSPACE_V1_RECOVERY_WRITES: 'true',
    ...overrides,
  };
}

describe('Content workspace production rollout preflight', () => {
  it('accepts only a complete, explicitly scoped owner cohort', () => {
    const { dbPath } = fixture();
    expect(getContentWorkspaceRolloutPreflightStatus({ dbPath, env: writeEnv() }))
      .toEqual({ ok: true, ownerCount: 1, errors: [] });
  });

  it('rejects read-only, global, excluded, malformed, inactive, and partial write state', () => {
    const { dbPath } = fixture();
    const rejected = [
      writeEnv({ CONTENT_WORKSPACE_V1_MODE: 'read_only' }),
      writeEnv({ CONTENT_WORKSPACE_V1_GLOBAL_WRITE: 'true' }),
      writeEnv({ CONTENT_WORKSPACE_V1_USER_IDS: '99' }),
      writeEnv({ CONTENT_WORKSPACE_V1_USER_IDS: '41,private' }),
      writeEnv({ CONTENT_WORKSPACE_V1_AGENT_WRITES: 'false' }),
    ].map((env) => getContentWorkspaceRolloutPreflightStatus({ dbPath, env }));

    expect(rejected.every((status) => !status.ok)).toBe(true);
    expect(rejected[0].errors).toContain('mode_not_write');
    expect(rejected[1].errors).toContain('global_write_not_scoped');
    expect(rejected[2].errors).toContain('owner_not_enrolled');
    expect(rejected[3].errors).toContain('user_cohort_invalid');
    expect(rejected[4].errors).toContain('write_slice_disabled_or_invalid');

    const db = new Database(dbPath);
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = 41").run();
    db.close();
    expect(getContentWorkspaceRolloutPreflightStatus({ dbPath, env: writeEnv() }).errors)
      .toContain('owner_not_active');
  });

  it('returns only reason codes and aggregate owner count', () => {
    const { dbPath } = fixture();
    const status = getContentWorkspaceRolloutPreflightStatus({
      dbPath,
      env: writeEnv({ CONTENT_WORKSPACE_V1_USER_IDS: '99' }),
    });
    expect(JSON.stringify(status)).not.toContain('41');
    expect(JSON.stringify(status)).not.toContain('99');
    expect(status).toMatchObject({ ok: false, ownerCount: 1 });
  });

  it('fails closed when persisted owner cardinality is not exactly one', () => {
    const { dbPath } = fixture();
    const db = new Database(dbPath);
    db.prepare("INSERT INTO users (id, tier, status) VALUES (42, 'owner', 'active')").run();
    db.close();

    const status = getContentWorkspaceRolloutPreflightStatus({
      dbPath,
      env: writeEnv({ CONTENT_WORKSPACE_V1_USER_IDS: '41,42' }),
    });
    expect(status).toMatchObject({ ok: false, ownerCount: 2 });
    expect(status.errors).toContain('owner_count_not_one');
    expect(JSON.stringify(status)).not.toContain('41');
    expect(JSON.stringify(status)).not.toContain('42');
  });
});
