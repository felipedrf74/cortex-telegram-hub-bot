#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Generate safe ChatV2 legacy-retirement parity observations by comparing
 * paired legacy and ChatV2 HTTP responses. This script never writes to the DB
 * and never emits raw prompt/response text. Import the resulting NDJSON only
 * after review with scripts/chatv2-import-legacy-parity-observations.ts.
 *
 * Runtime evidence is intentionally stricter than local sandbox evidence:
 * `--evidence-source=runtime_route` requires distinct --legacy-base-url and
 * --chatv2-base-url values so a same-response comparison cannot masquerade as
 * production parity proof.
 */

import fs from 'fs';
import path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

import {
  buildChatV2LegacyParityObservation,
  CHAT_V2_LEGACY_PARITY_COMPARATOR_VERSION,
  compareLegacyParityProjection,
  projectChatCoreV2CandidateForParity,
  projectLegacyChatResponseForParity,
  type ChatV2LegacyParityProjection,
} from '../src/services/chat-legacy-parity-observation-harness';
import {
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  type ChatV2LegacyParityObservation,
} from '../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
	  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION,
	  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS,
	  CHAT_V2_LEGACY_PARITY_WRITE_ROUTE_IDS,
	  type ChatV2LegacyParityRoutePrompt,
	  type ChatV2LegacyParityRoutePromptTag,
	} from '../src/services/chat-legacy-parity-route-prompts';
import type { ChatV2LegacyRetirementEvidenceSource } from '../src/services/chat-legacy-retirement-evidence';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

type RuntimeAuth = {
  token: string;
  userId: number;
  tenantId: number;
};

const root = path.resolve(__dirname, '..');
const baseUrl = trimTrailingSlash(readArg('--base-url') ?? process.env.CHATV2_PARITY_BASE_URL ?? 'http://127.0.0.1:8200');
const legacyBaseUrl = trimTrailingSlash(readArg('--legacy-base-url') ?? baseUrl);
const chatV2BaseUrl = trimTrailingSlash(readArg('--chatv2-base-url') ?? baseUrl);
const tokenFile = path.resolve(readArg('--token-file') ?? process.env.CHATV2_RUNTIME_TOKEN_FILE ?? path.join(root, '.local/full-nexus/local-ios-auth.json'));
const legacyTokenFile = path.resolve(readArg('--legacy-token-file') ?? process.env.CHATV2_PARITY_LEGACY_TOKEN_FILE ?? tokenFile);
const chatV2TokenFile = path.resolve(
  readArg('--chatv2-token-file')
    ?? process.env.CHATV2_PARITY_CHATV2_TOKEN_FILE
    ?? (legacyBaseUrl === chatV2BaseUrl ? tokenFile : path.join(root, '.local/full-nexus/chatv2-parity-auth.json')),
);
const legacyDbPath = resolveOptionalPath(readArg('--legacy-db') ?? process.env.CHATV2_PARITY_LEGACY_DB);
const chatV2DbPath = resolveOptionalPath(readArg('--chatv2-db') ?? process.env.CHATV2_PARITY_CHATV2_DB);
const inviteCode = readArg('--invite-code') ?? process.env.IOS_INVITE_CODE ?? 'LOCAL-DEV-INVITE';
const outPath = path.resolve(readArg('--out') ?? '.local/release/eval-evidence/chatv2-legacy-parity-observations-local.ndjson');
const samplesPerRoute = parsePositiveInt(readArg('--samples-per-route')) ?? 50;
const evidenceSource = parseEvidenceSource(readArg('--evidence-source') ?? 'local_sandbox_seed');
const routesFilter = parseRoutes(readArg('--routes'));
const allowRawReviewArtifact = hasFlag('--allow-raw-review-artifact');
const allowWritePrompts = hasFlag('--allow-write-prompts');
const isolatePrompts = hasFlag('--isolate-prompts');
const turnTimeoutMs = parsePositiveInt(readArg('--turn-timeout-ms') ?? process.env.CHATV2_PARITY_TURN_TIMEOUT_MS) ?? 45000;
const sampleDelayMs = parseNonNegativeInt(readArg('--sample-delay-ms') ?? process.env.CHATV2_PARITY_SAMPLE_DELAY_MS) ?? 0;
const stateFixtureHash = readArg('--fixture-hash') ?? process.env.CHATV2_PARITY_FIXTURE_HASH;

