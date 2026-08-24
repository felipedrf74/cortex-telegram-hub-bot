import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRoutingCorpusLabelReviewManifest } from '../../scripts/apply-routing-corpus-label-plan';
import {
  assertRoutingCalibrationExportStateResolved,
  buildRoutingCalibrationExportPartialReceipt,
  buildRoutingCalibrationExportReceipt,
  canonicalJson,
  exportRoutingCalibrationCorpus,
  findAnchoredSqliteDescriptor,
  inspectRoutingCalibrationExport,
  nextRoutingCalibrationExportPlanSequence,
  publishPrivateEvidenceFile,
  recoverPrivateEvidencePublication,
  routingCalibrationCorpusIdentityDigest,
  sha256Digest,
  validateRoutingCalibrationExportPlan,
  validateRoutingCalibrationExportReceipt,
  verifyRoutingCalibrationExport,
} from '../../scripts/lib/routing-calibration-export.mjs';
import {
  ensureRoutingCorpusTables,
  hashRoutingCorpusSyntheticControl,
  isCheckedInSyntheticRoutingCorpusItem,
} from '../../src/services/routing-corpus';
import { parseAcceptedRoutingAccuracySnapshot } from '../../src/services/routing-accuracy-snapshot-contract';
import { BOOTSTRAP_ROUTING_CALIBRATION } from '../../src/services/intent-resolution/confidence';

const ROOT = path.resolve(__dirname, '../..');
const OPERATOR = path.join(ROOT, 'scripts/routing-calibration-export-operator.sh');
const REMOTE = path.join(ROOT, 'scripts/remote-routing-calibration-export-transaction.sh');
const HELPER = path.join(ROOT, 'scripts/lib/routing-calibration-export.mjs');
const PRIVATE_DIR_TOOL = path.join(ROOT, 'scripts/lib/ensure-private-directory.py');
const PYTHON = process.env.NEXUS_TEST_PYTHON_BIN ?? 'python3';
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const TRANSACTION_ID = '20260803T010203Z-abcdef123456';
const SECRET = '[redacted-routing-calibration-export-test-secret]';
const GENERATED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.parse(GENERATED_AT) + 60 * 60_000).toISOString();
const NORMALIZED_CREATED_AT = '1970-01-01T00:00:00.000Z';
const PRIVATE_PENDING_SENTINEL = 'PRIVATE_PENDING_CORPUS_SENTINEL';
const PRIVATE_CACHE_SENTINEL = 'PRIVATE_MATCHING_CACHE_MODEL_SENTINEL';
const PRIVATE_UNMATCHED_CACHE_SENTINEL = 'PRIVATE_UNMATCHED_CACHE_SENTINEL';
const PRIVATE_SNAPSHOT_SENTINEL = 'PRIVATE_ACCEPTED_SNAPSHOT_SENTINEL';
const CACHE_DOMAINS = new Set([
  'secretary', 'triathlon', 'content', 'finance', 'cooking', 'connections',
  'notifications', 'decision_center', 'clarify', 'none', 'tasks', 'training',
]);
const temporaryRoots: string[] = [];

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function approved(item: Parameters<typeof isCheckedInSyntheticRoutingCorpusItem>[0]): boolean {
  return isCheckedInSyntheticRoutingCorpusItem(item, SECRET);
}

function healthEvidence() {
  return {
    schema: 'nexus.routing-calibration-export-health-evidence.v1',
    status: 'healthy',
    database: 'connected',
    databaseProbe: 'connected',
    contentHealth: 'passed',
    role: 'production',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    releaseAttestationSchema: 'nexus.chat-capability-release-attestation.v2',
  };
}

function pm2Evidence(releaseDir: string) {
  return {
    schema: 'nexus.routing-calibration-export-pm2-evidence.v1',
    role: 'production',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    processes: [
      {
        name: 'content-engine',
        status: 'online',
        cwd: `${releaseDir}/content-engine`,
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
      },
      {
        name: 'nexus-hub',
        status: 'online',
        cwd: releaseDir,
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
      },
    ],
  };
}

function calibrationBuckets() {
  return [
    ['0.0-0.2', 0, 0.2],
    ['0.2-0.4', 0.2, 0.4],
    ['0.4-0.6', 0.4, 0.6],
    ['0.6-0.8', 0.6, 0.8],
    ['0.8-1.0', 0.8, 1],
  ].map(([bucket, lowerBound, upperBound]) => ({
    bucket,
    lowerBound,
    upperBound,
    count: 0,
    correct: 0,
    empiricalAccuracy: null,
    averageStatedConfidence: null,
  }));
}

function acceptedSnapshot(corpusIdentityDigest: string, cacheRows: number) {
  const surfaceIds = [
    'classifier_keyword',
    'shadow_route_guess',
    'orchestrator_analyze',
    'intent_resolver',
    'llm_classify_cache',
  ];
  return {
    version: 'routing-accuracy@1.1.0',
    generatedAt: '2026-08-01T00:00:00.000Z',
    itemCount: 300,
    clarifyAccuracyTarget: 0.85,
    evaluationScope: {
      domainRoutingScored: true,
      actionSkillRoutingScored: false,
      actionSkillGate: 'phase7_classifier_manifest_prompt',
    },
    corpusIdentityDigest,
    privateOperatorNote: PRIVATE_SNAPSHOT_SENTINEL,
    surfaces: surfaceIds.map((surface) => {
      const covered = surface === 'llm_classify_cache' ? cacheRows : 300;
      return {
        surface,
        covered,
        uncovered: 300 - covered,
        correct: covered,
        accuracy: covered === 0 ? null : 1,
        perDomain: covered === 0 ? [] : [{
          domain: 'secretary',
          support: covered,
          truePositives: covered,
          falsePositives: 0,
          falseNegatives: 0,
          precision: 1,
          recall: 1,
        }],
        calibration: calibrationBuckets(),
        recommendedClarifyThreshold: null,
      };
    }),
  };
}

