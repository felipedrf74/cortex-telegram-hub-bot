#!/usr/bin/env node
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectAuthoritativePromotionWindows,
  RELEASE_QUALITY_EVIDENCE_PAYLOAD_SCHEMA,
  RELEASE_QUALITY_EVIDENCE_SCHEMA,
} from './lib/release-plan-authoritative-evidence.mjs';
import { root } from './lib/test-policy.mjs';
import { canonicalJson, sha256 } from './protected-main-ci-evidence.mjs';

export const SERVER_QUALITY_REQUEST_SCHEMA =
  'nexus.serverdominguez-release-quality-request.v1';
export const SERVER_QUALITY_PAYLOAD_SCHEMA =
  'nexus.serverdominguez-release-quality-payload.v1';
export const SERVER_PROVENANCE_KEY_ID =
  'serverdominguez-release-provenance-2026-07';
export const RELEASE_EVIDENCE_KEY_ID =
  'github-environment-release-signing-2026-07';
export const RELEASE_QUALITY_QUERY =
  'escaped-release-defects-by-release-v1';
export const RELEASE_QUALITY_WINDOW_SIZE = 10;
export const SERVER_REQUEST_LIFETIME_MS = 15 * 60 * 1_000;
export const MINIMUM_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1_000;

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRANSACTION_ID_PATTERN =
  /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;
const SENTRY_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const SENTRY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const TERMINAL_STATUSES = new Set([
  'completed',
  'recovered',
  'failed_before_stop',
  'recovery_failed',
]);
const QUALITY_POLICY_FILES = Object.freeze([
  'scripts/release-quality-evidence.mjs',
  'scripts/lib/release-plan-authoritative-evidence.mjs',
  'scripts/lib/release-plan-evaluation.mjs',
  'scripts/release-plan-evaluator.mjs',
  '.github/workflows/sign-staging-attestation.yml',
  'docs/release/release-evidence-contract.md',
]);
const MAX_SENTRY_PAGES_PER_RELEASE = 100;
const MAX_SENTRY_TOTAL_PAGES = 50;
const MAX_SENTRY_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_SENTRY_ISSUES_PER_RELEASE = 10_000;
const EMPTY_ISSUE_SET_SHA256 = sha256(canonicalJson({
  schema: 'nexus.sentry-issue-set-commitment.v1',
  issueKeys: [],
}));
const EMPTY_RELEASE_OBSERVABILITY_SHA256 = sha256(canonicalJson({
  schema: 'nexus.sentry-release-observability.v1',
  status: 'not_production',
}));
const RELEASE_WORKFLOW_PATHS = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/release-candidate-evidence.yml',
  '.github/workflows/sign-release-manifest.yml',
  '.github/workflows/sign-staging-attestation.yml',
  '.github/workflows/release.yml',
  '.github/workflows/promote-reachability.yml',
]);
const NONTERMINAL_GITHUB_RUN_STATUSES = new Set([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const governed = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(governed)) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function requirePattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function keyObject(value, type, label) {
  try {
    return type === 'public' ? createPublicKey(value) : createPrivateKey(value);
  } catch {
    fail(`${label} is invalid`);
  }
}

function signEnvelope(payload, {
  schema,
  keyId,
  privateKeyPem,
  label,
}) {
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalJson(payload)),
    keyObject(privateKeyPem, 'private', `${label} private key`),
  ).toString('base64');
  return {
    schema,
    keyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature,
  };
}

function verifyEnvelope(envelope, {
  schema,
  keyId,
  publicKeyPem,
  label,
}) {
  exactKeys(
    envelope,
    ['schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature'],
    label,
  );
  if (envelope.schema !== schema || envelope.keyId !== keyId
      || envelope.signatureAlgorithm !== 'ed25519' || !isObject(envelope.payload)
      || typeof envelope.signature !== 'string') {
    fail(`${label} identity is invalid`);
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature
      || !cryptoVerify(
        null,
        Buffer.from(canonicalJson(envelope.payload)),
        keyObject(publicKeyPem, 'public', `${label} public key`),
        signature,
      )) {
    fail(`${label} signature is invalid`);
  }
  return envelope.payload;
}

export function releaseQualityPolicyDigest(sourceRoot = root) {
  const files = QUALITY_POLICY_FILES.map((relativePath) => {
    const file = path.join(sourceRoot, relativePath);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`release quality policy file is unsafe: ${relativePath}`);
    }
    return {
      path: relativePath,
      sha256: sha256(fs.readFileSync(file)),
    };
  });
  return sha256(canonicalJson(files));
}

