import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMutationPlan,
  buildStrykerEnvironment,
  buildWeeklyMutationSelection,
  buildStrykerInvocation,
  coalesceMutationLineTargets,
  countTestDeclarations,
  extractTestEvidence,
  extractReferencedSourceLiterals,
  extractRelativeImports,
  isCriticalModule,
  isTestCleanupChange,
  mergeMutationReports,
  mutationPlanExitCode,
  parseAddedLines,
  parseMutationTarget,
  resolveImportedSourcePaths,
  resolveEmptyRangeFallback,
  resolveReferencedSourcePaths,
  resolveDeletedTestCleanupMappings,
  validateCleanupMapping,
  validateGovernedMutationTarget,
  validateMutationException,
  validateMutationExecutionReport,
  validateMutationOwnerTestMapping,
  validateMutationReport,
} from '../../scripts/mutation-gate.mjs';

const RETIREMENT_BASE_SHA = '7b724f185580b18ce722a396b6e01d5ae268d3c1';

const currentGovernedRanges = [
  {
    pattern: 'src/services/cooking-tenant-scope.ts:54-57',
    replacementTest: '__tests__/services/cooking-private-scope.test.ts',
    ownerTestName: 'cooking private scope predicate admits only active user-private tenant-owned and user-owned rows',
    minimumMutants: 4,
  },
  {
    pattern: 'src/services/gemini-provider.ts:639-639',
    replacementTest: '__tests__/services/gemini-provider.test.ts',
    ownerTestName: 'GeminiProvider reserves unbounded grounded context and meters the provider search fee when grounding is used',
    minimumMutants: 1,
  },
  {
    pattern: 'src/services/openai-provider.ts:375-376',
    replacementTest: '__tests__/services/openai-provider.test.ts',
    ownerTestName: 'OpenAIProvider one-shot helpers bounds hosted web search, reserves unbounded context, and meters actual provider tool usage',
    minimumMutants: 2,
  },
  {
    pattern: 'src/services/openai-provider.ts:420-422',
    replacementTest: '__tests__/services/openai-provider.test.ts',
    ownerTestName: 'OpenAIProvider one-shot helpers bounds hosted web search, reserves unbounded context, and meters actual provider tool usage',
    minimumMutants: 2,
  },
  {
    pattern: 'src/services/openai-provider.ts:558-559',
    replacementTest: '__tests__/services/openai-provider.test.ts',
    ownerTestName: 'OpenAIProvider one-shot helpers bounds hosted web search, reserves unbounded context, and meters actual provider tool usage',
    minimumMutants: 2,
  },
  {
    pattern: 'src/services/openai-provider.ts:602-603',
    replacementTest: '__tests__/services/openai-provider.test.ts',
    ownerTestName: 'OpenAIProvider one-shot helpers bounds hosted web search, reserves unbounded context, and meters actual provider tool usage',
    minimumMutants: 1,
  },
];

const mutant = (id: string, line: number, killedBy: string[], status = 'Killed') => ({
  id,
  status,
  killedBy,
  location: {
    start: { line, column: 1 },
    end: { line, column: 2 },
  },
});

function currentMutationReport() {
  return {
    files: {
      'src/services/cooking-tenant-scope.ts': {
        mutants: [54, 55, 56, 57].map((line, index) => mutant(`c${index}`, line, ['cooking-owner'])),
      },
      'src/services/gemini-provider.ts': {
        mutants: [mutant('g0', 639, ['gemini-owner'])],
      },
      'src/services/openai-provider.ts': {
        mutants: [
          mutant('o0', 376, ['openai-owner']),
          mutant('o1', 376, ['openai-owner']),
          mutant('o2', 421, ['openai-owner']),
          mutant('o3', 421, ['openai-owner']),
          mutant('o4', 558, ['openai-owner']),
          mutant('o5', 559, ['openai-owner']),
          mutant('o6', 603, ['openai-owner']),
        ],
      },
    },
    testFiles: {
      '__tests__/services/cooking-private-scope.test.ts': {
        tests: [{
          id: 'cooking-owner',
          name: 'cooking private scope predicate admits only active user-private tenant-owned and user-owned rows',
        }],
      },
      '__tests__/services/gemini-provider.test.ts': {
        tests: [{
          id: 'gemini-owner',
          name: 'GeminiProvider reserves unbounded grounded context and meters the provider search fee when grounding is used',
        }],
      },
      '__tests__/services/openai-provider.test.ts': {
        tests: [{
          id: 'openai-owner',
          name: 'OpenAIProvider one-shot helpers bounds hosted web search, reserves unbounded context, and meters actual provider tool usage',
        }],
      },
    },
  };
}

