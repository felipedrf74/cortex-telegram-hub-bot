import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ROUTING_SYNTHETIC_QA_RECEIPT_SCHEMA,
  attestRoutingSyntheticQaManifestChain,
  executeRoutingSyntheticQaCampaign,
  main,
  routingSyntheticQaTurnIdentity,
  validateRoutingSyntheticQaReleaseLockFile,
} from '../../scripts/run-routing-synthetic-qa.mjs';
import {
  ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
  ROUTING_SYNTHETIC_QA_QUOTAS,
  ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
  buildRoutingSyntheticQaManifest,
  canonicalJson,
} from '../../scripts/lib/routing-synthetic-qa-manifest.mjs';

const runtimeSha = '4'.repeat(40);
const artifactDigest = '8'.repeat(64);
const manifestSha256 = 'a'.repeat(64);
const dedicatedId = 1_000_050;
const surface = 'classifierKeyword';
const secretToken = 'secret-token-must-never-appear-in-evidence';
const secretHealthToken = 'separate-health-token-must-stay-private';
const temporaryRoots: string[] = [];

function expandCounts(counts: Record<string, number>): string[] {
  return Object.entries(counts).flatMap(([value, count]) => Array(count).fill(value));
}

function storedManifest(surfaceName: string, predecessorManifestSha256s: string[] = []) {
  const profile = ROUTING_SYNTHETIC_QA_QUOTAS.surfaces[surfaceName];
  const domainRows = Object.entries(profile.expectedDomainsByLocale)
    .flatMap(([locale, counts]) => expandCounts(counts as Record<string, number>)
      .map((expectedDomain) => ({ locale, expectedDomain })));
  const strata = expandCounts(ROUTING_SYNTHETIC_QA_QUOTAS.strata);
  const scenarioRows: Array<{ scenarioGroupId: string; locale: string }> = [];
  let group = 0;
  for (const [locale, shape] of Object.entries(ROUTING_SYNTHETIC_QA_QUOTAS.scenarioGroupsByLocale)) {
    for (const [sizeText, count] of Object.entries(shape as Record<string, number>)) {
      for (let scenario = 0; scenario < count; scenario += 1) {
        group += 1;
        for (let turn = 0; turn < Number(sizeText); turn += 1) {
          scenarioRows.push({ scenarioGroupId: `scenario-${String(group).padStart(3, '0')}`, locale });
        }
      }
    }
  }
  const skillByDomain: Record<string, string> = {
    secretary: 'secretary',
    triathlon: 'training',
    content: 'content',
    cooking: 'cooking',
    finance: 'finance',
    connections: 'connections',
    notifications: 'notifications',
    decision_center: 'decision_center',
  };
  const vocabulary: Record<string, string> = {
    classifierKeyword: 'river cedar quartz maple',
    orchestratorPrimary: 'orchard amber pebble lantern',
    shadowRoute: 'harbor cobalt compass meadow',
    registrySubset: 'willow anchor granite forest',
  };
  const words = vocabulary[surfaceName].split(' ');
  return {
    schema: 'nexus.routing-synthetic-qa-manifest.v1',
    contractVersion: ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
    trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
    runtimeSha,
    artifactDigest,
    environment: 'staging',
    surface: surfaceName,
    userId: dedicatedId,
    tenantId: dedicatedId,
    plannedTurns: 200,
    referenceSources: [
      { kind: 'routing_corpus', sha256: `sha256:${'c'.repeat(64)}`, textCount: 300 },
      { kind: 'chat_eval_fixtures', sha256: `sha256:${'d'.repeat(64)}`, textCount: 40 },
    ],
    predecessorManifestSha256s,
    turns: domainRows.map(({ locale, expectedDomain }, index) => ({
      ordinal: index + 1,
      id: `qa-row-${String(index + 1).padStart(3, '0')}`,
      scenarioGroupId: scenarioRows[index].scenarioGroupId,
      text: `${words[0]}${index + 1} asks a standalone ${expectedDomain} ${words[1]}${index + 1} ${strata[index]} question with ${words[2]}${index + 1} context and ${words[3]}${index + 1} detail`,
      locale,
      expectedDomain,
      expectedResolverSkill: skillByDomain[expectedDomain],
      stratum: strata[index],
      standalone: true,
    })),
  };
}

