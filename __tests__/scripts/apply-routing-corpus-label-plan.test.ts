import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRoutingCorpusLabelReviewManifest,
  inspectRoutingCorpusLabelPlan,
  runRoutingCorpusLabelPlan,
  writeRoutingCorpusLabelReviewManifest,
} from '../../scripts/apply-routing-corpus-label-plan';
import {
  CHAT_BILINGUAL_EVAL_FIXTURES,
  CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES,
} from '../../src/services/chat-bilingual-eval-fixtures';
import {
  ensureRoutingCorpusTables,
  hashRoutingCorpusSyntheticControl,
  hashRoutingUtterance,
} from '../../src/services/routing-corpus';

const SECRET = '[redacted-test-secret]';
const OLD_SECRET = '[redacted-old-test-secret]';
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);

function legacyBilingualUtterances(): string[] {
  return [...new Map([
    ...CHAT_BILINGUAL_EVAL_FIXTURES.flatMap((fixture) => [fixture.pt, fixture.en]),
    ...CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES
      .filter((fixture) => fixture.promptLocale === 'pt-BR')
      .map((fixture) => fixture.prompt),
  ].map((text) => [text.trim().toLowerCase(), text])).values()];
}

describe('owner-reviewed routing corpus label plan', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-label-plan-'));
    dbPath = path.join(tempDir, 'bot.db');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedPendingProductProfile(options: {
    legacyAliases?: boolean;
    legacySecret?: string;
  } = {}): void {
    const manifest = buildRoutingCorpusLabelReviewManifest();
    const db = new Database(dbPath);
    ensureRoutingCorpusTables(db);
    db.exec(`
      CREATE TABLE audit_trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        user_id INTEGER NOT NULL,
        actor_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        tenant_id INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insert = db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source,
        suggested_domain, suggested_skill, label_status
      ) VALUES (0, NULL, ?, ?, ?, ?, ?, 'pending')
    `);
    for (const item of manifest.items) {
      insert.run(
        hashRoutingCorpusSyntheticControl(SECRET, item.utteranceText),
        item.utteranceText,
        item.source,
        item.labelDomain,
        item.labelSkill,
      );
    }
    if (options.legacyAliases !== false) {
      for (const utteranceText of legacyBilingualUtterances()) {
        insert.run(
          hashRoutingUtterance(options.legacySecret ?? SECRET, utteranceText),
          utteranceText,
          'bilingual_fixture',
          null,
          null,
        );
      }
    }
    db.close();
  }

  function inspect() {
    return inspectRoutingCorpusLabelPlan({
      dbPath,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
    });
  }

  it('builds one exact EN/PT product-profile review manifest covering the approved label space', () => {
    const manifest = buildRoutingCorpusLabelReviewManifest();

    expect(manifest.schemaVersion).toBe('routing_corpus_label_review_manifest.v1');
    expect(manifest.provenance).toBe('agent_proposed_owner_review_required');
    expect(manifest.items).toHaveLength(300);
    expect(manifest.summary).toMatchObject({
      total: 300,
      byLocale: { en: 147, pt: 153 },
      bySource: { bilingual_fixture: 224, manual: 76 },
      byDomain: {
        secretary: 122,
        triathlon: 24,
        content: 24,
        finance: 24,
        cooking: 24,
        connections: 22,
        notifications: 22,
        decision_center: 22,
        clarify: 8,
        none: 8,
      },
    });
    expect(manifest.summary.bySkill).toEqual({
      secretary_calendar: 38,
      secretary_reminders: 21,
      mail: 20,
      tasks: 31,
      training: 24,
      content: 24,
      finance: 24,
      cooking: 24,
      connections: 22,
      notifications: 22,
      decision_center: 22,
      unlabeled: 28,
    });
    expect(manifest.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(new Set(manifest.items.map((item) => item.normalizedUtterance)).size).toBe(300);
    expect(manifest.items.every((item) => item.locale === 'en' || item.locale === 'pt')).toBe(true);
    expect(manifest.items.some((item) => /(^|[-_])es($|[-_])/i.test(item.locale))).toBe(false);

    const projectedScenarios = [
      'pending_plan_continuation',
      'fresh_research_request',
      'budget_constrained_action',
      'resolve_decision',
      'what_changed',
    ];
    for (const scenario of projectedScenarios) {
      const rows = manifest.items.filter((item) => item.scenarioRefs.includes(scenario));
      expect(rows, scenario).toHaveLength(2);
      expect(rows.every((item) => item.utteranceText !== item.normalizedUtterance)).toBe(true);
    }
    expect(manifest.items.some((item) => item.utteranceText === 'It is 20 km a week')).toBe(false);
    expect(manifest.items.some((item) => item.utteranceText === 'Choose this option')).toBe(false);

    const calendarScenarios = new Set([
      'free_window',
      'provider_degraded',
      'focus_protection',
      'portuguese_agenda_question',
      'gmail_agenda_variant',
      'google_calendar_agenda_variant',
    ]);
    const calendarRows = manifest.items.filter((item) =>
      item.scenarioRefs.some((scenario) => calendarScenarios.has(scenario)));
    expect(calendarRows).toHaveLength(12);
    expect(calendarRows.every((item) => item.labelSkill === 'secretary_calendar')).toBe(true);
  });

  it('writes the exact review artifact once with owner-only permissions', () => {
    const outputPath = path.join(tempDir, 'review-manifest.json');
    const result = writeRoutingCorpusLabelReviewManifest(outputPath);
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

    expect(result).toEqual({
      outputPath,
      manifestDigest: buildRoutingCorpusLabelReviewManifest().manifestDigest,
    });
    expect(parsed.manifestDigest).toBe(result.manifestDigest);
    expect(parsed.items).toHaveLength(300);
    expect(fs.lstatSync(outputPath).isSymbolicLink()).toBe(false);
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(() => writeRoutingCorpusLabelReviewManifest(outputPath)).toThrow(/exist/i);
  });

  it('emits a deterministic read-only plan bound to the exact release, rows, and review manifest', () => {
    seedPendingProductProfile();
    const before = fs.statSync(dbPath).size;

    const first = inspect();
    const second = inspect();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 'routing_corpus_label_plan.v1',
      operation: 'apply_owner_reviewed_routing_corpus_labels',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      expectedItems: 300,
      expectedLegacyAliasesToDelete: 224,
      acceptedSnapshotCount: 0,
      integrity: 'ok',
    });
    expect(first.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.reviewManifestDigest).toBe(buildRoutingCorpusLabelReviewManifest().manifestDigest);
    expect(first.itemRows).toHaveLength(300);
    expect(first.legacyAliasRows).toHaveLength(224);
    expect(first.itemRows.every((row) => (
      row.tenantId === 0
      && row.userId === null
      && row.labelStatus === 'pending'
      && row.hashScheme === 'synthetic_control_v1'
      && /^[a-f0-9]{64}$/.test(row.utteranceHash)
      && /^[a-f0-9]{64}$/.test(row.utteranceTextSha256)
      && row.utteranceText === undefined
    ))).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    db.close();
    expect(fs.statSync(dbPath).size).toBe(before);
  });

  it('accepts a fresh database with no legacy bilingual aliases', () => {
    seedPendingProductProfile({ legacyAliases: false });

    const plan = inspect();

    expect(plan.itemRows).toHaveLength(300);
    expect(plan.legacyAliasRows).toEqual([]);
    expect(plan.expectedLegacyAliasesToDelete).toBe(0);
  });

  it('finds the exact 224 legacy aliases even when they were built under an older secret', () => {
    seedPendingProductProfile({ legacySecret: OLD_SECRET });

    const plan = inspect();
    const expectedOldHashes = new Set(
      legacyBilingualUtterances()
        .map((utteranceText) => hashRoutingUtterance(OLD_SECRET, utteranceText)),
    );

    expect(plan.legacyAliasRows).toHaveLength(224);
    expect(plan.expectedLegacyAliasesToDelete).toBe(224);
    expect(plan.legacyAliasRows.every((row) => expectedOldHashes.has(row.utteranceHash))).toBe(true);
  });

  it('refuses a partial legacy bilingual alias set instead of deleting ambiguous rows', () => {
    seedPendingProductProfile();
    const db = new Database(dbPath);
    db.prepare(`
      DELETE FROM routing_corpus_items
      WHERE id = (
        SELECT id
        FROM routing_corpus_items
        WHERE source = 'bilingual_fixture'
          AND utterance_hash NOT IN (
            SELECT utterance_hash
            FROM routing_corpus_items
            WHERE source = 'bilingual_fixture'
            ORDER BY id ASC
            LIMIT 224
          )
        ORDER BY id ASC
        LIMIT 1
      )
    `).run();
    db.close();

    expect(() => inspect()).toThrow(/legacy bilingual aliases must be all present or all absent.*223/i);
  });

  it('binds the plan digest to runtime, artifact, and every pending row identity', () => {
    seedPendingProductProfile();
    const current = inspect();
    const otherRuntime = inspectRoutingCorpusLabelPlan({
      dbPath,
      secret: SECRET,
      runtimeSha: 'c'.repeat(40),
      artifactDigest: ARTIFACT_DIGEST,
    });
    const otherArtifact = inspectRoutingCorpusLabelPlan({
      dbPath,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: 'd'.repeat(64),
    });

    expect(otherRuntime.planDigest).not.toBe(current.planDigest);
    expect(otherArtifact.planDigest).not.toBe(current.planDigest);
  });

  it('refuses missing rows, accepted snapshots, and any non-pending product-profile row', () => {
    seedPendingProductProfile();
    const db = new Database(dbPath);
    db.prepare('DELETE FROM routing_corpus_items WHERE id = 1').run();
    db.close();
    expect(() => inspect()).toThrow(/expected 300.*found 299/i);

    fs.rmSync(dbPath);
    seedPendingProductProfile();
    const snapshotDb = new Database(dbPath);
    snapshotDb.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES ('{}', 1)
    `).run();
    snapshotDb.close();
    expect(() => inspect()).toThrow(/accepted routing accuracy snapshot/i);

    fs.rmSync(dbPath);
    seedPendingProductProfile();
    const labeledDb = new Database(dbPath);
    labeledDb.prepare(`
      UPDATE routing_corpus_items
      SET label_status = 'skipped', labeled_at = datetime('now')
      WHERE id = 1
    `).run();
    labeledDb.close();
    expect(() => inspect()).toThrow(/pending and unlabeled/i);
  });

  it('cannot create a backup or mutate without owner authorization and the exact digest', async () => {
    seedPendingProductProfile();
    const plan = inspect();
    const backupDir = path.join(tempDir, 'protected-backups');

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: false,
      acknowledgedPlanDigest: plan.planDigest,
    })).rejects.toThrow(/owner authorization/i);
    expect(fs.existsSync(backupDir)).toBe(false);

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: `sha256:${'e'.repeat(64)}`,
    })).rejects.toThrow(/plan digest/i);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('backs up, labels all 300 atomically, and writes a redacted durable audit receipt', async () => {
    seedPendingProductProfile();
    const plan = inspect();
    const backupDir = path.join(tempDir, 'protected-backups');

    const result = await runRoutingCorpusLabelPlan({
      dbPath,
      backupDir,
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    });

    expect(result).toMatchObject({
      schemaVersion: 'routing_corpus_label_apply.v1',
      status: 'applied',
      planDigest: plan.planDigest,
      reviewManifestDigest: plan.reviewManifestDigest,
      labeledItems: 300,
      deletedLegacyAliases: 224,
      integrity: 'ok',
      backupIntegrity: 'ok',
    });
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'labeled'").get())
      .toEqual({ count: 300 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 0 });
    const audit = db.prepare(`
      SELECT tenant_id AS tenantId, user_id AS userId, action, resource, details
      FROM audit_trail
    `).get() as {
      tenantId: number;
      userId: number;
      action: string;
      resource: string;
      details: string;
    };
    db.close();
    expect(audit).toMatchObject({
      tenantId: 0,
      userId: 0,
      action: 'admin_mutation',
      resource: 'routing_corpus.owner_reviewed_batch',
    });
    expect(JSON.parse(audit.details)).toMatchObject({
      provenance: 'agent_proposed_owner_approved',
      planDigest: plan.planDigest,
      reviewManifestDigest: plan.reviewManifestDigest,
      labeledItems: 300,
      deletedLegacyAliases: 224,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
    });
    expect(audit.details).not.toContain('utteranceText');
    expect(audit.details).not.toContain('Remind me');
  });

  it('rolls back every label and the audit receipt if any row update fails', async () => {
    seedPendingProductProfile();
    const plan = inspect();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TRIGGER routing_label_test_abort
      BEFORE UPDATE OF label_status ON routing_corpus_items
      WHEN OLD.id = 150
      BEGIN
        SELECT RAISE(ABORT, 'synthetic label failure');
      END;
    `);
    db.close();

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir: path.join(tempDir, 'protected-backups'),
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    })).rejects.toThrow(/synthetic label failure/i);

    const verifyDb = new Database(dbPath, { readonly: true });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM audit_trail').get())
      .toEqual({ count: 0 });
    verifyDb.close();
  });

  it('rolls back all 300 labels if legacy alias cleanup fails', async () => {
    seedPendingProductProfile();
    const plan = inspect();
    const aliasId = plan.legacyAliasRows[100]?.id;
    expect(aliasId).toBeTypeOf('number');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TRIGGER routing_alias_delete_test_abort
      BEFORE DELETE ON routing_corpus_items
      WHEN OLD.id = ${aliasId}
      BEGIN
        SELECT RAISE(ABORT, 'synthetic alias cleanup failure');
      END;
    `);
    db.close();

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir: path.join(tempDir, 'protected-backups'),
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    })).rejects.toThrow(/synthetic alias cleanup failure/i);

    const verifyDb = new Database(dbPath, { readonly: true });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'labeled'").get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM audit_trail').get())
      .toEqual({ count: 0 });
    verifyDb.close();
  });

  it('rolls back labels and alias cleanup if the durable audit receipt fails', async () => {
    seedPendingProductProfile();
    const plan = inspect();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TRIGGER routing_batch_audit_test_abort
      BEFORE INSERT ON audit_trail
      BEGIN
        SELECT RAISE(ABORT, 'synthetic audit receipt failure');
      END;
    `);
    db.close();

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir: path.join(tempDir, 'protected-backups'),
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    })).rejects.toThrow(/synthetic audit receipt failure/i);

    const verifyDb = new Database(dbPath, { readonly: true });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'labeled'").get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM audit_trail').get())
      .toEqual({ count: 0 });
    verifyDb.close();
  });

  it('refuses when a snapshot is accepted after reinspection but before the label transaction', async () => {
    seedPendingProductProfile();
    const plan = inspect();

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir: path.join(tempDir, 'protected-backups'),
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      _testBeforeApplyTransaction: () => {
        const racingDb = new Database(dbPath);
        racingDb.prepare(`
          INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
          VALUES ('{}', 1)
        `).run();
        racingDb.close();
      },
    })).rejects.toThrow(/accepted routing accuracy snapshot.*label transaction/i);

    const verifyDb = new Database(dbPath, { readonly: true });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM audit_trail').get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM accepted_accuracy_snapshots WHERE accepted = 1').get())
      .toEqual({ count: 1 });
    verifyDb.close();
  });

  it('refuses row text drift after reinspection and leaves labels and aliases untouched', async () => {
    seedPendingProductProfile();
    const plan = inspect();
    const target = plan.itemRows[0]!;

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir: path.join(tempDir, 'protected-backups'),
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      _testBeforeApplyTransaction: () => {
        const racingDb = new Database(dbPath);
        racingDb.prepare('UPDATE routing_corpus_items SET utterance_text = ? WHERE id = ?')
          .run('tampered after owner review', target.id);
        racingDb.close();
      },
    })).rejects.toThrow(/routing-corpus labeling state changed inside the immediate transaction/i);

    const verifyDb = new Database(dbPath, { readonly: true });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'labeled'").get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM audit_trail').get())
      .toEqual({ count: 0 });
    verifyDb.close();
  });

  it('refuses legacy alias text drift after reinspection and rolls back labels', async () => {
    seedPendingProductProfile();
    const plan = inspect();
    const target = plan.legacyAliasRows[0]!;

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir: path.join(tempDir, 'protected-backups'),
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      _testBeforeApplyTransaction: () => {
        const racingDb = new Database(dbPath);
        racingDb.prepare('UPDATE routing_corpus_items SET utterance_text = ? WHERE id = ?')
          .run('tampered legacy alias after owner review', target.id);
        racingDb.close();
      },
    })).rejects.toThrow(/routing-corpus labeling state changed inside the immediate transaction/i);

    const verifyDb = new Database(dbPath, { readonly: true });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'labeled'").get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM audit_trail').get())
      .toEqual({ count: 0 });
    verifyDb.close();
  });

  it('refuses aliases inserted after a zero-alias inspection and before the immediate transaction', async () => {
    seedPendingProductProfile({ legacyAliases: false });
    const plan = inspect();
    expect(plan.expectedLegacyAliasesToDelete).toBe(0);

    await expect(runRoutingCorpusLabelPlan({
      dbPath,
      backupDir: path.join(tempDir, 'protected-backups'),
      secret: SECRET,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      _testBeforeApplyTransaction: () => {
        const racingDb = new Database(dbPath);
        const insert = racingDb.prepare(`
          INSERT INTO routing_corpus_items (
            tenant_id, user_id, utterance_hash, utterance_text, source,
            suggested_domain, suggested_skill, label_status
          ) VALUES (0, NULL, ?, ?, 'bilingual_fixture', ?, ?, 'pending')
        `);
        for (const utteranceText of legacyBilingualUtterances()) {
          insert.run(
            hashRoutingUtterance(OLD_SECRET, utteranceText),
            utteranceText,
            null,
            null,
          );
        }
        racingDb.close();
      },
    })).rejects.toThrow(/routing-corpus labeling state changed inside the immediate transaction/i);

    const verifyDb = new Database(dbPath, { readonly: true });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'pending'").get())
      .toEqual({ count: 524 });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM routing_corpus_items WHERE label_status = 'labeled'").get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM audit_trail').get())
      .toEqual({ count: 0 });
    verifyDb.close();
  });
});