describe('changed-critical mutation gate', () => {
  it('selects every changed critical range and isolates each source in a sequential batch', () => {
    expect([...parseAddedLines([
      '@@ -1,0 +2,3 @@',
      '@@ -8 +10 @@',
    ].join('\n'))]).toEqual([2, 3, 4, 10]);
    expect(coalesceMutationLineTargets('src/services/database.ts', [10, 3, 2, 3, 4])).toEqual([
      'src/services/database.ts:2-4',
      'src/services/database.ts:10-10',
    ]);

    const plan = buildWeeklyMutationSelection({
      schema: 'nexus.mutation-plan.v5',
      base: 'fixture-base',
      head: 'fixture-head',
      scope: 'changed-critical',
      targets: [
        'src/services/database.ts',
        'src/services/provider-fallback.ts',
      ],
      governedSources: [
        'src/services/database.ts',
        'src/services/provider-fallback.ts',
      ],
      governedRanges: [],
      minimumMutants: 2,
      testFiles: [],
    }, (_base, file) => (
      file.endsWith('database.ts')
        ? '@@ -1,0 +2,3 @@\n@@ -8 +10 @@'
        : '@@ -4,2 +4,0 @@'
    ));

    expect(plan.targets).toEqual([
      'src/services/database.ts:2-4',
      'src/services/database.ts:10-10',
      'src/services/provider-fallback.ts',
    ]);
    expect(plan.mutationBatches).toEqual([
      {
        index: 0,
        sources: ['src/services/database.ts'],
        targets: [
          'src/services/database.ts:2-4',
          'src/services/database.ts:10-10',
        ],
      },
      {
        index: 1,
        sources: ['src/services/provider-fallback.ts'],
        targets: ['src/services/provider-fallback.ts'],
      },
    ]);
    expect(plan.weeklySelection).toEqual([
      {
        source: 'src/services/database.ts',
        addedLines: 4,
        ranges: 2,
        fallback: null,
        ownerTestFiles: [],
      },
      {
        source: 'src/services/provider-fallback.ts',
        addedLines: 0,
        ranges: 1,
        fallback: 'full-file-deletion-only',
        ownerTestFiles: [],
      },
    ]);
  });

  it('binds an explicit retained owner suite to only its sequential source batch', () => {
    const plan = buildWeeklyMutationSelection({
      schema: 'nexus.mutation-plan.v5',
      base: 'fixture-base',
      head: 'fixture-head',
      scope: 'changed-critical',
      targets: ['src/services/database.ts', 'src/services/content-intelligence.ts'],
      governedSources: ['src/services/content-intelligence.ts', 'src/services/database.ts'],
      governedRanges: [],
      minimumMutants: 2,
      testFiles: [],
      ownerTestMappings: [{
        source: 'src/services/content-intelligence.ts',
        testFiles: ['__tests__/services/content-intelligence.test.ts'],
        reason: 'The focused behavior suite avoids unrelated native integration teardown.',
      }],
    }, () => '@@ -1,0 +2 @@');

    expect(plan.mutationBatches).toEqual([
      {
        index: 0,
        sources: ['src/services/content-intelligence.ts'],
        targets: ['src/services/content-intelligence.ts:2-2'],
        testFiles: ['__tests__/services/content-intelligence.test.ts'],
      },
      {
        index: 1,
        sources: ['src/services/database.ts'],
        targets: ['src/services/database.ts:2-2'],
      },
    ]);
    expect(plan.weeklySelection[0]).toMatchObject({
      source: 'src/services/content-intelligence.ts',
      ownerTestFiles: ['__tests__/services/content-intelligence.test.ts'],
    });
    expect(plan.weeklySelection[1]).toMatchObject({
      source: 'src/services/database.ts',
      ownerTestFiles: [],
    });
  });

  it('isolates exact cleanup ranges and owner tests by source without concurrent mutation lanes', () => {
    const plan = buildWeeklyMutationSelection({
      schema: 'nexus.mutation-plan.v5',
      base: 'fixture-base',
      head: 'fixture-head',
      scope: 'test-cleanup',
      targets: [
        'scripts/lib/test-groups.mjs:295-302',
        'scripts/lib/test-groups.mjs:310-312',
        'scripts/mutation-gate.mjs:385-390',
      ],
      governedSources: [
        'scripts/lib/test-groups.mjs',
        'scripts/mutation-gate.mjs',
      ],
      governedRanges: [
        {
          pattern: 'scripts/lib/test-groups.mjs:295-302',
          replacementTest: '__tests__/scripts/changed-area-classifier.test.ts',
        },
        {
          pattern: 'scripts/lib/test-groups.mjs:310-312',
          replacementTest: '__tests__/scripts/test-tier-governance.test.ts',
        },
        {
          pattern: 'scripts/mutation-gate.mjs:385-390',
          replacementTest: '__tests__/scripts/mutation-gate.test.ts',
        },
      ],
      testFiles: [
        '__tests__/scripts/changed-area-classifier.test.ts',
        '__tests__/scripts/mutation-gate.test.ts',
        '__tests__/scripts/retirement-only.test.ts',
      ],
    });

    expect(plan.mutationBatches).toEqual([
      {
        index: 0,
        sources: ['scripts/lib/test-groups.mjs'],
        targets: [
          'scripts/lib/test-groups.mjs:295-302',
          'scripts/lib/test-groups.mjs:310-312',
        ],
        testFiles: [
          '__tests__/scripts/changed-area-classifier.test.ts',
          '__tests__/scripts/test-tier-governance.test.ts',
        ],
      },
      {
        index: 1,
        sources: ['scripts/mutation-gate.mjs'],
        targets: ['scripts/mutation-gate.mjs:385-390'],
        testFiles: ['__tests__/scripts/mutation-gate.test.ts'],
      },
    ]);
    expect(plan.mutationBatches.flatMap((batch) => batch.targets).sort()).toEqual(
      [...plan.targets].sort(),
    );
    expect(() => buildWeeklyMutationSelection({
      schema: 'nexus.mutation-plan.v5',
      base: 'fixture-base',
      head: 'fixture-head',
      scope: 'test-cleanup',
      targets: ['scripts/unowned-cleanup.mjs:1-1'],
      governedSources: ['scripts/unowned-cleanup.mjs'],
      governedRanges: [],
      testFiles: [],
    })).toThrow('cleanup mutation source has no retained owner test');
  });

  it('cannot inherit a stale owner-test selector into an unmapped batch', () => {
    const invocation = buildStrykerInvocation({
      config: 'config/stryker.config.mjs',
      targets: ['src/services/database.ts:2-2'],
      thresholds: { high: 80, low: 70, break: 70 },
      testFiles: [],
      scope: 'changed-critical',
    });
    const environment = buildStrykerEnvironment({
      NODE_ENV: 'production',
      NEXUS_MUTATION_TEST_FILES: '["__tests__/stale-owner.test.ts"]',
      NEXUS_MUTATION_SOURCE_ROOT: '/tmp/stale-mutation-source',
      RETAINED_VALUE: 'retained',
    }, invocation.env);

    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      NEXUS_MUTATION_SOURCE_ROOT: path.resolve('.'),
      RETAINED_VALUE: 'retained',
    });
    expect(environment).not.toHaveProperty('NEXUS_MUTATION_TEST_FILES');
  });

  it('binds every accepted Stryker report to the exact batch targets and owner tests', () => {
    const targets = ['src/services/content-intelligence.ts:8-13'];
    const testFiles = ['__tests__/services/content-intelligence.test.ts'];
    const report = {
      config: {
        mutate: targets,
        testFiles,
        concurrency: 1,
        testRunner: 'vitest',
        ignoreStatic: false,
        coverageAnalysis: 'perTest',
        vitest: {
          related: true,
          configFile: 'config/vitest.stryker.config.ts',
        },
      },
    };
    expect(validateMutationExecutionReport(report, { targets, testFiles })).toEqual([]);
    const cleanupReport = {
      config: {
        ...report.config,
        coverageAnalysis: 'off',
        vitest: {
          related: false,
          configFile: 'config/vitest.stryker.config.ts',
        },
      },
    };
    expect(validateMutationExecutionReport(
      cleanupReport,
      { targets, testFiles, scope: 'test-cleanup' },
    )).toEqual([]);
    expect(validateMutationExecutionReport({
      config: {
        ...cleanupReport.config,
        ignoreStatic: true,
      },
    }, { targets, testFiles, scope: 'test-cleanup' })).toContain(
      'Stryker report ignoreStatic must be false, found true',
    );
    expect(validateMutationExecutionReport({
      config: {
        ...cleanupReport.config,
        coverageAnalysis: 'perTest',
      },
    }, { targets, testFiles, scope: 'test-cleanup' })).toContain(
      'Stryker report coverage analysis differs from the governed scope',
    );
    expect(validateMutationExecutionReport({
      config: {
        ...cleanupReport.config,
        vitest: {
          related: true,
          configFile: 'config/vitest.stryker.config.ts',
        },
      },
    }, { targets, testFiles, scope: 'test-cleanup' })).toContain(
      'Stryker report Vitest binding differs from the governed sequential config',
    );
    expect(validateMutationExecutionReport(
      cleanupReport,
      { targets, testFiles: [], scope: 'test-cleanup' },
    )).toContain('test-cleanup execution requires explicit governed owner tests');
    expect(validateMutationExecutionReport({
      config: {
        ...report.config,
        mutate: ['src/services/database.ts'],
      },
    }, { targets, testFiles })).toContain(
      'Stryker report mutate targets differ from the batch execution targets',
    );
    expect(validateMutationExecutionReport({
      config: {
        ...report.config,
        testFiles: ['__tests__/services/unrelated.test.ts'],
      },
    }, { targets, testFiles })).toContain(
      'Stryker report testFiles differ from the batch owner-test mapping',
    );
    expect(validateMutationExecutionReport({
      config: {
        ...report.config,
        testFiles,
      },
    }, { targets, testFiles: [] })).toContain(
      'Stryker report unexpectedly narrows an unmapped batch with testFiles',
    );
    expect(validateMutationExecutionReport({
      config: {
        ...report.config,
        concurrency: 2,
      },
    }, { targets, testFiles })).toContain(
      'Stryker report concurrency must be 1, found 2',
    );
  });

  it('merges sequential reports and rejects repeated governed sources', () => {
    const first = {
      files: {
        'src/services/database.ts': { mutants: [mutant('db', 2, ['db-owner'])] },
      },
      testFiles: {
        '__tests__/services/database.test.ts': { tests: [{ id: 'db-owner', name: 'database owner' }] },
      },
    };
    const second = {
      files: {
        '/repo/src/services/provider-fallback.ts': { mutants: [mutant('provider', 4, ['provider-owner'])] },
      },
      testFiles: {
        '__tests__/services/provider-fallback.test.ts': {
          tests: [{ id: 'provider-owner', name: 'provider owner' }],
        },
      },
    };
    expect(Object.keys(mergeMutationReports([first, second]).files)).toHaveLength(2);
    expect(() => mergeMutationReports([
      first,
      {
        files: {
          'src/services/database.ts': { mutants: [] },
        },
      },
    ])).toThrow('mutation batches repeat governed source');
  });

  it('canonicalizes process-local owner ids across sequential mutation reports', () => {
    const ownerFile = '__tests__/services/gemini-provider.test.ts';
    const ownerName = 'GeminiProvider reserves unbounded grounded context and meters the provider search fee when grounding is used';
    const first = {
      files: {
        'src/services/gemini-provider.ts': {
          mutants: [{ ...mutant('gemini', 639, ['4']), coveredBy: ['4'] }],
        },
      },
      testFiles: {
        [ownerFile]: { source: 'owner source', tests: [{ id: '4', name: ownerName }] },
      },
    };
    const second = {
      files: {
        'src/services/openai-provider.ts': {
          mutants: [{ ...mutant('openai', 375, ['7']), coveredBy: ['7'] }],
        },
      },
      testFiles: {
        [ownerFile]: { source: 'owner source', tests: [{ id: '7', name: ownerName }] },
      },
    };

    for (const merged of [
      mergeMutationReports([first, second]),
      mergeMutationReports([second, first]),
    ]) {
      const canonicalId = JSON.stringify([ownerFile, ownerName]);
      expect(merged.testFiles[ownerFile].tests).toEqual([{
        id: canonicalId,
        name: ownerName,
      }]);
      expect(Object.values(merged.files).flatMap(({ mutants }) => mutants)
        .map(({ coveredBy, killedBy }) => ({ coveredBy, killedBy }))).toEqual([
        { coveredBy: [canonicalId], killedBy: [canonicalId] },
        { coveredBy: [canonicalId], killedBy: [canonicalId] },
      ]);
    }
  });

  it('fails closed when one mutation batch repeats a logical test name', () => {
    expect(() => mergeMutationReports([{
      files: {
        'src/services/gemini-provider.ts': {
          mutants: [mutant('gemini', 639, ['4'])],
        },
      },
      testFiles: {
        '__tests__/services/gemini-provider.test.ts': {
          source: 'owner source',
          tests: [
            { id: '4', name: 'repeated governed owner test name' },
            { id: '7', name: 'repeated governed owner test name' },
          ],
        },
      },
    }])).toThrow('repeats logical test');
  });

  it('falls back only when one source has zero mutants in exact changed ranges', () => {
    expect(resolveEmptyRangeFallback({
      generatedMutants: 0,
      targets: [
        'src/services/database.ts:2-4',
        'src/services/database.ts:10-10',
      ],
      sources: ['src/services/database.ts'],
    })).toEqual({
      reason: 'full-file-no-generated-mutants',
      targets: ['src/services/database.ts'],
    });
    expect(resolveEmptyRangeFallback({
      generatedMutants: 0,
      targets: ['src/services/database.ts:2-4'],
      sources: ['src/services/database.ts'],
      scope: 'test-cleanup',
    })).toBeNull();
    expect(resolveEmptyRangeFallback({
      generatedMutants: 1,
      targets: ['src/services/database.ts:2-4'],
      sources: ['src/services/database.ts'],
    })).toBeNull();
    expect(resolveEmptyRangeFallback({
      generatedMutants: 0,
      targets: ['src/services/database.ts'],
      sources: ['src/services/database.ts'],
    })).toBeNull();
  });

  it('extracts static, dynamic, and require imports without package imports', () => {
    expect(extractRelativeImports(`
      import { authenticate } from '../../src/middleware/auth';
      const provider = await import('../../src/services/provider-router');
      const database = require('../../src/services/database');
      import { describe } from 'vitest';
    `)).toEqual([
      '../../src/middleware/auth',
      '../../src/services/database',
      '../../src/services/provider-router',
    ]);
  });

  it('matches only explicitly governed critical modules', () => {
    const patterns = ['src/services/*auth*.ts', 'src/services/database.ts'];
    expect(isCriticalModule('src/services/google-auth.ts', patterns)).toBe(true);
    expect(isCriticalModule('src/services/database.ts', patterns)).toBe(true);
    expect(isCriticalModule('src/services/content-scheduler.ts', patterns)).toBe(false);
  });

  it('detects net assertion removal without treating corrected expectations as cleanup', () => {
    expect(countTestDeclarations("it('a', () => {}); test.each([1])('b', () => {});")).toBe(2);
    expect(isTestCleanupChange({ status: 'D' }, '', "it('previous', () => {});")).toBe(true);
    expect(isTestCleanupChange(
      { status: 'M' },
      "it('remaining', () => { expect(result.ok).toBe(true); });",
      "it('remaining', () => { expect(result.ok).toBe(true); expect(result.owner).toBe('user'); });",
    )).toBe(true);
    expect(isTestCleanupChange(
      { status: 'M' },
      "it('remaining', () => { expect(result.status).toBe(201); });",
      "it('remaining', () => { expect(result.status).toBe(200); });",
    )).toBe(false);
    expect(isTestCleanupChange(
      { status: 'M' },
      "it('remaining', () => { expect(result.ok).toBe(true); expect(result.status).toBe(200); expect(result.timestamp).toBeDefined(); });",
      "it('remaining', () => { expect(result.ok).toBe(true); expect(result.owner).toBe('user'); });",
    )).toBe(true);
    expect(isTestCleanupChange(
      { status: 'M' },
      "it('remaining', () => { expect(write).toHaveBeenCalledWith({ userId: 1, tenantId: 7 }); });",
      "it('remaining', () => { expect(write).toHaveBeenCalledWith({ userId: 1 }); });",
    )).toBe(false);
    expect(isTestCleanupChange(
      { status: 'M' },
      "it('remaining', () => true);",
      "it('remaining', () => expect(result.ok).toBe(true));",
    )).toBe(true);
    expect(isTestCleanupChange(
      { status: 'M' },
      "const fixture = { id: 1 }; it('same behavior', () => { expect(fixture.id).toBe(1); });",
      "const fixture = { id: 1, unusedName: 'boilerplate', unusedRole: 'admin' }; it('same behavior', () => { expect(fixture.id).toBe(1); });",
    )).toBe(false);
    expect(isTestCleanupChange({ status: 'A' }, "test('new', () => {});", '')).toBe(false);
  });

  it('detects removed it.each rows even when the declaration and assertion counts are unchanged', () => {
    const previous = `
      it.each([
        [1, 'owner'],
        [2, 'delegate'],
      ])('allows user %s', (userId) => {
        expect(canAccess(userId)).toBe(true);
      });
    `;
    const current = `
      it.each([
        [1, 'owner'],
      ])('allows user %s', (userId) => {
        expect(canAccess(userId)).toBe(true);
      });
    `;

    expect(extractTestEvidence(previous).declarationCount).toBe(1);
    expect(extractTestEvidence(current).declarationCount).toBe(1);
    expect(extractTestEvidence(previous).eachRows).toHaveLength(2);
    expect(extractTestEvidence(current).eachRows).toHaveLength(1);
    expect(isTestCleanupChange({ status: 'M', file: '__tests__/matrix.test.ts' }, current, previous)).toBe(true);
  });

  it('protects structural control-flow removal while allowing corrected literals', () => {
    const previous = `
      it('guards tenant rows', () => {
        if (row.tenantId === tenantId) expect(row.allowed).toBe(true);
        const selected = row.active ? row : null;
        while (cursor < 2) cursor += 1;
        do { attempts += 1; } while (attempts < 2);
        for (let index = 0; index < rows.length; index += 1) consume(rows[index]);
        switch (row.scope) { case 'private': consume(row); break; }
        expect(selected).toBeDefined();
      });
    `;
    const current = previous.replace('if (row.tenantId === tenantId) expect(row.allowed).toBe(true);', 'expect(row.allowed).toBe(true);');
    const evidence = extractTestEvidence(previous);

    expect(evidence.controlFlow).toEqual(expect.arrayContaining([
      expect.stringMatching(/^if:/),
      expect.stringMatching(/^conditional:/),
      expect.stringMatching(/^while:/),
      expect.stringMatching(/^do:/),
      expect.stringMatching(/^for:/),
      expect.stringMatching(/^switch:/),
      expect.stringMatching(/^case:/),
    ]));
    expect(isTestCleanupChange(
      { status: 'M', file: '__tests__/tenant-guard.test.ts' },
      current,
      previous,
    )).toBe(true);
    expect(isTestCleanupChange(
      { status: 'M', file: '__tests__/cache-key.test.ts' },
      "it('uses the tenant cache key', () => { if (key === 'readiness:12:12') consume(); });",
      "it('uses the tenant cache key', () => { if (key === 'readiness:12') consume(); });",
    )).toBe(false);
    expect(isTestCleanupChange(
      { status: 'M', file: '__tests__/threshold.test.ts' },
      "it('uses corrected threshold', () => { if (score > 20) consume(); });",
      "it('uses corrected threshold', () => { if (score > 10) consume(); });",
    )).toBe(false);
    expect(isTestCleanupChange(
      { status: 'M', file: '__tests__/expanded-matrix.test.ts' },
      "it('checks every item', () => { for (const item of ['a', 'b', 'c']) consume(item); });",
      "it('checks every item', () => { for (const item of ['a', 'b']) consume(item); });",
    )).toBe(false);
    expect(isTestCleanupChange(
      { status: 'M', file: '__tests__/assert-message.test.ts' },
      "it('uses corrected message', () => { assert(ok, 'new message'); });",
      "it('uses corrected message', () => { assert(ok, 'old message'); });",
    )).toBe(false);
    expect(isTestCleanupChange(
      { status: 'M', file: '__tests__/soft-expect.test.ts' },
      "it('uses corrected status', () => { expect.soft(status).toBe(201); });",
      "it('uses corrected status', () => { expect.soft(status).toBe(200); });",
    )).toBe(false);
  });

  it('fails closed on TypeScript parse diagnostics even for a newly added test', () => {
    const testFile = '__tests__/services/malformed-added.test.ts';
    const malformed = "it('broken', () => {";
    expect(extractTestEvidence(malformed, testFile).parseDiagnostics.length).toBeGreaterThan(0);

    const plan = buildMutationPlan({
      base: 'fixture-base',
      changes: [{ status: 'A', file: testFile, previous: null }],
      patterns: ['src/services/*provider*.ts'],
      scope: 'test-cleanup',
      readCurrent: () => malformed,
      readPrevious: () => '',
    });

    expect(plan.testEvidenceParseDiagnostics).toHaveLength(1);
    expect(mutationPlanExitCode(plan)).toBe(3);
  });

  it('returns a blocking exit code for an unmapped modified test that loses behavior evidence', () => {
    const testFile = '__tests__/services/unmapped-provider-cleanup.test.ts';
    const plan = buildMutationPlan({
      base: 'fixture-base',
      changes: [{ status: 'M', file: testFile, previous: null }],
      patterns: ['src/services/*provider*.ts'],
      scope: 'test-cleanup',
      cleanupMappings: [],
      readCurrent: () => "it('kept', () => expect(result.status).toBe(201));",
      readPrevious: () => "it('kept', () => { expect(result.status).toBe(200); expect(result.owner).toBe('user'); });",
    });

    expect(plan.targets).toEqual([]);
    expect(plan.unmappedRetainedCleanupTests).toEqual([testFile]);
    expect(mutationPlanExitCode(plan)).toBe(3);
  });

  it('resolves nested and computed it.each tables before comparing row evidence', () => {
    const previous = `
      describe('matrix', () => {
        const baseRows = [['owner', 1], ['delegate', 2]];
        const matrices = { auth: [...baseRows, ['admin', 3]] };
        it.each(matrices.auth.map((row) => row))('allows %s', (role) => expect(role).toBeTruthy());
      });
    `;
    const current = `
      describe('matrix', () => {
        const baseRows = [['owner', 1], ['auditor', 4]];
        const matrices = { auth: [...baseRows, ['admin', 3]] };
        it.each(matrices.auth.map((row) => row))('allows %s', (role) => expect(role).toBeTruthy());
      });
    `;

    expect(extractTestEvidence(previous).eachRows).toHaveLength(1);
    expect(extractTestEvidence(current).eachRows).toHaveLength(1);
    expect(extractTestEvidence(previous).eachRows).not.toEqual(extractTestEvidence(current).eachRows);
    expect(extractTestEvidence(previous).assertions).toHaveLength(1);
    expect(isTestCleanupChange({ status: 'M', file: '__tests__/computed-matrix.test.ts' }, current, previous)).toBe(false);
  });

  it('governs root API authentication and tenant-scope modules', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8')) as {
      mutation: { criticalModulePatterns: string[] };
    };

    expect(isCriticalModule('src/api/auth-middleware.ts', policy.mutation.criticalModulePatterns)).toBe(true);
    expect(isCriticalModule('src/api/tenant-route-scope.ts', policy.mutation.criticalModulePatterns)).toBe(true);
    expect(isCriticalModule('src/services/content-tenant-scope.ts', policy.mutation.criticalModulePatterns)).toBe(true);
    expect(isCriticalModule('src/services/database.ts', policy.mutation.criticalModulePatterns)).toBe(true);
    expect(isCriticalModule('src/services/migration-runner.ts', policy.mutation.criticalModulePatterns)).toBe(true);
    expect(isCriticalModule('src/services/pm2-health.ts', policy.mutation.criticalModulePatterns)).toBe(true);
    expect(isCriticalModule('src/services/training-signals.ts', policy.mutation.criticalModulePatterns)).toBe(false);
  });

  it('keeps targeted mutation evidence independent from ordinary CI coverage', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8')) as {
      coverage: {
        exceptions: Array<{
          file: string;
          minimum: { lines: number; branches: number };
        }>;
      };
      mutation: {
        schedule: string;
        scope: string;
        thresholds: { high: number; low: number; break: number };
        cleanupMappings: Array<unknown>;
        minimumMutants?: Record<string, number>;
        respectCoverageExceptions?: boolean;
      };
    };

    expect(policy.coverage.exceptions).toHaveLength(6);
    const minimumFor = (file: string) => policy.coverage.exceptions.find(
      (exception) => exception.file === file,
    )?.minimum;
    expect(minimumFor('src/services/database.ts')).toEqual({
      lines: 25.28,
      branches: 26.08,
    });
    expect(minimumFor('src/services/gemini-provider.ts')).toEqual({
      lines: 88.42,
      branches: 67.5,
    });
    expect(minimumFor('src/services/training-exercise-media-manifest.ts')).toEqual({
      lines: 83.88,
      branches: 72.06,
    });
    expect(minimumFor('src/services/scheduler.ts')).toEqual({
      lines: 53.64,
      branches: 38.79,
    });
    expect(policy.mutation.schedule).toBe('manual-test-rationalization-only');
    expect(policy.mutation.scope).toBe('test-cleanup');
    expect(policy.mutation.thresholds).toEqual({ high: 80, low: 70, break: 70 });
    expect(policy.mutation.cleanupMappings.length).toBeGreaterThan(0);
    for (const mapping of policy.mutation.cleanupMappings) {
      expect(validateCleanupMapping(mapping), JSON.stringify(mapping)).toEqual([]);
    }
    expect(policy.mutation.respectCoverageExceptions).toBeUndefined();
    expect(policy.mutation.minimumMutants).toBeUndefined();
  });

  it('maps deleted-test source text back to repository source dependencies', () => {
    const existing = new Set([
      path.resolve('src/services/database.ts'),
      path.resolve('src/services/provider-router.ts'),
    ]);
    const resolved = resolveImportedSourcePaths(
      '__tests__/scripts/deleted-cleanup.test.ts',
      `
        import '../../src/services/database';
        import('../../src/services/provider-router');
      `,
      (candidate) => existing.has(candidate),
    );
    expect(resolved).toEqual([
      'src/services/database.ts',
      'src/services/provider-router.ts',
    ]);
  });

  it('maps source files read through fs/path helpers instead of treating them as unowned deletions', () => {
    const source = `
      const direct = read('src/api/routes/training-plan-generation.ts');
      const resolved = fs.readFileSync(path.resolve(__dirname, '../../src/portal/health-routes.ts'));
    `;
    expect(extractReferencedSourceLiterals(source)).toEqual([
      'src/api/routes/training-plan-generation.ts',
      'src/portal/health-routes.ts',
    ]);

    const existing = new Set([
      path.resolve('src/api/routes/training-plan-generation.ts'),
      path.resolve('src/portal/health-routes.ts'),
    ]);
    expect(resolveReferencedSourcePaths(
      '__tests__/scripts/deleted-source-read.test.ts',
      source,
      (candidate) => existing.has(candidate),
    )).toEqual([
      'src/api/routes/training-plan-generation.ts',
      'src/portal/health-routes.ts',
    ]);
  });

  it('requires every surviving deleted-test cleanup to provide an explicit mapping', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8')) as {
      mutation: { cleanupMappings: Array<Record<string, unknown>> };
    };
    expect(policy.mutation.cleanupMappings.length).toBeGreaterThan(0);
    for (const mapping of policy.mutation.cleanupMappings) {
      expect(validateCleanupMapping(mapping), JSON.stringify(mapping)).toEqual([]);
    }

    const missing = resolveDeletedTestCleanupMappings(
      [{ status: 'D', file: '__tests__/security/removed-contract.test.ts', previous: null }],
      policy.mutation.cleanupMappings,
    );
    expect(missing.unmapped).toEqual(['__tests__/security/removed-contract.test.ts']);
    expect(missing.resolved).toEqual([]);
  });

  it('accepts only an exact-diff retirement and selects its replacement evidence', () => {
    const deletedTest = '__tests__/scripts/legacy-release.test.ts';
    const replacementTest = '__tests__/scripts/lean-release-path.test.ts';
    const retiredSource = 'scripts/legacy-release.mjs';
    const files = new Set([replacementTest]);
    const relative = (candidate: string) => path.relative(path.resolve('.'), candidate)
      .split(path.sep).join('/');
    const exists = (candidate: string) => files.has(relative(candidate));
    const retirementMappings = [{
      baseSha: RETIREMENT_BASE_SHA,
      test: deletedTest,
      requiredRemovedPaths: [retiredSource],
      replacementTests: [replacementTest],
      reason: 'The deleted legacy release contract is replaced by the retained lean release evidence.',
    }];
    const shared = {
      base: RETIREMENT_BASE_SHA,
      patterns: ['src/services/database.ts'],
      scope: 'test-cleanup' as const,
      cleanupMappings: [],
      retirementMappings,
      exists,
      readCurrent: () => '',
      readPrevious: (_base: string, file: string) => (
        file === deletedTest ? "it('protects legacy release', () => expect(ready).toBe(true));" : ''
      ),
    };

    const approved = buildMutationPlan({
      ...shared,
      changes: [
        { status: 'D', file: deletedTest, previous: null },
        { status: 'D', file: retiredSource, previous: null },
      ],
    });
    expect(approved.retirementMappings).toEqual([expect.objectContaining({
      test: deletedTest,
      replacementTests: [replacementTest],
    })]);
    expect(approved.unmappedDeletedTests).toEqual([]);
    expect(approved.targets).toEqual([]);
    expect(approved.testFiles).toEqual([replacementTest]);
    expect(mutationPlanExitCode(approved)).toBe(0);

    const historicalOnly = buildMutationPlan({
      ...shared,
      changes: [{ status: 'D', file: deletedTest, previous: null }],
    });
    expect(historicalOnly.retirementMappings).toEqual([]);
    expect(historicalOnly.unmappedDeletedTests).toEqual([deletedTest]);
    expect(historicalOnly.testFiles).toEqual([]);
    expect(mutationPlanExitCode(historicalOnly)).toBe(3);

    const missingReplacement = buildMutationPlan({
      ...shared,
      exists: () => false,
      changes: [
        { status: 'D', file: deletedTest, previous: null },
        { status: 'D', file: retiredSource, previous: null },
      ],
    });
    expect(missingReplacement.retirementMappings).toEqual([]);
    expect(missingReplacement.unmappedDeletedTests).toEqual([deletedTest]);
    expect(mutationPlanExitCode(missingReplacement)).toBe(3);

    const futureBase = buildMutationPlan({
      ...shared,
      base: 'b'.repeat(40),
      changes: [
        { status: 'D', file: deletedTest, previous: null },
        { status: 'D', file: retiredSource, previous: null },
      ],
    });
    expect(futureBase.retirementMappings).toEqual([]);
    expect(futureBase.unmappedDeletedTests).toEqual([deletedTest]);
    expect(mutationPlanExitCode(futureBase)).toBe(3);
  });

  it('fails pure renames closed unless exact baseline retirement evidence also removes an owner', () => {
    const previousTest = '__tests__/scripts/legacy-contract.test.ts';
    const replacementTest = '__tests__/scripts/lean-contract.test.ts';
    const retiredSource = 'scripts/legacy-contract.mjs';
    const files = new Set([replacementTest]);
    const relative = (candidate: string) => path.relative(path.resolve('.'), candidate)
      .split(path.sep).join('/');
    const exists = (candidate: string) => files.has(relative(candidate));
    const changes = [
      { status: 'R100', file: replacementTest, previous: previousTest },
      { status: 'D', file: retiredSource, previous: null },
    ];
    const shared = {
      base: RETIREMENT_BASE_SHA,
      changes,
      patterns: ['src/services/database.ts'],
      scope: 'test-cleanup' as const,
      cleanupMappings: [],
      exists,
      readCurrent: (file: string) => (
        file === replacementTest
          ? "it('protects behavior', () => expect(ready).toBe(true));"
          : ''
      ),
      readPrevious: (_base: string, file: string) => (
        file === previousTest
          ? "import '../../scripts/legacy-contract.mjs';\nit('protects behavior', () => expect(ready).toBe(true));"
          : ''
      ),
    };
    const pureRename = buildMutationPlan({ ...shared, retirementMappings: [] });
    expect(pureRename.cleanupTests).toEqual([replacementTest]);
    expect(pureRename.retirementMappings).toEqual([]);
    expect(pureRename.unmappedDeletedTests).toEqual([]);
    expect(pureRename.unmappedRetainedCleanupTests).toEqual([previousTest]);
    expect(pureRename.targets).toEqual([]);
    expect(mutationPlanExitCode(pureRename)).toBe(3);

    const cleanupShared = {
      ...shared,
      readPrevious: (_base: string, file: string) => (
        file === previousTest
          ? "import '../../scripts/legacy-contract.mjs';\nit('protects behavior', () => { expect(owner).toBe('user'); expect(ready).toBe(true); });"
          : ''
      ),
    };
    const approved = buildMutationPlan({
      ...cleanupShared,
      retirementMappings: [{
        baseSha: RETIREMENT_BASE_SHA,
        test: previousTest,
        baselineOwnerPaths: [retiredSource],
        requiredRemovedPaths: [retiredSource],
        requiredChangedPaths: [replacementTest],
        replacementTests: [replacementTest],
        reason: 'The renamed contract replaces the retired implementation in this exact change.',
      }],
    });
    expect(approved.retirementMappings).toEqual([expect.objectContaining({
      test: previousTest,
      currentTest: replacementTest,
      status: 'R100',
    })]);
    expect(approved.unmappedDeletedTests).toEqual([]);
    expect(approved.testFiles).toEqual([replacementTest]);
    expect(mutationPlanExitCode(approved)).toBe(0);

    const unmapped = buildMutationPlan({ ...cleanupShared, retirementMappings: [] });
    expect(unmapped.unmappedRetainedCleanupTests).toEqual([previousTest]);
    expect(mutationPlanExitCode(unmapped)).toBe(3);
  });

  it('authorizes modified cleanup only from its exact retirement diff', () => {
    const changedTest = '__tests__/scripts/legacy-gate.test.ts';
    const retiredSource = 'scripts/legacy-gate.mjs';
    const files = new Set([changedTest]);
    const relative = (candidate: string) => path.relative(path.resolve('.'), candidate)
      .split(path.sep).join('/');
    const exists = (candidate: string) => files.has(relative(candidate));
    const mapping = {
      baseSha: RETIREMENT_BASE_SHA,
      test: changedTest,
      requiredRemovedPaths: [retiredSource],
      requiredChangedPaths: [changedTest],
      replacementTests: [changedTest],
      reason: 'The retained gate now covers the lean path after its legacy implementation is retired.',
    };
    const shared = {
      base: RETIREMENT_BASE_SHA,
      patterns: ['src/services/database.ts'],
      scope: 'test-cleanup' as const,
      cleanupMappings: [],
      retirementMappings: [mapping],
      exists,
      readCurrent: () => "it('protects lean gate', () => expect(status).toBe('ready'));",
      readPrevious: () => (
        "it('protects legacy gate', () => { expect(owner).toBe('user'); expect(status).toBe('ready'); });"
      ),
    };

    const approved = buildMutationPlan({
      ...shared,
      changes: [
        { status: 'M', file: changedTest, previous: null },
        { status: 'D', file: retiredSource, previous: null },
      ],
    });
    expect(approved.retirementMappings).toEqual([expect.objectContaining({
      test: changedTest,
      currentTest: changedTest,
      status: 'M',
    })]);
    expect(approved.unmappedRetainedCleanupTests).toEqual([]);
    expect(approved.testFiles).toEqual([changedTest]);
    expect(mutationPlanExitCode(approved)).toBe(0);

    const unrelated = buildMutationPlan({
      ...shared,
      changes: [{ status: 'M', file: changedTest, previous: null }],
    });
    expect(unrelated.retirementMappings).toEqual([]);
    expect(unrelated.unmappedRetainedCleanupTests).toEqual([changedTest]);
    expect(mutationPlanExitCode(unrelated)).toBe(3);
  });

  it('validates governed ranges, in-range anchors, behavior ownership, and retained tests', () => {
    expect(parseMutationTarget('src/services/gemini-provider.ts:149-203')).toEqual({
      file: 'src/services/gemini-provider.ts',
      startLine: 149,
      endLine: 203,
    });
    expect(parseMutationTarget('src/services/gemini-provider.ts:203-149')).toBeNull();
    expect(parseMutationTarget('src/services/gemini-provider.ts')).toBeNull();

    const existing = new Set([
      path.resolve('__tests__/services/retained-cleanup.test.ts'),
      path.resolve('src/services/gemini-provider.ts'),
    ]);
    const baseMapping = {
      test: '__tests__/services/deleted-cleanup.test.ts',
      replacementTests: ['__tests__/services/retained-cleanup.test.ts'],
      sources: ['src/services/gemini-provider.ts'],
      reason: 'Retained behavior protects the removed cleanup assertions.',
    };
    const exists = (candidate: string) => existing.has(candidate);
    const source = Array.from({ length: 220 }, (_, index) => (
      index === 148 ? 'assertAiBudgetReservationForProvider({ ownedBehavior: true });' : `// line ${index + 1}`
    )).join('\n');
    const readSource = () => source;
    const target = {
      pattern: 'src/services/gemini-provider.ts:149-155',
      anchor: 'ownedBehavior: true',
      behavior: 'The retained provider test owns this budget reservation behavior.',
      replacementTest: '__tests__/services/retained-cleanup.test.ts',
      ownerTestName: 'retained provider suite proves budget reservation behavior',
      minimumMutants: 1,
    };

    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [target],
    }, exists, readSource)).toEqual([]);
    expect(validateGovernedMutationTarget(target, baseMapping, exists, readSource)).toEqual([]);
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [{ ...target, pattern: 'src/services/openai-provider.ts:10-20' }],
    }, exists, readSource)).toContain(
      'mutation target source is not governed by mapping.sources: src/services/openai-provider.ts',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      sources: ['src/services/missing-provider.ts'],
      mutationTargets: [{ ...target, pattern: 'src/services/missing-provider.ts:10-20' }],
    }, exists, readSource)).toEqual(expect.arrayContaining([
      'source path does not exist: src/services/missing-provider.ts',
      'mutation target source does not exist: src/services/missing-provider.ts',
    ]));
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [{ ...target, pattern: 'src/services/gemini-provider.ts:0-20' }],
    }, exists, readSource)).toContain(
      'invalid mutation target pattern: src/services/gemini-provider.ts:0-20',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [{ ...target, pattern: 'src/services/gemini-provider.ts:149-221' }],
    }, exists, readSource)).toContain(
      'mutation target line range exceeds src/services/gemini-provider.ts (220 lines): src/services/gemini-provider.ts:149-221',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [{ ...target, anchor: 'not-in-selected-lines' }],
    }, exists, readSource)).toContain(
      'mutation target anchor is absent from selected lines: src/services/gemini-provider.ts:149-155',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [{ ...target, replacementTest: '__tests__/services/unowned.test.ts' }],
    }, exists, readSource)).toContain(
      'mutation target replacementTest is not retained by the cleanup mapping: src/services/gemini-provider.ts:149-155',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [{ ...target, minimumMutants: 0 }],
    }, exists, readSource)).toContain(
      'mutation target minimumMutants must be a positive integer: src/services/gemini-provider.ts:149-155',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [{ ...target, pattern: 'src/services/gemini-provider.ts:149-203' }],
    }, exists, readSource)).toContain(
      'mutation target range exceeds 12 lines: src/services/gemini-provider.ts:149-203',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [target, { ...target }],
    }, exists, readSource)).toContain(
      'duplicate governed mutation range: src/services/gemini-provider.ts:149-155',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [
        target,
        {
          ...target,
          pattern: 'src/services/gemini-provider.ts:150-156',
          anchor: 'secondOwnedBehavior',
        },
      ],
    }, exists, () => Array.from({ length: 220 }, (_, index) => {
      if (index === 148) return 'ownedBehavior: true';
      if (index === 149) return 'secondOwnedBehavior';
      return `line ${index + 1}`;
    }).join('\n'))).toContain(
      'governed mutation ranges overlap: src/services/gemini-provider.ts:149-155 and src/services/gemini-provider.ts:150-156',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [target],
    }, exists, () => Array.from({ length: 220 }, (_, index) => (
      index === 148 || index === 149 ? 'ownedBehavior: true' : `line ${index + 1}`
    )).join('\n'))).toContain(
      'mutation target anchor must occur exactly once in selected lines: src/services/gemini-provider.ts:149-155',
    );
    const { ownerTestName: _ownerTestName, ...targetWithoutOwnerTest } = target;
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: [targetWithoutOwnerTest],
    }, exists, readSource)).toContain(
      'mutation target must declare exactly one ownerTestName or ownerTestNamePattern: src/services/gemini-provider.ts:149-155',
    );
    expect(validateCleanupMapping({
      ...baseMapping,
      mutationTargets: ['src/services/gemini-provider.ts:149-155'],
    }, exists, readSource)).toContain('mutation target must be a structured ownership entry');
  });

  it('separates exact test-cleanup ownership from weekly changed-critical source edits', () => {
    const deletedTest = '__tests__/services/deleted-cleanup.test.ts';
    const retainedTest = '__tests__/services/retained-cleanup.test.ts';
    const shrunkTest = '__tests__/services/shrunk-cleanup.test.ts';
    const files = new Set([
      retainedTest,
      shrunkTest,
      'src/services/cooking-tenant-scope.ts',
      'src/services/gemini-provider.ts',
      'src/services/openai-provider.ts',
      'src/services/unrelated-provider.ts',
    ]);
    const relative = (candidate: string) => path.relative(path.resolve('.'), candidate).split(path.sep).join('/');
    const exists = (candidate: string) => files.has(relative(candidate));
    const current = new Map([
      [shrunkTest, `import '../../src/services/openai-provider'; test('kept', () => {});`],
    ]);
    const previous = new Map([
      [deletedTest, `import '../../src/services/cooking-tenant-scope'; test('removed', () => {});`],
      [shrunkTest, `import '../../src/services/openai-provider'; test('kept', () => {}); test('removed', () => {});`],
    ]);
    const changes = [
      { status: 'M', file: 'src/services/unrelated-provider.ts', previous: null },
      { status: 'D', file: deletedTest, previous: null },
      { status: 'M', file: shrunkTest, previous: null },
    ];
    const cleanupMappings = [{
      test: deletedTest,
      replacementTests: [retainedTest],
      sources: ['src/services/gemini-provider.ts'],
      mutationTargets: [
        {
          pattern: 'src/services/gemini-provider.ts:10-20',
          anchor: 'firstOwnedBehavior',
          behavior: 'The retained cleanup suite owns the first provider behavior range.',
          replacementTest: retainedTest,
          ownerTestName: 'retained provider owner proves first behavior range',
          minimumMutants: 1,
        },
        {
          pattern: 'src/services/gemini-provider.ts:30-40',
          anchor: 'secondOwnedBehavior',
          behavior: 'The retained cleanup suite owns the second provider behavior range.',
          replacementTest: retainedTest,
          ownerTestName: 'retained provider owner proves second behavior range',
          minimumMutants: 1,
        },
      ],
      reason: 'Retained behavior protects the removed cleanup assertions.',
    }, {
      test: shrunkTest,
      replacementTests: [shrunkTest],
      sources: ['src/services/openai-provider.ts'],
      mutationTargets: [{
        pattern: 'src/services/openai-provider.ts:5-6',
        anchor: 'openAiOwnedBehavior',
        behavior: 'The retained modified suite owns this OpenAI provider behavior range.',
        replacementTest: shrunkTest,
        ownerTestName: 'shrunk provider suite proves owned behavior range',
        minimumMutants: 1,
      }],
      reason: 'Retained modified assertions continue to own the provider behavior.',
    }];
    const shared = {
      base: 'fixture-base',
      changes,
      patterns: ['src/services/*tenant*.ts', 'src/services/*provider*.ts'],
      cleanupMappings,
      // Coverage ratchets are intentionally not mutation exemptions.
      coverageExceptions: [{
        file: 'src/services/gemini-provider.ts',
        owner: 'provider-platform',
        reason: 'Coverage ratchet must not suppress cleanup mutation ownership.',
        expires: '2099-12-31',
      }],
      exists,
      readCurrent: (file: string) => current.get(file) ?? '',
      readPrevious: (_base: string, file: string) => previous.get(file) ?? '',
      readSource: (candidate: string) => Array.from({ length: 50 }, (_, index) => {
        if (index === 9) return 'firstOwnedBehavior';
        if (index === 29) return 'secondOwnedBehavior';
        if (candidate.endsWith('openai-provider.ts') && index === 4) return 'openAiOwnedBehavior';
        return `line ${index + 1}`;
      }).join('\n'),
    };

    const cleanup = buildMutationPlan({ ...shared, scope: 'test-cleanup' });
    expect(cleanup.targets).toEqual([
      'src/services/gemini-provider.ts:10-20',
      'src/services/gemini-provider.ts:30-40',
      'src/services/openai-provider.ts:5-6',
    ]);
    expect(cleanup.testFiles).toEqual([retainedTest, shrunkTest]);
    expect(cleanup.excludedTargets).toEqual([]);
    expect(cleanup.minimumMutants).toBe(3);

    const weekly = buildMutationPlan({ ...shared, scope: 'changed-critical' });
    expect(weekly.targets).toEqual(['src/services/unrelated-provider.ts']);
    expect(weekly.testFiles).toEqual([]);
  });

  it('keeps mapped non-critical cleanup sources in targeted mutation scope', () => {
    const deletedTest = '__tests__/services/deleted-content-contract.test.ts';
    const replacementTest = '__tests__/services/content-workflow.test.ts';
    const source = 'src/services/content-workflow.ts';
    const files = new Set([replacementTest, source]);
    const relative = (candidate: string) => path.relative(path.resolve('.'), candidate)
      .split(path.sep).join('/');
    const exists = (candidate: string) => files.has(relative(candidate));
    const plan = buildMutationPlan({
      base: 'fixture-base',
      changes: [{ status: 'D', file: deletedTest, previous: null }],
      patterns: ['src/services/database.ts'],
      scope: 'test-cleanup',
      cleanupMappings: [{
        test: deletedTest,
        replacementTests: [replacementTest],
        sources: [source],
        mutationTargets: [{
          pattern: `${source}:5-5`,
          anchor: 'ownedContentBehavior',
          behavior: 'The retained content contract owns the selected workflow decision.',
          replacementTest,
          ownerTestName: 'content workflow preserves the selected decision',
          minimumMutants: 1,
        }],
        reason: 'The retained content contract replaces the deleted focused behavior.',
      }],
      exists,
      readCurrent: () => '',
      readPrevious: () => "it('removed', () => expect(result).toBe('ready'));",
      readSource: () => [
        'line 1',
        'line 2',
        'line 3',
        'line 4',
        'ownedContentBehavior',
      ].join('\n'),
    });

    expect(plan.targets).toEqual([`${source}:5-5`]);
    expect(plan.governedSources).toEqual([source]);
    expect(plan.testFiles).toEqual([replacementTest]);
    expect(plan.minimumMutants).toBe(1);
    expect(mutationPlanExitCode(plan)).toBe(0);
  });

  it('does not let a historical replacement mapping authorize a later retained-test cleanup', () => {
    const changedTest = '__tests__/services/changed-provider.test.ts';
    const ownerTest = '__tests__/services/owner-provider.test.ts';
    const legacyTest = '__tests__/services/legacy-provider.test.ts';
    const source = 'src/services/gemini-provider.ts';
    const files = new Set([changedTest, ownerTest, source]);
    const relative = (candidate: string) => path.relative(path.resolve('.'), candidate).split(path.sep).join('/');
    const exists = (candidate: string) => files.has(relative(candidate));
    const plan = buildMutationPlan({
      base: 'fixture-base',
      changes: [{ status: 'M', file: changedTest, previous: null }],
      patterns: ['src/services/*provider*.ts'],
      scope: 'test-cleanup',
      cleanupMappings: [{
        test: legacyTest,
        replacementTests: [changedTest, ownerTest],
        sources: [source],
        mutationTargets: [{
          pattern: `${source}:10-10`,
          anchor: 'ownedProviderBehavior',
          behavior: 'The dedicated retained owner suite protects the selected provider behavior.',
          replacementTest: ownerTest,
          ownerTestName: 'dedicated retained owner proves selected provider behavior',
          minimumMutants: 1,
        }],
        reason: 'The modified suite delegates the selected behavior to its retained owner.',
      }],
      exists,
      readCurrent: () => "it('kept', () => expect(result.status).toBe(201));",
      readPrevious: () => "it('kept', () => { expect(result.status).toBe(200); expect(result.owner).toBe('user'); });",
      readSource: () => Array.from({ length: 20 }, (_, index) => (
        index === 9 ? 'ownedProviderBehavior' : `line ${index + 1}`
      )).join('\n'),
    });

    expect(plan.unmappedRetainedCleanupTests).toEqual([changedTest]);
    expect(plan.targets).toEqual([]);
    expect(plan.testFiles).toEqual([]);
    expect(mutationPlanExitCode(plan)).toBe(3);
  });

  it('does not authorize a modified retained suite from historical global mappings', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8')) as {
      mutation: {
        criticalModulePatterns: string[];
        cleanupMappings: Array<Record<string, unknown>>;
      };
    };
    const cases = [
      '__tests__/api/training-plan-generation.test.ts',
      '__tests__/brand/package-manifest.test.ts',
    ];
    expect(policy.mutation.cleanupMappings.filter(
      (mapping) => cases.includes(String(mapping.test)),
    )).toEqual([]);

    for (const testFile of cases) {
      const plan = buildMutationPlan({
        base: 'fixture-base',
        changes: [{ status: 'M', file: testFile, previous: null }],
        patterns: policy.mutation.criticalModulePatterns,
        scope: 'test-cleanup',
        cleanupMappings: policy.mutation.cleanupMappings,
        readCurrent: () => "it('retained contract', () => expect(contract.version).toBe(2));",
        readPrevious: () => "it('retained contract', () => { expect(contract.version).toBe(1); expect(contract.owner).toBe('user'); });",
      });

      expect(plan.cleanupTests).toEqual([testFile]);
      expect(plan.unmappedRetainedCleanupTests).toEqual([testFile]);
      expect(plan.invalidCleanupMappings).toEqual([]);
      expect(plan.targets).toEqual([]);
      expect(mutationPlanExitCode(plan)).toBe(3);
    }
  });

  it('fails malformed mutation exceptions closed instead of suppressing the only target', () => {
    const source = 'src/services/gemini-provider.ts';
    const exists = (candidate: string) => path.relative(path.resolve('.'), candidate) === source;
    const malformed = {
      file: source,
      owner: '',
      reason: 'short',
      expires: '2026-02-30',
    };
    expect(validateMutationException(
      malformed,
      exists,
      Date.parse('2026-07-15T00:00:00Z'),
      ['src/services/*provider*.ts'],
    )).toEqual(
      expect.arrayContaining([
        `mutation exception owner is missing: ${source}`,
        `mutation exception reason is insufficient: ${source}`,
        `mutation exception expiry is invalid: ${source}`,
      ]),
    );

    const shared = {
      base: 'fixture-base',
      changes: [{ status: 'M', file: source, previous: null }],
      patterns: ['src/services/*provider*.ts'],
      exists,
      now: Date.parse('2026-07-15T00:00:00Z'),
    };
    const malformedPlan = buildMutationPlan({
      ...shared,
      mutationExceptions: [malformed],
      scope: 'changed-critical',
    });
    expect(malformedPlan.targets).toEqual([source]);
    expect(malformedPlan.excludedTargets).toEqual([]);
    expect(malformedPlan.invalidMutationExemptions).toHaveLength(1);

    const validPlan = buildMutationPlan({
      ...shared,
      mutationExceptions: [{
        file: source,
        owner: 'provider-platform',
        reason: 'Weekly mutation is temporarily covered by an owned external campaign.',
        expires: '2099-12-31',
      }],
      scope: 'changed-critical',
    });
    expect(validPlan.targets).toEqual([]);
    expect(validPlan.excludedTargets).toHaveLength(1);
    expect(validPlan.invalidMutationExemptions).toEqual([]);
  });

  it('rejects mutation exceptions outside the governed critical module patterns', () => {
    const source = 'src/services/ordinary-service.ts';
    const exists = (candidate: string) => path.relative(path.resolve('.'), candidate) === source;
    const exception = {
      file: source,
      owner: 'service-platform',
      reason: 'This otherwise valid exception must not expand mutation governance scope.',
      expires: '2099-12-31',
    };

    expect(validateMutationException(
      exception,
      exists,
      Date.parse('2026-07-15T00:00:00Z'),
      ['src/services/*provider*.ts'],
    )).toContain(`mutation exception file is outside governed critical module patterns: ${source}`);
  });

  it('validates explicit weekly mutation owner tests and fails malformed mappings closed', () => {
    const source = 'src/services/content-intelligence.ts';
    const testFile = '__tests__/services/content-intelligence.test.ts';
    const files = new Set([source, testFile]);
    const exists = (candidate: string) => files.has(
      path.relative(path.resolve('.'), candidate).split(path.sep).join('/'),
    );
    const valid = {
      source,
      testFiles: [testFile],
      reason: 'This focused behavior suite owns stable mutation scoring for the source.',
    };
    expect(validateMutationOwnerTestMapping(
      valid,
      exists,
      ['src/services/content-intelligence.ts'],
      {
        dispositionRules: [{
          pattern: testFile,
          disposition: 'keep',
          reason: 'Retained deterministic owner.',
        }],
      },
    )).toEqual([]);
    expect(validateMutationOwnerTestMapping(
      valid,
      exists,
      ['src/services/content-intelligence.ts'],
      {
        dispositionRules: [{
          pattern: testFile,
          disposition: 'eval',
          reason: 'Evaluation-only test.',
        }],
      },
    )).toContain(
      `mutation owner test file must have keep disposition, found eval: ${testFile}`,
    );
    expect(validateMutationOwnerTestMapping(
      valid,
      exists,
      ['src/services/content-intelligence.ts'],
      { dispositionRules: [] },
    )).toContain(`mutation owner test file has no policy disposition: ${testFile}`);

    const plan = buildMutationPlan({
      base: 'fixture-base',
      changes: [{ status: 'M', file: source, previous: null }],
      patterns: ['src/services/content-intelligence.ts'],
      scope: 'changed-critical',
      ownerTestMappings: [
        valid,
        {
          source,
          testFiles: [testFile, testFile],
          reason: 'This duplicate mapping must be rejected instead of silently replacing ownership.',
        },
      ],
      exists,
      testPolicy: {
        dispositionRules: [{
          pattern: '__tests__/**/*.test.ts',
          disposition: 'keep',
          reason: 'Retained deterministic tests.',
        }],
      },
    });
    expect(plan.invalidOwnerTestMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source,
        errors: expect.arrayContaining([
          `duplicate mutation owner source: ${source}`,
          `duplicate mutation owner test file: ${testFile}`,
        ]),
      }),
    ]));
    expect(mutationPlanExitCode(plan)).toBe(3);
  });

  it('does not carry retired provider-specific cleanup mappings in the global policy', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8')) as {
      mutation: {
        cleanupMappings: Array<Record<string, unknown>>;
      };
    };
    expect(policy.mutation.cleanupMappings.filter((mapping) => (
      Array.isArray(mapping.sources)
      && mapping.sources.some((source) => (
        source === 'src/services/gemini-provider.ts'
        || source === 'src/services/openai-provider.ts'
      ))
    ))).toEqual([]);
  });

  it('accepts the governed 12-mutant, three-source cleanup report', () => {
    const validation = validateMutationReport(currentMutationReport(), {
      governedSources: [
        'src/services/cooking-tenant-scope.ts',
        'src/services/gemini-provider.ts',
        'src/services/openai-provider.ts',
      ],
      governedRanges: currentGovernedRanges,
      minimumScore: 70,
    });

    expect(validation.valid).toBe(true);
    expect(validation.totalMutants).toBe(12);
    expect(validation.minimumMutants).toBe(12);
    expect(validation.sources).toHaveLength(3);
    expect(validation.ranges).toHaveLength(6);
    expect(validation.ranges.every((range) => range.ownerKilled === range.minimumMutants)).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('fails closed when a governed source reports an unscored mutation status', () => {
    const report = currentMutationReport();
    report.files['src/services/openai-provider.ts'].mutants.push(
      mutant('compile-error', 375, [], 'CompileError'),
    );
    const validation = validateMutationReport(report, {
      governedSources: [
        'src/services/cooking-tenant-scope.ts',
        'src/services/gemini-provider.ts',
        'src/services/openai-provider.ts',
      ],
      governedRanges: currentGovernedRanges,
      minimumScore: 70,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      'governed source contains unscored mutation status CompileError: src/services/openai-provider.ts',
    );
  });

  it('rejects zero-mutant ranges and kills not owned by their retained replacement test', () => {
    const report = currentMutationReport();
    report.testFiles['__tests__/services/openai-provider.test.ts'].tests.push({
      id: 'foreign-test',
      name: 'OpenAIProvider unrelated provider behavior',
    });
    report.files['src/services/openai-provider.ts'].mutants[0].killedBy = ['foreign-test'];
    const validation = validateMutationReport(report, {
      governedSources: [
        'src/services/cooking-tenant-scope.ts',
        'src/services/gemini-provider.ts',
        'src/services/openai-provider.ts',
      ],
      governedRanges: [
        ...currentGovernedRanges,
        {
          pattern: 'src/services/openai-provider.ts:365-368',
          replacementTest: '__tests__/services/openai-provider.test.ts',
          ownerTestName: 'OpenAIProvider one-shot helpers bounds hosted web search, reserves unbounded context, and meters actual provider tool usage',
          minimumMutants: 1,
        },
      ],
      minimumScore: 70,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'governed range owner-killed total 1 is below floor 2: src/services/openai-provider.ts:375-376',
      'governed range mutant total 0 is below floor 1: src/services/openai-provider.ts:365-368',
      'governed range mutation score 0.00 is below 70: src/services/openai-provider.ts:365-368',
      'governed range owner-killed total 0 is below floor 1: src/services/openai-provider.ts:365-368',
    ]));
  });

  it('derives a one-mutant floor for a legitimate small future cleanup range', () => {
    const validation = validateMutationReport({
      files: {
        'src/services/gemini-provider.ts': {
          mutants: [mutant('small', 639, ['small-owner'])],
        },
      },
      testFiles: {
        '__tests__/services/gemini-provider.test.ts': {
          tests: [{ id: 'small-owner', name: 'small provider owner proves grounded budget behavior' }],
        },
      },
    }, {
      governedSources: ['src/services/gemini-provider.ts'],
      governedRanges: [{
        pattern: 'src/services/gemini-provider.ts:639-639',
        replacementTest: '__tests__/services/gemini-provider.test.ts',
        ownerTestName: 'small provider owner proves grounded budget behavior',
        minimumMutants: 1,
      }],
      minimumScore: 70,
    });

    expect(validation.valid).toBe(true);
    expect(validation.minimumMutants).toBe(1);
  });

  it('rejects a thin report, missing governed source, NoCoverage, and sub-70 source score', () => {
    const validation = validateMutationReport({
      files: {
        'src/services/gemini-provider.ts': {
          mutants: [
            { id: '1', status: 'Killed' },
          ],
        },
        'src/services/openai-provider.ts': {
          mutants: [
            { id: '4', status: 'NoCoverage' },
          ],
        },
      },
    }, {
      governedSources: [
        'src/services/cooking-tenant-scope.ts',
        'src/services/gemini-provider.ts',
        'src/services/openai-provider.ts',
      ],
      minimumScore: 70,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'governed source is missing from Stryker report: src/services/cooking-tenant-scope.ts',
      'governed source contains 1 NoCoverage mutant(s): src/services/openai-provider.ts',
      'governed source mutation score 0.00 is below 70: src/services/openai-provider.ts',
      'governed mutant total 2 is below plan-derived floor 3',
    ]));
  });

  it('passes Stryker 9 thresholds through config environment instead of removed CLI flags', () => {
    const invocation = buildStrykerInvocation({
      config: '/repo/config/stryker.config.mjs',
      targets: ['src/services/database.ts'],
      thresholds: { high: 80, low: 70, break: 70 },
      testFiles: ['__tests__/services/database.test.ts'],
      scope: 'test-cleanup',
    });

    expect(invocation.args).toEqual(['run', '/repo/config/stryker.config.mjs']);
    expect(invocation.args.join(' ')).not.toContain('--thresholds.');
    expect(JSON.parse(invocation.env.NEXUS_MUTATE_FILES)).toEqual(['src/services/database.ts']);
    expect(JSON.parse(invocation.env.NEXUS_MUTATION_THRESHOLDS)).toEqual({
      high: 80,
      low: 70,
      break: 70,
    });
    expect(JSON.parse(invocation.env.NEXUS_MUTATION_TEST_FILES)).toEqual([
      '__tests__/services/database.test.ts',
    ]);
    expect(invocation.env.NEXUS_MUTATION_SCOPE).toBe('test-cleanup');

    const weekly = buildStrykerInvocation({
      config: '/repo/config/stryker.config.mjs',
      targets: ['src/services/database.ts'],
      thresholds: { high: 80, low: 70, break: 70 },
      testFiles: [],
      scope: 'changed-critical',
    });
    expect(weekly.env).not.toHaveProperty('NEXUS_MUTATION_TEST_FILES');
    expect(weekly.env.NEXUS_MUTATION_SCOPE).toBe('changed-critical');
  });

  it('configures exact cleanup tests but leaves weekly Vitest related selection open', async () => {
    const prior = {
      mutate: process.env.NEXUS_MUTATE_FILES,
      thresholds: process.env.NEXUS_MUTATION_THRESHOLDS,
      tests: process.env.NEXUS_MUTATION_TEST_FILES,
      scope: process.env.NEXUS_MUTATION_SCOPE,
    };
    const configUrl = pathToFileURL(path.resolve('config/stryker.config.mjs')).href;
    try {
      process.env.NEXUS_MUTATE_FILES = JSON.stringify(['src/services/database.ts']);
      process.env.NEXUS_MUTATION_THRESHOLDS = JSON.stringify({ high: 80, low: 70, break: 70 });
      delete process.env.NEXUS_MUTATION_TEST_FILES;
      process.env.NEXUS_MUTATION_SCOPE = 'changed-critical';
      const weekly = (await import(`${configUrl}?weekly=${Date.now()}`)).default;
      expect(weekly.testFiles).toBeUndefined();
      expect(weekly.vitest).toEqual({
        related: true,
        configFile: 'config/vitest.stryker.config.ts',
      });
      expect(weekly.concurrency).toBe(1);
      expect(weekly.ignoreStatic).toBe(false);
      expect(weekly.coverageAnalysis).toBe('perTest');

      process.env.NEXUS_MUTATION_SCOPE = 'test-cleanup';
      await expect(import(`${configUrl}?missing-cleanup-owner=${Date.now()}`)).rejects.toThrow(
        'test-cleanup mutation scope requires explicit governed retained tests',
      );

      process.env.NEXUS_MUTATION_TEST_FILES = JSON.stringify(['__tests__/services/database.test.ts']);
      const cleanup = (await import(`${configUrl}?cleanup=${Date.now()}`)).default;
      expect(cleanup.testFiles).toEqual(['__tests__/services/database.test.ts']);
      expect(cleanup.ignoreStatic).toBe(false);
      expect(cleanup.coverageAnalysis).toBe('off');
      expect(cleanup.vitest).toEqual({
        related: false,
        configFile: 'config/vitest.stryker.config.ts',
      });
      expect(cleanup.concurrency).toBe(1);
      expect(cleanup.ignorePatterns).toEqual(['/.local', '/.local/**']);
      expect(cleanup.dryRunTimeoutMinutes).toBe(10);
    } finally {
      for (const [key, value] of Object.entries({
        NEXUS_MUTATE_FILES: prior.mutate,
        NEXUS_MUTATION_THRESHOLDS: prior.thresholds,
        NEXUS_MUTATION_TEST_FILES: prior.tests,
        NEXUS_MUTATION_SCOPE: prior.scope,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