function passedReceipt(stored: ReturnType<typeof buildRoutingSyntheticQaManifest>) {
  return {
    schema: ROUTING_SYNTHETIC_QA_RECEIPT_SCHEMA,
    status: 'passed',
    contractVersion: ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
    trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
    manifestSha256: `sha256:${stored.sha256}`,
    runtimeSha,
    artifactDigest,
    environment: 'staging',
    surface: stored.manifest.surface,
    userId: dedicatedId,
    tenantId: dedicatedId,
    plannedTurns: 200,
    attemptedTurns: 200,
    acceptedTurns: 200,
    recordedTurns: 200,
    startedAt: '2026-08-02T17:00:00.000Z',
    completedAt: '2026-08-02T17:01:00.000Z',
    httpStatusCounts: { 200: 200 },
    apiUsageDelta: { rows: 0, costUsd: 0 },
    providerReservationDelta: { rows: 0, costUsd: 0 },
    providerCalled: false,
    externalCallPerformed: false,
    domainMutationPerformed: false,
  };
}

function writePrivate(file: string, bytes: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function persistPassedSurface(stateRoot: string, stored: ReturnType<typeof buildRoutingSyntheticQaManifest>) {
  const directory = path.join(stateRoot, stored.manifest.surface);
  const manifestPath = path.join(directory, `${stored.sha256}.manifest.json`);
  const receiptPath = path.join(directory, `${stored.sha256}.receipt.json`);
  writePrivate(manifestPath, stored.bytes);
  writePrivate(receiptPath, `${canonicalJson(passedReceipt(stored))}\n`);
  return { manifestPath, receiptPath };
}

function releaseStateRoot(prefix: string) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(parent);
  const root = path.join(parent, `${runtimeSha}-${artifactDigest.slice(0, 12)}`);
  fs.mkdirSync(root, { mode: 0o700 });
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function manifest() {
  return {
    schema: 'nexus.routing-synthetic-qa-manifest.v1',
    contractVersion: 'routing-synthetic-qa-v1',
    trafficClass: 'owner_authorized_synthetic_staging_qa',
    runtimeSha,
    artifactDigest,
    environment: 'staging',
    surface,
    userId: dedicatedId,
    tenantId: dedicatedId,
    plannedTurns: 200,
    referenceSources: [
      { kind: 'routing_corpus', sha256: `sha256:${'c'.repeat(64)}`, textCount: 300 },
      { kind: 'chat_eval_fixtures', sha256: `sha256:${'d'.repeat(64)}`, textCount: 40 },
    ],
    predecessorManifestSha256s: [],
    turns: Array.from({ length: 200 }, (_, index) => ({
      ordinal: index + 1,
      id: `qa-row-${String(index + 1).padStart(3, '0')}`,
      scenarioGroupId: `scenario-${String(Math.floor(index / 2) + 1).padStart(3, '0')}`,
      text: `Natural synthetic routing prompt number ${index + 1} with unique safe context`,
      locale: index % 2 === 0 ? 'en-US' : 'pt-BR',
      expectedDomain: 'secretary',
      expectedResolverSkill: 'secretary',
      stratum: 'deterministic_state_read',
      standalone: true,
    })),
  } as const;
}

function responseFor(ordinal: number) {
  const turnId = routingSyntheticQaTurnIdentity(manifestSha256, surface, ordinal);
  return {
    id: `msg-routing-synthetic-qa-${surface}-${String(ordinal).padStart(3, '0')}`,
    routeMethod: 'routing-synthetic-qa',
    metadata: {
      type: 'routing_synthetic_qa_recorded',
      providerCalled: false,
      externalCallPerformed: false,
      domainMutationPerformed: false,
      replayBundleId: `bundle-${ordinal}`,
      trafficProvenance: {
        contractVersion: 'routing-synthetic-qa-v1',
        trafficClass: 'owner_authorized_synthetic_staging_qa',
        manifestSha256: `sha256:${manifestSha256}`,
        surface,
        ordinal,
        plannedTurns: 200,
        turnId,
        locale: manifest().turns[ordinal - 1].locale,
      },
    },
  };
}

function ledger(rows = 0, costUsd = 0) {
  return {
    apiUsage: { rows, costUsd },
    providerReservations: { rows, costUsd },
  };
}

function healthyServingRuntime() {
  return {
    status: 'healthy',
    database: 'connected',
    releaseAttestation: {
      schema: 'nexus.chat-capability-release-attestation.v2',
      runtimeSha,
      artifactDigest,
      role: 'staging',
      processId: 4242,
      capabilityRuntimeGuard: {
        status: 'clear',
        reason: 'no_unresolved_transaction',
        transactionId: null,
        planDigest: null,
      },
      shadowPlannerEffective: {
        global: false,
        dedicatedEval: { present: true, user: false, tenant: false },
      },
      shadowRouteHookEffective: {
        global: false,
        dedicatedEval: { present: true, user: true, tenant: true },
      },
      capabilityFlags: {
        configured: { AI_ROUTING_MANIFEST_CLASSIFIER: false },
        effective: { AI_ROUTING_MANIFEST_CLASSIFIER: false },
        masterKill: false,
      },
    },
  };
}

function withHealthyServingRuntime(
  chatHandler: (url: string, init: RequestInit) => Promise<Response>,
) {
  return vi.fn(async (url: string | URL, init: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/health/detailed')) {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secretHealthToken}`);
      return new Response(JSON.stringify(healthyServingRuntime()), { status: 200 });
    }
    return chatHandler(href, init);
  });
}