function compactPromotionEntry(entry, label) {
  if (!isObject(entry)) fail(`${label} is invalid`);
  requirePattern(entry.transactionId, TRANSACTION_ID_PATTERN, `${label}.transactionId`);
  requirePattern(
    entry.promotionJournalSha256,
    DIGEST_PATTERN,
    `${label}.promotionJournalSha256`,
  );
  requirePattern(entry.runtimeSha, SHA_PATTERN, `${label}.runtimeSha`);
  canonicalTimestamp(entry.completedAt, `${label}.completedAt`);
  if (!TERMINAL_STATUSES.has(entry.status)) fail(`${label}.status is invalid`);
  return {
    transactionId: entry.transactionId,
    promotionJournalSha256: entry.promotionJournalSha256,
    runtimeSha: entry.runtimeSha,
    completedAt: entry.completedAt,
    status: entry.status,
  };
}

function validateRequestEntry(entry, index, section) {
  const label = `release quality request ${section}.transactions[${index}]`;
  exactKeys(entry, [
    'transactionId',
    'promotionJournalSha256',
    'runtimeSha',
    'completedAt',
    'status',
    'windowStart',
    'windowEnd',
  ], label);
  const compact = compactPromotionEntry(entry, label);
  const completedAtMs = canonicalTimestamp(entry.completedAt, `${label}.completedAt`);
  const windowStartMs = canonicalTimestamp(entry.windowStart, `${label}.windowStart`);
  const windowEndMs = canonicalTimestamp(entry.windowEnd, `${label}.windowEnd`);
  if (entry.windowStart !== entry.completedAt || windowStartMs !== completedAtMs) {
    fail(`${label}.windowStart must equal the root promotion completion`);
  }
  if (entry.status === 'completed') {
    if (windowEndMs <= windowStartMs) fail(`${label} completed exposure window is empty`);
  } else if (entry.windowEnd !== entry.windowStart) {
    fail(`${label} non-production outcome must have an empty exposure window`);
  }
  return { ...compact, windowStart: entry.windowStart, windowEnd: entry.windowEnd };
}

function validateRequestWindow(value, section) {
  exactKeys(value, ['transactions'], `release quality request ${section}`);
  if (!Array.isArray(value.transactions)
      || value.transactions.length !== RELEASE_QUALITY_WINDOW_SIZE) {
    fail(
      `release quality request ${section} must contain exactly `
      + `${RELEASE_QUALITY_WINDOW_SIZE} transactions`,
    );
  }
  return value.transactions.map((entry, index) => (
    validateRequestEntry(entry, index, section)
  ));
}

function validateExposureWindows(entries, observedThrough) {
  const observedThroughMs = Date.parse(observedThrough);
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    const previousMs = Date.parse(previous.completedAt);
    const currentMs = Date.parse(current.completedAt);
    if (currentMs < previousMs
        || (currentMs === previousMs
          && current.transactionId.localeCompare(previous.transactionId) <= 0)) {
      fail('release quality request transaction sequence is not chronological');
    }
  }
  if (new Set(entries.map((entry) => entry.transactionId)).size !== entries.length) {
    fail('release quality request contains duplicate transactions');
  }
  entries.forEach((entry, index) => {
    if (entry.status !== 'completed') return;
    const nextCompleted = entries.slice(index + 1).find((candidate) => (
      candidate.status === 'completed'
    ));
    const expectedEnd = nextCompleted?.completedAt ?? observedThrough;
    if (entry.windowEnd !== expectedEnd) {
      fail('release quality request completed exposure windows are not consecutive');
    }
    if (Date.parse(entry.windowEnd) > observedThroughMs) {
      fail('release quality request exposure window exceeds its observation cutoff');
    }
  });
}

