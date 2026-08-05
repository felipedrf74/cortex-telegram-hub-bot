import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
  ROUTING_SYNTHETIC_QA_MANIFEST_SCHEMA,
  ROUTING_SYNTHETIC_QA_QUOTAS,
  ROUTING_SYNTHETIC_QA_SURFACES,
  ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
  buildRoutingSyntheticQaManifest,
  fourGramJaccard,
  getRoutingSyntheticQaSurfaceQuota,
  loadReferenceTexts,
  validateRoutingSyntheticQaManifest,
} from '../../scripts/lib/routing-synthetic-qa-manifest.mjs';

const roots: string[] = [];
const runtimeSha = '4'.repeat(40);
const artifactDigest = '8'.repeat(64);
const referenceSources = [
  { kind: 'routing_corpus', sha256: `sha256:${'a'.repeat(64)}`, textCount: 300 },
  { kind: 'chat_eval_fixtures', sha256: `sha256:${'b'.repeat(64)}`, textCount: 40 },
];

const resolverSkillByDomain: Record<string, string> = {
  secretary: 'secretary',
  triathlon: 'training',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

function expand(counts: Record<string, number>): string[] {
  return Object.entries(counts).flatMap(([value, count]) => Array(count).fill(value));
}

function profileFor(surface: string) {
  return ROUTING_SYNTHETIC_QA_QUOTAS.surfaces[surface];
}

function standaloneText(surface: string, index: number, expectedDomain: string, stratum: string) {
  const ordinal = index + 1;
  if (surface === 'classifierKeyword') {
    return `River${ordinal} review ${expectedDomain} cedar${ordinal} ${stratum} for synthetic project quartz${ordinal} marker while preserving scoped state`;
  }
  if (surface === 'orchestratorPrimary') {
    return `Please map orchard${ordinal} ${expectedDomain} request pebble${ordinal} under ${stratum} with amber${ordinal} context proof${ordinal} and complete independent routing detail${ordinal}`;
  }
  if (surface === 'shadowRoute') {
    return `Harbor${ordinal} contains standalone ${expectedDomain} question lantern${ordinal} in ${stratum} form using cobalt${ordinal} details compass${ordinal} for governed comparison`;
  }
  return `Complete registry${ordinal} example asks about ${expectedDomain} meadow${ordinal} through ${stratum} and includes willow${ordinal} details anchor${ordinal} without prior context`;
}

function validManifest(surface = 'classifierKeyword') {
  const profile = profileFor(surface);
  const domainLocaleRows = Object.entries(profile.expectedDomainsByLocale)
    .flatMap(([locale, counts]) => expand(counts as Record<string, number>)
      .map((expectedDomain) => ({ locale, expectedDomain })));
  const strata = expand(ROUTING_SYNTHETIC_QA_QUOTAS.strata);
  const scenarioRows: Array<{ scenarioGroupId: string; locale: string }> = [];
  let scenarioNumber = 0;
  for (const [locale, shape] of Object.entries(ROUTING_SYNTHETIC_QA_QUOTAS.scenarioGroupsByLocale)) {
    for (const [turnCountText, scenarioCount] of Object.entries(shape as Record<string, number>)) {
      const turnCount = Number(turnCountText);
      for (let scenario = 0; scenario < scenarioCount; scenario += 1) {
        scenarioNumber += 1;
        for (let turnIndex = 1; turnIndex <= turnCount; turnIndex += 1) {
          scenarioRows.push({
            scenarioGroupId: `scenario-${String(scenarioNumber).padStart(3, '0')}`,
            locale,
          });
        }
      }
    }
  }
  expect(domainLocaleRows).toHaveLength(200);
  expect(scenarioRows).toHaveLength(200);
  expect(domainLocaleRows.map((row) => row.locale)).toEqual(scenarioRows.map((row) => row.locale));

  const surfaceIndex = ROUTING_SYNTHETIC_QA_SURFACES.indexOf(surface);
  return {
    schema: ROUTING_SYNTHETIC_QA_MANIFEST_SCHEMA,
    contractVersion: ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
    trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
    runtimeSha,
    artifactDigest,
    environment: 'staging',
    surface,
    userId: 1000050,
    tenantId: 1000050,
    plannedTurns: 200,
    referenceSources: structuredClone(referenceSources),
    predecessorManifestSha256s: Array.from(
      { length: surfaceIndex },
      (_, index) => `sha256:${String(index + 1).repeat(64)}`,
    ),
    turns: domainLocaleRows.map(({ locale, expectedDomain }, index) => ({
      ordinal: index + 1,
      id: `qa-row-${String(index + 1).padStart(3, '0')}`,
      scenarioGroupId: scenarioRows[index].scenarioGroupId,
      text: standaloneText(surface, index, expectedDomain, strata[index]),
      locale,
      expectedDomain,
      expectedResolverSkill: resolverSkillByDomain[expectedDomain],
      stratum: strata[index],
      standalone: true,
    })),
  };
}

function cliDraft(surface = 'classifierKeyword') {
  const draft: any = validManifest(surface);
  delete draft.referenceSources;
  delete draft.predecessorManifestSha256s;
  return draft;
}

function writePrivate(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function sha256(bytes: string | Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('routing synthetic QA manifest', () => {
  it('freezes the exact surface-specific 200-turn domain/locale and resolver-skill profiles', () => {
    expect(ROUTING_SYNTHETIC_QA_QUOTAS.surfaces.classifierKeyword).toEqual({
      expectedDomains: { secretary: 68, triathlon: 39, content: 32, cooking: 32, finance: 29 },
      expectedResolverSkills: { secretary: 68, training: 39, content: 32, cooking: 32, finance: 29 },
      expectedDomainsByLocale: {
        'en-US': { secretary: 34, triathlon: 20, content: 16, cooking: 16, finance: 14 },
        'pt-BR': { secretary: 20, triathlon: 12, content: 10, cooking: 10, finance: 8 },
        'pt-PT': { secretary: 14, triathlon: 7, content: 6, cooking: 6, finance: 7 },
      },
    });
    expect(ROUTING_SYNTHETIC_QA_QUOTAS.surfaces.orchestratorPrimary)
      .toEqual(ROUTING_SYNTHETIC_QA_QUOTAS.surfaces.classifierKeyword);
    expect(ROUTING_SYNTHETIC_QA_QUOTAS.surfaces.shadowRoute).toEqual({
      expectedDomains: {
        secretary: 53,
        triathlon: 30,
        content: 25,
        cooking: 25,
        finance: 23,
        connections: 17,
        notifications: 14,
        decision_center: 13,
      },
      expectedResolverSkills: {
        secretary: 53,
        training: 30,
        content: 25,
        cooking: 25,
        finance: 23,
        connections: 17,
        notifications: 14,
        decision_center: 13,
      },
      expectedDomainsByLocale: {
        'en-US': {
          secretary: 27,
          triathlon: 15,
          content: 13,
          cooking: 12,
          finance: 11,
          connections: 8,
          notifications: 7,
          decision_center: 7,
        },
        'pt-BR': {
          secretary: 16,
          triathlon: 9,
          content: 7,
          cooking: 8,
          finance: 7,
          connections: 5,
          notifications: 4,
          decision_center: 4,
        },
        'pt-PT': {
          secretary: 10,
          triathlon: 6,
          content: 5,
          cooking: 5,
          finance: 5,
          connections: 4,
          notifications: 3,
          decision_center: 2,
        },
      },
    });
    expect(ROUTING_SYNTHETIC_QA_QUOTAS.surfaces.registrySubset)
      .toEqual(ROUTING_SYNTHETIC_QA_QUOTAS.surfaces.shadowRoute);
    expect(getRoutingSyntheticQaSurfaceQuota('classifierKeyword'))
      .toBe(ROUTING_SYNTHETIC_QA_QUOTAS.surfaces.classifierKeyword);
    expect(() => getRoutingSyntheticQaSurfaceQuota('not-a-surface')).toThrow(/surface/);
  });

  it.each(ROUTING_SYNTHETIC_QA_SURFACES)(
    'builds deterministic canonical provider-free bytes for %s',
    (surface) => {
      const manifest = validManifest(surface);
      const first = buildRoutingSyntheticQaManifest(manifest, { referenceTexts: [] });
      const second = buildRoutingSyntheticQaManifest(structuredClone(manifest), { referenceTexts: [] });

      expect(first.bytes).toBe(second.bytes);
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.sha256).toBe(second.sha256);
      expect(first.bytes).toBe(`${JSON.stringify(first.manifest)}\n`);
      expect(Object.keys(first.manifest).sort()).toEqual([
        'artifactDigest',
        'contractVersion',
        'environment',
        'plannedTurns',
        'predecessorManifestSha256s',
        'referenceSources',
        'runtimeSha',
        'schema',
        'surface',
        'tenantId',
        'trafficClass',
        'turns',
        'userId',
      ]);
      expect(Object.keys(first.manifest.turns[0]).sort()).toEqual([
        'expectedDomain',
        'expectedResolverSkill',
        'id',
        'locale',
        'ordinal',
        'scenarioGroupId',
        'standalone',
        'stratum',
        'text',
      ]);
      expect(first.manifest.turns).toHaveLength(200);
      expect(first.summary).toMatchObject({
        plannedTurns: 200,
        providerCallsAllowed: 0,
        scenarioGroups: 83,
        twoTurnScenarioGroups: 49,
        threeTurnScenarioGroups: 34,
        referenceSources,
      });
      expect(first.summary).not.toHaveProperty('conversations');
    },
  );

  it('rejects wrong identity, release, surface, schema, quotas, ordering, and unknown fields', () => {
    const cases: Array<[string, (manifest: any) => void]> = [
      ['schema', (manifest) => { manifest.schema = 'other'; }],
      ['runtimeSha', (manifest) => { manifest.runtimeSha = '4'.repeat(39); }],
      ['artifactDigest', (manifest) => { manifest.artifactDigest = '8'.repeat(63); }],
      ['environment', (manifest) => { manifest.environment = 'production'; }],
      ['surface', (manifest) => { manifest.surface = 'all'; }],
      ['same positive canonical ID', (manifest) => { manifest.tenantId = 1000051; }],
      ['plannedTurns', (manifest) => { manifest.plannedTurns = 199; }],
      ['ordinal', (manifest) => { manifest.turns[3].ordinal = 8; }],
      ['locale quota', (manifest) => { manifest.turns[0].locale = 'pt-BR'; }],
      ['expected resolver skill', (manifest) => { manifest.turns[0].expectedResolverSkill = 'training'; }],
      ['standalone', (manifest) => { manifest.turns[0].standalone = false; }],
      ['stratum quota', (manifest) => { manifest.turns[0].stratum = 'missing_field_clarification'; }],
      ['unknown top-level field', (manifest) => { manifest.unreviewed = true; }],
      ['unknown turn field', (manifest) => { manifest.turns[0].conversationId = 'not-runtime-bound'; }],
    ];
    for (const [message, mutate] of cases) {
      const manifest: any = validManifest();
      mutate(manifest);
      expect(() => validateRoutingSyntheticQaManifest(manifest, { referenceTexts: [] }), message).toThrow();
    }
  });

  it('enforces the per-surface domain-by-locale matrix even when marginal quotas stay unchanged', () => {
    const manifest: any = validManifest('classifierKeyword');
    const englishSecretary = manifest.turns.find((turn: any) => turn.locale === 'en-US' && turn.expectedDomain === 'secretary');
    const brazilTraining = manifest.turns.find((turn: any) => turn.locale === 'pt-BR' && turn.expectedDomain === 'triathlon');
    [englishSecretary.expectedDomain, brazilTraining.expectedDomain] = [brazilTraining.expectedDomain, englishSecretary.expectedDomain];
    [englishSecretary.expectedResolverSkill, brazilTraining.expectedResolverSkill] = [
      brazilTraining.expectedResolverSkill,
      englishSecretary.expectedResolverSkill,
    ];
    expect(() => validateRoutingSyntheticQaManifest(manifest, { referenceTexts: [] }))
      .toThrow(/domain-by-locale quota/);
  });

  it('requires immutable typed corpus/eval lineage and strict predecessor digests by surface order', () => {
    const missingSource: any = validManifest();
    missingSource.referenceSources = missingSource.referenceSources.filter((source: any) => source.kind !== 'routing_corpus');
    expect(() => validateRoutingSyntheticQaManifest(missingSource)).toThrow(/routing_corpus/);

    const zeroTexts: any = validManifest();
    zeroTexts.referenceSources[0].textCount = 0;
    expect(() => validateRoutingSyntheticQaManifest(zeroTexts)).toThrow(/textCount/);

    const spoofedDigest: any = validManifest();
    spoofedDigest.referenceSources[0].sha256 = `sha256:${'c'.repeat(64)}`;
    expect(() => validateRoutingSyntheticQaManifest(spoofedDigest, {
      expectedReferenceSources: referenceSources,
    })).toThrow(/operator-derived binding/);

    const malformedDigest: any = validManifest();
    malformedDigest.referenceSources[0].sha256 = `sha256:${'z'.repeat(64)}`;
    expect(() => validateRoutingSyntheticQaManifest(malformedDigest)).toThrow(/sha256/);

    const extraSourceField: any = validManifest();
    extraSourceField.referenceSources[0].path = '/private/not-allowed';
    expect(() => validateRoutingSyntheticQaManifest(extraSourceField)).toThrow(/fields/);

    const reversedSources: any = validManifest();
    reversedSources.referenceSources.reverse();
    expect(() => validateRoutingSyntheticQaManifest(reversedSources)).toThrow(/canonical order/);

    const noClassifierPredecessor: any = validManifest();
    noClassifierPredecessor.predecessorManifestSha256s = [`sha256:${'c'.repeat(64)}`];
    expect(() => validateRoutingSyntheticQaManifest(noClassifierPredecessor)).toThrow(/predecessor/);

    const missingOrchestratorPredecessor: any = validManifest('orchestratorPrimary');
    missingOrchestratorPredecessor.predecessorManifestSha256s = [];
    expect(() => validateRoutingSyntheticQaManifest(missingOrchestratorPredecessor)).toThrow(/predecessor/);

    const duplicateRegistryPredecessor: any = validManifest('registrySubset');
    duplicateRegistryPredecessor.predecessorManifestSha256s[1] = duplicateRegistryPredecessor.predecessorManifestSha256s[0];
    expect(() => validateRoutingSyntheticQaManifest(duplicateRegistryPredecessor)).toThrow(/predecessor/);

    const spoofedPredecessor: any = validManifest('orchestratorPrimary');
    expect(() => validateRoutingSyntheticQaManifest(spoofedPredecessor, {
      expectedPredecessorManifestSha256s: [`sha256:${'d'.repeat(64)}`],
    })).toThrow(/operator-derived binding/);
  });

  it('rejects duplicate text or ids, Spanish, reference leakage, and templated within-manifest overlap', () => {
    const duplicateText: any = validManifest();
    duplicateText.turns[1].text = duplicateText.turns[0].text;
    expect(() => validateRoutingSyntheticQaManifest(duplicateText, { referenceTexts: [] }))
      .toThrow(/normalized text is not unique/);

    const duplicateId: any = validManifest();
    duplicateId.turns[1].id = duplicateId.turns[0].id;
    expect(() => validateRoutingSyntheticQaManifest(duplicateId, { referenceTexts: [] }))
      .toThrow(/turn id is not unique/);

    const spanish: any = validManifest();
    spanish.turns[0].text = '¿Puedes revisar mis tareas de hoy antes de la reunión de mañana?';
    expect(() => validateRoutingSyntheticQaManifest(spanish, { referenceTexts: [] }))
      .toThrow(/Spanish marker/);

    const exactReference: any = validManifest();
    expect(() => validateRoutingSyntheticQaManifest(exactReference, {
      referenceTexts: [exactReference.turns[0].text],
    })).toThrow(/normalized exact reference match/);

    const passage: any = validManifest();
    const shared = passage.turns[0].text.split(/\s+/).slice(0, 8).join(' ');
    expect(() => validateRoutingSyntheticQaManifest(passage, {
      referenceTexts: [`Unrelated prefix ${shared} unrelated suffix`],
    })).toThrow(/shared contiguous 8-token passage/);

    const isolatedWithinManifestPassage: any = validManifest();
    isolatedWithinManifestPassage.turns[0].text =
      'Review my morning agenda and keep this exact shared passage for overlap checking while highlighting urgent calendar conflicts.';
    isolatedWithinManifestPassage.turns[1].text =
      'List tomorrow afternoon reminders, then keep this exact shared passage for overlap checking before noting any unfinished task.';
    expect(() => validateRoutingSyntheticQaManifest(isolatedWithinManifestPassage, { referenceTexts: [] }))
      .toThrow('within-manifest 8-token overlap at ordinals 1 and 2');

    const templated: any = validManifest();
    templated.turns[1].text = `${templated.turns[0].text} tomorrow`;
    expect(() => validateRoutingSyntheticQaManifest(templated, { referenceTexts: [] }))
      .toThrow(/within-manifest/);
  });

  it('accepts the ordinary English word decision', () => {
    const english: any = validManifest();
    const englishIndex = english.turns.findIndex((turn: any) => turn.locale === 'en-US');
    english.turns[englishIndex].text =
      'Please review this decision and summarize the available options before my meeting';
    expect(() => validateRoutingSyntheticQaManifest(english, { referenceTexts: [] }))
      .not.toThrow();
  });

  it('accepts the ordinary Portuguese word eliminar', () => {
    const portuguese: any = validManifest();
    const portugueseIndex = portuguese.turns.findIndex((turn: any) => turn.locale === 'pt-BR');
    portuguese.turns[portugueseIndex].text =
      'Por favor, eliminar este lembrete antigo e manter os restantes na lista de hoje';
    expect(() => validateRoutingSyntheticQaManifest(portuguese, { referenceTexts: [] }))
      .not.toThrow();
  });

  it('computes four-gram Jaccard on normalized token sets', () => {
    expect(fourGramJaccard('one two three four five', 'one two three four six')).toBeCloseTo(1 / 3);
    expect(fourGramJaccard('one two three', 'one two three')).toBe(0);
  });

  it('loads typed private reference sources and binds their exact hashes and text counts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-routing-qa-refs-'));
    roots.push(root);
    const corpus = path.join(root, 'corpus.json');
    const fixtures = path.join(root, 'fixtures.jsonl');
    const history = path.join(root, 'history.txt');
    writePrivate(corpus, JSON.stringify({ rows: [{ utterance_text: 'private corpus row' }, { metadata: 'ignored' }] }));
    writePrivate(fixtures, `${JSON.stringify({ prompt: 'fixture prompt row' })}\n${JSON.stringify({ text: 'history text row' })}\n`);
    writePrivate(history, 'first history row\nsecond history row\n');

    const loaded = loadReferenceTexts([
      `chat_eval_fixtures=${fixtures}`,
      `qa_history=${history}`,
      `routing_corpus=${corpus}`,
    ]);
    expect(loaded.texts.sort()).toEqual([
      'first history row',
      'fixture prompt row',
      'history text row',
      'private corpus row',
      'second history row',
    ]);
    expect(loaded.sources).toEqual([
      { kind: 'routing_corpus', sha256: `sha256:${sha256(fs.readFileSync(corpus))}`, textCount: 1 },
      { kind: 'chat_eval_fixtures', sha256: `sha256:${sha256(fs.readFileSync(fixtures))}`, textCount: 2 },
      { kind: 'qa_history', sha256: `sha256:${sha256(fs.readFileSync(history))}`, textCount: 2 },
    ]);
  });

  it('rejects untyped, duplicate-kind, missing, linked, or non-private reference inputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-routing-qa-private-'));
    roots.push(root);
    const corpus = path.join(root, 'corpus.txt');
    const fixtures = path.join(root, 'fixtures.txt');
    writePrivate(corpus, 'private corpus row\n');
    writePrivate(fixtures, 'private eval row\n');

    expect(() => loadReferenceTexts([corpus])).toThrow(/kind=path/);
    expect(() => loadReferenceTexts([
      `routing_corpus=${corpus}`,
      `routing_corpus=${fixtures}`,
      `chat_eval_fixtures=${fixtures}`,
    ])).toThrow(/duplicate reference kind/);
    expect(() => loadReferenceTexts([`routing_corpus=${corpus}`])).toThrow(/chat_eval_fixtures/);

    fs.chmodSync(fixtures, 0o644);
    expect(() => loadReferenceTexts([
      `routing_corpus=${corpus}`,
      `chat_eval_fixtures=${fixtures}`,
    ])).toThrow(/mode 0600/);
    fs.chmodSync(fixtures, 0o600);

    const linked = path.join(root, 'linked.txt');
    fs.linkSync(fixtures, linked);
    expect(() => loadReferenceTexts([
      `routing_corpus=${corpus}`,
      `chat_eval_fixtures=${fixtures}`,
    ])).toThrow(/link count 1/);
  });

  it('CLI injects typed source lineage, writes once at mode 0600, and prints no prompt text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-routing-qa-cli-'));
    roots.push(root);
    const input = path.join(root, 'draft.json');
    const output = path.join(root, 'manifest.json');
    const corpus = path.join(root, 'corpus.txt');
    const fixtures = path.join(root, 'fixtures.txt');
    writePrivate(input, JSON.stringify(cliDraft()));
    writePrivate(corpus, 'reference corpus phrase wholly different alpha beta gamma delta\n');
    writePrivate(fixtures, 'reference fixture phrase wholly different epsilon zeta eta theta\n');

    const args = [
      'scripts/build-routing-synthetic-qa-manifest.mjs',
      '--input', input,
      '--output', output,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', artifactDigest,
      '--surface', 'classifierKeyword',
      '--dedicated-id', '1000050',
      '--reference', `routing_corpus=${corpus}`,
      '--reference', `chat_eval_fixtures=${fixtures}`,
    ];
    const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      schema: ROUTING_SYNTHETIC_QA_MANIFEST_SCHEMA,
      status: 'passed',
      plannedTurns: 200,
      scenarioGroups: 83,
      providerCallsAllowed: 0,
    });
    expect(summary.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.stdout).not.toContain((validManifest() as any).turns[0].text);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(parsed.referenceSources.map((source: any) => source.kind)).toEqual([
      'routing_corpus',
      'chat_eval_fixtures',
    ]);
    expect(parsed.predecessorManifestSha256s).toEqual([]);

    const overwrite = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toContain('output already exists');
  });

  it('CLI binds strict canonical predecessor order and rejects cross-surface prompt reuse', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-routing-qa-predecessor-'));
    roots.push(root);
    const corpus = path.join(root, 'corpus.txt');
    const fixtures = path.join(root, 'fixtures.txt');
    const classifierPath = path.join(root, 'classifier.json');
    const classifier = buildRoutingSyntheticQaManifest(validManifest('classifierKeyword'));
    writePrivate(corpus, 'reference corpus phrase wholly different alpha beta gamma delta\n');
    writePrivate(fixtures, 'reference fixture phrase wholly different epsilon zeta eta theta\n');
    writePrivate(classifierPath, classifier.bytes);

    const input = path.join(root, 'orchestrator-draft.json');
    const output = path.join(root, 'orchestrator.json');
    const draft: any = cliDraft('orchestratorPrimary');
    writePrivate(input, JSON.stringify(draft));
    const baseArgs = [
      'scripts/build-routing-synthetic-qa-manifest.mjs',
      '--input', input,
      '--output', output,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', artifactDigest,
      '--surface', 'orchestratorPrimary',
      '--dedicated-id', '1000050',
      '--reference', `routing_corpus=${corpus}`,
      '--reference', `chat_eval_fixtures=${fixtures}`,
      '--predecessor-manifest', classifierPath,
    ];

    const pass = spawnSync(process.execPath, baseArgs, { cwd: process.cwd(), encoding: 'utf8' });
    expect(pass.status, pass.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).predecessorManifestSha256s)
      .toEqual([`sha256:${sha256(classifier.bytes)}`]);

    const reusedDraft: any = cliDraft('orchestratorPrimary');
    reusedDraft.turns[0].text = (validManifest('classifierKeyword') as any).turns[0].text;
    const reusedInput = path.join(root, 'reused.json');
    writePrivate(reusedInput, JSON.stringify(reusedDraft));
    const reuse = spawnSync(process.execPath, [
      ...baseArgs.slice(0, 2), reusedInput,
      ...baseArgs.slice(3, 4), path.join(root, 'reused-output.json'),
      ...baseArgs.slice(5),
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(reuse.status).toBe(1);
    expect(reuse.stderr).toMatch(/reference match|shared contiguous|similarity/);
  });

  it('CLI refuses draft lineage injection and non-private input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-routing-qa-cli-private-'));
    roots.push(root);
    const corpus = path.join(root, 'corpus.txt');
    const fixtures = path.join(root, 'fixtures.txt');
    writePrivate(corpus, 'reference corpus phrase wholly different alpha beta gamma delta\n');
    writePrivate(fixtures, 'reference fixture phrase wholly different epsilon zeta eta theta\n');

    const run = (input: string, output: string) => spawnSync(process.execPath, [
      'scripts/build-routing-synthetic-qa-manifest.mjs',
      '--input', input,
      '--output', output,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', artifactDigest,
      '--surface', 'classifierKeyword',
      '--dedicated-id', '1000050',
      '--reference', `routing_corpus=${corpus}`,
      '--reference', `chat_eval_fixtures=${fixtures}`,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    const injected = path.join(root, 'injected.json');
    writePrivate(injected, JSON.stringify(validManifest()));
    const injection = run(injected, path.join(root, 'injected-output.json'));
    expect(injection.status).toBe(1);
    expect(injection.stderr).toContain('operator-derived lineage');

    const publicInput = path.join(root, 'public.json');
    writePrivate(publicInput, JSON.stringify(cliDraft()));
    fs.chmodSync(publicInput, 0o644);
    const publicResult = run(publicInput, path.join(root, 'public-output.json'));
    expect(publicResult.status).toBe(1);
    expect(publicResult.stderr).toContain('mode 0600');
  });

  it('CLI rejects noncanonical, wrong-surface, and wrong-release predecessor files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-routing-qa-predecessor-adversary-'));
    roots.push(root);
    const corpus = path.join(root, 'corpus.txt');
    const fixtures = path.join(root, 'fixtures.txt');
    const input = path.join(root, 'orchestrator-draft.json');
    writePrivate(corpus, 'reference corpus phrase wholly different alpha beta gamma delta\n');
    writePrivate(fixtures, 'reference fixture phrase wholly different epsilon zeta eta theta\n');
    writePrivate(input, JSON.stringify(cliDraft('orchestratorPrimary')));

    const run = (predecessor: string, output: string) => spawnSync(process.execPath, [
      'scripts/build-routing-synthetic-qa-manifest.mjs',
      '--input', input,
      '--output', output,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', artifactDigest,
      '--surface', 'orchestratorPrimary',
      '--dedicated-id', '1000050',
      '--reference', `routing_corpus=${corpus}`,
      '--reference', `chat_eval_fixtures=${fixtures}`,
      '--predecessor-manifest', predecessor,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    const canonical = buildRoutingSyntheticQaManifest(validManifest('classifierKeyword')).bytes;
    const noncanonical = path.join(root, 'noncanonical.json');
    writePrivate(noncanonical, `${canonical.trimEnd()} \n`);
    expect(run(noncanonical, path.join(root, 'noncanonical-output.json')).stderr).toContain('not canonical');

    const wrongSurface = path.join(root, 'wrong-surface.json');
    writePrivate(wrongSurface, buildRoutingSyntheticQaManifest(validManifest('orchestratorPrimary')).bytes);
    expect(run(wrongSurface, path.join(root, 'wrong-surface-output.json')).stderr)
      .toContain('surface does not match operator binding');

    const wrongReleaseManifest: any = validManifest('classifierKeyword');
    wrongReleaseManifest.runtimeSha = '5'.repeat(40);
    const wrongRelease = path.join(root, 'wrong-release.json');
    writePrivate(wrongRelease, buildRoutingSyntheticQaManifest(wrongReleaseManifest).bytes);
    expect(run(wrongRelease, path.join(root, 'wrong-release-output.json')).stderr)
      .toContain('runtime SHA does not match operator binding');
  });
});