describe('routing synthetic QA campaign runner', () => {
  it('refuses direct execution outside the shared release mutex', async () => {
    vi.stubEnv('NEXUS_ROUTING_SYNTHETIC_QA_RELEASE_LOCK_HELD', '1');
    await expect(main([])).rejects.toThrow(/release mutex/i);
  });

  it('accepts only a single-link owner mode-0600 ordinary release lock file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-qa-release-lock-'));
    temporaryRoots.push(root);
    const lock = path.join(root, '.release.lock');
    fs.writeFileSync(lock, '', { mode: 0o600 });
    fs.chmodSync(lock, 0o600);
    expect(() => validateRoutingSyntheticQaReleaseLockFile(lock)).not.toThrow();

    fs.chmodSync(lock, 0o644);
    expect(() => validateRoutingSyntheticQaReleaseLockFile(lock)).toThrow(/release lock/i);
    fs.chmodSync(lock, 0o600);
    const link = path.join(root, 'release-lock-link');
    fs.symlinkSync(lock, link);
    expect(() => validateRoutingSyntheticQaReleaseLockFile(link)).toThrow(/release lock/i);
  });

  it('attests the exact protected predecessor manifest and passed receipt before accepting a later surface', () => {
    const stateRoot = releaseStateRoot('routing-qa-chain-');
    const classifier = buildRoutingSyntheticQaManifest(storedManifest('classifierKeyword'));
    persistPassedSurface(stateRoot, classifier);
    const orchestrator = buildRoutingSyntheticQaManifest(storedManifest(
      'orchestratorPrimary',
      [`sha256:${classifier.sha256}`],
    ));

    const attested = attestRoutingSyntheticQaManifestChain({
      source: { raw: Buffer.from(orchestrator.bytes), parsed: orchestrator.manifest },
      expectedManifestSha256: orchestrator.sha256,
      release: { runtimeSha, artifactDigest },
      dedicatedId,
      stateRoot,
    });

    expect(attested.built.sha256).toBe(orchestrator.sha256);
    expect(attested.predecessors.map((item: any) => ({
      surface: item.surface,
      manifestSha256: item.manifestSha256,
      receiptStatus: item.receipt.status,
    }))).toEqual([{
      surface: 'classifierKeyword',
      manifestSha256: `sha256:${classifier.sha256}`,
      receiptStatus: 'passed',
    }]);
    expect(attested.predecessorTexts).toEqual(classifier.manifest.turns.map((turn: any) => turn.text));
  });

  it('rejects current prompts copied from an attested prior surface', () => {
    const stateRoot = releaseStateRoot('routing-qa-chain-reuse-');
    const classifier = buildRoutingSyntheticQaManifest(storedManifest('classifierKeyword'));
    persistPassedSurface(stateRoot, classifier);
    const current: any = storedManifest('orchestratorPrimary', [`sha256:${classifier.sha256}`]);
    current.turns[0].text = classifier.manifest.turns[0].text;
    const unchecked = buildRoutingSyntheticQaManifest(current);

    expect(() => attestRoutingSyntheticQaManifestChain({
      source: { raw: Buffer.from(unchecked.bytes), parsed: unchecked.manifest },
      expectedManifestSha256: unchecked.sha256,
      release: { runtimeSha, artifactDigest },
      dedicatedId,
      stateRoot,
    })).toThrow(/reference match|shared contiguous|similarity/);
  });

  it('rejects unsafe, noncanonical, wrong-identity, or non-passed predecessor evidence', () => {
    const cases: Array<{
      name: string;
      mutate: (
        files: { manifestPath: string; receiptPath: string },
        classifier: ReturnType<typeof buildRoutingSyntheticQaManifest>,
      ) => void;
      error: RegExp;
    }> = [
      {
        name: 'public manifest mode',
        mutate: ({ manifestPath }) => fs.chmodSync(manifestPath, 0o644),
        error: /owner-only|mode/i,
      },
      {
        name: 'symlinked manifest',
        mutate: ({ manifestPath }) => {
          const target = `${manifestPath}.target`;
          fs.renameSync(manifestPath, target);
          fs.symlinkSync(target, manifestPath);
        },
        error: /owner-only|ordinary|accessible/i,
      },
      {
        name: 'hard-linked manifest',
        mutate: ({ manifestPath }) => fs.linkSync(manifestPath, `${manifestPath}.extra-link`),
        error: /single-link|owner-only/i,
      },
      {
        name: 'public receipt mode',
        mutate: ({ receiptPath }) => fs.chmodSync(receiptPath, 0o644),
        error: /owner-only|mode/i,
      },
      {
        name: 'noncanonical bytes',
        mutate: ({ manifestPath }, classifier) => {
          fs.writeFileSync(manifestPath, `${classifier.bytes.trimEnd()} \n`);
          fs.chmodSync(manifestPath, 0o600);
        },
        error: /canonical|digest/i,
      },
      {
        name: 'failed receipt',
        mutate: ({ receiptPath }, classifier) => {
          const receipt = passedReceipt(classifier);
          receipt.status = 'failed';
          fs.writeFileSync(receiptPath, `${canonicalJson(receipt)}\n`);
          fs.chmodSync(receiptPath, 0o600);
        },
        error: /passed receipt/i,
      },
      {
        name: 'wrong release receipt',
        mutate: ({ receiptPath }, classifier) => {
          const receipt = passedReceipt(classifier);
          receipt.runtimeSha = 'f'.repeat(40);
          fs.writeFileSync(receiptPath, `${canonicalJson(receipt)}\n`);
          fs.chmodSync(receiptPath, 0o600);
        },
        error: /passed receipt/i,
      },
    ];

    for (const testCase of cases) {
      const stateRoot = releaseStateRoot('routing-qa-chain-adversary-');
      const classifier = buildRoutingSyntheticQaManifest(storedManifest('classifierKeyword'));
      const files = persistPassedSurface(stateRoot, classifier);
      testCase.mutate(files, classifier);
      const current = buildRoutingSyntheticQaManifest(storedManifest(
        'orchestratorPrimary',
        [`sha256:${classifier.sha256}`],
      ));
      expect(
        () => attestRoutingSyntheticQaManifestChain({
          source: { raw: Buffer.from(current.bytes), parsed: current.manifest },
          expectedManifestSha256: current.sha256,
          release: { runtimeSha, artifactDigest },
          dedicatedId,
          stateRoot,
        }),
        testCase.name,
      ).toThrow(testCase.error);
    }
  });

  it('rejects a prior surface whose own fixed predecessor chain is forged', () => {
    const stateRoot = releaseStateRoot('routing-qa-chain-order-');
    const classifier = buildRoutingSyntheticQaManifest(storedManifest('classifierKeyword'));
    persistPassedSurface(stateRoot, classifier);
    const orchestrator = buildRoutingSyntheticQaManifest(storedManifest(
      'orchestratorPrimary',
      [`sha256:${'e'.repeat(64)}`],
    ));
    persistPassedSurface(stateRoot, orchestrator);
    const shadow = buildRoutingSyntheticQaManifest(storedManifest('shadowRoute', [
      `sha256:${classifier.sha256}`,
      `sha256:${orchestrator.sha256}`,
    ]));

    expect(() => attestRoutingSyntheticQaManifestChain({
      source: { raw: Buffer.from(shadow.bytes), parsed: shadow.manifest },
      expectedManifestSha256: shadow.sha256,
      release: { runtimeSha, artifactDigest },
      dedicatedId,
      stateRoot,
    })).toThrow(/strict prior-surface|predecessor chain|lineage/i);
  });

  it('rejects predecessor bytes that hash to the selected digest but are not canonical', () => {
    const stateRoot = releaseStateRoot('routing-qa-chain-noncanonical-');
    const classifier = buildRoutingSyntheticQaManifest(storedManifest('classifierKeyword'));
    const noncanonical = Buffer.from(`${JSON.stringify(classifier.manifest, null, 2)}\n`, 'utf8');
    const digest = createHash('sha256').update(noncanonical).digest('hex');
    writePrivate(
      path.join(stateRoot, 'classifierKeyword', `${digest}.manifest.json`),
      noncanonical,
    );
    const current = buildRoutingSyntheticQaManifest(storedManifest(
      'orchestratorPrimary',
      [`sha256:${digest}`],
    ));

    expect(() => attestRoutingSyntheticQaManifestChain({
      source: { raw: Buffer.from(current.bytes), parsed: current.manifest },
      expectedManifestSha256: current.sha256,
      release: { runtimeSha, artifactDigest },
      dedicatedId,
      stateRoot,
    })).toThrow(/canonical/i);
  });

  it.each([
    ['surface', 'orchestratorPrimary', runtimeSha],
    ['release', 'classifierKeyword', 'f'.repeat(40)],
  ])('rejects a predecessor with the wrong %s identity', (_label, predecessorSurface, predecessorRuntimeSha) => {
    const stateRoot = releaseStateRoot('routing-qa-chain-identity-');
    const wrong: any = storedManifest(
      predecessorSurface,
      predecessorSurface === 'classifierKeyword' ? [] : [`sha256:${'e'.repeat(64)}`],
    );
    wrong.runtimeSha = predecessorRuntimeSha;
    const builtWrong = buildRoutingSyntheticQaManifest(wrong);
    const directory = path.join(stateRoot, 'classifierKeyword');
    writePrivate(path.join(directory, `${builtWrong.sha256}.manifest.json`), builtWrong.bytes);
    const current = buildRoutingSyntheticQaManifest(storedManifest(
      'orchestratorPrimary',
      [`sha256:${builtWrong.sha256}`],
    ));

    expect(() => attestRoutingSyntheticQaManifestChain({
      source: { raw: Buffer.from(current.bytes), parsed: current.manifest },
      expectedManifestSha256: current.sha256,
      release: { runtimeSha, artifactDigest },
      dedicatedId,
      stateRoot,
    })).toThrow(/runtime SHA|surface does not match operator binding/i);
  });

  it('sends exactly 200 authenticated real API turns and returns a strict zero-provider receipt', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = withHealthyServingRuntime(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const body = JSON.parse(String(init.body));
      const ordinal = requests.length;
      expect(body).toEqual({
        text: manifest().turns[ordinal - 1].text,
        clientMessageId: routingSyntheticQaTurnIdentity(manifestSha256, surface, ordinal),
      });
      return new Response(JSON.stringify(responseFor(ordinal)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const snapshots = [ledger(41, 1.25), ledger(41, 1.25)];
    const nowValues = [
      new Date('2026-08-02T17:00:00.000Z'),
      new Date('2026-08-02T17:01:00.000Z'),
    ];
    const onServingRuntimeAttested = vi.fn();

    const receipt = await executeRoutingSyntheticQaCampaign({
      manifest: manifest(),
      manifestSha256,
      token: secretToken,
      healthToken: secretHealthToken,
      baseUrl: 'http://127.0.0.1:8201',
      fetchImpl: fetchImpl as typeof fetch,
      snapshotLedger: () => snapshots.shift()!,
      now: () => nowValues.shift()!,
      onServingRuntimeAttested,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(201);
    expect(onServingRuntimeAttested).toHaveBeenCalledTimes(1);
    expect(new Set(requests.map((request) => request.url))).toEqual(
      new Set(['http://127.0.0.1:8201/api/v1/chat/message']),
    );
    const firstHeaders = new Headers(requests[0].init.headers);
    expect(firstHeaders.get('authorization')).toBe(`Bearer ${secretToken}`);
    expect(firstHeaders.get('x-language')).toBe('en-US');
    expect(firstHeaders.get('x-nexus-routing-synthetic-qa-contract')).toBe('routing-synthetic-qa-v1');
    expect(firstHeaders.get('x-nexus-routing-synthetic-qa-manifest-sha256')).toBe(`sha256:${manifestSha256}`);
    expect(firstHeaders.get('x-nexus-routing-synthetic-qa-surface')).toBe(surface);
    expect(firstHeaders.get('x-nexus-routing-synthetic-qa-ordinal')).toBe('1');
    expect(firstHeaders.get('x-nexus-routing-synthetic-qa-planned-turns')).toBe('200');
    expect(firstHeaders.get('x-nexus-routing-synthetic-qa-turn-id')).toBe(
      routingSyntheticQaTurnIdentity(manifestSha256, surface, 1),
    );
    expect(receipt).toEqual({
      schema: ROUTING_SYNTHETIC_QA_RECEIPT_SCHEMA,
      status: 'passed',
      contractVersion: 'routing-synthetic-qa-v1',
      trafficClass: 'owner_authorized_synthetic_staging_qa',
      manifestSha256: `sha256:${manifestSha256}`,
      runtimeSha,
      artifactDigest,
      environment: 'staging',
      surface,
      userId: dedicatedId,
      tenantId: dedicatedId,
      plannedTurns: 200,
      attemptedTurns: 200,
      acceptedTurns: 200,
      recordedTurns: 200,
      startedAt: '2026-08-02T17:00:00.000Z',
      completedAt: '2026-08-02T17:01:00.000Z',
      httpStatusCounts: { 200: 200 },
      apiUsageDelta: { rows: 0, costUsd: 0 },
      providerReservationDelta: { rows: 0, costUsd: 0 },
      providerCalled: false,
      externalCallPerformed: false,
      domainMutationPerformed: false,
    });
    expect(JSON.stringify(receipt)).not.toContain(secretToken);
    expect(JSON.stringify(receipt)).not.toContain(secretHealthToken);
    expect(JSON.stringify(receipt)).not.toContain(manifest().turns[0].text);
  });

  it('fails closed on the first non-200 or malformed terminal response', async () => {
    const fetchImpl = withHealthyServingRuntime(async () => new Response(JSON.stringify({ error: { code: 'blocked' } }), { status: 403 }));
    await expect(executeRoutingSyntheticQaCampaign({
      manifest: manifest(),
      manifestSha256,
      token: secretToken,
      healthToken: secretHealthToken,
      baseUrl: 'http://127.0.0.1:8201',
      fetchImpl: fetchImpl as typeof fetch,
      snapshotLedger: () => ledger(),
      now: () => new Date('2026-08-02T17:00:00.000Z'),
    })).rejects.toThrow(/turn 1 was not accepted/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a terminal response whose provenance locale is not the manifested request locale', async () => {
    const fetchImpl = withHealthyServingRuntime(async () => {
      const response = responseFor(1);
      response.metadata.trafficProvenance.locale = 'pt-PT';
      return new Response(JSON.stringify(response), { status: 200 });
    });
    await expect(executeRoutingSyntheticQaCampaign({
      manifest: manifest(),
      manifestSha256,
      token: secretToken,
      healthToken: secretHealthToken,
      baseUrl: 'http://127.0.0.1:8201',
      fetchImpl: fetchImpl as typeof fetch,
      snapshotLedger: () => ledger(),
      now: () => new Date('2026-08-02T17:00:00.000Z'),
    })).rejects.toThrow(/exact recorded evidence/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a stale serving process before any chat turn is sent', async () => {
    const chatHandler = vi.fn(async () => new Response('{}', { status: 200 }));
    const onServingRuntimeAttested = vi.fn();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/health/detailed')) {
        const health = healthyServingRuntime();
        health.releaseAttestation.runtimeSha = 'f'.repeat(40);
        return new Response(JSON.stringify(health), { status: 200 });
      }
      return chatHandler();
    });

    await expect(executeRoutingSyntheticQaCampaign({
      manifest: manifest(),
      manifestSha256,
      token: secretToken,
      healthToken: secretHealthToken,
      baseUrl: 'http://127.0.0.1:8201',
      fetchImpl: fetchImpl as typeof fetch,
      snapshotLedger: () => ledger(),
      now: () => new Date('2026-08-02T17:00:00.000Z'),
      onServingRuntimeAttested,
    })).rejects.toThrow(/serving release|attestation/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(chatHandler).not.toHaveBeenCalled();
    expect(onServingRuntimeAttested).not.toHaveBeenCalled();
  });

  it('refuses a missing or reused health credential before any HTTP request', async () => {
    for (const healthToken of ['', secretToken]) {
      const fetchImpl = vi.fn();
      await expect(executeRoutingSyntheticQaCampaign({
        manifest: manifest(),
        manifestSha256,
        token: secretToken,
        healthToken,
        baseUrl: 'http://127.0.0.1:8201',
        fetchImpl: fetchImpl as typeof fetch,
        snapshotLedger: () => ledger(),
        now: () => new Date('2026-08-02T17:00:00.000Z'),
      })).rejects.toThrow(/health token|credential/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('refuses a passed receipt when provider usage or reservation state changes', async () => {
    const fetchImpl = withHealthyServingRuntime(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const ordinal = Number(headers.get('x-nexus-routing-synthetic-qa-ordinal'));
      return new Response(JSON.stringify(responseFor(ordinal)), { status: 200 });
    });
    const snapshots = [ledger(), ledger(1, 0.0001)];
    await expect(executeRoutingSyntheticQaCampaign({
      manifest: manifest(),
      manifestSha256,
      token: secretToken,
      healthToken: secretHealthToken,
      baseUrl: 'http://127.0.0.1:8201',
      fetchImpl: fetchImpl as typeof fetch,
      snapshotLedger: () => snapshots.shift()!,
      now: () => new Date('2026-08-02T17:00:00.000Z'),
    })).rejects.toThrow(/provider ledger changed/);
    expect(fetchImpl).toHaveBeenCalledTimes(201);
  });
});