export function validateServerQualityPayload(payload, {
  expectedPolicyDigest,
  expectedRuntimeSha = '',
  nowMs = Date.now(),
  allowExpired = false,
} = {}) {
  exactKeys(payload, [
    'schema',
    'requestId',
    'generatedAt',
    'expiresAt',
    'observedThrough',
    'query',
    'qualityPolicyDigest',
    'releaseState',
    'windows',
  ], 'release quality request payload');
  if (payload.schema !== SERVER_QUALITY_PAYLOAD_SCHEMA
      || payload.query !== RELEASE_QUALITY_QUERY) {
    fail('release quality request payload identity is invalid');
  }
  requirePattern(payload.requestId, UUID_PATTERN, 'release quality request payload.requestId');
  requirePattern(
    payload.qualityPolicyDigest,
    DIGEST_PATTERN,
    'release quality request payload.qualityPolicyDigest',
  );
  if (expectedPolicyDigest && payload.qualityPolicyDigest !== expectedPolicyDigest) {
    fail('release quality request policy digest does not match protected main');
  }
  const generatedAtMs = canonicalTimestamp(
    payload.generatedAt,
    'release quality request payload.generatedAt',
  );
  const expiresAtMs = canonicalTimestamp(
    payload.expiresAt,
    'release quality request payload.expiresAt',
  );
  const observedThroughMs = canonicalTimestamp(
    payload.observedThrough,
    'release quality request payload.observedThrough',
  );
  if (payload.generatedAt !== payload.observedThrough
      || expiresAtMs - generatedAtMs !== SERVER_REQUEST_LIFETIME_MS) {
    fail('release quality request lifetime or observation cutoff is invalid');
  }
  if (generatedAtMs > nowMs + 5 * 60_000 || (!allowExpired && expiresAtMs < nowMs)) {
    fail('release quality request is expired or from the future');
  }
  exactKeys(
    payload.releaseState,
    ['activePromotion', 'observedAt'],
    'release quality request payload.releaseState',
  );
  if (payload.releaseState.activePromotion !== false
      || payload.releaseState.observedAt !== payload.generatedAt) {
    fail('release quality request was not created from an idle promotion state');
  }
  exactKeys(payload.windows, ['baseline', 'current'], 'release quality request payload.windows');
  const baseline = validateRequestWindow(payload.windows.baseline, 'baseline');
  const current = validateRequestWindow(payload.windows.current, 'current');
  const entries = [...baseline, ...current];
  validateExposureWindows(entries, payload.observedThrough);
  if (observedThroughMs - Date.parse(current.at(-1).completedAt)
      < MINIMUM_OBSERVATION_AGE_MS) {
    fail('release quality request current window has not matured for 24 hours');
  }
  if (expectedRuntimeSha
      && current.at(-1).runtimeSha !== expectedRuntimeSha) {
    fail('release quality request runtime SHA does not match the dispatch identity');
  }
  return payload;
}

export function buildReleaseQualityServerPayload({
  requestId,
  promotionWindows,
  qualityPolicyDigest,
  generatedAt = new Date(),
  activePromotion = false,
}) {
  if (!promotionWindows || !Array.isArray(promotionWindows.baseline)
      || !Array.isArray(promotionWindows.current)) {
    fail('authoritative baseline and current promotion windows are required');
  }
  const observedThrough = new Date(generatedAt);
  if (!Number.isFinite(observedThrough.getTime())) fail('request generation time is invalid');
  const generatedAtIso = observedThrough.toISOString();
  const authorities = [
    ...promotionWindows.baseline.map((entry, index) => (
      compactPromotionEntry(entry, `baseline authority[${index}]`)
    )),
    ...promotionWindows.current.map((entry, index) => (
      compactPromotionEntry(entry, `current authority[${index}]`)
    )),
  ];
  const withWindows = authorities.map((entry, index) => {
    const nextCompleted = authorities.slice(index + 1).find((candidate) => (
      candidate.status === 'completed'
    ));
    return {
      ...entry,
      windowStart: entry.completedAt,
      windowEnd: entry.status === 'completed'
        ? nextCompleted?.completedAt ?? generatedAtIso
        : entry.completedAt,
    };
  });
  const payload = {
    schema: SERVER_QUALITY_PAYLOAD_SCHEMA,
    requestId,
    generatedAt: generatedAtIso,
    expiresAt: new Date(observedThrough.getTime() + SERVER_REQUEST_LIFETIME_MS).toISOString(),
    observedThrough: generatedAtIso,
    query: RELEASE_QUALITY_QUERY,
    qualityPolicyDigest,
    releaseState: {
      activePromotion,
      observedAt: generatedAtIso,
    },
    windows: {
      baseline: {
        transactions: withWindows.slice(0, RELEASE_QUALITY_WINDOW_SIZE),
      },
      current: {
        transactions: withWindows.slice(RELEASE_QUALITY_WINDOW_SIZE),
      },
    },
  };
  return validateServerQualityPayload(payload, {
    expectedPolicyDigest: qualityPolicyDigest,
    nowMs: observedThrough.getTime(),
  });
}

export function signServerQualityRequest(payload, serverPrivateKeyPem) {
  validateServerQualityPayload(payload, {
    expectedPolicyDigest: payload?.qualityPolicyDigest,
    nowMs: Date.parse(payload?.generatedAt),
  });
  return signEnvelope(payload, {
    schema: SERVER_QUALITY_REQUEST_SCHEMA,
    keyId: SERVER_PROVENANCE_KEY_ID,
    privateKeyPem: serverPrivateKeyPem,
    label: 'ServerDominguez release quality request',
  });
}

export function validateServerQualityRequest(request, {
  serverPublicKeyPem,
  expectedPolicyDigest,
  expectedRuntimeSha = '',
  nowMs = Date.now(),
  allowExpired = false,
} = {}) {
  const payload = verifyEnvelope(request, {
    schema: SERVER_QUALITY_REQUEST_SCHEMA,
    keyId: SERVER_PROVENANCE_KEY_ID,
    publicKeyPem: serverPublicKeyPem,
    label: 'ServerDominguez release quality request',
  });
  return validateServerQualityPayload(payload, {
    expectedPolicyDigest,
    expectedRuntimeSha,
    nowMs,
    allowExpired,
  });
}

