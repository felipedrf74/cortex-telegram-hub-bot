import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ROUTING_CALIBRATION_SANITIZED_SCHEMA,
  buildRoutingCalibrationExportReceipt,
  canonicalJson,
  routingCalibrationCacheRowsDigest,
  routingCalibrationCorpusIdentityDigest,
  sha256Digest,
} from '../../scripts/lib/routing-calibration-export.mjs';
import { BOOTSTRAP_ROUTING_CALIBRATION } from '../../src/services/intent-resolution/confidence';
import { listLabeledRoutingCorpusItems } from '../../src/services/routing-corpus';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/calibrate-routing-confidence.ts');
const tempDirectories: string[] = [];
let cliInvocation = 0;
let exportArtifactInvocation = 0;

function dynamicImportStandaloneScopes(raw: string, modulePath: string): boolean[] {
  const source = ts.createSourceFile(
    'standalone-tool.ts',
    raw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const scopes: boolean[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === modulePath
    ) {
      let current: ts.Node | undefined = node.parent;
      let insideStandaloneCallback = false;
      while (current) {
        if (
          (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
          && ts.isCallExpression(current.parent)
          && ts.isIdentifier(current.parent.expression)
          && current.parent.expression.text === 'withStandaloneToolDatabaseAsync'
          && current.parent.arguments[1] === current
        ) {
          insideStandaloneCallback = true;
          break;
        }
        current = current.parent;
      }
      scopes.push(insideStandaloneCallback);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scopes;
}

function createCorpusDatabase(labeled: boolean): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calibration-cli-')),
  );
  tempDirectories.push(directory);
  const dbPath = path.join(directory, 'routing.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(ROUTING_CALIBRATION_SANITIZED_SCHEMA);
    if (labeled) {
      const insert = db.prepare(`
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source,
          label_domain, label_skill, label_status, labeled_at, created_at
        ) VALUES (0, NULL, ?, ?, 'manual',
          'secretary', NULL, 'labeled', ?, ?)
      `);
      for (let index = 0; index < 300; index += 1) {
        const timestamp = new Date(Date.parse('2026-07-30T00:00:00.000Z') + index * 1000)
          .toISOString();
        insert.run(
          createHash('sha256').update(`fixture-${index}`).digest('hex'),
          `show my agenda reference ${index}`,
          timestamp,
          timestamp,
        );
      }
    }
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
}

function createCalibrationBaseline(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calibration-baseline-')),
  );
  tempDirectories.push(directory);
  const baselinePath = path.join(directory, 'routing-calibration-baseline.json');
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return baselinePath;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function reviewedExportArtifactArgs(dbPath: string): string[] {
  exportArtifactInvocation += 1;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const corpusRows = listLabeledRoutingCorpusItems(db, { ensureTables: false });
    const cacheRows = db.prepare(`
      SELECT utterance_hash AS utteranceHash, domain, confidence,
             model, created_at AS createdAt
      FROM routing_llm_classify_cache ORDER BY utterance_hash ASC
    `).all();
    const root = path.dirname(dbPath);
    const artifactDirectory = path.join(
      root,
      `reviewed-export-${exportArtifactInvocation}`,
    );
    fs.mkdirSync(artifactDirectory, { mode: 0o700 });
    const runtimeSha = 'a'.repeat(40);
    const artifactDigest = 'b'.repeat(64);
    const transactionId = '20260730T000000Z-abcdef123456';
    const releaseDir = path.join(
      artifactDirectory,
      `${runtimeSha}-${artifactDigest.slice(0, 12)}`,
    );
    fs.mkdirSync(releaseDir, { mode: 0o700 });
    const health = {
      schema: 'nexus.routing-calibration-export-health-evidence.v1',
      status: 'healthy',
      database: 'connected',
      databaseProbe: 'connected',
      contentHealth: 'passed',
      role: 'production',
      runtimeSha,
      artifactDigest,
      releaseAttestationSchema: 'nexus.chat-capability-release-attestation.v2',
    };
    const pm2 = {
      schema: 'nexus.routing-calibration-export-pm2-evidence.v1',
      role: 'production',
      runtimeSha,
      artifactDigest,
      processes: [
        {
          name: 'content-engine',
          status: 'online',
          cwd: `${releaseDir}/content-engine`,
          runtimeSha,
          artifactDigest,
        },
        {
          name: 'nexus-hub',
          status: 'online',
          cwd: releaseDir,
          runtimeSha,
          artifactDigest,
        },
      ],
    };
    const corpusIdentityDigest = routingCalibrationCorpusIdentityDigest(corpusRows);
    const cacheRowsDigest = routingCalibrationCacheRowsDigest(cacheRows);
    const acceptedSnapshotJsonSha256 = `sha256:${'c'.repeat(64)}`;
    const productionBaseDir = path.join(artifactDirectory, 'production');
    const sourceDataRoot = path.join(productionBaseDir, 'data');
    const sourceDatabasePath = path.join(sourceDataRoot, 'bot.db');
    const exportRoot = path.join(artifactDirectory, 'exports');
    const outputPath = path.join(exportRoot, `${transactionId}.sqlite`);
    const preflight = {
      selector: releaseDir,
      health,
      healthSha256: sha256Digest(canonicalJson(health)),
      pm2,
      pm2Sha256: sha256Digest(canonicalJson(pm2)),
    };
    const planBody = {
      schema: 'nexus.routing-calibration-export-plan.v1',
      operation: 'export_sanitized_routing_calibration_corpus',
      role: 'production',
      runtimeSha,
      artifactDigest,
      transactionId,
      planSequence: 1,
      releaseDir,
      operatorSha256: `sha256:${'d'.repeat(64)}`,
      helperSha256: `sha256:${'e'.repeat(64)}`,
      preflight,
      containment: {
        productionBaseDir,
        sourceDataRoot,
        sourceDataRootDevice: '1',
        sourceDataRootInode: '2',
        sourceDatabasePath,
        exportRoot,
        exportRootDevice: '1',
        exportRootInode: '3',
      },
      database: {
        path: sourceDatabasePath,
        device: '1',
        inode: '4',
        mode: '0600',
        integrity: 'ok',
        foreignKeys: 'ok',
      },
      corpus: { rows: 300, identityDigest: corpusIdentityDigest },
      cache: {
        rows: cacheRows.length,
        corpusRows: 300,
        coverage: cacheRows.length / 300,
        complete: cacheRows.length === 300,
        rowsDigest: cacheRowsDigest,
      },
      acceptedSnapshot: {
        acceptedRows: 1,
        latestId: 1,
        jsonSha256: acceptedSnapshotJsonSha256,
        itemCount: 300,
        llmCacheCovered: cacheRows.length,
        corpusIdentityDigest,
      },
      normalization: {
        createdAtBase: '1970-01-01T00:00:00.000Z',
        createdAtOrder: 'source_corpus_order_then_cache_hash_order',
        preserveLabeledAt: true,
        suggestedFields: null,
        providerModel: null,
      },
      output: {
        path: outputPath,
        mode: '0600',
        corpusRows: 300,
        cacheRows: cacheRows.length,
        acceptedSnapshotRows: 0,
      },
      providerCalls: 0,
      generatedAt: '2026-07-30T00:00:00.000Z',
      expiresAt: '2026-07-30T00:30:00.000Z',
    };
    const plan = {
      ...planBody,
      planDigest: sha256Digest(canonicalJson(planBody)),
    };
    const databaseBytes = fs.readFileSync(dbPath);
    const evidence = {
      schema: 'nexus.routing-calibration-export-evidence.v1',
      outputPath,
      outputSha256: sha256Digest(databaseBytes),
      outputBytes: databaseBytes.length,
      outputMode: '0600',
      corpusRows: 300,
      cacheRows: cacheRows.length,
      cacheCoverage: cacheRows.length / 300,
      cacheComplete: cacheRows.length === 300,
      acceptedSnapshotRows: 0,
      corpusIdentityDigest,
      cacheRowsDigest,
      acceptedSnapshotJsonSha256,
      integrity: 'ok',
      foreignKeys: 'ok',
      providerCalls: 0,
      providerCalled: false,
      externalCallPerformed: false,
    };
    const receipt = buildRoutingCalibrationExportReceipt({
      plan,
      evidence,
      completedAt: '2026-07-30T00:01:00.000Z',
      postflight: { selector: releaseDir, health, pm2 },
    });
    const planPath = path.join(artifactDirectory, 'plan.json');
    const evidencePath = path.join(artifactDirectory, 'evidence.json');
    const receiptPath = path.join(artifactDirectory, 'receipt.json');
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return [
      `--export-plan=${planPath}`,
      `--export-evidence=${evidencePath}`,
      `--export-receipt=${receiptPath}`,
      `--ack-plan=${plan.planDigest}`,
    ];
  } finally {
    db.close();
  }
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  cliInvocation += 1;
  const outputDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calibration-test-output-')),
  );
  tempDirectories.push(outputDirectory);
  const isolatedArgs = args.some((arg) => arg === '--out' || arg.startsWith('--out='))
    ? args
    : [
      ...args,
      `--out=${path.join(
        outputDirectory,
        `routing-calibration-${process.pid}-${cliInvocation}.json`,
      )}`,
    ];
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT_PATH, ...isolatedArgs], {
    cwd: process.cwd(),
    // This standalone calibration CLI does not exercise the iOS API. Keep the
    // subprocess hermetic when a developer's local .env enables that API.
    env: {
      ...env,
      NODE_ENV: 'test',
      IOS_API_ENABLED: env.IOS_API_ENABLED ?? 'false',
    },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('calibrate-routing-confidence operational CLI', () => {
  it('rejects a non-canonical generated-at timestamp', () => {
    const result = runCli([
      '--bootstrap',
      '--dry-run',
      '--generated-at=July 30 2026',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--generated-at must be a canonical UTC ISO timestamp with milliseconds',
    );
  });

  it('refuses a missing corpus database unless bootstrap mode is explicit', () => {
    const missingPath = path.join(
      os.tmpdir(),
      `nexus-missing-calibration-${process.pid}-${Date.now()}.sqlite`,
    );
    const result = runCli([`--db=${missingPath}`, '--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Routing corpus database does not exist; use --bootstrap only for explicit bootstrap emission',
    );
  });

  it('refuses an empty corpus instead of silently emitting bootstrap output', () => {
    const dbPath = createCorpusDatabase(false);
    const result = runCli([`--db=${dbPath}`, '--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Routing corpus database has no labeled items; use --bootstrap only for explicit bootstrap emission',
    );
  });

  it('requires a reviewed generated-at value in corpus mode', () => {
    const dbPath = createCorpusDatabase(true);
    const result = runCli([`--db=${dbPath}`, '--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Corpus-mode calibration requires --generated-at=<canonical UTC ISO timestamp>',
    );
  });

  it('uses the explicit database instead of DATABASE_PATH', () => {
    const explicitDbPath = createCorpusDatabase(true);
    const defaultDbPath = createCorpusDatabase(false);
    const baselinePath = createCalibrationBaseline();
    const result = runCli([
      `--db=${explicitDbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...reviewedExportArtifactArgs(explicitDbPath),
    ], {
      ...process.env,
      DATABASE_PATH: defaultDbPath,
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.dbPath).toBe(explicitDbPath);
    expect(output.mode).toBe('corpus');
    expect(output.labeledCorpusItems).toBe(300);
  });

  it('keeps the standalone replay independent from unrelated iOS API config', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...reviewedExportArtifactArgs(dbPath),
    ], {
      ...process.env,
      IOS_API_ENABLED: 'true',
      IOS_API_JWT_SECRET: 'known-placeholder-value',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'corpus',
      providerCalls: 0,
    });
  });

  it('requires a separate reviewed baseline in corpus mode', () => {
    const dbPath = createCorpusDatabase(true);
    const result = runCli([
      `--db=${dbPath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Corpus-mode calibration requires --baseline=<reviewed-calibration-json>',
    );
  });

  it('requires the private reviewed export artifacts in corpus mode', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Corpus-mode calibration requires private --export-plan, --export-evidence, '
      + '--export-receipt, and --ack-plan artifacts',
    );
  });

  it('rejects a plan acknowledgement that differs from the validated artifact', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const artifacts = reviewedExportArtifactArgs(dbPath);
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...artifacts.filter((arg) => !arg.startsWith('--ack-plan=')),
      `--ack-plan=sha256:${'f'.repeat(64)}`,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Acknowledged routing calibration export plan digest does not match the validated plan',
    );
  });

  it('rejects tampered final receipt evidence even when the caller supplies its paths', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const artifacts = reviewedExportArtifactArgs(dbPath);
    const receiptPath = artifacts.find((arg) => arg.startsWith('--export-receipt='))!
      .slice('--export-receipt='.length);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.providerCalls = 1;
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...artifacts,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('routing-calibration export receipt is invalid');
  });

  it('rejects a copied corpus whose bytes differ from the validated export evidence', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const artifacts = reviewedExportArtifactArgs(dbPath);
    const writer = new Database(dbPath);
    try {
      writer.prepare(`
        UPDATE routing_corpus_items SET utterance_text = ? WHERE id = 1
      `).run('changed after the reviewed export');
    } finally {
      writer.close();
    }
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...artifacts,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sanitized export content differs from the reviewed plan',
    );
  });

  it('rejects reviewed export artifacts that are not private files', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const artifacts = reviewedExportArtifactArgs(dbPath);
    const evidencePath = artifacts.find((arg) => arg.startsWith('--export-evidence='))!
      .slice('--export-evidence='.length);
    fs.chmodSync(evidencePath, 0o644);
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...artifacts,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must have exact mode 0600');
  });

  it('retries byte-for-byte from the same explicit baseline and timestamp', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calibration-retry-')),
    );
    tempDirectories.push(directory);
    const firstOut = path.join(directory, 'first.json');
    const secondOut = path.join(directory, 'second.json');
    const common = [
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...reviewedExportArtifactArgs(dbPath),
    ];

    const first = runCli([...common, `--out=${firstOut}`]);
    const second = runCli([...common, `--out=${secondOut}`]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(fs.readFileSync(secondOut)).toEqual(fs.readFileSync(firstOut));
  });

  it('replays against the explicit baseline instead of the ambient runtime table', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calibration-ambient-retry-')),
    );
    tempDirectories.push(root);
    const outputPath = path.join(root, 'routing-calibration.json');
    const baselinePath = path.join(root, 'routing-calibration-baseline.json');
    const explicitBaseline = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), 'config/routing-calibration.json'),
      'utf8',
    ));
    const ambientScheduling = explicitBaseline.orchestrator.branches.scheduling;
    explicitBaseline.orchestrator.branches.scheduling = 0.92;
    expect(ambientScheduling).not.toBe(explicitBaseline.orchestrator.branches.scheduling);
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify(explicitBaseline, null, 2)}\n`,
      { mode: 0o600 },
    );
    const dbPath = path.join(root, 'routing.sqlite');
    const db = new Database(dbPath);
    try {
      db.exec(ROUTING_CALIBRATION_SANITIZED_SCHEMA);
      const insert = db.prepare(`
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source,
          label_domain, label_status, labeled_at, created_at
        ) VALUES (0, NULL, ?, ?, 'manual', 'finance', 'labeled', ?, ?)
      `);
      for (let index = 0; index < 300; index += 1) {
        const timestamp = new Date(Date.parse('2026-07-30T00:00:00.000Z') + index * 1000)
          .toISOString();
        insert.run(
          createHash('sha256').update(String(index)).digest('hex'),
          `schedule meeting with Alice tomorrow reference ${index}`,
          timestamp,
          timestamp,
        );
      }
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);
    const command = [
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      `--out=${outputPath}`,
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...reviewedExportArtifactArgs(dbPath),
    ];

    const first = runCli(command);
    expect(first.status, first.stderr).toBe(0);
    const firstBytes = fs.readFileSync(outputPath);
    expect(JSON.parse(firstBytes.toString()).orchestrator.branches.scheduling).toBe(0);
    const second = runCli(command);
    expect(second.status, second.stderr).toBe(0);

    expect(fs.readFileSync(outputPath)).toEqual(firstBytes);
  });

  it('keeps the governed SQLite input byte-identical during a successful replay', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const before = sha256File(dbPath);
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...reviewedExportArtifactArgs(dbPath),
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(sha256File(dbPath)).toBe(before);
  });

  it('opens the governed SQLite input read-only and rejects a missing schema without mutation', () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calibration-schema-')),
    );
    tempDirectories.push(directory);
    const dbPath = path.join(directory, 'missing-schema.sqlite');
    const malformed = new Database(dbPath);
    malformed.exec('CREATE TABLE wrong_schema (value TEXT)');
    malformed.close();
    fs.chmodSync(dbPath, 0o600);
    const baselinePath = createCalibrationBaseline();
    const before = sha256File(dbPath);
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required routing calibration corpus schema');
    expect(sha256File(dbPath)).toBe(before);
  });

  it('rejects extra application schema without mutating the governed input', () => {
    const dbPath = createCorpusDatabase(true);
    const writer = new Database(dbPath);
    try {
      writer.exec('CREATE TABLE unexpected_private_rows (value TEXT)');
    } finally {
      writer.close();
    }
    const baselinePath = createCalibrationBaseline();
    const before = sha256File(dbPath);
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required routing calibration corpus schema');
    expect(sha256File(dbPath)).toBe(before);
  });

  it('refuses committed SQLite sidecar state that is not covered by the input hash', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const writer = new Database(dbPath);
    try {
      expect(String(writer.pragma('journal_mode = WAL', { simple: true })).toLowerCase())
        .toBe('wal');
      writer.prepare(`
        UPDATE routing_corpus_items
        SET utterance_text = 'show my updated agenda'
        WHERE utterance_hash = ?
      `).run(createHash('sha256').update('fixture-0').digest('hex'));
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

      const result = runCli([
        `--db=${dbPath}`,
        `--baseline=${baselinePath}`,
        '--dry-run',
        '--generated-at=2026-07-30T00:00:00.000Z',
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SQLite sidecar');
    } finally {
      writer.close();
    }
  });

  it('refuses private inputs whose parent directory is replaceable by another account', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    fs.chmodSync(path.dirname(dbPath), 0o777);
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('corpus database parent');
    expect(result.stderr).toContain('group/world accessible');
  });

  it('refuses an output symlink alias without overwriting the reviewed baseline', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const outputPath = path.join(path.dirname(baselinePath), 'output.json');
    const baselineBytes = fs.readFileSync(baselinePath);
    fs.symlinkSync(baselinePath, outputPath);
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      `--out=${outputPath}`,
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...reviewedExportArtifactArgs(dbPath),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Routing calibration output path is unsafe');
    expect(fs.readFileSync(baselinePath)).toEqual(baselineBytes);
  });

  it('refuses a concurrent calibration transaction for the same output', () => {
    const dbPath = createCorpusDatabase(true);
    const baselinePath = createCalibrationBaseline();
    const outputPath = path.join(path.dirname(baselinePath), 'locked-output.json');
    const lockPath = path.join(
      path.dirname(outputPath),
      `.${path.basename(outputPath)}.calibration.lock`,
    );
    fs.writeFileSync(lockPath, 'existing transaction\n', { mode: 0o600 });
    const result = runCli([
      `--db=${dbPath}`,
      `--baseline=${baselinePath}`,
      `--out=${outputPath}`,
      '--generated-at=2026-07-30T00:00:00.000Z',
      ...reviewedExportArtifactArgs(dbPath),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already locked by another calibration transaction');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('existing transaction\n');
  });

  it('refuses hard-link aliases and non-private reviewed baselines', () => {
    const dbPath = createCorpusDatabase(true);
    const hardLinkBaseline = createCalibrationBaseline();
    const hardLinkOutput = path.join(path.dirname(hardLinkBaseline), 'hard-link-output.json');
    const baselineBytes = fs.readFileSync(hardLinkBaseline);
    fs.linkSync(hardLinkBaseline, hardLinkOutput);
    const hardLinkResult = runCli([
      `--db=${dbPath}`,
      `--baseline=${hardLinkBaseline}`,
      `--out=${hardLinkOutput}`,
      '--generated-at=2026-07-30T00:00:00.000Z',
    ]);
    expect(hardLinkResult.status).toBe(1);
    expect(fs.readFileSync(hardLinkBaseline)).toEqual(baselineBytes);

    const publicBaseline = createCalibrationBaseline();
    fs.chmodSync(publicBaseline, 0o644);
    const publicResult = runCli([
      `--db=${dbPath}`,
      `--baseline=${publicBaseline}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
    ]);
    expect(publicResult.status).toBe(1);
    expect(publicResult.stderr).toContain('permissions must be 0600');
  });

  it('binds the explicit database before importing the routing graph', () => {
    const raw = fs.readFileSync(SCRIPT_PATH, 'utf8');

    expect(raw).toContain(
      "await import('../src/services/standalone-tool-database')",
    );
    expect(dynamicImportStandaloneScopes(
      raw,
      '../src/services/routing-accuracy',
    )).toEqual([true]);
    expect(raw).not.toContain('initDatabase(');
  });
});