async function main(): Promise<void> {
  if (evidenceSource === 'runtime_route' && areEquivalentEndpointUrls(legacyBaseUrl, chatV2BaseUrl)) {
    throw new Error(
      'Refusing runtime_route observations from a single endpoint. Provide distinct --legacy-base-url and --chatv2-base-url, or use --evidence-source=local_sandbox_seed.',
    );
  }
  if (evidenceSource === 'runtime_route' && !isSha256Token(stateFixtureHash)) {
    throw new Error('Runtime parity observations require --fixture-hash=sha256:<64-hex> for the identical seeded state used by both endpoints.');
  }
  const hmacSecret = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (!hmacSecret) {
    throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required to emit parity observations');
  }
  if (allowRawReviewArtifact) {
    assertRawReviewArtifactPathIsLocalOnly(outPath);
  }
  const sharedLegacyAuth = isolatePrompts ? null : await resolveAuth({ baseUrl: legacyBaseUrl, tokenPath: legacyTokenFile });
  const sharedChatV2Auth = isolatePrompts
    ? null
    : (legacyBaseUrl === chatV2BaseUrl && legacyTokenFile === chatV2TokenFile
      ? sharedLegacyAuth
      : await resolveAuth({ baseUrl: chatV2BaseUrl, tokenPath: chatV2TokenFile }));
  const routePrompts = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.filter((route) => routesFilter.size === 0 || routesFilter.has(route.routeId));
  if (routePrompts.length === 0) {
    throw new Error(`No route prompt definitions matched --routes=${[...routesFilter].join(',') || '(empty)'}`);
  }
	  const writeRoutes = routePrompts.filter((route) => CHAT_V2_LEGACY_PARITY_WRITE_ROUTE_IDS.has(route.routeId));
	  validateRuntimePromptSampling(routePrompts);
	  if (writeRoutes.length > 0 && !allowWritePrompts) {
    throw new Error(
      `Refusing write-intent parity prompts without --allow-write-prompts. Routes: ${writeRoutes.map((route) => route.routeId).join(', ')}`,
    );
  }
  if (evidenceSource === 'runtime_route' && writeRoutes.length > 0 && !isolatePrompts) {
    throw new Error(
      `Refusing runtime_route write-intent prompts without --isolate-prompts. Routes: ${writeRoutes.map((route) => route.routeId).join(', ')}`,
    );
  }
  if (evidenceSource === 'runtime_route' && writeRoutes.length > 0 && (!legacyDbPath || !chatV2DbPath)) {
    throw new Error(
      'Runtime write parity observations require --legacy-db and --chatv2-db so fresh isolated users can be seeded with identical referenced entities.',
    );
  }

  const observations: ChatV2LegacyParityObservation[] = [];
  const summaryRows: Array<{
    routeId: string;
    attempted: number;
    emitted: number;
    matched: number;
    missingChatV2Projection: number;
    targetRouteNotObserved: number;
  }> = [];
  const rawReviewRows: unknown[] = [];

  for (const route of routePrompts) {
    let attempted = 0;
    let matched = 0;
    let missingChatV2Projection = 0;
    let targetRouteNotObserved = 0;
	    for (let index = 0; index < samplesPerRoute; index += 1) {
	      const prompt = evidenceSource === 'runtime_route'
	        ? route.prompts[index]!
	        : route.prompts[index % route.prompts.length]!;
      const sampleKey = `${route.routeId}:${index}:${prompt.language}`;
      const legacyAuth = sharedLegacyAuth ?? await registerAuth({ baseUrl: legacyBaseUrl });
      const text = promptTextForObservation(prompt.text);
      const legacyFixture = prepareParityFixture({
        dbPath: legacyDbPath,
        endpointRole: 'legacy',
        routeId: route.routeId,
        sampleKey,
        prompt,
        auth: legacyAuth,
      });
      const legacyBody = await sendChatTurn({
        baseUrl: legacyBaseUrl,
        auth: legacyAuth,
        text,
        language: prompt.language,
        clientMessageId: `legacy-parity-${route.routeId}-${Date.now()}-${index}`,
      });
      const chatV2Auth = legacyBaseUrl === chatV2BaseUrl
        ? legacyAuth
        : (sharedChatV2Auth ?? await registerAuth({ baseUrl: chatV2BaseUrl }));
      const chatV2Fixture = prepareParityFixture({
        dbPath: chatV2DbPath,
        endpointRole: 'chatv2',
        routeId: route.routeId,
        sampleKey,
        prompt,
        auth: chatV2Auth,
      });
      const chatV2Body = legacyBaseUrl === chatV2BaseUrl
        ? legacyBody
        : await sendChatTurn({
          baseUrl: chatV2BaseUrl,
          auth: chatV2Auth,
          text,
          language: prompt.language,
          clientMessageId: `chatv2-parity-${route.routeId}-${Date.now()}-${index}`,
        });
      const legacyProjection = projectLegacyChatResponseForParity({
        routeId: route.routeId,
        body: legacyBody.body,
        status: legacyBody.status,
      });
      const chatV2Projection = projectChatCoreV2CandidateForParity({
        routeId: route.routeId,
        body: chatV2Body.body,
        status: chatV2Body.status,
      });
      const comparison = compareLegacyParityProjection(legacyProjection, chatV2Projection);
      if (!chatV2Projection) missingChatV2Projection += 1;
      if (comparison.reasonCodes.includes('legacy_route_not_observed')
        || comparison.reasonCodes.includes('chatv2_route_not_observed')) {
        targetRouteNotObserved += 1;
      }
      if (comparison.matched) matched += 1;
      const observation = buildChatV2LegacyParityObservation({
        routeId: route.routeId,
        sampleKey,
        oldOwner: route.oldOwner,
        replacement: route.replacement,
        evaluator: 'runtime_tool',
        evidenceSource,
        legacyProjection,
        chatV2Projection,
        hmacSecret,
      });
      observations.push(observation);
      if (allowRawReviewArtifact) {
        rawReviewRows.push({
          schemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
          routeId: route.routeId,
          sampleKey,
          sampleHmac: observation.sampleHmac,
          language: prompt.language,
          promptText: text,
          legacyRawResponse: {
            status: legacyBody.status,
            body: legacyBody.body,
          },
          chatV2RawResponse: {
            status: chatV2Body.status,
            body: chatV2Body.body,
          },
          legacyProjection,
          chatV2Projection,
          comparison,
          fixture: {
            legacy: legacyFixture,
            chatV2: chatV2Fixture,
          },
        });
      }
      attempted += 1;
      if (sampleDelayMs > 0 && index + 1 < samplesPerRoute) {
        await sleep(sampleDelayMs);
      }
    }
    summaryRows.push({
      routeId: route.routeId,
      attempted,
      emitted: attempted,
      matched,
      missingChatV2Projection,
      targetRouteNotObserved,
    });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const observationsPayload = observations.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(outPath, observationsPayload);
  const manifestPath = outPath.replace(/\.ndjson$/i, '.manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_observer_manifest.v1',
    generatedAt: new Date().toISOString(),
    evidenceSource,
    routePromptVersion: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION,
    routeCorpusId: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.corpusId,
    routeCorpusFrozenAt: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.frozenAt,
    routeCorpusFrozenBeforeImplementation: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.frozenBeforeImplementation,
    routeCorpusMutationPolicy: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.mutationPolicy,
    routeCorpusSha256: stableSha256({
      meta: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
      routes: routePrompts,
    }),
    reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    comparatorVersion: CHAT_V2_LEGACY_PARITY_COMPARATOR_VERSION,
    stateFixtureHash: stateFixtureHash ?? `sha256:${'0'.repeat(64)}`,
    stateFixtureContract: writeRoutes.length > 0
      ? 'fresh_isolated_user_per_prompt_with_seeded_entities'
      : 'shared_read_only_seeded_snapshot',
    writeFixtureSeeding: writeRoutes.length > 0
      ? {
          schemaVersion: 'chat_v2_parity_write_fixture_seeding.v1',
          required: evidenceSource === 'runtime_route',
          legacyDbSupplied: !!legacyDbPath,
          chatV2DbSupplied: !!chatV2DbPath,
          seededEntities: ['native_task', 'decision_center_item'],
          fixtureSeedHash: `sha256:${stableSha256({
            version: 'chat_v2_parity_write_fixture_seeding.v1',
            seededEntities: ['native_task', 'decision_center_item'],
            routeIds: writeRoutes.map((route) => route.routeId).sort(),
          })}`,
        }
      : null,
    observationsSha256: crypto.createHash('sha256').update(observationsPayload).digest('hex'),
    observationRows: observations.length,
	    routeIds: routePrompts.map((route) => route.routeId).sort(),
	    samplesPerRoute,
	    samplesByRoute: Object.fromEntries(routePrompts.map((route) => [route.routeId, samplesPerRoute])),
	    distinctPromptsByRoute: Object.fromEntries(routePrompts.map((route) => [route.routeId, distinctPromptCount(route.prompts)])),
	    promptSamplingPolicy: evidenceSource === 'runtime_route'
	      ? 'no_repeated_prompts_for_answer_quality_research'
	      : 'local_sandbox_may_repeat_prompts',
	    sampleDelayMs,
    isolatePrompts,
    writeRoutes: writeRoutes.map((route) => route.routeId).sort(),
    runtimeRouteDistinctEndpoints: evidenceSource === 'runtime_route'
      ? !areEquivalentEndpointUrls(legacyBaseUrl, chatV2BaseUrl)
      : null,
    legacyEndpointHmac: hmacEndpoint(legacyBaseUrl, hmacSecret),
    chatV2EndpointHmac: hmacEndpoint(chatV2BaseUrl, hmacSecret),
    rawPromptOrResponseStored: false,
    committedObservationRawPromptOrResponseStored: false,
    rawReviewArtifactLocalOnly: allowRawReviewArtifact,
    rawReviewArtifactContainsRawPromptOrResponse: allowRawReviewArtifact,
    rawReviewArtifactSchemaVersion: allowRawReviewArtifact
      ? 'chat_v2_legacy_parity_raw_review_row.v1'
      : null,
    tokenFilesAreLocalOnly: true,
  }, null, 2)}\n`);
  if (allowRawReviewArtifact) {
    const reviewPath = outPath.replace(/\.ndjson$/i, '.review.json');
    fs.writeFileSync(reviewPath, `${JSON.stringify(rawReviewRows, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_observation_run.v1',
    evidenceSource,
    outPath,
    manifestPath,
    routes: routePrompts.length,
    observations: observations.length,
    sampleDelayMs,
    isolatePrompts,
    summaryRows,
    warning: evidenceSource === 'local_sandbox_seed'
      ? 'Local sandbox observations prove tooling/plumbing only. Default Phase 7 promotion still requires runtime_route paired observations.'
      : 'Runtime observations require independent QA before import; this script emitted HMAC-only rows and did not write the DB.',
  }, null, 2));
}