function assertPromotionStateIdle(promotionEvidenceRoot) {
  const activePath = path.join(path.resolve(promotionEvidenceRoot), 'active.json');
  try {
    const stat = fs.lstatSync(activePath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fail('release quality collection is blocked while a promotion is active');
    }
    fail('promotion active-state path is unsafe');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function buildServerQualityRequest({
  promotionEvidenceRoot,
  sourceRoot = root,
  requestId,
  serverPrivateKeyPem,
  now = new Date(),
  allowTestPromotionRoot = false,
}) {
  assertPromotionStateIdle(promotionEvidenceRoot);
  const promotionWindows = collectAuthoritativePromotionWindows({
    promotionEvidenceRoot,
    allowTestPromotionRoot,
  }, {
    baselineCount: RELEASE_QUALITY_WINDOW_SIZE,
    currentCount: RELEASE_QUALITY_WINDOW_SIZE,
  });
  const payload = buildReleaseQualityServerPayload({
    requestId,
    promotionWindows,
    qualityPolicyDigest: releaseQualityPolicyDigest(sourceRoot),
    generatedAt: now,
    activePromotion: false,
  });
  return signServerQualityRequest(payload, serverPrivateKeyPem);
}

function normalizeSentryConfiguration({
  apiBaseUrl,
  organization,
  projectIds,
  authToken,
}) {
  let base;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    fail('Sentry API base URL is invalid');
  }
  if (base.protocol !== 'https:' || base.username || base.password
      || base.search || base.hash || !/(^|\.)sentry\.io$/u.test(base.hostname)
      || (base.pathname !== '/' && base.pathname !== '')) {
    fail('Sentry API base URL must be an HTTPS sentry.io origin');
  }
  requirePattern(organization, SENTRY_SLUG_PATTERN, 'Sentry organization');
  if (!Array.isArray(projectIds) || projectIds.length === 0 || projectIds.length > 20
      || projectIds.some((value) => !SENTRY_ID_PATTERN.test(value))
      || new Set(projectIds).size !== projectIds.length) {
    fail('Sentry project IDs must be 1-20 unique positive numeric IDs');
  }
  if (typeof authToken !== 'string' || authToken.length < 20 || authToken.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(authToken)) {
    fail('Sentry quality-read token is missing or malformed');
  }
  return {
    apiOrigin: base.origin,
    organization,
    projectIds: [...projectIds].sort((left, right) => (
      left.length - right.length || left.localeCompare(right)
    )),
    authToken,
    environment: 'production',
  };
}

function queryUrl(configuration, entry, cursor = '') {
  const url = new URL(
    `/api/0/organizations/${encodeURIComponent(configuration.organization)}/issues/`,
    configuration.apiOrigin,
  );
  for (const projectId of configuration.projectIds) {
    url.searchParams.append('project', projectId);
  }
  url.searchParams.set('environment', configuration.environment);
  url.searchParams.set('start', entry.windowStart);
  url.searchParams.set('end', entry.windowEnd);
  url.searchParams.set('query', `release:${entry.runtimeSha}`);
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('cursor', cursor);
  return url;
}

function releaseDetailsUrl(configuration, entry) {
  return new URL(
    `/api/0/organizations/${encodeURIComponent(configuration.organization)}`
    + `/releases/${encodeURIComponent(entry.runtimeSha)}/`,
    configuration.apiOrigin,
  );
}

function nextCursor(linkHeader, expectedUrl) {
  if (!linkHeader) return '';
  if (linkHeader.length > 8_192) fail('Sentry pagination header is oversized');
  for (const part of linkHeader.split(',')) {
    const match = part.trim().match(/^<([^>]+)>(.*)$/u);
    if (!match) continue;
    const parameters = new Map(match[2].split(';').map((raw) => {
      const [name, ...rest] = raw.trim().split('=');
      return [name, rest.join('=').replace(/^"|"$/gu, '')];
    }));
    if (parameters.get('rel') !== 'next' || parameters.get('results') !== 'true') continue;
    let linked;
    try {
      linked = new URL(match[1]);
    } catch {
      fail('Sentry pagination link is invalid');
    }
    if (linked.origin !== expectedUrl.origin || linked.pathname !== expectedUrl.pathname) {
      fail('Sentry pagination link escaped the governed endpoint');
    }
    const cursor = linked.searchParams.get('cursor') ?? '';
    if (!/^[A-Za-z0-9:_-]{1,512}$/u.test(cursor)) {
      fail('Sentry pagination cursor is invalid');
    }
    return cursor;
  }
  return '';
}

async function readBoundedSentryBody(response, windowIndex) {
  const declaredLength = typeof response.headers?.get === 'function'
    ? response.headers.get('content-length')
    : '';
  if (declaredLength && (!/^(0|[1-9][0-9]*)$/u.test(declaredLength)
      || Number(declaredLength) > MAX_SENTRY_RESPONSE_BYTES)) {
    fail(`Sentry response was oversized for release window ${windowIndex + 1}`);
  }
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      let item;
      try {
        item = await reader.read();
      } catch {
        fail(`Sentry response could not be read for release window ${windowIndex + 1}`);
      }
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > MAX_SENTRY_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best-effort bounded cancellation */ }
        fail(`Sentry response was oversized for release window ${windowIndex + 1}`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  let body;
  try {
    body = await response.text();
  } catch {
    fail(`Sentry response could not be read for release window ${windowIndex + 1}`);
  }
  if (Buffer.byteLength(body) > MAX_SENTRY_RESPONSE_BYTES) {
    fail(`Sentry response was oversized for release window ${windowIndex + 1}`);
  }
  return body;
}

async function resolveSentryRelease(
  entry,
  configuration,
  fetchImpl,
  windowIndex,
) {
  const url = releaseDetailsUrl(configuration, entry);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${configuration.authToken}`,
      },
    });
  } catch {
    fail(`Sentry release query transport failed for release window ${windowIndex + 1}`);
  }
  if (!response || response.ok !== true) {
    const status = Number.isSafeInteger(response?.status) ? response.status : 0;
    fail(`Sentry release query returned HTTP ${status} for release window ${windowIndex + 1}`);
  }
  const body = await readBoundedSentryBody(response, windowIndex);
  let release;
  try {
    release = JSON.parse(body);
  } catch {
    fail(`Sentry release response was not JSON for release window ${windowIndex + 1}`);
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)
      || release.version !== entry.runtimeSha || !Array.isArray(release.projects)) {
    fail(
      `Sentry runtime SHA did not resolve to its exact release `
      + `for release window ${windowIndex + 1}`,
    );
  }
  const observedProjectIds = release.projects.map((project) => (
    String(project?.id ?? '')
  ));
  if (observedProjectIds.some((projectId) => !SENTRY_ID_PATTERN.test(projectId))
      || new Set(observedProjectIds).size !== observedProjectIds.length) {
    fail(`Sentry exact release project identity was invalid for release window ${windowIndex + 1}`);
  }
  const exactRelease = {
    version: release.version,
    projectIds: observedProjectIds.sort((left, right) => (
      left.length - right.length || left.localeCompare(right)
    )),
  };
  if (configuration.projectIds.some((projectId) => (
    !exactRelease.projectIds.includes(projectId)
  ))) {
    fail(
      `Sentry exact release did not bind every configured project `
      + `for release window ${windowIndex + 1}`,
    );
  }
  return sha256(canonicalJson({
    schema: 'nexus.sentry-release-observability.v1',
    version: exactRelease.version,
    configuredProjectIds: configuration.projectIds,
    observedProjectIds: exactRelease.projectIds,
    environment: configuration.environment,
  }));
}

async function querySentryIssueSet(
  entry,
  configuration,
  fetchImpl,
  windowIndex,
  pageBudget,
) {
  const issueKeys = new Set();
  let cursor = '';
  for (let page = 0; page < MAX_SENTRY_PAGES_PER_RELEASE; page += 1) {
    if (pageBudget.remaining <= 0) {
      fail('Sentry quality collection exceeded its total pagination bound');
    }
    pageBudget.remaining -= 1;
    const url = queryUrl(configuration, entry, cursor);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${configuration.authToken}`,
        },
      });
    } catch {
      fail(`Sentry query transport failed for release window ${windowIndex + 1}`);
    }
    if (!response || response.ok !== true) {
      const status = Number.isSafeInteger(response?.status) ? response.status : 0;
      fail(`Sentry query returned HTTP ${status} for release window ${windowIndex + 1}`);
    }
    const body = await readBoundedSentryBody(response, windowIndex);
    let issues;
    try {
      issues = JSON.parse(body);
    } catch {
      fail(`Sentry response was not JSON for release window ${windowIndex + 1}`);
    }
    if (!Array.isArray(issues)) {
      fail(`Sentry response shape was invalid for release window ${windowIndex + 1}`);
    }
    const startMs = Date.parse(entry.windowStart);
    const endMs = Date.parse(entry.windowEnd);
    for (const issue of issues) {
      const issueId = issue?.id;
      const projectId = String(issue?.project?.id ?? '');
      const firstSeenMs = Date.parse(issue?.firstSeen ?? '');
      if (typeof issueId !== 'string' || !SENTRY_ID_PATTERN.test(issueId)
          || !configuration.projectIds.includes(projectId)
          || !Number.isFinite(firstSeenMs)) {
        fail(`Sentry issue identity was invalid for release window ${windowIndex + 1}`);
      }
      if (firstSeenMs >= startMs && firstSeenMs < endMs) {
        issueKeys.add(`${projectId}:${issueId}`);
        if (issueKeys.size > MAX_SENTRY_ISSUES_PER_RELEASE) {
          fail(`Sentry issue set exceeded its bound for release window ${windowIndex + 1}`);
        }
      }
    }
    const link = typeof response.headers?.get === 'function'
      ? response.headers.get('link')
      : '';
    const next = nextCursor(link, url);
    if (!next) {
      const sorted = [...issueKeys].sort();
      return {
        escapedReleaseDefects: sorted.length,
        issueSetSha256: sha256(canonicalJson({
          schema: 'nexus.sentry-issue-set-commitment.v1',
          issueKeys: sorted,
        })),
      };
    }
    if (next === cursor) fail('Sentry pagination cursor did not advance');
    cursor = next;
  }
  fail(`Sentry pagination exceeded its bound for release window ${windowIndex + 1}`);
}

