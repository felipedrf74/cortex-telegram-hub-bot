import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const registrySql = readFileSync(
  resolve(__dirname, '../../migrations/087_skill_version_registry.sql'),
  'utf8',
);
const upSql = readFileSync(
  resolve(__dirname, '../../migrations/311_activate_secretary_2_2_skill_version.sql'),
  'utf8',
);
const downSql = readFileSync(
  resolve(__dirname, '../../migrations/down/311_activate_secretary_2_2_skill_version.sql'),
  'utf8',
);

function seedTenantCanary(db: Database.Database): void {
  const result = db.prepare(`
    INSERT INTO skill_versions (
      skill_id, skill_name, version, release_type, release_title,
      release_summary, status, rollout_scope
    ) VALUES (
      'secretary', 'Secretary', '2.1.0', 'minor', 'Tenant canary',
      'Existing scoped rollout that the global release must preserve.',
      'active', 'tenant'
    )
  `).run();
  db.prepare(`
    INSERT INTO skill_version_rollouts (
      skill_version_id, scope_type, tenant_id, status, created_by, activated_at
    ) VALUES (?, 'tenant', 42, 'active', 'existing-release', '2026-08-01T00:00:00.000Z')
  `).run(Number(result.lastInsertRowid));
}

function seedPreexisting22Candidate(db: Database.Database): void {
  const result = db.prepare(`
    INSERT INTO skill_versions (
      skill_id, skill_name, version, release_type, release_title,
      release_summary, created_by, status, rollout_scope
    ) VALUES (
      'secretary', 'Secretary', '2.2.0', 'minor', 'Existing candidate',
      'Operator-authored candidate metadata.', 'release-operator',
      'candidate', 'global'
    )
  `).run();
  db.prepare(`
    INSERT INTO skill_version_rollouts (
      skill_version_id, scope_type, status, created_by, rollout_notes
    ) VALUES (?, 'global', 'candidate', 'release-operator', 'Pre-existing candidate rollout')
  `).run(Number(result.lastInsertRowid));
}

function globalActiveVersions(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT version.version
    FROM skill_versions version
    JOIN skill_version_rollouts rollout ON rollout.skill_version_id = version.id
    WHERE version.skill_id = 'secretary'
      AND rollout.scope_type = 'global'
      AND rollout.status = 'active'
    ORDER BY version.version
  `).all() as Array<{ version: string }>).map((row) => row.version);
}

describe('migration 311 Secretary 2.2 release metadata', () => {
  it('activates one global 2.2 rollout idempotently and preserves scoped rollout history', () => {
    const db = new Database(':memory:');
    try {
      db.exec(registrySql);
      seedTenantCanary(db);

      db.exec(upSql);
      db.exec(upSql);

      expect(globalActiveVersions(db)).toEqual(['2.2.0']);
      expect(db.prepare(`
        SELECT status, rollout_scope AS rolloutScope
        FROM skill_versions
        WHERE skill_id = 'secretary' AND version = '2.2.0'
      `).get()).toEqual({ status: 'active', rolloutScope: 'global' });
      expect(db.prepare(`
        SELECT version.status AS versionStatus, rollout.status AS rolloutStatus
        FROM skill_versions version
        JOIN skill_version_rollouts rollout ON rollout.skill_version_id = version.id
        WHERE version.skill_id = 'secretary'
          AND version.version = '2.1.0'
          AND rollout.scope_type = 'tenant'
          AND rollout.tenant_id = 42
      `).get()).toEqual({ versionStatus: 'active', rolloutStatus: 'active' });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM skill_version_rollouts rollout
        JOIN skill_versions version ON version.id = rollout.skill_version_id
        WHERE version.skill_id = 'secretary'
          AND version.version = '2.2.0'
          AND rollout.scope_type = 'global'
          AND rollout.status = 'active'
      `).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('restores 2.0 globally while retaining 2.2 and scoped history on rehearsal rollback', () => {
    const db = new Database(':memory:');
    try {
      db.exec(registrySql);
      seedTenantCanary(db);
      db.exec(upSql);
      db.exec(downSql);

      expect(globalActiveVersions(db)).toEqual(['2.0.0']);
      expect(db.prepare(`
        SELECT status
        FROM skill_versions
        WHERE skill_id = 'secretary' AND version = '2.2.0'
      `).get()).toEqual({ status: 'rolled_back' });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM skill_version_rollouts rollout
        JOIN skill_versions version ON version.id = rollout.skill_version_id
        WHERE version.skill_id = 'secretary'
          AND rollout.scope_type = 'global'
          AND rollout.status = 'active'
      `).get()).toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT rollout.status AS status
        FROM skill_version_rollouts rollout
        JOIN skill_versions version ON version.id = rollout.skill_version_id
        WHERE version.skill_id = 'secretary'
          AND version.version = '2.1.0'
          AND rollout.scope_type = 'tenant'
          AND rollout.tenant_id = 42
      `).get()).toEqual({ status: 'active' });
    } finally {
      db.close();
    }
  });

  it('restores an operator-authored 2.2 candidate exactly on rehearsal rollback', () => {
    const db = new Database(':memory:');
    try {
      db.exec(registrySql);
      seedPreexisting22Candidate(db);

      db.exec(upSql);
      expect(globalActiveVersions(db)).toEqual(['2.2.0']);
      db.exec(downSql);

      expect(globalActiveVersions(db)).toEqual(['2.0.0']);
      expect(db.prepare(`
        SELECT status, rollout_scope AS rolloutScope, created_by AS createdBy
        FROM skill_versions
        WHERE skill_id = 'secretary' AND version = '2.2.0'
      `).get()).toEqual({
        status: 'candidate',
        rolloutScope: 'global',
        createdBy: 'release-operator',
      });
      expect(db.prepare(`
        SELECT rollout.status AS status, rollout.created_by AS createdBy
        FROM skill_version_rollouts rollout
        JOIN skill_versions version ON version.id = rollout.skill_version_id
        WHERE version.skill_id = 'secretary'
          AND version.version = '2.2.0'
          AND rollout.created_by = 'release-operator'
      `).get()).toEqual({ status: 'candidate', createdBy: 'release-operator' });
    } finally {
      db.close();
    }
  });
});