async function sendChatTurn(input: {
  baseUrl: string;
  auth: RuntimeAuth;
  text: string;
  language: string;
  clientMessageId: string;
}): Promise<{ status: number; body: unknown }> {
  return fetchJsonWithObserverTimeout(`${input.baseUrl}/api/v1/chat/message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.auth.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Language': input.language,
      'X-Client-Message-Id': input.clientMessageId,
      'X-Chat-V2-First-Progress-Ms': '250',
      'User-Agent': 'NexusHubChatV2LegacyParityObserver/1',
    },
    body: JSON.stringify({ text: input.text, clientMessageId: input.clientMessageId }),
  });
}

async function resolveAuth(input: { baseUrl: string; tokenPath: string }): Promise<RuntimeAuth> {
  const existing = readTokenFile(input.tokenPath);
  if (existing && await validateAuthToken(input.baseUrl, existing.token)) return existing;
  return registerAuth({ baseUrl: input.baseUrl, writePath: input.tokenPath });
}

async function validateAuthToken(baseUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetchJsonWithObserverTimeout(`${baseUrl}/api/v1/auth/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'NexusHubChatV2LegacyParityObserver/1',
      },
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

async function registerAuth(input: { baseUrl: string; writePath?: string }): Promise<RuntimeAuth> {
  const response = await fetchJsonWithObserverTimeout(`${input.baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: `chatv2-parity-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      deviceName: 'ChatV2 Legacy Parity Observer',
      inviteCode,
    }),
  });
  const body = response.body;
  const payload = body && typeof body === 'object' && 'data' in body
    ? (body as Record<string, unknown>).data
    : body;
  const payloadRecord = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  if (response.status < 200 || response.status >= 300 || typeof payloadRecord?.accessToken !== 'string') {
    throw new Error(`Unable to register parity auth token at ${input.baseUrl}: HTTP ${response.status} ${JSON.stringify(safeErrorCode(body))}`);
  }
  if (input.writePath) {
    fs.mkdirSync(path.dirname(input.writePath), { recursive: true });
    fs.writeFileSync(input.writePath, JSON.stringify({
      accessToken: payloadRecord.accessToken,
      refreshToken: payloadRecord.refreshToken,
      expiresIn: payloadRecord.expiresIn,
      user: payloadRecord.user,
    }, null, 2));
  }
  return authFromPayload(payloadRecord.accessToken, payloadRecord.user);
}