function qualityEntry(entry, result) {
  return {
    transactionId: entry.transactionId,
    promotionJournalSha256: entry.promotionJournalSha256,
    runtimeSha: entry.runtimeSha,
    completedAt: entry.completedAt,
    escapedReleaseDefects: result.escapedReleaseDefects,
    issueSetSha256: result.issueSetSha256,
  };
}

export async function collectSentryQualityPayload({
  serverRequest,
  serverPublicKeyPem,
  expectedPolicyDigest,
  expectedRuntimeSha = '',
  sentry,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
}) {
  if (typeof fetchImpl !== 'function') fail('Sentry fetch implementation is unavailable');
  const request = validateServerQualityRequest(serverRequest, {
    serverPublicKeyPem,
    expectedPolicyDigest,
    expectedRuntimeSha,
    nowMs,
  });
  const configuration = normalizeSentryConfiguration(sentry);
  const inputEntries = [
    ...request.windows.baseline.transactions,
    ...request.windows.current.transactions,
  ];
  const outputEntries = [];
  const sourceEntries = [];
  const issuePageBudget = { remaining: MAX_SENTRY_TOTAL_PAGES };
  for (let index = 0; index < inputEntries.length; index += 1) {
    const entry = inputEntries[index];
    let releaseObservabilitySha256 = EMPTY_RELEASE_OBSERVABILITY_SHA256;
    let result;
    if (entry.status === 'completed') {
      releaseObservabilitySha256 = await resolveSentryRelease(
        entry,
        configuration,
        fetchImpl,
        index,
      );
      result = await querySentryIssueSet(
        entry,
        configuration,
        fetchImpl,
        index,
        issuePageBudget,
      );
    } else {
      result = {
        escapedReleaseDefects: 0,
        issueSetSha256: EMPTY_ISSUE_SET_SHA256,
      };
    }
    outputEntries.push(qualityEntry(entry, result));
    sourceEntries.push({
      transactionId: entry.transactionId,
      runtimeSha: entry.runtimeSha,
      windowStart: entry.windowStart,
      windowEnd: entry.windowEnd,
      escapedReleaseDefects: result.escapedReleaseDefects,
      issueSetSha256: result.issueSetSha256,
      releaseObservabilitySha256,
    });
  }
  const sourceSnapshotSha256 = sha256(canonicalJson({
    schema: 'nexus.release-quality-source-snapshot.v1',
    query: RELEASE_QUALITY_QUERY,
    observedThrough: request.observedThrough,
    qualityPolicyDigest: request.qualityPolicyDigest,
    sentryScopeSha256: sha256(canonicalJson({
      apiOrigin: configuration.apiOrigin,
      organization: configuration.organization,
      projectIds: configuration.projectIds,
      environment: configuration.environment,
    })),
    transactions: sourceEntries,
  }));
  return {
    schema: RELEASE_QUALITY_EVIDENCE_PAYLOAD_SCHEMA,
    provider: 'sentry',
    query: RELEASE_QUALITY_QUERY,
    generatedAt: request.observedThrough,
    sourceSnapshotSha256,
    baseline: {
      transactions: outputEntries.slice(0, RELEASE_QUALITY_WINDOW_SIZE),
    },
    current: {
      transactions: outputEntries.slice(RELEASE_QUALITY_WINDOW_SIZE),
    },
  };
}