function seedSource(cacheRows = 25) {
  // macOS exposes /var through /private/var. Canonicalize the temporary root
  // before building any governed path so the ancestor-symlink guard exercises
  // the fixture itself, not the operating system's compatibility symlink.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'routing-calibration-export-')),
  );
  temporaryRoots.push(root);
  fs.chmodSync(root, 0o755);
  const dataDir = path.join(root, 'data');
  const exportRoot = path.join(root, 'protected-export');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(exportRoot, { mode: 0o700 });
  const dbPath = path.join(dataDir, 'bot.db');
  const outputPath = path.join(exportRoot, `${TRANSACTION_ID}.sqlite`);
  const unresolvedReleaseDir = path.join(
    root,
    `releases/${RUNTIME_SHA}-${ARTIFACT_DIGEST.slice(0, 12)}`,
  );
  fs.mkdirSync(unresolvedReleaseDir, { recursive: true, mode: 0o700 });
  const releaseDir = fs.realpathSync(unresolvedReleaseDir);
  const manifest = buildRoutingCorpusLabelReviewManifest();
  expect(manifest.items).toHaveLength(300);

  const db = new Database(dbPath);
  ensureRoutingCorpusTables(db);
  const insert = db.prepare(`
    INSERT INTO routing_corpus_items (
      tenant_id, user_id, utterance_hash, utterance_text, source,
      suggested_domain, suggested_skill, label_domain, label_skill,
      label_status, labeled_at, created_at
    ) VALUES (0, NULL, ?, ?, ?, 'discard-me', 'discard-me', ?, ?, 'labeled', ?, ?)
  `);
  const rows = manifest.items.map((item, index) => {
    const labeledAt = new Date(Date.parse('2026-07-30T00:00:00.000Z') + index * 1000)
      .toISOString();
    // Deliberately reverse source creation order relative to id. The export
    // must normalize timestamps without changing the corpus identity order.
    const createdAt = new Date(Date.parse('2026-07-31T00:00:00.000Z') + (299 - index) * 1000)
      .toISOString();
    const utteranceHash = hashRoutingCorpusSyntheticControl(SECRET, item.utteranceText);
    const result = insert.run(
      utteranceHash,
      item.utteranceText,
      item.source,
      item.labelDomain,
      item.labelSkill,
      labeledAt,
      createdAt,
    );
    return {
      id: Number(result.lastInsertRowid),
      tenantId: 0,
      userId: null,
      utteranceHash,
      utteranceText: item.utteranceText,
      source: item.source,
      suggestedDomain: 'discard-me',
      suggestedSkill: 'discard-me',
      labelDomain: item.labelDomain,
      labelSkill: item.labelSkill,
      labelStatus: 'labeled',
      labeledAt,
      createdAt,
    };
  });
  const orderedRows = [...rows].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id - right.id
  ));
  const corpusIdentityDigest = routingCalibrationCorpusIdentityDigest(orderedRows);
  db.prepare(`
    INSERT INTO routing_corpus_items (
      tenant_id, user_id, utterance_hash, utterance_text, source,
      label_status, created_at
    ) VALUES (99, 42, ?, ?, 'history_unmatched', 'pending', ?)
  `).run(
    'd'.repeat(64),
    PRIVATE_PENDING_SENTINEL,
    '2026-08-02T00:00:00.000Z',
  );

  const insertCache = db.prepare(`
    INSERT INTO routing_llm_classify_cache (
      utterance_hash, domain, confidence, model, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const [index, row] of [...rows]
    .sort((left, right) => left.utteranceHash.localeCompare(right.utteranceHash))
    .slice(0, cacheRows)
    .entries()) {
    insertCache.run(
      row.utteranceHash,
      row.labelDomain,
      0.7 + (index % 20) / 100,
      PRIVATE_CACHE_SENTINEL,
      new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 1000).toISOString(),
    );
  }
  insertCache.run(
    'e'.repeat(64),
    'secretary',
    0.99,
    PRIVATE_UNMATCHED_CACHE_SENTINEL,
    '2026-08-01T01:00:00.000Z',
  );
  const snapshotRaw = JSON.stringify(acceptedSnapshot(corpusIdentityDigest, cacheRows));
  db.prepare(`
    INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
    VALUES (?, 1)
  `).run(snapshotRaw);
  db.close();
  fs.chmodSync(dbPath, 0o600);

  const planInput = {
    dbPath,
    releaseDir,
    outputPath,
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    transactionId: TRANSACTION_ID,
    planSequence: 7,
    generatedAt: GENERATED_AT,
    expiresAt: EXPIRES_AT,
    operatorSha256: sha256('operator'),
    helperSha256: sha256('helper'),
    productionBaseDir: root,
    exportRoot,
    preflight: {
      selector: releaseDir,
      health: healthEvidence(),
      pm2: pm2Evidence(releaseDir),
    },
    isApprovedSyntheticItem: approved,
    parseAcceptedSnapshot: parseAcceptedRoutingAccuracySnapshot,
    isApprovedCacheDomain: (domain: string) => CACHE_DOMAINS.has(domain),
  };
  return {
    root,
    dbPath,
    outputPath,
    exportRoot,
    releaseDir,
    planInput,
    rows,
    snapshotRaw,
  };
}

function writePrivateJson(filename: string, value: unknown): void {
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function seedResolvedFinalState() {
  const fixture = seedSource(25);
  const stateRoot = path.join(fixture.root, 'retained-state');
  const planRoot = path.join(stateRoot, 'plans');
  const claimRoot = path.join(stateRoot, 'claims');
  const receiptRoot = path.join(stateRoot, 'receipts');
  fs.mkdirSync(planRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claimRoot, { mode: 0o700 });
  fs.mkdirSync(receiptRoot, { mode: 0o700 });
  const plan = inspectRoutingCalibrationExport(fixture.planInput);
  const partialOutput = `${fixture.outputPath}.partial`;
  const evidence = exportRoutingCalibrationCorpus({
    ...fixture.planInput,
    plan,
    ownerAuthorized: true,
    acknowledgedPlanDigest: plan.planDigest,
    partialOutputPath: partialOutput,
  });
  fs.renameSync(partialOutput, fixture.outputPath);
  const receipt = buildRoutingCalibrationExportReceipt({
    plan,
    evidence,
    completedAt: '2026-08-03T01:11:00.000Z',
    postflight: {
      selector: fixture.releaseDir,
      health: healthEvidence(),
      pm2: pm2Evidence(fixture.releaseDir),
    },
  });
  const pendingPlanPath = path.join(planRoot, `${TRANSACTION_ID}.json`);
  const claimPlanPath = path.join(claimRoot, `${TRANSACTION_ID}.plan.json`);
  const evidencePath = path.join(claimRoot, `${TRANSACTION_ID}.export-evidence.json`);
  const partialReceiptPath = path.join(receiptRoot, `${TRANSACTION_ID}.partial.json`);
  const receiptPath = path.join(receiptRoot, `${TRANSACTION_ID}.json`);
  const partialReceipt = buildRoutingCalibrationExportPartialReceipt({
    plan,
    status: 'exported_pending_post_health',
    startedAt: '2026-08-03T01:10:00.000Z',
    evidence,
  });
  writePrivateJson(pendingPlanPath, plan);
  writePrivateJson(claimPlanPath, plan);
  writePrivateJson(evidencePath, evidence);
  writePrivateJson(partialReceiptPath, partialReceipt);
  writePrivateJson(receiptPath, receipt);
  return {
    ...fixture,
    plan,
    evidence,
    receipt,
    stateInput: {
      releaseDir: fixture.releaseDir,
      planRoot,
      claimRoot,
      exportRoot: fixture.exportRoot,
      receiptRoot,
    },
    pendingPlanPath,
    claimPlanPath,
    evidencePath,
    partialReceiptPath,
    receiptPath,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('governed routing-calibration export operator', () => {
  it('ships one exact-artifact inspect/apply command with both shared locks and partial receipts', () => {
    expect(fs.existsSync(OPERATOR)).toBe(true);
    expect(fs.existsSync(REMOTE)).toBe(true);
    expect(fs.existsSync(HELPER)).toBe(true);
    expect(fs.existsSync(PRIVATE_DIR_TOOL)).toBe(true);

    const operator = fs.readFileSync(OPERATOR, 'utf8');
    const remote = fs.readFileSync(REMOTE, 'utf8');
    const helper = fs.readFileSync(HELPER, 'utf8');
    const privateDirectoryTool = fs.readFileSync(PRIVATE_DIR_TOOL, 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const releaseManifest = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/release-artifact-manifest.mjs'),
      'utf8',
    );
    const runbook = fs.readFileSync(
      path.join(ROOT, 'docs/release/chat-quality-operations.md'),
      'utf8',
    );

    expect(packageJson.scripts['release:routing-calibration-export']).toBe(
      'scripts/routing-calibration-export-operator.sh',
    );
    expect(releaseManifest).toContain("'scripts/routing-calibration-export-operator.sh'");
    expect(releaseManifest).toContain("'scripts/remote-routing-calibration-export-transaction.sh'");
    expect(releaseManifest).toContain("'scripts/lib/routing-calibration-export.mjs'");
    expect(releaseManifest).toContain("'scripts/lib/ensure-private-directory.py'");
    expect(operator).toContain('NEXUS_RELEASE_OWNER_AUTHORIZED=1');
    expect(operator).toContain('--ack-plan');
    expect(operator).toContain('systemd-run --user --quiet --collect --remain-after-exit');
    expect(operator).toContain('collect with the same tuple and plan digest');
    expect(operator).toContain('publish_private "$receipt_temp" "$LOCAL_RECEIPT"');
    expect(fs.statSync(OPERATOR).mode & 0o111).not.toBe(0);
    expect(fs.statSync(REMOTE).mode & 0o111).not.toBe(0);
    expect(remote).toContain('USER_RELEASE_LOCK="$HOME/.local/state/nexus-release/.release.lock"');
    expect(remote).toContain("ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'");
    expect(remote.indexOf('flock -n 9')).toBeLessThan(remote.indexOf('flock -n 8'));
    expect(remote).toContain('assert_lock_fd_matches_path 9');
    expect(remote).toContain('assert_lock_fd_matches_path 8');
    expect(helper).toContain('nexus.routing-calibration-export-partial.v1');
    expect(helper).toContain('nexus.routing-calibration-export-receipt.v1');
    expect(remote).toContain('collect_health_evidence "$HEALTH_AFTER"');
    expect(remote).toContain('resolve_exact_release');
    expect(remote).toContain("curl --noproxy '*' --fail");
    expect(remote).toContain('sequence.lastIssued !== plan.planSequence');
    expect(remote).toContain('observe it by transaction ID and never re-apply');
    expect(remote).toContain('emit_validated_artifact');
    expect(remote).toContain('--require-status=failed');
    expect(remote.indexOf('ATTEMPT_ACTIVE=true')).toBeLessThan(
      remote.indexOf('publish_private_file "$PARTIAL_TEMP" "$PARTIAL_RECEIPT"'),
    );
    expect(remote).toContain('ln -- "$PARTIAL_EXPORT" "$FINAL_EXPORT"');
    expect(remote).not.toContain('mv -T "$PARTIAL_EXPORT" "$FINAL_EXPORT"');
    expect(remote).toContain('--replace-private-file');
    expect(operator).toContain('ensure-private-directory.py');
    expect(remote).toContain('ensure-private-directory.py');
    expect(operator).not.toContain('install -d -m 700');
    expect(remote).not.toContain('install -d -m 700');
    expect(privateDirectoryTool).toContain('dir_fd=parent_fd');
    expect(privateDirectoryTool).toContain('NOFOLLOW = os.O_NOFOLLOW');
    expect(remote).toContain('assert-resolved-state');
    expect(runbook).toContain('release:routing-calibration-export');
    expect(runbook).toContain('release:routing-calibration-export -- collect');
    expect(runbook).toContain('Partial LLM-cache coverage is valid for export');
  });

  it('emits a deterministic redacted plan bound to 300 approved rows, partial cache, and accepted snapshot', () => {
    const fixture = seedSource(25);
    const first = inspectRoutingCalibrationExport(fixture.planInput);
    const second = inspectRoutingCalibrationExport(fixture.planInput);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: 'nexus.routing-calibration-export-plan.v1',
      operation: 'export_sanitized_routing_calibration_corpus',
      role: 'production',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      transactionId: TRANSACTION_ID,
      planSequence: 7,
      corpus: { rows: 300 },
      cache: { rows: 25, corpusRows: 300, complete: false },
      acceptedSnapshot: { itemCount: 300, llmCacheCovered: 25 },
      normalization: {
        createdAtBase: NORMALIZED_CREATED_AT,
        preserveLabeledAt: true,
        suggestedFields: null,
        providerModel: null,
      },
    });
    expect(first.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain(fixture.rows[0].utteranceText);
    expect(JSON.stringify(first)).not.toContain(PRIVATE_SNAPSHOT_SENTINEL);
    expect(first.acceptedSnapshot.jsonSha256).toBe(sha256(fixture.snapshotRaw));
  });

  it('never follows a directory or replacement symlink into its target', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'routing-export-no-follow-')),
    );
    temporaryRoots.push(root);
    fs.chmodSync(root, 0o755);
    const outsideDirectory = path.join(root, 'outside-directory');
    fs.mkdirSync(outsideDirectory, { mode: 0o755 });
    fs.symlinkSync(outsideDirectory, path.join(root, '.local'));
    const directoryAttempt = spawnSync(PYTHON, [
      '-B',
      PRIVATE_DIR_TOOL,
      '--anchor',
      root,
      '--exact-private',
      path.join(root, '.local/release/routing-calibration-export'),
    ], { encoding: 'utf8' });
    expect(directoryAttempt.status).toBe(1);
    expect(fs.lstatSync(outsideDirectory).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(outsideDirectory)).toEqual([]);

    const safeTarget = path.join(root, 'safe/evidence/receipts');
    const safeAttempt = spawnSync(PYTHON, [
      '-B',
      PRIVATE_DIR_TOOL,
      '--anchor',
      root,
      '--exact-private',
      safeTarget,
    ], { encoding: 'utf8' });
    expect(safeAttempt.status, safeAttempt.stderr).toBe(0);
    for (const directory of [
      path.join(root, 'safe'),
      path.join(root, 'safe/evidence'),
      safeTarget,
    ]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
    }

    const privateRoot = path.join(root, 'private');
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    const source = path.join(privateRoot, 'source.json');
    const protectedTarget = path.join(root, 'protected-target.json');
    const destination = path.join(privateRoot, 'destination.json');
    fs.writeFileSync(source, 'replacement\n', { mode: 0o600 });
    fs.writeFileSync(protectedTarget, 'must remain unchanged\n', { mode: 0o644 });
    fs.symlinkSync(protectedTarget, destination);
    const replaceAttempt = spawnSync(PYTHON, [
      '-B',
      PRIVATE_DIR_TOOL,
      '--replace-private-file',
      source,
      destination,
    ], { encoding: 'utf8' });
    expect(replaceAttempt.status).toBe(1);
    expect(fs.readFileSync(protectedTarget, 'utf8')).toBe('must remain unchanged\n');
    expect(fs.lstatSync(protectedTarget).mode & 0o777).toBe(0o644);
    fs.unlinkSync(destination);
    const validReplace = spawnSync(PYTHON, [
      '-B',
      PRIVATE_DIR_TOOL,
      '--replace-private-file',
      source,
      destination,
    ], { encoding: 'utf8' });
    expect(validReplace.status, validReplace.stderr).toBe(0);
    expect(fs.readFileSync(destination, 'utf8')).toBe('replacement\n');
    expect(fs.lstatSync(destination).mode & 0o777).toBe(0o600);
  });

  it('requires owner authorization and the exact plan before creating any export bytes', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);

    expect(() => exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: false,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath: `${fixture.outputPath}.partial`,
    })).toThrow(/owner authorization/i);
    expect(() => exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: `sha256:${'f'.repeat(64)}`,
      partialOutputPath: `${fixture.outputPath}.partial`,
    })).toThrow(/plan digest/i);
    expect(fs.existsSync(fixture.outputPath)).toBe(false);
    expect(fs.existsSync(`${fixture.outputPath}.partial`)).toBe(false);
  });

  it('exports only the 300 approved rows and 25 matching cache rows while preserving identity', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const partialOutputPath = `${fixture.outputPath}.partial`;
    const evidence = exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath,
    });

    expect(evidence).toMatchObject({
      schema: 'nexus.routing-calibration-export-evidence.v1',
      corpusRows: 300,
      cacheRows: 25,
      acceptedSnapshotRows: 0,
      corpusIdentityDigest: plan.corpus.identityDigest,
      cacheRowsDigest: plan.cache.rowsDigest,
      integrity: 'ok',
      foreignKeys: 'ok',
      providerCalls: 0,
    });
    const stat = fs.lstatSync(partialOutputPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);

    const exported = new Database(partialOutputPath, { readonly: true });
    const tables = exported.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'accepted_accuracy_snapshots',
      'routing_corpus_items',
      'routing_llm_classify_cache',
    ]);
    expect(exported.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get())
      .toEqual({ count: 300 });
    expect(exported.prepare('SELECT COUNT(*) AS count FROM routing_llm_classify_cache').get())
      .toEqual({ count: 25 });
    expect(exported.prepare('SELECT COUNT(*) AS count FROM accepted_accuracy_snapshots').get())
      .toEqual({ count: 0 });
    expect(exported.prepare(`
      SELECT COUNT(*) AS count FROM routing_corpus_items
      WHERE suggested_domain IS NOT NULL OR suggested_skill IS NOT NULL
    `).get()).toEqual({ count: 0 });
    expect(exported.prepare(`
      SELECT COUNT(*) AS count FROM routing_llm_classify_cache WHERE model IS NOT NULL
    `).get()).toEqual({ count: 0 });
    const exportedRows = exported.prepare(`
      SELECT labeled_at AS labeledAt, created_at AS createdAt
      FROM routing_corpus_items ORDER BY created_at ASC, id ASC
    `).all() as Array<{ labeledAt: string; createdAt: string }>;
    expect(exportedRows.map((row) => row.labeledAt)).toEqual(
      [...fixture.rows]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id - right.id)
        .map((row) => row.labeledAt),
    );
    expect(new Set(exportedRows.map((row) => row.createdAt)).size).toBe(300);
    exported.close();
    const exportedBytes = fs.readFileSync(partialOutputPath);
    for (const sentinel of [
      PRIVATE_PENDING_SENTINEL,
      PRIVATE_CACHE_SENTINEL,
      PRIVATE_UNMATCHED_CACHE_SENTINEL,
      PRIVATE_SNAPSHOT_SENTINEL,
    ]) {
      expect(exportedBytes.includes(Buffer.from(sentinel))).toBe(false);
    }
  });

  it('fails closed when source cache state changes after inspect', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const db = new Database(fixture.dbPath);
    db.prepare('UPDATE routing_llm_classify_cache SET confidence = 0.01 LIMIT 1').run();
    db.close();

    expect(() => exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath: `${fixture.outputPath}.partial`,
    })).toThrow(/source state changed/i);
    expect(fs.existsSync(`${fixture.outputPath}.partial`)).toBe(false);
  });

  it('builds distinct partial and final receipt schemas bound to postflight evidence', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const evidence = exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath: `${fixture.outputPath}.partial`,
    });
    const partial = buildRoutingCalibrationExportPartialReceipt({
      plan,
      status: 'exported_pending_post_health',
      startedAt: '2026-08-03T01:10:00.000Z',
      evidence,
    });
    const final = buildRoutingCalibrationExportReceipt({
      plan,
      evidence,
      completedAt: '2026-08-03T01:11:00.000Z',
      postflight: {
        selector: fixture.planInput.releaseDir,
        health: healthEvidence(),
        pm2: pm2Evidence(fixture.planInput.releaseDir),
      },
    });

    expect(partial).toMatchObject({
      schema: 'nexus.routing-calibration-export-partial.v1',
      status: 'exported_pending_post_health',
      planDigest: plan.planDigest,
    });
    expect(final).toMatchObject({
      schema: 'nexus.routing-calibration-export-receipt.v1',
      status: 'passed',
      planDigest: plan.planDigest,
      outputSha256: evidence.outputSha256,
      cacheComplete: false,
      providerCalled: false,
      postflight: { selector: plan.releaseDir },
    });
    expect(final.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('collects only a terminal failed partial receipt', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const planFile = path.join(fixture.exportRoot, 'plan.json');
    const receiptFile = path.join(fixture.exportRoot, 'partial.json');
    fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
    const started = buildRoutingCalibrationExportPartialReceipt({
      plan,
      status: 'started',
      startedAt: '2026-08-03T01:10:00.000Z',
    });
    fs.writeFileSync(receiptFile, JSON.stringify(started), { mode: 0o600 });
    const rejected = spawnSync(process.execPath, [
      HELPER,
      'validate-partial',
      `--receipt-file=${receiptFile}`,
      `--plan-file=${planFile}`,
      '--require-status=failed',
    ], { encoding: 'utf8' });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('not required failed');

    const failed = buildRoutingCalibrationExportPartialReceipt({
      plan,
      status: 'failed',
      startedAt: '2026-08-03T01:10:00.000Z',
    });
    fs.writeFileSync(receiptFile, JSON.stringify(failed), { mode: 0o600 });
    const accepted = spawnSync(process.execPath, [
      HELPER,
      'validate-partial',
      `--receipt-file=${receiptFile}`,
      `--plan-file=${planFile}`,
      '--require-status=failed',
    ], { encoding: 'utf8' });
    expect(accepted.status).toBe(0);
  });

  it('recovers only the exact hard-link pair left by an interrupted publication', () => {
    const fixture = seedSource(25);
    const publicationRoot = path.join(fixture.root, 'publication');
    fs.mkdirSync(publicationRoot, { mode: 0o700 });
    const source = path.join(publicationRoot, 'source.json');
    const destination = path.join(publicationRoot, 'receipt.json');
    const orphan = path.join(publicationRoot, '.receipt.json.next-123-abcdef123456');
    fs.writeFileSync(source, '{"status":"passed"}\n', { mode: 0o600 });
    fs.writeFileSync(orphan, fs.readFileSync(source), { mode: 0o600 });
    fs.linkSync(orphan, destination);
    expect(fs.lstatSync(destination).nlink).toBe(2);

    expect(publishPrivateEvidenceFile({
      sourcePath: source,
      destinationPath: destination,
    })).toMatchObject({ status: 'already_published' });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.lstatSync(destination).nlink).toBe(1);

    const unpublishedDestination = path.join(publicationRoot, 'sequence.json');
    const unpublishedTemporary = path.join(
      publicationRoot,
      '.sequence.json.next-999-111111111111',
    );
    fs.writeFileSync(unpublishedTemporary, '{"lastIssued":7}\n', { mode: 0o600 });
    expect(recoverPrivateEvidencePublication({
      destinationPath: unpublishedDestination,
    })).toMatchObject({ status: 'discarded_unpublished_temporary' });
    expect(fs.existsSync(unpublishedTemporary)).toBe(false);
    expect(fs.existsSync(unpublishedDestination)).toBe(false);
  });

  it('refuses a missing, truncated, or reset durable plan sequence', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'routing-export-sequence-')),
    );
    temporaryRoots.push(root);
    fs.chmodSync(root, 0o700);
    const roots = Object.fromEntries(['plan', 'claim', 'export', 'receipt'].map((kind) => {
      const directory = path.join(root, `${kind}s`);
      fs.mkdirSync(directory, { mode: 0o700 });
      return [`${kind}Root`, directory];
    })) as Record<string, string>;
    const sequencePath = path.join(root, 'sequence.json');
    const input = { sequencePath, ...roots };
    expect(nextRoutingCalibrationExportPlanSequence(input)).toBe(1);

    fs.writeFileSync(sequencePath, '{', { mode: 0o600 });
    expect(() => nextRoutingCalibrationExportPlanSequence(input)).toThrow();
    fs.writeFileSync(sequencePath, JSON.stringify({
      schema: 'nexus.routing-calibration-export-sequence.v1',
      lastIssued: 7,
    }), { mode: 0o600 });
    const retainedPlan = path.join(roots.planRoot, `${TRANSACTION_ID}.json`);
    fs.writeFileSync(retainedPlan, JSON.stringify({
      schema: 'nexus.routing-calibration-export-plan.v1',
      transactionId: TRANSACTION_ID,
      planSequence: 7,
    }), { mode: 0o600 });
    expect(nextRoutingCalibrationExportPlanSequence(input)).toBe(8);
    fs.writeFileSync(sequencePath, JSON.stringify({
      schema: 'nexus.routing-calibration-export-sequence.v1',
      lastIssued: 6,
    }), { mode: 0o600 });
    expect(() => nextRoutingCalibrationExportPlanSequence(input)).toThrow(/reset/i);
    fs.unlinkSync(sequencePath);
    expect(() => nextRoutingCalibrationExportPlanSequence(input)).toThrow(/missing/i);
  });

  it('recognizes a reused Linux descriptor number only when its identity changed', () => {
    const anchor = { dev: 4, ino: 99 };
    const before = new Map([[12, { dev: 4, ino: 12 }]]);
    const afterReuse = new Map([[12, anchor]]);
    expect(findAnchoredSqliteDescriptor(before, afterReuse, 9, anchor)).toBe(12);
    expect(findAnchoredSqliteDescriptor(
      new Map([[12, anchor]]),
      afterReuse,
      9,
      anchor,
    )).toBeNull();
  });

  it.each([
    {
      name: 'an added routing column',
      mutate: (db: Database.Database) => db.exec(
        'ALTER TABLE routing_llm_classify_cache ADD COLUMN private_note TEXT',
      ),
      error: /schema differs/i,
    },
    {
      name: 'a trigger observing a protected routing table',
      mutate: (db: Database.Database) => db.exec(`
        CREATE TRIGGER routing_corpus_observer
        AFTER UPDATE ON routing_corpus_items
        BEGIN SELECT 1; END
      `),
      error: /unexpected trigger or view/i,
    },
  ])('rejects source schema drift from $name', ({ mutate, error }) => {
    const fixture = seedSource(25);
    const db = new Database(fixture.dbPath);
    mutate(db);
    db.close();

    expect(() => inspectRoutingCalibrationExport(fixture.planInput)).toThrow(error);
  });

  it('rejects an ungoverned matching-cache domain and a corrupt accepted snapshot', () => {
    const invalidDomain = seedSource(25);
    const domainDb = new Database(invalidDomain.dbPath);
    domainDb.prepare(`
      UPDATE routing_llm_classify_cache
      SET domain = 'private_unapproved_domain'
      WHERE utterance_hash IN (
        SELECT utterance_hash FROM routing_corpus_items WHERE label_status = 'labeled'
      )
      LIMIT 1
    `).run();
    domainDb.close();
    expect(() => inspectRoutingCalibrationExport(invalidDomain.planInput))
      .toThrow(/matching LLM-cache row is invalid/i);

    const corruptSnapshot = seedSource(25);
    const snapshotDb = new Database(corruptSnapshot.dbPath);
    snapshotDb.prepare(`
      UPDATE accepted_accuracy_snapshots SET snapshot_json = ? WHERE accepted = 1
    `).run(JSON.stringify({ version: 'routing-accuracy@1.1.0', itemCount: 300 }));
    snapshotDb.close();
    expect(() => inspectRoutingCalibrationExport(corruptSnapshot.planInput))
      .toThrow(/canonical contract/i);
  });

  it('refuses destination symlinks, hard links, and a swapped destination parent', () => {
    const symlinkFixture = seedSource(25);
    const symlinkPlan = inspectRoutingCalibrationExport(symlinkFixture.planInput);
    fs.symlinkSync('/dev/null', `${symlinkFixture.outputPath}.partial`);
    expect(() => exportRoutingCalibrationCorpus({
      ...symlinkFixture.planInput,
      plan: symlinkPlan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: symlinkPlan.planDigest,
      partialOutputPath: `${symlinkFixture.outputPath}.partial`,
    })).toThrow(/output already exists/i);

    const hardLinkFixture = seedSource(25);
    const hardLinkPlan = inspectRoutingCalibrationExport(hardLinkFixture.planInput);
    const hardLinkOutput = `${hardLinkFixture.outputPath}.partial`;
    const hardLinkEvidence = exportRoutingCalibrationCorpus({
      ...hardLinkFixture.planInput,
      plan: hardLinkPlan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: hardLinkPlan.planDigest,
      partialOutputPath: hardLinkOutput,
    });
    fs.linkSync(hardLinkOutput, path.join(hardLinkFixture.exportRoot, 'unexpected-link.sqlite'));
    expect(() => verifyRoutingCalibrationExport({
      plan: hardLinkPlan,
      evidence: hardLinkEvidence,
      releaseDir: hardLinkFixture.releaseDir,
      outputPath: hardLinkOutput,
    })).toThrow(/single-link/i);

    const raceFixture = seedSource(25);
    const racePlan = inspectRoutingCalibrationExport(raceFixture.planInput);
    const displacedExportRoot = `${raceFixture.exportRoot}.displaced`;
    expect(() => exportRoutingCalibrationCorpus({
      ...raceFixture.planInput,
      afterSourceAnchorOpened: () => {
        fs.renameSync(raceFixture.exportRoot, displacedExportRoot);
        fs.mkdirSync(raceFixture.exportRoot, { mode: 0o700 });
      },
      plan: racePlan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: racePlan.planDigest,
      partialOutputPath: `${raceFixture.outputPath}.partial`,
    })).toThrow(/export root identity|partial export parent identity/i);
  });

  it('binds every security-relevant final receipt field to exact evidence', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const evidence = exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath: `${fixture.outputPath}.partial`,
    });
    const receipt = buildRoutingCalibrationExportReceipt({
      plan,
      evidence,
      completedAt: '2026-08-03T01:11:00.000Z',
      postflight: {
        selector: fixture.releaseDir,
        health: healthEvidence(),
        pm2: pm2Evidence(fixture.releaseDir),
      },
    });
    expect(validateRoutingCalibrationExportReceipt(receipt, plan, evidence)).toEqual(receipt);

    const mutations: Array<(candidate: typeof receipt) => void> = [
      (candidate) => { candidate.runtimeSha = 'c'.repeat(40); },
      (candidate) => { candidate.cacheRows += 1; },
      (candidate) => { candidate.outputSha256 = `sha256:${'d'.repeat(64)}`; },
      (candidate) => { candidate.normalization.providerModel = 'private-model'; },
      (candidate) => { candidate.preflight.health.status = 'unhealthy'; },
      (candidate) => { candidate.preflight.pm2.processes[0].cwd = fixture.releaseDir; },
      (candidate) => { candidate.postflight.health.database = 'disconnected'; },
      (candidate) => {
        candidate.postflight.pm2.processes[1].cwd = `${fixture.releaseDir}/content-engine`;
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(receipt);
      mutate(candidate);
      candidate.preflight.healthSha256 = sha256Digest(canonicalJson(candidate.preflight.health));
      candidate.preflight.pm2Sha256 = sha256Digest(canonicalJson(candidate.preflight.pm2));
      candidate.postflight.healthSha256 = sha256Digest(canonicalJson(candidate.postflight.health));
      candidate.postflight.pm2Sha256 = sha256Digest(canonicalJson(candidate.postflight.pm2));
      const { receiptDigest: _discarded, ...body } = candidate;
      candidate.receiptDigest = sha256Digest(canonicalJson(body));
      expect(() => validateRoutingCalibrationExportReceipt(candidate, plan, evidence)).toThrow();
    }
  });

  it('requires explicit copied-evidence mode for a locally transferred export', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const remoteOutput = `${fixture.outputPath}.partial`;
    const evidence = exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath: remoteOutput,
    });
    const copiedRoot = path.join(fixture.root, 'copied-evidence');
    fs.mkdirSync(copiedRoot, { mode: 0o700 });
    const copiedOutput = path.join(copiedRoot, 'routing.sqlite');
    fs.copyFileSync(remoteOutput, copiedOutput);
    fs.chmodSync(copiedOutput, 0o600);

    expect(() => verifyRoutingCalibrationExport({
      plan,
      evidence,
      releaseDir: fixture.releaseDir,
      outputPath: copiedOutput,
    })).toThrow(/parent identity/i);
    expect(verifyRoutingCalibrationExport({
      plan,
      evidence,
      releaseDir: fixture.releaseDir,
      outputPath: copiedOutput,
      copiedEvidence: true,
    })).toEqual(evidence);
  });

  it('feeds the partial 25/300 export into calibration with zero provider work', () => {
    const fixture = seedSource(25);
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const outputPath = `${fixture.outputPath}.partial`;
    const evidence = exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath: outputPath,
    });
    expect(evidence.providerCalls).toBe(0);
    const receipt = buildRoutingCalibrationExportReceipt({
      plan,
      evidence,
      completedAt: new Date(Date.parse(GENERATED_AT) + 30_000).toISOString(),
      postflight: {
        selector: fixture.releaseDir,
        health: healthEvidence(),
        pm2: pm2Evidence(fixture.releaseDir),
      },
    });
    const baselineDirectory = path.join(fixture.root, 'private-baseline');
    fs.mkdirSync(baselineDirectory, { mode: 0o700 });
    const baselinePath = path.join(baselineDirectory, 'reviewed-calibration-baseline.json');
    const reviewedPredecessor = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    reviewedPredecessor.provenance = {
      source: 'corpus',
      corpusSize: 300,
      generatedAt: '2026-07-30T08:34:49.775Z',
    };
    reviewedPredecessor.intentResolver.scoreBuckets = [
      { minScore: 5, calibratedPrecision: 0.8846 },
      { minScore: 2, calibratedPrecision: 0.8984 },
      { minScore: 1, calibratedPrecision: 0.7551 },
      { minScore: 0, calibratedPrecision: 0.1778 },
    ];
    const baselineBytes = `${JSON.stringify(reviewedPredecessor, null, 2)}\n`;
    fs.writeFileSync(
      baselinePath,
      baselineBytes,
      { encoding: 'utf8', mode: 0o600 },
    );
    const planPath = path.join(baselineDirectory, 'export-plan.json');
    const evidencePath = path.join(baselineDirectory, 'export-evidence.json');
    const receiptPath = path.join(baselineDirectory, 'export-receipt.json');
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    const calibration = spawnSync(process.execPath, [
      '--import',
      'tsx',
      path.join(ROOT, 'scripts/calibrate-routing-confidence.ts'),
      `--db=${outputPath}`,
      `--baseline=${baselinePath}`,
      `--out=${path.join(baselineDirectory, 'calibration-output.json')}`,
      '--dry-run',
      '--generated-at=2026-08-03T01:12:00.000Z',
      `--export-plan=${planPath}`,
      `--export-evidence=${evidencePath}`,
      `--export-receipt=${receiptPath}`,
      `--ack-plan=${plan.planDigest}`,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IOS_API_ENABLED: 'false',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GEMINI_API_KEY: '',
      },
      encoding: 'utf8',
    });
    expect(calibration.status, calibration.stderr).toBe(0);
    const result = JSON.parse(calibration.stdout);
    expect(result).toMatchObject({
      mode: 'corpus',
      labeledCorpusItems: 300,
      providerCalls: 0,
      reviewedExportIdentity: {
        runtimeSha: plan.runtimeSha,
        artifactDigest: plan.artifactDigest,
        transactionId: plan.transactionId,
        planDigest: plan.planDigest,
        receiptDigest: receipt.receiptDigest,
        inputSha256: evidence.outputSha256.slice('sha256:'.length),
        corpusRows: 300,
        corpusIdentityDigest: plan.corpus.identityDigest,
        cacheRowsDigest: plan.cache.rowsDigest,
        cacheRows: plan.cache.rows,
        providerCalls: 0,
      },
      llmCoverage: {
        covered: 25,
        total: 300,
        complete: false,
        classifierFloorCalibrated: false,
      },
    });
    expect(`sha256:${result.inputSha256}`).toBe(evidence.outputSha256);
    expect(result.baselineSha256).toBe(
      createHash('sha256').update(baselineBytes).digest('hex'),
    );
    expect(`sha256:${result.outputSha256}`).toBe(
      sha256(`${JSON.stringify(result.table, null, 2)}\n`),
    );
    expect(result.table.classifier.lowConfidenceFloor).toBe(0.6);
    expect(result.table.intentResolver.scoreBuckets.slice(0, 2)).toEqual([
      { minScore: 5, calibratedPrecision: 0.943 },
      { minScore: 2, calibratedPrecision: 0.943 },
    ]);
  });

  it.each([
    {
      name: 'truncated final receipt',
      mutate: (state: ReturnType<typeof seedResolvedFinalState>) => {
        fs.writeFileSync(state.receiptPath, '{');
      },
    },
    {
      name: 'corrupt export evidence',
      mutate: (state: ReturnType<typeof seedResolvedFinalState>) => {
        fs.writeFileSync(state.evidencePath, '{"schema":"wrong"}\n');
      },
    },
    {
      name: 'corrupt SQLite bytes',
      mutate: (state: ReturnType<typeof seedResolvedFinalState>) => {
        fs.writeFileSync(state.outputPath, 'not a sqlite database');
      },
    },
  ])('refuses retained state with $name', ({ mutate }) => {
    const state = seedResolvedFinalState();
    expect(assertRoutingCalibrationExportStateResolved(state.stateInput))
      .toEqual({ attemptedTransactions: 1, status: 'resolved' });
    mutate(state);
    expect(() => assertRoutingCalibrationExportStateResolved(state.stateInput)).toThrow();
  });

  it('rejects stale partial output, divergent retained plans, and contradictory partial state', () => {
    const staleOutput = seedResolvedFinalState();
    fs.copyFileSync(staleOutput.outputPath, `${staleOutput.outputPath}.partial`);
    fs.chmodSync(`${staleOutput.outputPath}.partial`, 0o600);
    expect(() => assertRoutingCalibrationExportStateResolved(staleOutput.stateInput))
      .toThrow(/partial|ambiguous/i);

    const divergentPlan = seedResolvedFinalState();
    const pending = structuredClone(divergentPlan.plan);
    pending.planSequence -= 1;
    const { planDigest: _oldPlanDigest, ...pendingBody } = pending;
    pending.planDigest = sha256Digest(canonicalJson(pendingBody));
    writePrivateJson(divergentPlan.pendingPlanPath, pending);
    expect(() => assertRoutingCalibrationExportStateResolved(divergentPlan.stateInput))
      .toThrow(/pending|claimed|retained/i);

    const contradictoryPartial = seedResolvedFinalState();
    writePrivateJson(
      contradictoryPartial.partialReceiptPath,
      buildRoutingCalibrationExportPartialReceipt({
        plan: contradictoryPartial.plan,
        status: 'failed',
        startedAt: '2026-08-03T01:10:00.000Z',
      }),
    );
    expect(() => assertRoutingCalibrationExportStateResolved(
      contradictoryPartial.stateInput,
    )).toThrow(/partial|contradictory/i);
  });

  it('rejects a failed partial receipt bound to another transaction', () => {
    const fixture = seedSource(25);
    const stateRoot = path.join(fixture.root, 'failed-retained-state');
    const planRoot = path.join(stateRoot, 'plans');
    const claimRoot = path.join(stateRoot, 'claims');
    const receiptRoot = path.join(stateRoot, 'receipts');
    fs.mkdirSync(planRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(claimRoot, { mode: 0o700 });
    fs.mkdirSync(receiptRoot, { mode: 0o700 });
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    writePrivateJson(path.join(planRoot, `${TRANSACTION_ID}.json`), plan);
    const valid = buildRoutingCalibrationExportPartialReceipt({
      plan,
      status: 'failed',
      startedAt: '2026-08-03T01:10:00.000Z',
    });
    const stateInput = {
      releaseDir: fixture.releaseDir,
      planRoot,
      claimRoot,
      exportRoot: fixture.exportRoot,
      receiptRoot,
    };
    const partialPath = path.join(receiptRoot, `${TRANSACTION_ID}.partial.json`);
    writePrivateJson(partialPath, valid);
    expect(assertRoutingCalibrationExportStateResolved(stateInput))
      .toEqual({ attemptedTransactions: 1, status: 'resolved' });

    const mismatch = structuredClone(valid);
    mismatch.transactionId = '20260803T010203Z-111111111111';
    const { partialReceiptDigest: _oldDigest, ...body } = mismatch;
    mismatch.partialReceiptDigest = sha256Digest(canonicalJson(body));
    writePrivateJson(partialPath, mismatch);
    expect(() => assertRoutingCalibrationExportStateResolved(stateInput)).toThrow();
  });

  it('rejects retained export evidence that has no durable one-shot claim', () => {
    const fixture = seedSource(25);
    const stateRoot = path.join(fixture.root, 'unclaimed-evidence-state');
    const planRoot = path.join(stateRoot, 'plans');
    const claimRoot = path.join(stateRoot, 'claims');
    const receiptRoot = path.join(stateRoot, 'receipts');
    fs.mkdirSync(planRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(claimRoot, { mode: 0o700 });
    fs.mkdirSync(receiptRoot, { mode: 0o700 });
    const plan = inspectRoutingCalibrationExport(fixture.planInput);
    const outputPath = `${fixture.outputPath}.partial`;
    const evidence = exportRoutingCalibrationCorpus({
      ...fixture.planInput,
      plan,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
      partialOutputPath: outputPath,
    });
    writePrivateJson(path.join(planRoot, `${TRANSACTION_ID}.json`), plan);
    writePrivateJson(
      path.join(claimRoot, `${TRANSACTION_ID}.export-evidence.json`),
      evidence,
    );
    writePrivateJson(
      path.join(receiptRoot, `${TRANSACTION_ID}.partial.json`),
      buildRoutingCalibrationExportPartialReceipt({
        plan,
        status: 'failed',
        startedAt: '2026-08-03T01:10:00.000Z',
        evidence,
      }),
    );
    expect(() => assertRoutingCalibrationExportStateResolved({
      releaseDir: fixture.releaseDir,
      planRoot,
      claimRoot,
      exportRoot: fixture.exportRoot,
      receiptRoot,
    })).toThrow(/one-shot claim/i);
  });
});