function readTokenFile(filePath: string): RuntimeAuth | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.accessToken === 'string') return authFromPayload(parsed.accessToken, parsed.user);
    if (typeof parsed.token === 'string') return authFromPayload(parsed.token, parsed.user);
    if (typeof parsed.jwt === 'string') return authFromPayload(parsed.jwt, parsed.user);
  } catch {
    return authFromPayload(raw, null);
  }
  return null;
}

function authFromPayload(token: string, user: unknown): RuntimeAuth {
  const record = user && typeof user === 'object' ? user as Record<string, unknown> : null;
  const userId = numberFromUnknown(record?.id ?? record?.userId ?? process.env.CHATV2_RUNTIME_USER_ID);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Unable to resolve user id for parity observation auth. Set CHATV2_RUNTIME_USER_ID or regenerate token file.');
  }
  const tenantId = numberFromUnknown(record?.tenantId ?? record?.tenant_id ?? process.env.CHATV2_RUNTIME_TENANT_ID) ?? userId;
  return { token, userId, tenantId };
}

function safeJsonText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { code: 'non_json_response' } };
  }
}

async function fetchJsonWithObserverTimeout(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const method = String(init.method ?? 'GET').toUpperCase();
  const rawBody = typeof init.body === 'string' || Buffer.isBuffer(init.body)
    ? init.body
    : init.body == null
      ? undefined
      : String(init.body);
  const headers = normalizeObserverHeaders(init.headers);
  if (rawBody !== undefined && !hasHeader(headers, 'content-length')) {
    headers['Content-Length'] = Buffer.byteLength(rawBody).toString();
  }
  return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let settled = false;
    let hardTimeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: { status: number; body: unknown }) => {
      if (settled) return;
      settled = true;
      if (hardTimeout) clearTimeout(hardTimeout);
      resolve(result);
    };
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        settle({
          status: res.statusCode ?? 599,
          body: safeJsonText(Buffer.concat(chunks).toString('utf8')),
        });
      });
    });
    hardTimeout = setTimeout(() => {
      req.destroy();
      settle({ status: 599, body: { error: { code: 'observer_timeout' } } });
    }, turnTimeoutMs);
    req.setTimeout(turnTimeoutMs, () => {
      req.destroy();
      settle({ status: 599, body: { error: { code: 'observer_timeout' } } });
    });
    req.on('error', (err) => {
      if (settled) return;
      if ((err as { code?: string })?.code === 'ECONNRESET') {
        settle({ status: 599, body: { error: { code: 'observer_timeout' } } });
        return;
      }
      reject(err);
    });
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

function normalizeObserverHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) normalized[key] = value;
    return normalized;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    normalized[key] = value;
  }
  return normalized;
}

function hasHeader(headers: Record<string, string>, needle: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === needle.toLowerCase());
}

function safeErrorCode(body: unknown): string {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const error = record?.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null;
  return typeof error?.code === 'string' ? error.code : 'unknown_error';
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEvidenceSource(value: string): ChatV2LegacyRetirementEvidenceSource {
  if (value === 'runtime_route' || value === 'local_sandbox_seed') return value;
  throw new Error(`Invalid --evidence-source=${value}`);
}

function parseRoutes(value: string | undefined): Set<string> {
  return new Set(String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean));
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  return value ? path.resolve(value) : undefined;
}

function assertRawReviewArtifactPathIsLocalOnly(candidateOutPath: string): void {
  const localRoot = path.join(root, '.local');
  const relative = path.relative(localRoot, path.resolve(candidateOutPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      'Raw legacy-parity review artifacts contain prompts/responses and must be written under this repository .local/ directory.',
    );
  }
}

function areEquivalentEndpointUrls(a: string, b: string): boolean {
  return canonicalEndpoint(a) === canonicalEndpoint(b);
}

function canonicalEndpoint(value: string): string {
  const parsed = new URL(value);
  const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return `${parsed.protocol}//${host}:${port}${parsed.pathname.replace(/\/+$/, '')}`;
}