function validateQualityEvidenceWindow(value, requestWindow, section) {
  exactKeys(value, ['transactions'], `release quality evidence ${section}`);
  if (!Array.isArray(value.transactions)
      || value.transactions.length !== RELEASE_QUALITY_WINDOW_SIZE) {
    fail(`release quality evidence ${section} transaction count is invalid`);
  }
  return value.transactions.map((entry, index) => {
    const label = `release quality evidence ${section}.transactions[${index}]`;
    exactKeys(entry, [
      'transactionId',
      'promotionJournalSha256',
      'runtimeSha',
      'completedAt',
      'escapedReleaseDefects',
      'issueSetSha256',
    ], label);
    const authority = requestWindow.transactions[index];
    for (const name of [
      'transactionId',
      'promotionJournalSha256',
      'runtimeSha',
      'completedAt',
    ]) {
      if (entry[name] !== authority[name]) {
        fail(`${label}.${name} does not match the root-signed request`);
      }
    }
    if (!Number.isSafeInteger(entry.escapedReleaseDefects)
        || entry.escapedReleaseDefects < 0
        || entry.escapedReleaseDefects > MAX_SENTRY_ISSUES_PER_RELEASE) {
      fail(`${label}.escapedReleaseDefects is invalid`);
    }
    requirePattern(entry.issueSetSha256, DIGEST_PATTERN, `${label}.issueSetSha256`);
    if (authority.status !== 'completed'
        && (entry.escapedReleaseDefects !== 0
          || entry.issueSetSha256 !== EMPTY_ISSUE_SET_SHA256)) {
      fail(`${label} assigned escaped defects to a non-production outcome`);
    }
    return entry;
  });
}

