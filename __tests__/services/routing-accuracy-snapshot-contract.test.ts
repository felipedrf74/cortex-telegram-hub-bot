import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ROUTING_ACCURACY_SURFACES,
  isRoutingAccuracyReport,
  parseAcceptedRoutingAccuracySnapshot,
  type RoutingAccuracyReport,
} from '../../src/services/routing-accuracy-snapshot-contract';

const ZERO_CALIBRATION = [
  { bucket: '0.0-0.2', lowerBound: 0, upperBound: 0.2 },
  { bucket: '0.2-0.4', lowerBound: 0.2, upperBound: 0.4 },
  { bucket: '0.4-0.6', lowerBound: 0.4, upperBound: 0.6 },
  { bucket: '0.6-0.8', lowerBound: 0.6, upperBound: 0.8 },
  { bucket: '0.8-1.0', lowerBound: 0.8, upperBound: 1 },
] as const;

function validAcceptedReport(): RoutingAccuracyReport {
  return {
    version: 'routing-accuracy@1.0.0',
    generatedAt: '2026-07-29T00:00:00.000Z',
    itemCount: 300,
    clarifyAccuracyTarget: 0.85,
    surfaces: ROUTING_ACCURACY_SURFACES.map((surface) => ({
      surface,
      covered: 0,
      uncovered: 300,
      correct: 0,
      accuracy: null,
      perDomain: [],
      calibration: ZERO_CALIBRATION.map((bucket) => ({
        ...bucket,
        count: 0,
        correct: 0,
        empiricalAccuracy: null,
        averageStatedConfidence: null,
      })),
      recommendedClarifyThreshold: null,
    })),
  };
}

function staticModuleSpecifiers(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const parsed = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

describe('routing accuracy accepted-snapshot contract', () => {
  it('parses a valid legacy accepted report without changing its shape', () => {
    const report = validAcceptedReport();

    expect(isRoutingAccuracyReport(report)).toBe(true);
    expect(parseAcceptedRoutingAccuracySnapshot(JSON.stringify(report))).toEqual(report);
  });

  it('preserves the fail-closed invalid-JSON error and cause', () => {
    let thrown: unknown;
    try {
      parseAcceptedRoutingAccuracySnapshot('{not-json');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /accepted routing accuracy snapshot contains invalid json; refusing to treat a corrupt ratchet as absent/i,
    );
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
  });

  it('preserves the fail-closed invalid-schema error', () => {
    const corrupt = { ...validAcceptedReport(), surfaces: [] };

    expect(isRoutingAccuracyReport(corrupt)).toBe(false);
    expect(() => parseAcceptedRoutingAccuracySnapshot(JSON.stringify(corrupt))).toThrow(
      /accepted routing accuracy snapshot has an invalid report schema; refusing to treat a corrupt ratchet as absent/i,
    );
  });

  it('rejects internally inconsistent metrics through the pure parser', () => {
    const corrupt = validAcceptedReport();
    corrupt.surfaces[0] = {
      ...corrupt.surfaces[0],
      covered: 1,
      uncovered: 299,
      correct: 1,
      accuracy: 1,
    };

    expect(() => parseAcceptedRoutingAccuracySnapshot(JSON.stringify(corrupt))).toThrow(
      /invalid report schema/i,
    );
  });

  it('has a provider-free, network-free source/import graph', () => {
    const contractPath = path.resolve(
      __dirname,
      '../../src/services/routing-accuracy-snapshot-contract.ts',
    );
    const specifiers = staticModuleSpecifiers(contractPath);
    const source = readFileSync(contractPath, 'utf8');

    expect(specifiers).toEqual([]);
    expect(source).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(|\brequire\s*\(\s*['"](?:node:https?|node:net|https?|provider|anthropic|openai|gemini|ollama)/i,
    );

    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: contractPath,
    }).outputText;
    const loaded: { exports: Record<string, unknown> } = { exports: {} };
    const required: string[] = [];
    runInNewContext(compiled, {
      exports: loaded.exports,
      module: loaded,
      require: (specifier: string) => {
        required.push(specifier);
        throw new Error('unexpected compiled dependency: ' + specifier);
      },
    });

    expect(required).toEqual([]);
    expect(loaded.exports.parseAcceptedRoutingAccuracySnapshot).toBeTypeOf('function');
  });
});