function hmacEndpoint(value: string, hmacSecret: string): string {
  return `hmac:endpoint:${crypto.createHmac('sha256', hmacSecret).update(canonicalEndpoint(value)).digest('hex')}`;
}

function stableSha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function isSha256Token(value: string | undefined): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function validateRuntimePromptSampling(routes: ChatV2LegacyParityRoutePrompt[]): void {
  if (evidenceSource !== 'runtime_route') return;
  for (const route of routes) {
    const distinct = distinctPromptCount(route.prompts);
    if (
      (
        route.evidenceTrack === 'answer_quality_research'
        || route.evidenceTrack === 'write_firewall_bundle'
        || route.runtimeCoupling === 'independent_read_route'
      )
      && (distinct < samplesPerRoute || route.prompts.length < samplesPerRoute)
    ) {
      throw new Error(
        `Runtime evidence for ${route.routeId} requires ${samplesPerRoute} distinct held-out prompts; found ${distinct}. Repeated prompt padding is not valid parity evidence.`,
      );
    }
  }
}

function distinctPromptCount(prompts: ChatV2LegacyParityRoutePrompt['prompts']): number {
  return new Set(prompts.map((prompt) => prompt.text.trim().replace(/\s+/g, ' '))).size;
}

function promptTextForObservation(text: string): string {
  // Keep the prompt semantics untouched. Uniqueness lives in sampleKey and
  // clientMessageId; appending text changed slash commands like `/todo` into a
  // different route, which made the parity harness observe the wrong owner.
  return text;
}

