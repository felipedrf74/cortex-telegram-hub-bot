import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inspectSpanishRoutingCorpusRetirement,
  prepareProtectedBackupDirectory,
  runSpanishRoutingCorpusRetirement,
} from '../../scripts/prune-spanish-routing-corpus';
import { CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES } from '../../src/services/chat-bilingual-eval-fixtures';
import {
  ensureRoutingCorpusTables,
  hashRoutingUtterance,
} from '../../src/services/routing-corpus';

const SECRET = 'test-only-key';
const RUNTIME_SHA = 'b'.repeat(40);
const ARTIFACT_DIGEST = 'c'.repeat(64);

describe('prune-spanish-routing-corpus protected backup boundary', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-corpus-prune-'));
    dbPath = path.join(tempDir, 'bot.db');
    const db = new Database(dbPath);
    ensureRoutingCorpusTables(db);
    db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source, label_status
      ) VALUES (7, 11, ?, 'historical user row', 'history_unmatched', 'pending')
    `).run('a'.repeat(64));
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedRetiredFixtures(): void {
    const db = new Database(dbPath);
    const insert = db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source, label_status
      ) VALUES (0, NULL, ?, ?, 'bilingual_fixture', 'pending')
    `);
    for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
      if (fixture.promptLocale !== 'es-419') continue;
      insert.run(hashRoutingUtterance(SECRET, fixture.prompt), fixture.prompt);
    }
    db.close();
  }

  function inspectPlan() {
    return inspectSpanishRoutingCorpusRetirement({
      dbPath,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
    });
  }

  it('emits a deterministic read-only plan bound to the release and exact eight fixture rows', () => {
    seedRetiredFixtures();

    const first = inspectPlan();
    const second = inspectPlan();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 'routing_corpus_spanish_retirement_plan.v1',
      operation: 'prune_retired_spanish_synthetic_routing_corpus',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      status: 'ready',
      expectedFixtures: 8,
      acceptedSnapshotCount: 0,
    });
    expect(first.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.fixtureRows).toHaveLength(8);
    expect(first.fixtureRows.every((row) => (
      row.source === 'bilingual_fixture'
      && row.tenantId === 0
      && row.userId === null
      && row.labelStatus === 'pending'
      && /^[a-f0-9]{64}$/.test(row.utteranceHash)
      && /^[a-f0-9]{64}$/.test(row.utteranceTextSha256)
    ))).toBe(true);

    const source = new Database(dbPath, { readonly: true });
    expect(source.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get())
      .toEqual({ count: 9 });
    source.close();
  });

  it('binds the plan digest to the deployed runtime and artifact identities', () => {
    seedRetiredFixtures();
    const current = inspectPlan();
    const otherRuntime = inspectSpanishRoutingCorpusRetirement({
      dbPath,
      secret: SECRET,
      runtimeSha: 'd'.repeat(40),
      artifactDigest: ARTIFACT_DIGEST,
    });
    const otherArtifact = inspectSpanishRoutingCorpusRetirement({
      dbPath,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: 'e'.repeat(64),
    });

    expect(otherRuntime.planDigest).not.toBe(current.planDigest);
    expect(otherArtifact.planDigest).not.toBe(current.planDigest);
  });

  it('cannot create a backup or mutate without both owner authorization and the exact plan acknowledgement', async () => {
    seedRetiredFixtures();
    const plan = inspectPlan();
    const backupDir = path.join(tempDir, 'protected', 'routing');

    await expect(runSpanishRoutingCorpusRetirement({
      dbPath,
      backupDir,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: false,
      acknowledgedPlanDigest: plan.planDigest,
    })).rejects.toThrow(/owner authorization/i);
    expect(fs.existsSync(backupDir)).toBe(false);

    await expect(runSpanishRoutingCorpusRetirement({
      dbPath,
      backupDir,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: `sha256:${'f'.repeat(64)}`,
    })).rejects.toThrow(/plan digest/i);
    expect(fs.existsSync(backupDir)).toBe(false);

    const source = new Database(dbPath, { readonly: true });
    expect(source.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE source = 'bilingual_fixture'").get())
      .toEqual({ count: 8 });
    source.close();
  });

  it('creates a missing backup directory as 0700 and verifies the backup file as 0600 before pruning', async () => {
    seedRetiredFixtures();
    const backupDir = path.join(tempDir, 'protected', 'routing');
    const plan = inspectPlan();

    const result = await runSpanishRoutingCorpusRetirement({
      dbPath,
      backupDir,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    });

    expect(result.status).toBe('pruned');
    expect(result.planDigest).toBe(plan.planDigest);
    expect(result.runtimeSha).toBe(RUNTIME_SHA);
    expect(result.artifactDigest).toBe(ARTIFACT_DIGEST);
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    const backupStat = fs.lstatSync(result.backupPath);
    expect(backupStat.isFile()).toBe(true);
    expect(backupStat.isSymbolicLink()).toBe(false);
    expect(backupStat.mode & 0o777).toBe(0o600);
    if (typeof process.getuid === 'function') {
      expect(backupStat.uid).toBe(process.getuid());
    }

    const source = new Database(dbPath, { readonly: true });
    const rows = source.prepare('SELECT utterance_text FROM routing_corpus_items').all();
    source.close();
    expect(rows).toEqual([{ utterance_text: 'historical user row' }]);
  });

  it.each([
    { name: 'group-readable', mode: 0o750 },
    { name: 'world-accessible', mode: 0o701 },
  ])('rejects an existing $name backup directory before opening the mutation window', async ({ mode }) => {
    const backupDir = path.join(tempDir, 'unsafe-backups');
    fs.mkdirSync(backupDir, { mode });
    fs.chmodSync(backupDir, mode);
    const plan = inspectPlan();

    await expect(runSpanishRoutingCorpusRetirement({
      dbPath,
      backupDir,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    })).rejects.toThrow(/backup directory.*permissions/i);
    expect(fs.readdirSync(backupDir)).toEqual([]);

    const source = new Database(dbPath, { readonly: true });
    const count = source.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get();
    source.close();
    expect(count).toEqual({ count: 1 });
  });

  it('rejects a symlink backup directory instead of following it', () => {
    const realDir = path.join(tempDir, 'real-backups');
    const linkDir = path.join(tempDir, 'linked-backups');
    fs.mkdirSync(realDir, { mode: 0o700 });
    fs.symlinkSync(realDir, linkDir, 'dir');

    expect(() => prepareProtectedBackupDirectory(linkDir)).toThrow(/symbolic link/i);
    expect(fs.readdirSync(realDir)).toEqual([]);
  });
});
