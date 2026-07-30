import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRoutingCorpusTables } from '../../src/services/routing-corpus';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/calibrate-routing-confidence.ts');
const tempDirectories: string[] = [];

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calibration-cli-'));
  tempDirectories.push(directory);
  const dbPath = path.join(directory, 'routing.sqlite');
  const db = new Database(dbPath);
  try {
    ensureRoutingCorpusTables(db);
    if (labeled) {
      db.prepare(`
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source,
          label_domain, label_skill, label_status, labeled_at
        ) VALUES (
          0, NULL, ?, 'show my agenda', 'manual',
          'secretary', NULL, 'labeled', '2026-07-30T00:00:00.000Z'
        )
      `).run('a'.repeat(64));
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    env: { ...env, NODE_ENV: 'test' },
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
    const result = runCli([
      `--db=${explicitDbPath}`,
      '--dry-run',
      '--generated-at=2026-07-30T00:00:00.000Z',
    ], {
      ...process.env,
      DATABASE_PATH: defaultDbPath,
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.dbPath).toBe(explicitDbPath);
    expect(output.mode).toBe('corpus');
    expect(output.labeledCorpusItems).toBe(1);
  });

  it('binds the explicit database before importing the routing graph', () => {
    const raw = fs.readFileSync(SCRIPT_PATH, 'utf8');

    expect(dynamicImportStandaloneScopes(
      raw,
      '../src/services/routing-accuracy',
    )).toEqual([true]);
    expect(raw).not.toContain('initDatabase(');
  });
});
