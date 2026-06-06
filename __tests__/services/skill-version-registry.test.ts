import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

import {
  activateSkillVersion,
  createSkillVersion,
  getActiveSkillVersion,
  getAllSkillMetadata,
  getSkillMetadata,
  getSkillVersion,
  listSkillVersions,
  setSkillVersionStatus,
  toPublicSkillVersion,
} from '../../src/services/skill-version-registry';
import { setSkillMemory } from '../../src/services/skill-memory';

describe('skill-version-registry', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('seeds active baseline versions for all major Nexus skills', () => {
    const skills = getAllSkillMetadata();
    expect(skills.map((skill) => skill.skillId)).toEqual([
      'chat',
      'secretary',
      'training',
      'finance',
      'cooking',
      'content',
    ]);
    expect(skills.every((skill) => skill.status === 'active')).toBe(true);
    expect(getSkillMetadata('triathlon').skillId).toBe('training');
  });

  it('creates a candidate skill version with release evidence and rollback metadata', () => {
    const created = createSkillVersion({
      skillId: 'content',
      skillName: 'Content Creation',
      version: '2.1.0',
      releaseType: 'minor',
      releaseTitle: 'Source provenance foundation',
      releaseSummary: 'Adds source-ledger metadata for content artifacts.',
      capabilitiesAdded: ['source registry', 'artifact source ledger'],
      bugFixes: ['dedup routing follows live provider routing'],
      testsAdded: ['skill-version-registry.test.ts'],
      smokeTestsPassed: ['fixture mode only'],
      openRisks: ['tenant-shared source library still pending'],
      knownLimitations: ['link ingestion is not enabled yet'],
      rollbackNotes: 'Roll back to content@2.0.0 if source ledger writes regress.',
      internalNotes: 'do not expose raw incident notes',
      createdBy: 'codex',
      status: 'candidate',
      compatibleApiVersion: 'api-v1',
      memorySchemaVersion: 'content-memory-v2',
      qualityGateStatus: 'candidate',
    });

    expect(created.skillId).toBe('content');
    expect(created.status).toBe('candidate');
    expect(created.capabilitiesAdded).toContain('source registry');
    expect(created.rollbackNotes).toContain('content@2.0.0');

    const publicRecord = toPublicSkillVersion(created);
    expect('internalNotes' in publicRecord).toBe(false);
    expect(JSON.stringify(publicRecord)).not.toContain('incident notes');
  });

  it('registers the Content Creation production candidate without activating it', () => {
    const candidate = getSkillVersion('content', '2.3.0-rc.1');

    expect(candidate).toMatchObject({
      skillId: 'content',
      skillName: 'Content Creation',
      version: '2.3.0-rc.1',
      status: 'candidate',
      qualityGateStatus: 'pass_with_conditions',
    });
    expect(candidate?.capabilitiesAdded).toEqual(expect.arrayContaining([
      'tenant-safe reference registry',
      'reference provenance and claim review',
      'deterministic content evaluation harness',
    ]));
    expect(candidate?.securityFixes).toEqual(expect.arrayContaining([
      'Cross-tenant reference leakage blocked in focused tests',
      'Prompt-injection source content labeled as untrusted evidence',
    ]));
    expect(getActiveSkillVersion('content')?.version).toBe('2.0.0');
  });

  it('activates a global version and deprecates the previous global active version', () => {
    createSkillVersion({
      skillId: 'content',
      skillName: 'Content Creation',
      version: '2.2.0',
      releaseType: 'minor',
      releaseTitle: 'Lifecycle states',
      releaseSummary: 'Adds explicit lifecycle state metadata.',
      capabilitiesAdded: ['artifact lifecycle'],
      rollbackNotes: 'Use content@2.0.0 as rollback target.',
      status: 'candidate',
    });

    const activated = activateSkillVersion('content', '2.2.0', { actor: 'release-bot' });
    expect(activated.status).toBe('active');
    expect(getActiveSkillVersion('content')?.version).toBe('2.2.0');
    expect(getSkillVersion('content', '2.0.0')?.status).toBe('deprecated');
  });

  it('resolves tenant-specific rollout before global rollout', () => {
    createSkillVersion({
      skillId: 'secretary',
      skillName: 'Secretary',
      version: '2.1.0',
      releaseType: 'minor',
      releaseTitle: 'Tenant canary schedule repair',
      releaseSummary: 'Canary schedule repair rollout for one tenant.',
      capabilitiesAdded: ['schedule repair canary'],
      rollbackNotes: 'Remove tenant rollout to fall back to secretary@2.0.0.',
      status: 'candidate',
      rolloutScope: 'tenant',
    });

    activateSkillVersion('secretary', '2.1.0', {
      scopeType: 'tenant',
      tenantId: 42,
      actor: 'release-bot',
    });

    expect(getActiveSkillVersion('secretary', { tenantId: 42 })?.version).toBe('2.1.0');
    expect(getActiveSkillVersion('secretary', { tenantId: 43 })?.version).toBe('2.0.0');
  });

  it('transitions version status to rolled_back without deleting release history', () => {
    createSkillVersion({
      skillId: 'chat',
      skillName: 'Chat',
      version: '1.1.0',
      releaseType: 'patch',
      releaseTitle: 'Retry repair',
      releaseSummary: 'Repairs stuck retry state.',
      rollbackNotes: 'Return to chat@1.0.0.',
      status: 'candidate',
    });

    const rolledBack = setSkillVersionStatus('chat', '1.1.0', 'rolled_back', { actor: 'ops' });
    expect(rolledBack.status).toBe('rolled_back');
    expect(listSkillVersions('chat').map((version) => version.version)).toContain('1.1.0');
  });

  it('rejects illegal skill version status regressions', () => {
    createSkillVersion({
      skillId: 'chat',
      skillName: 'Chat',
      version: '1.2.0',
      releaseType: 'patch',
      releaseTitle: 'Status guard',
      releaseSummary: 'Pins illegal transition behavior.',
      rollbackNotes: 'Return to chat@1.0.0.',
      status: 'candidate',
    });

    activateSkillVersion('chat', '1.2.0', { actor: 'release-bot' });

    expect(() => setSkillVersionStatus('chat', '1.2.0', 'draft', { actor: 'release-bot' }))
      .toThrow(/SKILL_VERSION_TRANSITION_DENIED/);
  });

  it('rejects activation when active memories use an incompatible schema version', () => {
    setSkillMemory({
      tenantId: 77,
      userId: 77,
      skillId: 'content',
      memoryType: 'content_creative_preference',
      scope: 'user_private',
      memoryKey: 'voice',
      memoryValue: 'Use terse operator notes.',
      source: 'test',
      schemaVersion: 'content-memory-v1',
    });
    createSkillVersion({
      skillId: 'content',
      skillName: 'Content Creation',
      version: '3.0.0',
      releaseType: 'major',
      releaseTitle: 'Memory schema v3',
      releaseSummary: 'Requires migrated content memory.',
      rollbackNotes: 'Stay on content@2.0.0.',
      status: 'candidate',
      rolloutScope: 'tenant',
      memorySchemaVersion: 'content-memory-v3',
    });

    expect(() => activateSkillVersion('content', '3.0.0', {
      scopeType: 'tenant',
      tenantId: 77,
      userId: 77,
      actor: 'release-bot',
    })).toThrow(/SKILL_VERSION_MEMORY_SCHEMA_INCOMPATIBLE/);
  });

  it('falls back safely for skills without explicit version metadata', () => {
    const metadata = getSkillMetadata('experimental-skill');
    expect(metadata.currentVersion).toBe('0.0.0');
    expect(metadata.qualityGateStatus).toBe('fallback');
    expect(metadata.knownLimitations[0]).toContain('No explicit skill version registry row');
  });
});