function prepareParityFixture(input: {
  dbPath: string | undefined;
  endpointRole: 'legacy' | 'chatv2';
  routeId: string;
  sampleKey: string;
  prompt: {
    language: string;
    text: string;
    tags?: readonly ChatV2LegacyParityRoutePromptTag[];
  };
  auth: RuntimeAuth;
}): { seeded: boolean; fixtureHash: string | null; reason: string } {
  if (!CHAT_V2_LEGACY_PARITY_WRITE_ROUTE_IDS.has(input.routeId)) {
    return { seeded: false, fixtureHash: null, reason: 'route_is_not_write_track' };
  }
  if (!input.dbPath) {
    return { seeded: false, fixtureHash: null, reason: 'db_path_not_supplied' };
  }
  if (!fs.existsSync(input.dbPath)) {
    throw new Error(`Parity fixture DB not found for ${input.endpointRole}: ${input.dbPath}`);
  }

  const db = new Database(input.dbPath);
  try {
    const operations = computeWriteFixtureOperations(input.routeId, input.prompt.tags ?? []);
    const fixtureHash = `sha256:${stableSha256({
      schemaVersion: 'chat_v2_parity_write_fixture_operations.v1',
      routeId: input.routeId,
      sampleKey: input.sampleKey,
      language: input.prompt.language,
      operations,
    })}`;
    db.transaction(() => {
      if (operations.seedDuplicateTasks || operations.seedDestructiveTasks) {
        seedNativeTaskFixture(db, input.auth, operations);
      }
      if (operations.seedDecision) {
        seedDecisionFixture(db, input.auth);
      }
    })();
    return { seeded: true, fixtureHash, reason: 'seeded_write_fixture_entities' };
  } finally {
    db.close();
  }
}

function computeWriteFixtureOperations(routeId: string, tags: readonly ChatV2LegacyParityRoutePromptTag[]): {
  seedDuplicateTasks: boolean;
  seedDestructiveTasks: boolean;
  seedDecision: boolean;
} {
  const tagSet = new Set(tags);
  return {
    seedDuplicateTasks: routeId === 'general_action_planner' && tagSet.has('duplicate_title'),
    seedDestructiveTasks: routeId === 'destructive_confirmation_hold' && tagSet.has('destructive_write'),
    seedDecision: routeId === 'decision_confirmation_shortcut',
  };
}

function seedNativeTaskFixture(
  db: Database.Database,
  auth: RuntimeAuth,
  operations: { seedDuplicateTasks: boolean; seedDestructiveTasks: boolean },
): void {
  ensureTablesExist(db, ['native_task_lists', 'native_tasks']);
  db.prepare(`
    INSERT OR IGNORE INTO native_task_lists (user_id, name, is_default, color)
    VALUES (?, 'Inbox', 1, '#ff6b3d')
  `).run(auth.userId);
  const list = db.prepare(`
    SELECT id FROM native_task_lists
     WHERE user_id = ? AND name = 'Inbox'
     ORDER BY id ASC
     LIMIT 1
  `).get(auth.userId) as { id: number } | undefined;
  if (!list) throw new Error(`Unable to seed parity tasks for user ${auth.userId}: Inbox list missing`);

  db.prepare(`
    DELETE FROM native_tasks
     WHERE user_id = ?
       AND tags = ?
  `).run(auth.userId, JSON.stringify(['chatv2-parity-fixture']));

  const insertTask = db.prepare(`
    INSERT INTO native_tasks (user_id, list_id, title, body, importance, status, tags)
    VALUES (?, ?, ?, ?, 'normal', 'notStarted', ?)
  `);
  if (operations.seedDuplicateTasks) {
    insertTask.run(auth.userId, list.id, 'duplicate title audit', 'ChatV2 parity fixture duplicate A.', JSON.stringify(['chatv2-parity-fixture']));
    insertTask.run(auth.userId, list.id, 'duplicate title audit', 'ChatV2 parity fixture duplicate B.', JSON.stringify(['chatv2-parity-fixture']));
  }
  if (operations.seedDestructiveTasks) {
    insertTask.run(auth.userId, list.id, 'parity destructive audit one', 'ChatV2 parity fixture destructive candidate A.', JSON.stringify(['chatv2-parity-fixture']));
    insertTask.run(auth.userId, list.id, 'parity destructive audit two', 'ChatV2 parity fixture destructive candidate B.', JSON.stringify(['chatv2-parity-fixture']));
  }
}