export function signReleaseQualityEvidence(payload, releaseEvidencePrivateKeyPem) {
  return signEnvelope(payload, {
    schema: RELEASE_QUALITY_EVIDENCE_SCHEMA,
    keyId: RELEASE_EVIDENCE_KEY_ID,
    privateKeyPem: releaseEvidencePrivateKeyPem,
    label: 'release quality evidence',
  });
}

export function validateSignedReleaseQualityEvidence(evidence, {
  releaseEvidencePublicKeyPem,
  serverRequest,
  serverPublicKeyPem,
  expectedPolicyDigest,
  expectedRuntimeSha = '',
  nowMs = Date.now(),
  allowExpiredRequest = false,
} = {}) {
  const request = validateServerQualityRequest(serverRequest, {
    serverPublicKeyPem,
    expectedPolicyDigest,
    expectedRuntimeSha,
    nowMs,
    allowExpired: allowExpiredRequest,
  });
  const payload = verifyEnvelope(evidence, {
    schema: RELEASE_QUALITY_EVIDENCE_SCHEMA,
    keyId: RELEASE_EVIDENCE_KEY_ID,
    publicKeyPem: releaseEvidencePublicKeyPem,
    label: 'release quality evidence',
  });
  exactKeys(payload, [
    'schema',
    'provider',
    'query',
    'generatedAt',
    'sourceSnapshotSha256',
    'baseline',
    'current',
  ], 'release quality evidence payload');
  if (payload.schema !== RELEASE_QUALITY_EVIDENCE_PAYLOAD_SCHEMA
      || payload.provider !== 'sentry'
      || payload.query !== RELEASE_QUALITY_QUERY
      || payload.generatedAt !== request.observedThrough) {
    fail('release quality evidence payload identity is invalid');
  }
  requirePattern(
    payload.sourceSnapshotSha256,
    DIGEST_PATTERN,
    'release quality evidence payload.sourceSnapshotSha256',
  );
  validateQualityEvidenceWindow(
    payload.baseline,
    request.windows.baseline,
    'baseline',
  );
  validateQualityEvidenceWindow(
    payload.current,
    request.windows.current,
    'current',
  );
  return payload;
}

export async function issueReleaseQualityEvidence({
  serverRequest,
  serverPublicKeyPem,
  releaseEvidencePrivateKeyPem,
  sourceRoot = root,
  expectedRuntimeSha = '',
  sentry,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
}) {
  const payload = await collectSentryQualityPayload({
    serverRequest,
    serverPublicKeyPem,
    expectedPolicyDigest: releaseQualityPolicyDigest(sourceRoot),
    expectedRuntimeSha,
    sentry,
    fetchImpl,
    nowMs,
  });
  return signReleaseQualityEvidence(payload, releaseEvidencePrivateKeyPem);
}

export function assertNoConcurrentReleaseRuns(snapshots, currentRunId) {
  if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 8
      || !/^[1-9][0-9]*$/u.test(String(currentRunId ?? ''))) {
    fail('GitHub release-idle evidence is incomplete');
  }
  for (const snapshot of snapshots) {
    if (!isObject(snapshot) || !Number.isSafeInteger(snapshot.total_count)
        || snapshot.total_count < 0 || !Array.isArray(snapshot.workflow_runs)
        || snapshot.total_count > snapshot.workflow_runs.length) {
      fail('GitHub release-idle evidence is invalid or truncated');
    }
    for (const run of snapshot.workflow_runs) {
      const runId = String(run?.id ?? '');
      const workflowPath = String(run?.path ?? '').split('@')[0];
      if (runId !== String(currentRunId)
          && RELEASE_WORKFLOW_PATHS.has(workflowPath)
          && NONTERMINAL_GITHUB_RUN_STATUSES.has(run?.status)) {
        fail('release quality collection is blocked while a release workflow is active');
      }
    }
  }
  return true;
}

