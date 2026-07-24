import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASE_QUALITY_EVIDENCE_SCHEMA,
} from '../../scripts/lib/release-plan-authoritative-evidence.mjs';
import {
  MINIMUM_OBSERVATION_AGE_MS,
  RELEASE_QUALITY_QUERY,
  SERVER_QUALITY_REQUEST_SCHEMA,
  assertNoConcurrentReleaseRuns,
  buildReleaseQualityServerPayload,
  buildServerQualityRequest,
  issueReleaseQualityEvidence,
  releaseQualityPolicyDigest,
  signServerQualityRequest,
  validateServerQualityRequest,
  validateSignedReleaseQualityEvidence,
} from '../../scripts/release-quality-evidence.mjs';

const roots: string[] = [];
const generatedAt = new Date('2026-07-01T12:00:00.000Z');

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function pem(pair: { privateKey: KeyObject; publicKey: KeyObject }) {
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function transaction(index: number, status = 'completed') {
  const day = String(index + 1).padStart(2, '0');
  return {
    transactionId: `202606${day}T120000Z-${1000 + index}-${digest(`transaction-${index}`).slice(0, 12)}`,
    status,
    runtimeSha: digest(`runtime-${index}`).slice(0, 40),
    completedAt: `2026-06-${day}T12:00:00.000Z`,
    completedAtMs: Date.parse(`2026-06-${day}T12:00:00.000Z`),
    promotionJournalSha256: digest(`journal-${index}`),
  };
}

function promotionWindows() {
  const statuses = new Map([
    [2, 'recovered'],
    [7, 'failed_before_stop'],
    [12, 'recovery_failed'],
    [17, 'recovered'],
  ]);
  const entries = Array.from({ length: 20 }, (_, index) => (
    transaction(index, statuses.get(index) ?? 'completed')
  ));
  return {
    baseline: entries.slice(0, 10),
    current: entries.slice(10),
  };
}

function requestFixture() {
  const serverKeys = pem(generateKeyPairSync('ed25519'));
  const payload = buildReleaseQualityServerPayload({
    requestId: 'd7a816ba-c360-4ce7-9416-a34b3956c26d',
    promotionWindows: promotionWindows(),
    qualityPolicyDigest: releaseQualityPolicyDigest(),
    generatedAt,
  });
  return {
    payload,
    request: signServerQualityRequest(payload, serverKeys.privateKey),
    serverKeys,
  };
}

function response(value: unknown, link = '') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name.toLowerCase() === 'link' ? link : null },
    text: async () => JSON.stringify(value),
  };
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('protected Sentry release-quality evidence', () => {
  it('binds exactly the latest 10 baseline and 10 current root promotion journals', () => {
    const promotionRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quality-promotion-')),
    );
    roots.push(promotionRoot);
    for (let index = 0; index < 21; index += 1) {
      const authority = transaction(index);
      const journal = {
        schema: 'nexus.promotion-transaction-journal.v1',
        transactionId: authority.transactionId,
        status: authority.status,
        target: { sha: authority.runtimeSha },
        completedAt: authority.completedAt,
      };
      const state = path.join(
        promotionRoot,
        'transactions',
        authority.transactionId,
        'state',
      );
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, 'journal.json'), `${JSON.stringify(journal)}\n`);
    }
    const keys = pem(generateKeyPairSync('ed25519'));
    const request = buildServerQualityRequest({
      promotionEvidenceRoot: promotionRoot,
      requestId: 'af77975b-2599-44dc-b8cc-f63414d9cd22',
      serverPrivateKeyPem: keys.privateKey,
      now: new Date('2026-07-03T12:00:00.000Z'),
      allowTestPromotionRoot: true,
    });
    expect(request.schema).toBe(SERVER_QUALITY_REQUEST_SCHEMA);
    const payload = validateServerQualityRequest(request, {
      serverPublicKeyPem: keys.publicKey,
      expectedPolicyDigest: releaseQualityPolicyDigest(),
      expectedRuntimeSha: transaction(20).runtimeSha,
      nowMs: Date.parse('2026-07-03T12:01:00.000Z'),
    });
    expect(payload.windows.baseline.transactions).toHaveLength(10);
    expect(payload.windows.current.transactions).toHaveLength(10);
    expect(payload.windows.baseline.transactions[0].transactionId)
      .toBe(transaction(1).transactionId);
    expect(payload.windows.current.transactions.at(-1)?.transactionId)
      .toBe(transaction(20).transactionId);

    fs.writeFileSync(path.join(promotionRoot, 'active.json'), '{}\n');
    expect(() => buildServerQualityRequest({
      promotionEvidenceRoot: promotionRoot,
      requestId: 'f47e1ab2-a5d6-4de5-b3f8-b246b8919169',
      serverPrivateKeyPem: keys.privateKey,
      now: new Date('2026-07-03T12:00:00.000Z'),
      allowTestPromotionRoot: true,
    })).toThrow('promotion is active');
  });

  it('uses fixed successful-release exposure windows and requires 24-hour maturation', () => {
    const { payload } = requestFixture();
    const flattened = [
      ...payload.windows.baseline.transactions,
      ...payload.windows.current.transactions,
    ];
    expect(flattened[1].windowEnd).toBe(flattened[3].completedAt);
    expect(flattened[2]).toMatchObject({
      status: 'recovered',
      windowStart: flattened[2].completedAt,
      windowEnd: flattened[2].completedAt,
    });
    expect(flattened[16].windowEnd).toBe(flattened[18].completedAt);
    expect(flattened.at(-1)?.windowEnd).toBe(generatedAt.toISOString());

    expect(() => buildReleaseQualityServerPayload({
      requestId: '0efc725d-2f23-4482-963f-554d588ac38d',
      promotionWindows: promotionWindows(),
      qualityPolicyDigest: releaseQualityPolicyDigest(),
      generatedAt: new Date(
        promotionWindows().current.at(-1)!.completedAtMs
        + MINIMUM_OBSERVATION_AGE_MS - 1,
      ),
    })).toThrow('has not matured for 24 hours');
  });

  it('queries exact release/time scopes sequentially and emits only aggregate commitments', async () => {
    const { request, serverKeys, payload: requestPayload } = requestFixture();
    const releaseKeys = pem(generateKeyPairSync('ed25519'));
    const calls: Array<{ url: URL; options: Record<string, any> }> = [];
    const privateIssueIds: string[] = [];
    let active = false;
    let issueCallCount = 0;
    let firstWindowPage = true;
    const fetchImpl = async (input: URL, options: Record<string, any>) => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      const url = new URL(input);
      calls.push({ url, options });
      const releaseMatch = url.pathname.match(/\/releases\/([0-9a-f]{40})\/$/u);
      if (releaseMatch) {
        active = false;
        return response({
          id: 'PRIVATE SENTRY RELEASE ID MUST NOT PERSIST',
          version: releaseMatch[1],
          projects: [{
            id: '17',
            slug: 'private-production-project',
            name: 'PRIVATE SENTRY PROJECT MUST NOT PERSIST',
          }],
          owner: { email: 'private-release-owner@example.test' },
        });
      }
      issueCallCount += 1;
      const start = Date.parse(url.searchParams.get('start')!);
      const issue = {
        id: String(900000 + issueCallCount),
        firstSeen: new Date(start + 1_000).toISOString(),
        project: { id: '17' },
        title: 'PRIVATE CUSTOMER INCIDENT MUST NOT PERSIST',
        culprit: 'private@example.test',
      };
      privateIssueIds.push(issue.id);
      active = false;
      if (firstWindowPage) {
        firstWindowPage = false;
        return response(
          [issue, {
            ...issue,
            id: '910000',
            firstSeen: new Date(start - 1_000).toISOString(),
          }],
          `<${url.origin}${url.pathname}?cursor=0:1:0>; rel="next"; results="true"`,
        );
      }
      return response([issue]);
    };
    const evidence = await issueReleaseQualityEvidence({
      serverRequest: request,
      serverPublicKeyPem: serverKeys.publicKey,
      releaseEvidencePrivateKeyPem: releaseKeys.privateKey,
      expectedRuntimeSha: requestPayload.windows.current.transactions.at(-1).runtimeSha,
      sentry: {
        apiBaseUrl: 'https://us.sentry.io',
        organization: 'nexus-hub',
        projectIds: ['17'],
        authToken: 'super-secret-quality-read-token-value',
      },
      fetchImpl,
      nowMs: generatedAt.getTime() + 60_000,
    });
    expect(evidence.schema).toBe(RELEASE_QUALITY_EVIDENCE_SCHEMA);
    const completed = [
      ...requestPayload.windows.baseline.transactions,
      ...requestPayload.windows.current.transactions,
    ].filter((entry) => entry.status === 'completed');
    const releaseCalls = calls.filter(({ url }) => url.pathname.includes('/releases/'));
    const issueCalls = calls.filter(({ url }) => url.pathname.endsWith('/issues/'));
    expect(releaseCalls).toHaveLength(completed.length);
    expect(issueCalls).toHaveLength(completed.length + 1);
    expect(calls).toHaveLength((completed.length * 2) + 1);
    for (const { url, options } of calls) {
      expect(url.origin).toBe('https://us.sentry.io');
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('error');
      expect(options.headers.Authorization).toBe('Bearer super-secret-quality-read-token-value');
    }
    for (const { url } of releaseCalls) {
      expect(url.pathname).toMatch(
        /^\/api\/0\/organizations\/nexus-hub\/releases\/[0-9a-f]{40}\/$/u,
      );
      expect([...url.searchParams]).toEqual([]);
    }
    for (const { url } of issueCalls) {
      expect(url.pathname).toBe('/api/0/organizations/nexus-hub/issues/');
      expect(url.searchParams.get('environment')).toBe('production');
      expect(url.searchParams.getAll('project')).toEqual(['17']);
      expect(url.searchParams.get('query')).toMatch(/^release:[0-9a-f]{40}$/u);
      expect(url.searchParams.get('start')).toMatch(/Z$/u);
      expect(url.searchParams.get('end')).toMatch(/Z$/u);
    }
    for (const entry of completed) {
      const releaseCallIndex = calls.findIndex(({ url }) => (
        url.pathname.endsWith(`/releases/${entry.runtimeSha}/`)
      ));
      const issueCallIndex = calls.findIndex(({ url }) => (
        url.pathname.endsWith('/issues/')
        && url.searchParams.get('query') === `release:${entry.runtimeSha}`
      ));
      expect(releaseCallIndex).toBeGreaterThanOrEqual(0);
      expect(issueCallIndex).toBeGreaterThan(releaseCallIndex);
    }
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('PRIVATE CUSTOMER');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('PRIVATE SENTRY RELEASE');
    expect(serialized).not.toContain('PRIVATE SENTRY PROJECT');
    expect(serialized).not.toContain('private-release-owner@example.test');
    expect(serialized).not.toContain('super-secret-quality-read-token-value');
    for (const issueId of privateIssueIds) {
      expect(serialized).not.toContain(issueId);
    }
    const validated = validateSignedReleaseQualityEvidence(evidence, {
      releaseEvidencePublicKeyPem: releaseKeys.publicKey,
      serverRequest: request,
      serverPublicKeyPem: serverKeys.publicKey,
      expectedPolicyDigest: releaseQualityPolicyDigest(),
      expectedRuntimeSha: requestPayload.windows.current.transactions.at(-1).runtimeSha,
      nowMs: generatedAt.getTime() + 60_000,
    });
    expect(validated.query).toBe(RELEASE_QUALITY_QUERY);
    expect(validated.baseline.transactions[0].escapedReleaseDefects).toBe(2);
    expect(validated.current.transactions[2].escapedReleaseDefects).toBe(0);

    const tampered = structuredClone(evidence);
    tampered.payload.current.transactions[0].escapedReleaseDefects += 1;
    expect(() => validateSignedReleaseQualityEvidence(tampered, {
      releaseEvidencePublicKeyPem: releaseKeys.publicKey,
      serverRequest: request,
      serverPublicKeyPem: serverKeys.publicKey,
      expectedPolicyDigest: releaseQualityPolicyDigest(),
      nowMs: generatedAt.getTime() + 60_000,
    })).toThrow('signature is invalid');
  });

  it('fails closed on pagination escape, token problems, and concurrent release runs', async () => {
    const { request, serverKeys } = requestFixture();
    const releaseKeys = pem(generateKeyPairSync('ed25519'));
    await expect(issueReleaseQualityEvidence({
      serverRequest: request,
      serverPublicKeyPem: serverKeys.publicKey,
      releaseEvidencePrivateKeyPem: releaseKeys.privateKey,
      sentry: {
        apiBaseUrl: 'https://sentry.io',
        organization: 'nexus-hub',
        projectIds: ['17'],
        authToken: 'short',
      },
      fetchImpl: async () => response([]),
      nowMs: generatedAt.getTime() + 60_000,
    })).rejects.toThrow('token is missing or malformed');

    await expect(issueReleaseQualityEvidence({
      serverRequest: request,
      serverPublicKeyPem: serverKeys.publicKey,
      releaseEvidencePrivateKeyPem: releaseKeys.privateKey,
      sentry: {
        apiBaseUrl: 'https://sentry.io',
        organization: 'nexus-hub',
        projectIds: ['17'],
        authToken: 'valid-quality-read-token-value',
      },
      fetchImpl: async (rawUrl: URL) => {
        const url = new URL(rawUrl);
        const releaseMatch = url.pathname.match(/\/releases\/([0-9a-f]{40})\/$/u);
        if (releaseMatch) {
          return response({ version: releaseMatch[1], projects: [{ id: '17' }] });
        }
        return response(
          [],
          '<https://attacker.example/api/0/issues/?cursor=0:1:0>; rel="next"; results="true"',
        );
      },
      nowMs: generatedAt.getTime() + 60_000,
    })).rejects.toThrow('escaped the governed endpoint');

    const currentRunId = '123';
    expect(assertNoConcurrentReleaseRuns([
      { total_count: 1, workflow_runs: [{ id: 123, path: '.github/workflows/sign-staging-attestation.yml', status: 'in_progress' }] },
      { total_count: 0, workflow_runs: [] },
    ], currentRunId)).toBe(true);
    expect(() => assertNoConcurrentReleaseRuns([
      { total_count: 1, workflow_runs: [{ id: 456, path: '.github/workflows/release.yml@refs/heads/main', status: 'waiting' }] },
      { total_count: 0, workflow_runs: [] },
    ], currentRunId)).toThrow('release workflow is active');
    expect(() => assertNoConcurrentReleaseRuns([
      { total_count: 101, workflow_runs: [] },
      { total_count: 0, workflow_runs: [] },
    ], currentRunId)).toThrow('invalid or truncated');
  });

  it('fails closed before issue counting when release observability is absent or untrusted', async () => {
    const { request, serverKeys } = requestFixture();
    const releaseKeys = pem(generateKeyPairSync('ed25519'));
    const commonInput = {
      serverRequest: request,
      serverPublicKeyPem: serverKeys.publicKey,
      releaseEvidencePrivateKeyPem: releaseKeys.privateKey,
      sentry: {
        apiBaseUrl: 'https://sentry.io',
        organization: 'nexus-hub',
        projectIds: ['17'],
        authToken: 'valid-quality-read-token-value',
      },
      nowMs: generatedAt.getTime() + 60_000,
    };
    let calls = 0;
    await expect(issueReleaseQualityEvidence({
      ...commonInput,
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          text: async () => '',
        };
      },
    })).rejects.toThrow('release query returned HTTP 404');
    expect(calls).toBe(1);

    calls = 0;
    await expect(issueReleaseQualityEvidence({
      ...commonInput,
      fetchImpl: async (rawUrl: URL) => {
        calls += 1;
        const version = new URL(rawUrl).pathname.split('/').at(-2);
        const exactRelease = { version, projects: [{ id: '17' }] };
        return response([exactRelease, structuredClone(exactRelease)]);
      },
    })).rejects.toThrow('did not resolve to its exact release');
    expect(calls).toBe(1);

    calls = 0;
    await expect(issueReleaseQualityEvidence({
      ...commonInput,
      fetchImpl: async () => {
        calls += 1;
        return response({
          version: digest('different-release').slice(0, 40),
          projects: [{ id: '17' }],
        });
      },
    })).rejects.toThrow('did not resolve to its exact release');
    expect(calls).toBe(1);

    calls = 0;
    await expect(issueReleaseQualityEvidence({
      ...commonInput,
      sentry: {
        ...commonInput.sentry,
        projectIds: ['17', '18'],
      },
      fetchImpl: async (rawUrl: URL) => {
        calls += 1;
        return response({
          version: new URL(rawUrl).pathname.split('/').at(-2),
          projects: [{ id: '17' }],
        });
      },
    })).rejects.toThrow('did not bind every configured project');
    expect(calls).toBe(1);
  });

  it('bounds Sentry response bytes and total pagination work', async () => {
    const { request, serverKeys } = requestFixture();
    const releaseKeys = pem(generateKeyPairSync('ed25519'));
    const input = {
      serverRequest: request,
      serverPublicKeyPem: serverKeys.publicKey,
      releaseEvidencePrivateKeyPem: releaseKeys.privateKey,
      sentry: {
        apiBaseUrl: 'https://sentry.io',
        organization: 'nexus-hub',
        projectIds: ['17'],
        authToken: 'valid-quality-read-token-value',
      },
      nowMs: generatedAt.getTime() + 60_000,
    };
    await expect(issueReleaseQualityEvidence({
      ...input,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => name.toLowerCase() === 'content-length'
            ? '6000000'
            : null,
        },
        text: async () => {
          throw new Error('oversized body must not be read');
        },
      }),
    })).rejects.toThrow('response was oversized');

    let calls = 0;
    await expect(issueReleaseQualityEvidence({
      ...input,
      fetchImpl: async (rawUrl: URL) => {
        calls += 1;
        const url = new URL(rawUrl);
        const releaseMatch = url.pathname.match(/\/releases\/([0-9a-f]{40})\/$/u);
        if (releaseMatch) {
          return response({ version: releaseMatch[1], projects: [{ id: '17' }] });
        }
        return response(
          [],
          `<${url.origin}${url.pathname}?cursor=0:${calls - 1}:0>; rel="next"; results="true"`,
        );
      },
    })).rejects.toThrow('total pagination bound');
    expect(calls).toBe(51);
  });

  it('extends the existing protected signer without tests, jobs, or a release lane', () => {
    const workflow = fs.readFileSync(
      '.github/workflows/sign-staging-attestation.yml',
      'utf8',
    );
    const requester = fs.readFileSync(
      'scripts/request-release-quality-evidence.sh',
      'utf8',
    );
    expect(workflow).toContain('- release_quality');
    expect(workflow).toContain('release_quality)');
    expect(workflow).toContain('NEXUS_SENTRY_QUALITY_READ_TOKEN');
    expect(workflow).not.toContain('NEXUS_SENTRY_EVENT_READ_TOKEN');
    expect(workflow).toContain('NEXUS_SENTRY_PROJECT_IDS');
    expect(workflow).toContain('collect-and-sign');
    expect(workflow.match(/assert-actions-idle/gmu)).toHaveLength(2);
    expect(workflow.match(/^jobs:/gmu)).toHaveLength(1);
    expect(workflow.match(/^  sign:/gmu)).toHaveLength(1);
    expect(workflow).not.toMatch(/\bnpm (?:test|run test)\b/u);
    expect(workflow).not.toContain('vitest');
    expect(workflow.match(/secrets\.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM/gmu))
      .toHaveLength(1);
    expect(workflow.match(/secrets\.NEXUS_SENTRY_QUALITY_READ_TOKEN/gmu))
      .toHaveLength(1);
    expect(requester).toContain('/run/lock/nexus-release-sonar.lock');
    expect(requester).toContain('evidence_kind=release_quality');
    expect(requester).toContain('sign-staging-attestation.yml');
    expect(requester).toContain('--allow-expired-request true');
    expect(requester).not.toContain('NEXUS_SENTRY_QUALITY_READ_TOKEN');
    expect(requester).not.toContain('NEXUS_SENTRY_EVENT_READ_TOKEN');
    expect(requester).not.toMatch(/\bcurl\b/u);
  });
});