function seedDecisionFixture(db: Database.Database, auth: RuntimeAuth): void {
  ensureTablesExist(db, ['notification_intents', 'notification_center_items']);
  const now = new Date().toISOString();
  const intentId = 'intent_dec_123';
  const itemId = 'dec_123';
  const actions = [
    { id: 'open_detail', label: 'Review', style: 'primary' },
    { id: 'snooze', label: 'Snooze', style: 'secondary' },
    { id: 'dismiss', label: 'Dismiss', style: 'destructive' },
  ];
  const context = {
    entityTitle: 'Parity decision dec_123',
    sourceState: 'pending_chat_confirmation',
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    locale: 'en',
    timezone: 'UTC',
  };

  db.prepare(`
    DELETE FROM notification_center_items
     WHERE item_id = ?
  `).run(itemId);
  db.prepare(`
    DELETE FROM notification_intents
     WHERE intent_id = ?
  `).run(intentId);

  db.prepare(`
    INSERT INTO notification_intents (
      intent_id, user_id, tenant_id, source_skill, type, priority,
      related_entity_id, related_entity_type, title, body, sensitive_body,
      action_buttons_json, deeplink, expires_at, quiet_hours_policy,
      dedupe_key, requires_user_action, decision_deadline, delivery_policy,
      privacy_policy, decision_context_json, status, created_at
    ) VALUES (?, ?, ?, 'chat', 'decision_required', 'time_sensitive',
      ?, 'chat_confirmation', 'Nexus needs your choice',
      'Review the parity decision dec_123 before continuing the chat workflow.',
      NULL, ?, 'nexus://decision-center/dec_123', NULL, 'respect',
      ?, 1, ?, 'in_app_only', 'standard', ?, 'delivered', ?)
  `).run(
    intentId,
    auth.userId,
    auth.tenantId,
    itemId,
    JSON.stringify(actions),
    `chatv2-parity:decision:${auth.userId}:${auth.tenantId}`,
    context.deadlineAt,
    JSON.stringify(context),
    now,
  );
  db.prepare(`
    INSERT INTO notification_center_items (
      item_id, intent_id, user_id, tenant_id, title, body, safe_body,
      source_skill, type, priority, status, deeplink, actions_json,
      dedupe_key, created_at
    ) VALUES (?, ?, ?, ?, 'Nexus needs your choice',
      'Review the parity decision dec_123 before continuing the chat workflow.',
      'Review the parity decision dec_123 before continuing the chat workflow.',
      'chat', 'decision_required', 'time_sensitive', 'unread',
      'nexus://decision-center/dec_123', ?, ?, ?)
  `).run(
    itemId,
    intentId,
    auth.userId,
    auth.tenantId,
    JSON.stringify(actions),
    `chatv2-parity:decision:${auth.userId}:${auth.tenantId}`,
    now,
  );
}

function ensureTablesExist(db: Database.Database, tableNames: string[]): void {
  const missing = tableNames.filter((table) => {
    const row = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = ?
       LIMIT 1
    `).get(table) as { name: string } | undefined;
    return !row;
  });
  if (missing.length > 0) {
    throw new Error(`Parity fixture DB is missing required table(s): ${missing.join(', ')}`);
  }
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