function readJson(file) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
      || stat.size > 4 * 1024 * 1024) {
    fail('release quality input must be a bounded regular non-symlink file');
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function readPem(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 32_768) {
    fail(`${label} must be a bounded regular non-symlink file`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

function writeNewJson(file, value) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || fs.realpathSync(parent) !== parent) {
    fail('release quality output parent must be a real non-symlink directory');
  }
  const temporary = path.join(
    parent,
    `.${path.basename(resolved)}.next.${process.pid}.${randomBytes(8).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, resolved);
    let parentDescriptor = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
    fs.unlinkSync(temporary);
    parentDescriptor = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const valuesOf = (name) => args.flatMap((value, index) => (
  value === name && args[index + 1] ? [args[index + 1]] : []
));

async function main() {
  const sourceRoot = path.resolve(valueOf('--source-root', root));
  if (command === 'build-server-request') {
    const output = writeNewJson(valueOf('--output'), buildServerQualityRequest({
      promotionEvidenceRoot: path.resolve(valueOf(
        '--promotion-evidence-root',
        '/var/lib/nexus-release-promotion',
      )),
      sourceRoot,
      requestId: valueOf('--request-id'),
      serverPrivateKeyPem: readPem(valueOf('--server-private-key'), 'server provenance private key'),
    }));
    const request = readJson(output);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      requestId: request.payload.requestId,
      runtimeSha: request.payload.windows.current.transactions.at(-1).runtimeSha,
      requestSha256: sha256(fs.readFileSync(output)),
      output,
    })}\n`);
    return;
  }
  if (command === 'validate-server-request') {
    const payload = validateServerQualityRequest(readJson(valueOf('--request')), {
      serverPublicKeyPem: readPem(valueOf('--server-public-key'), 'server provenance public key'),
      expectedPolicyDigest: releaseQualityPolicyDigest(sourceRoot),
      expectedRuntimeSha: valueOf('--expect-runtime-sha'),
      allowExpired: valueOf('--allow-expired-request') === 'true',
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (command === 'collect-and-sign') {
    const output = valueOf('--output');
    const request = readJson(valueOf('--request'));
    const evidence = await issueReleaseQualityEvidence({
      serverRequest: request,
      serverPublicKeyPem: readPem(
        valueOf('--server-public-key'),
        'server provenance public key',
      ),
      releaseEvidencePrivateKeyPem:
        process.env.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM ?? '',
      sourceRoot,
      expectedRuntimeSha: valueOf('--expect-runtime-sha'),
      sentry: {
        apiBaseUrl: process.env.NEXUS_SENTRY_API_BASE_URL || 'https://sentry.io',
        organization: process.env.NEXUS_SENTRY_ORGANIZATION || '',
        projectIds: (process.env.NEXUS_SENTRY_PROJECT_IDS || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        authToken: process.env.NEXUS_SENTRY_QUALITY_READ_TOKEN || '',
      },
    });
    const resolved = writeNewJson(output, evidence);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      requestId: request.payload.requestId,
      runtimeSha: request.payload.windows.current.transactions.at(-1).runtimeSha,
      evidenceSha256: sha256(fs.readFileSync(resolved)),
      output: resolved,
    })}\n`);
    return;
  }
  if (command === 'validate-evidence') {
    const request = readJson(valueOf('--request'));
    const evidenceFile = path.resolve(valueOf('--evidence'));
    validateSignedReleaseQualityEvidence(readJson(evidenceFile), {
      releaseEvidencePublicKeyPem: readPem(
        valueOf(
          '--release-public-key',
          path.join(sourceRoot, 'docs/release/evidence/release-evidence-public-key.pem'),
        ),
        'release evidence public key',
      ),
      serverRequest: request,
      serverPublicKeyPem: readPem(
        valueOf('--server-public-key'),
        'server provenance public key',
      ),
      expectedPolicyDigest: releaseQualityPolicyDigest(sourceRoot),
      expectedRuntimeSha: valueOf('--expect-runtime-sha'),
      allowExpiredRequest: valueOf('--allow-expired-request') === 'true',
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      requestId: request.payload.requestId,
      evidenceSha256: sha256(fs.readFileSync(evidenceFile)),
    })}\n`);
    return;
  }
  if (command === 'policy-digest') {
    process.stdout.write(`${releaseQualityPolicyDigest(sourceRoot)}\n`);
    return;
  }
  if (command === 'assert-actions-idle') {
    assertNoConcurrentReleaseRuns(
      valuesOf('--actions-snapshot').map(readJson),
      valueOf('--current-run-id'),
    );
    process.stdout.write('{"ok":true,"releaseWorkflowsActive":false}\n');
    return;
  }
  fail(
    'Usage: release-quality-evidence.mjs '
    + '<build-server-request|validate-server-request|collect-and-sign|'
    + 'validate-evidence|policy-digest|assert-actions-idle> [options]',
  );
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
