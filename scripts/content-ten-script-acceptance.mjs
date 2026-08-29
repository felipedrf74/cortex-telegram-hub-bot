#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEN_SCRIPT_ACCEPTANCE_SCHEMA = 'nexus.content-ten-script-acceptance.v3';
export const LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA = 'nexus.content-ten-script-acceptance.v2';
export const TEN_SCRIPT_ACCEPTANCE_REVISION = '2026-08-24-v3';
export const TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA = 'nexus.content-ten-script-acceptance.v4';
export const TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION = '2026-08-29-v4';
export const TEN_SCRIPT_SUCCESSOR_PREDECESSOR_SCHEMA =
  'nexus.content-ten-script-predecessor.v1';
export const TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA = 'nexus.content-ten-script-workload-source.v1';
export const TEN_SCRIPT_ACCEPTANCE_SCENARIOS = Object.freeze([
  { id: 'std-en-01', phase: 'pre-release', deliveryMode: 'standard', language: 'en', topic: 'Build a practical meal-prep system for busy professionals using timeless planning, food-safety, and consistency principles.' },
  { id: 'std-ptbr-01', phase: 'pre-release', deliveryMode: 'standard', language: 'pt-BR', topic: 'Crie um sistema prático de formação de hábitos para profissionais ocupados, com princípios atemporais, exemplos e passos acionáveis.' },
  { id: 'std-en-02', phase: 'pre-release', deliveryMode: 'standard', language: 'en', topic: 'Explain a sustainable recovery routine for an amateur triathlete using timeless sleep, mobility, fueling, and workload principles.' },
  { id: 'std-ptbr-02', phase: 'pre-release', deliveryMode: 'standard', language: 'pt-BR', topic: 'Explique um método atemporal de produtividade pessoal para priorizar trabalho importante sem esgotamento.' },
  { id: 'sched-en-01', phase: 'pre-release', deliveryMode: 'scheduled', language: 'en', topic: 'Create a beginner-friendly home strength progression using timeless technique, recovery, and progressive-overload principles.' },
  { id: 'sched-ptbr-01', phase: 'pre-release', deliveryMode: 'scheduled', language: 'pt-BR', topic: 'Crie um sistema editorial atemporal para transformar uma ideia em roteiro, revisão e publicação com qualidade consistente.' },
  { id: 'sched-en-02', phase: 'pre-release', deliveryMode: 'scheduled', language: 'en', topic: 'Teach timeless cooking fundamentals for balancing salt, acid, fat, heat, texture, and timing in everyday meals.' },
  { id: 'prio-ptbr-01', phase: 'pre-release', deliveryMode: 'priority', language: 'pt-BR', topic: 'Explique princípios atemporais de organização financeira pessoal, orçamento, reserva e decisões conscientes sem aconselhamento individual.' },
  { id: 'prio-en-01', phase: 'pre-release', deliveryMode: 'priority', language: 'en', topic: 'Explain timeless marathon pacing principles, effort control, fueling practice, and race-day decision making for recreational runners.' },
  { id: 'prio-ptbr-smoke', phase: 'production-smoke', deliveryMode: 'priority', language: 'pt-BR', topic: 'Crie um guia atemporal de organização digital para reduzir distrações e manter arquivos, tarefas e comunicação sob controle.' },
]);

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[0-9a-f]{32}$/u;
const JOB_ID = /^script_job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_RELEASE_VIEW_BYTES = 1024 * 1024;
const MAX_ACCEPTANCE_STATE_BYTES = 1024 * 1024;
const MAX_ACCEPTANCE_SERVER_CLOCK_SKEW_MS = 30_000;
const MAX_AUTH_FILE_BYTES = 64 * 1024;
const PRODUCTION_API_ORIGIN = 'https://api.nexushub.me';
const EXPECTED_PRODUCTION_SOURCE_SHA = '815582be8127bafb97d7edaae2a4eab96e37c4cf';
const RELEASE_VIEW_COMMAND = '/usr/local/sbin/nexus-release-state-view';
const SUDO = '/usr/bin/sudo';
const JOB_STATUSES = new Set([
  'pending', 'queued', 'running', 'waiting_capacity', 'completed', 'failed', 'cancelled',
]);
const ROW_KEYS = new Set([
  'id', 'phase', 'deliveryMode', 'language', 'topicSha256', 'status', 'jobId', 'output',
  'stage', 'progress', 'updatedAt', 'submittedAt', 'errorCode', 'lastPollError',
  'lastPollErrorAt', 'requestRevision', 'carriedForward',
]);

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key))
      || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error(`${label} fields do not match the governed schema`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const normalized = typeof value === 'string' && !value.includes('.')
    ? value.replace(/Z$/u, '.000Z') : value;
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)
      || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function boundedString(value, label, maximum = 240) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
      || /[\r\n\u0000]/u.test(value)) {
    throw new Error(`${label} must be bounded single-line text`);
  }
  return value;
}

function validateOutput(output, label) {
  exactKeys(output, [
    'scriptSha256', 'wordCount', 'warnings', 'route', 'modelDigest',
    'sourceConsistent', 'contractPass',
  ], [], label);
  if (!SHA256.test(output.scriptSha256 ?? '')
      || !Number.isSafeInteger(output.wordCount) || output.wordCount < 1
      || !Array.isArray(output.warnings) || output.warnings.length > 32
      || output.warnings.some((warning) => typeof warning !== 'string'
        || warning.length < 1 || warning.length > 120 || /[\r\n\u0000]/u.test(warning))
      || output.route !== 'cloud' || output.modelDigest !== null
      || typeof output.sourceConsistent !== 'boolean'
      || typeof output.contractPass !== 'boolean') {
    throw new Error(`${label} is invalid`);
  }
  const sourceConsistent = !output.warnings.includes('unsupported_source_url');
  const contractPass = output.wordCount >= 1900 && output.wordCount <= 2400
    && output.warnings.length === 0 && sourceConsistent;
  if (output.sourceConsistent !== sourceConsistent || output.contractPass !== contractPass) {
    throw new Error(`${label} derived verdict is inconsistent`);
  }
  return output;
}

export function validateCompletedReleaseView(view, expectedSourceSha) {
  const receipt = view?.activeReceipt;
  const effective = view?.effective;
  const active = view?.active;
  if (!FULL_SHA.test(expectedSourceSha ?? '')
      || view?.schema !== 'nexus.release-state-view.v2'
      || view.blocked !== null
      || active?.status !== 'completed'
      || active.sourceSha !== expectedSourceSha
      || effective?.source !== 'receipt' || effective.provable !== true
      || effective.status !== 'completed' || effective.stateStatus !== 'completed'
      || effective.staleProjection !== false
      || receipt?.schema !== 'nexus.release-receipt.v3'
      || receipt.outcome !== 'completed' || receipt.sourceSha !== expectedSourceSha
      || !RELEASE_ID.test(receipt.releaseId ?? '')
      || active.releaseId !== receipt.releaseId || effective.releaseId !== receipt.releaseId
      || !SHA256.test(receipt.releasePayloadDigest ?? '')
      || active.releasePayloadDigest !== receipt.releasePayloadDigest
      || effective.releasePayloadDigest !== receipt.releasePayloadDigest) {
    const error = new Error('release view does not prove an unblocked completed v3 receipt for the expected source');
    error.exitCode = 78;
    throw error;
  }
  canonicalTimestamp(view.capturedAt, 'release view capturedAt');
  canonicalTimestamp(receipt.completedAt, 'release receipt completedAt');
  if (Date.parse(receipt.completedAt) > Date.parse(view.capturedAt)) {
    const error = new Error('release receipt completion cannot be later than release view capture');
    error.exitCode = 78;
    throw error;
  }
  return {
    viewSchema: view.schema,
    capturedAt: view.capturedAt,
    releaseId: receipt.releaseId,
    sourceSha: receipt.sourceSha,
    stateStatus: active.status,
    receiptSchema: receipt.schema,
    receiptOutcome: receipt.outcome,
    receiptCompletedAt: receipt.completedAt,
    releasePayloadDigest: receipt.releasePayloadDigest,
  };
}

function parseReleaseViewBytes(bytes, expectedSourceSha, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_RELEASE_VIEW_BYTES) {
    throw new Error(`${label} bytes are missing or oversized`);
  }
  let view;
  try {
    view = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return { view, release: validateCompletedReleaseView(view, expectedSourceSha) };
}

function captureAuthoritativeReleaseView(expectedSourceSha) {
  const result = spawnSync(SUDO, ['-n', RELEASE_VIEW_COMMAND], {
    encoding: null,
    maxBuffer: MAX_RELEASE_VIEW_BYTES,
    env: { PATH: '/usr/bin:/bin' },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('authoritative release-state viewer failed');
  }
  return parseReleaseViewBytes(
    result.stdout,
    expectedSourceSha,
    'authoritative release view',
  );
}

export function validateAuthoritativeWorkloadReleaseView(
  candidateBytes,
  authoritativeView,
  expectedSourceSha,
) {
  const candidate = parseReleaseViewBytes(
    candidateBytes,
    expectedSourceSha,
    'workload release view',
  );
  const authoritative = {
    view: authoritativeView,
    release: validateCompletedReleaseView(authoritativeView, expectedSourceSha),
  };
  const stableFields = [
    'releaseId',
    'sourceSha',
    'receiptCompletedAt',
    'releasePayloadDigest',
  ];
  const candidateBackendDigest = candidate.view.active?.images?.backend?.digest;
  const authoritativeBackendDigest = authoritative.view.active?.images?.backend?.digest;
  if (!SHA256.test(candidateBackendDigest ?? '')
      || candidateBackendDigest !== authoritativeBackendDigest
      || stableFields.some((field) => candidate.release[field] !== authoritative.release[field])
      || Date.parse(candidate.release.capturedAt) > Date.parse(authoritative.release.capturedAt)) {
    throw new Error('workload release view does not match the current authoritative receipt');
  }
  return candidate;
}

function validateWorkloadSourceBinding(binding) {
  exactKeys(binding, [
    'schemaVersion', 'sourceSha', 'boundAt', 'releaseViewSha256', 'releaseId',
    'releasePayloadDigest', 'receiptCompletedAt', 'viewCapturedAt',
  ], [], 'production smoke workload source');
  if (binding.schemaVersion !== TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA
      || !FULL_SHA.test(binding.sourceSha ?? '')
      || !SHA256.test(binding.releaseViewSha256 ?? '')
      || !RELEASE_ID.test(binding.releaseId ?? '')
      || !SHA256.test(binding.releasePayloadDigest ?? '')) {
    throw new Error('production smoke workload source identity is invalid');
  }
  canonicalTimestamp(binding.boundAt, 'production smoke workload source boundAt');
  canonicalTimestamp(binding.receiptCompletedAt, 'production smoke workload receiptCompletedAt');
  canonicalTimestamp(binding.viewCapturedAt, 'production smoke workload viewCapturedAt');
  if (Date.parse(binding.receiptCompletedAt) > Date.parse(binding.viewCapturedAt)
      || Date.parse(binding.viewCapturedAt) > Date.parse(binding.boundAt)) {
    throw new Error('production smoke workload source timestamps are not causal');
  }
  return binding;
}

export function validateAcceptanceStateShape(state) {
  const successor = state?.schemaVersion === TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA;
  exactKeys(state, [
    'schemaVersion', 'acceptanceRevision', 'createdAt', 'scenarios',
    ...(successor ? ['predecessor'] : []),
  ], ['productionSmokeSource'], 'acceptance state');
  if ((!successor && (state.schemaVersion !== TEN_SCRIPT_ACCEPTANCE_SCHEMA
        || state.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION))
      || (successor && state.acceptanceRevision !== TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION)
      || !Array.isArray(state.scenarios)
      || state.scenarios.length !== TEN_SCRIPT_ACCEPTANCE_SCENARIOS.length) {
    throw new Error('acceptance state does not match the immutable ten-scenario inventory');
  }
  canonicalTimestamp(state.createdAt, 'acceptance state createdAt');
  let carriedScenarioIds = [];
  if (successor) {
    exactKeys(state.predecessor, [
      'schemaVersion', 'stateSchemaVersion', 'acceptanceRevision', 'stateSha256',
      'carriedScenarioIds',
    ], [], 'acceptance predecessor');
    carriedScenarioIds = state.predecessor.carriedScenarioIds;
    if (state.predecessor.schemaVersion !== TEN_SCRIPT_SUCCESSOR_PREDECESSOR_SCHEMA
        || ![LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA, TEN_SCRIPT_ACCEPTANCE_SCHEMA]
          .includes(state.predecessor.stateSchemaVersion)
        || state.predecessor.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
        || !SHA256.test(state.predecessor.stateSha256 ?? '')
        || !Array.isArray(carriedScenarioIds)
        || carriedScenarioIds.length !== 7
        || new Set(carriedScenarioIds).size !== carriedScenarioIds.length
        || carriedScenarioIds.some((id) => typeof id !== 'string')) {
      throw new Error('acceptance predecessor identity is invalid');
    }
  }
  if (state.productionSmokeSource !== undefined) {
    validateWorkloadSourceBinding(state.productionSmokeSource);
    if (Date.parse(state.productionSmokeSource.boundAt) < Date.parse(state.createdAt)) {
      throw new Error('production smoke workload binding predates acceptance state creation');
    }
  }
  state.scenarios.forEach((row, index) => {
    const expected = TEN_SCRIPT_ACCEPTANCE_SCENARIOS[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some((key) => !ROW_KEYS.has(key))
        || row.id !== expected.id || row.phase !== expected.phase
        || row.deliveryMode !== expected.deliveryMode || row.language !== expected.language
        || row.topicSha256 !== sha256(expected.topic)
        || !JOB_STATUSES.has(row.status)
        || (row.jobId !== null && !JOB_ID.test(row.jobId ?? ''))) {
      throw new Error(`acceptance scenario ${expected.id} is invalid`);
    }
    for (const key of ['id', 'phase', 'deliveryMode', 'language', 'topicSha256', 'status', 'jobId', 'output']) {
      if (!Object.hasOwn(row, key)) throw new Error(`acceptance scenario ${expected.id} fields are incomplete`);
    }
    if (successor) {
      if (typeof row.carriedForward !== 'boolean'
          || ![TEN_SCRIPT_ACCEPTANCE_REVISION, TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION]
            .includes(row.requestRevision)
          || (row.carriedForward && row.requestRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION)
          || (!row.carriedForward
            && row.requestRevision !== TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION)) {
        throw new Error(`${expected.id} successor provenance is invalid`);
      }
    } else if (Object.hasOwn(row, 'carriedForward') || Object.hasOwn(row, 'requestRevision')) {
      throw new Error(`${expected.id} predecessor state cannot assert successor provenance`);
    }
    if (row.jobId === null && row.status !== 'pending') {
      throw new Error(`acceptance scenario ${expected.id} has status without a job identity`);
    }
    if (row.jobId !== null && row.submittedAt === undefined) {
      throw new Error(`acceptance scenario ${expected.id} has a job identity without submittedAt`);
    }
    if (row.status === 'completed') validateOutput(row.output, `${expected.id} output`);
    else if (row.output !== null) throw new Error(`${expected.id} non-completed output must be null`);
    if (row.status === 'completed'
        && (row.stage !== 'completed' || row.progress !== 100 || row.updatedAt === undefined)) {
      throw new Error(`${expected.id} completed state is incomplete`);
    }
    if (row.stage !== undefined) boundedString(row.stage, `${expected.id} stage`, 120);
    if (row.progress !== undefined
        && (!Number.isSafeInteger(row.progress) || row.progress < 0 || row.progress > 100)) {
      throw new Error(`${expected.id} progress is invalid`);
    }
    for (const key of ['updatedAt', 'submittedAt', 'lastPollErrorAt']) {
      if (row[key] !== undefined) canonicalTimestamp(row[key], `${expected.id} ${key}`);
    }
    if (row.submittedAt !== undefined && !row.carriedForward
        && Date.parse(row.submittedAt) < Date.parse(state.createdAt)) {
      throw new Error(`${expected.id} submission predates acceptance state creation`);
    }
    if (row.updatedAt !== undefined && row.submittedAt !== undefined
        && Date.parse(row.updatedAt) + MAX_ACCEPTANCE_SERVER_CLOCK_SKEW_MS
          < Date.parse(row.submittedAt)) {
      throw new Error(`${expected.id} update predates submission`);
    }
    if (row.errorCode !== undefined) boundedString(row.errorCode, `${expected.id} errorCode`, 120);
    if (row.lastPollError !== undefined) boundedString(row.lastPollError, `${expected.id} lastPollError`);
  });
  if (successor) {
    const actualCarried = state.scenarios
      .filter((row) => row.carriedForward)
      .map((row) => row.id);
    if (JSON.stringify(actualCarried) !== JSON.stringify(carriedScenarioIds)
        || state.scenarios.some((row) => row.carriedForward
          && (row.phase !== 'pre-release' || row.status !== 'completed'
            || row.output?.contractPass !== true))) {
      throw new Error('acceptance successor carry-forward set is invalid');
    }
  }
  return state;
}

export function migrateLegacyAcceptanceState(state) {
  exactKeys(state, ['schemaVersion', 'acceptanceRevision', 'createdAt', 'scenarios'], [
    'productionSmokeSourceSha',
  ], 'legacy acceptance state');
  if (state.schemaVersion !== LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA
      || state.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
      || !Array.isArray(state.scenarios)
      || state.scenarios.length !== TEN_SCRIPT_ACCEPTANCE_SCENARIOS.length) {
    throw new Error('legacy acceptance state schema or revision is invalid');
  }
  if (Object.hasOwn(state, 'productionSmokeSourceSha')) {
    throw new Error('legacy acceptance state already contains an unprovable smoke source assertion');
  }
  const migrated = {
    ...state,
    schemaVersion: TEN_SCRIPT_ACCEPTANCE_SCHEMA,
    scenarios: state.scenarios.map((row) => ({ ...row })),
  };
  validateAcceptanceStateShape(migrated);
  const smoke = migrated.scenarios.find((row) => row.phase === 'production-smoke');
  if (!smoke || smoke.jobId !== null || smoke.status !== 'pending' || smoke.output !== null) {
    throw new Error('legacy acceptance state cannot be migrated after smoke submission');
  }
  exactKeys(smoke, [
    'id', 'phase', 'deliveryMode', 'language', 'topicSha256', 'status', 'jobId', 'output',
  ], [], 'legacy production smoke scenario');
  return migrated;
}

function predecessorStateFromBytes(predecessorBytes) {
  if (!Buffer.isBuffer(predecessorBytes) || predecessorBytes.length < 1
      || predecessorBytes.length > MAX_ACCEPTANCE_STATE_BYTES) {
    throw new Error('acceptance predecessor bytes are missing or oversized');
  }
  let raw;
  try {
    raw = JSON.parse(predecessorBytes.toString('utf8'));
  } catch {
    throw new Error('acceptance predecessor is not valid JSON');
  }
  const validated = raw?.schemaVersion === LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA
    ? migrateLegacyAcceptanceState(raw)
    : validateAcceptanceStateShape(raw);
  if (validated.schemaVersion !== TEN_SCRIPT_ACCEPTANCE_SCHEMA
      || validated.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
      || Object.hasOwn(validated, 'productionSmokeSource')) {
    throw new Error('acceptance predecessor is not the exact pre-smoke v3 workload');
  }
  const preRelease = validated.scenarios.filter((row) => row.phase === 'pre-release');
  const carried = preRelease.filter((row) => row.status === 'completed'
    && row.output?.contractPass === true);
  const recoverable = preRelease.filter((row) => row.status === 'failed');
  const smoke = validated.scenarios.find((row) => row.phase === 'production-smoke');
  if (carried.length !== 7 || recoverable.length !== 2
      || preRelease.length !== 9
      || preRelease.some((row) => !carried.includes(row) && !recoverable.includes(row))
      || !smoke || smoke.status !== 'pending' || smoke.jobId !== null || smoke.output !== null) {
    throw new Error('acceptance predecessor is not the authorized seven-pass/two-failure state');
  }
  return { raw, validated, carried, recoverable };
}

export function createSuccessorAcceptanceState(predecessorBytes, createdAt = new Date().toISOString()) {
  canonicalTimestamp(createdAt, 'acceptance successor createdAt');
  const predecessor = predecessorStateFromBytes(predecessorBytes);
  if (Date.parse(createdAt) < Date.parse(predecessor.validated.createdAt)) {
    throw new Error('acceptance successor predates its predecessor');
  }
  const carriedIds = predecessor.carried.map((row) => row.id);
  const predecessorStateSha256 = sha256(predecessorBytes);
  const state = {
    schemaVersion: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION,
    createdAt,
    predecessor: {
      schemaVersion: TEN_SCRIPT_SUCCESSOR_PREDECESSOR_SCHEMA,
      stateSchemaVersion: predecessor.raw.schemaVersion,
      acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
      stateSha256: predecessorStateSha256,
      carriedScenarioIds: carriedIds,
    },
    scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map(({ topic, ...definition }) => {
      const previous = predecessor.validated.scenarios.find((row) => row.id === definition.id);
      if (carriedIds.includes(definition.id)) {
        return {
          ...structuredClone(previous),
          requestRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
          carriedForward: true,
        };
      }
      return {
        ...definition,
        topicSha256: sha256(topic),
        status: 'pending',
        jobId: null,
        output: null,
        requestRevision: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION,
        carriedForward: false,
      };
    }),
  };
  return validateAcceptanceStateShape(state);
}

export function validateSuccessorAcceptancePredecessor(state, predecessorBytes) {
  validateAcceptanceStateShape(state);
  if (state.schemaVersion !== TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA) {
    throw new Error('acceptance state is not a successor revision');
  }
  const predecessor = predecessorStateFromBytes(predecessorBytes);
  if (state.predecessor.stateSha256 !== sha256(predecessorBytes)
      || state.predecessor.stateSchemaVersion !== predecessor.raw.schemaVersion) {
    throw new Error('acceptance successor does not match the predecessor bytes');
  }
  for (const id of state.predecessor.carriedScenarioIds) {
    const carried = state.scenarios.find((row) => row.id === id);
    const original = predecessor.validated.scenarios.find((row) => row.id === id);
    const { requestRevision: _requestRevision, carriedForward: _carriedForward, ...rest } = carried;
    if (JSON.stringify(rest) !== JSON.stringify(original)) {
      throw new Error(`acceptance successor changed carried scenario ${id}`);
    }
  }
  const recoveryIds = state.scenarios
    .filter((row) => row.phase === 'pre-release' && !row.carriedForward)
    .map((row) => row.id);
  if (JSON.stringify(recoveryIds) !== JSON.stringify(predecessor.recoverable.map((row) => row.id))) {
    throw new Error('acceptance successor recovery identities differ from predecessor failures');
  }
  return state;
}

function fail(message, code = 1) {
  console.error(`content acceptance refused: ${message}`);
  process.exit(code);
}

function option(name, required = false) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) fail(`${name} requires a value`, 64);
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertPrivateRegularFile(filename, label) {
  const stat = fs.lstatSync(filename);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600
      || (currentUid !== null && stat.uid !== currentUid)) {
    fail(`${label} must be an owner-controlled mode-0600, single-link regular file`, 77);
  }
}

function readPrivateRegularFileBytes(filename, label, maximumBytes, expectedIdentity = null) {
  assertPrivateDirectory(path.dirname(filename), `${label} directory`);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') fail(`${label} requires no-follow file support`, 77);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const currentUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : null;
    if (!stat.isFile() || stat.nlink !== 1n || Number(stat.mode & 0o777n) !== 0o600
        || (currentUid !== null && stat.uid !== currentUid)) {
      fail(`${label} must be an owner-controlled mode-0600, single-link regular file`, 77);
    }
    if (expectedIdentity
        && (stat.dev.toString() !== expectedIdentity.dev
          || stat.ino.toString() !== expectedIdentity.ino)) {
      fail(`${label} identity changed before the locked read`, 75);
    }
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes) {
      fail(`${label} is missing or oversized`, 77);
    }
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read < 1) fail(`${label} could not be read completely`, 77);
      offset += read;
    }
    if (expectedIdentity
        && crypto.createHash('sha256').update(bytes).digest('hex') !== expectedIdentity.sha256) {
      fail(`${label} bytes changed before the locked read`, 75);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPrivateAnonymousFileDescriptor(descriptor, label, maximumBytes) {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  const currentUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : null;
  const mode = Number(stat.mode & 0o777n);
  if (!stat.isFile() || stat.nlink !== 0n || (mode & 0o077) !== 0
      || (currentUid !== null && stat.uid !== currentUid)) {
    fail(`${label} must be a private anonymous regular file`, 77);
  }
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes) {
    fail(`${label} is missing or oversized`, 77);
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read < 1) fail(`${label} could not be read completely`, 77);
    offset += read;
  }
  return bytes;
}

function assertPrivateDirectory(directory, label) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (currentUid !== null && stat.uid !== currentUid)) {
    fail(`${label} must be an owner-controlled private real directory`, 77);
  }
  return stat;
}

function atomicPrivateWrite(filename, value) {
  const directory = path.dirname(filename);
  const directoryIdentity = assertPrivateDirectory(directory, 'acceptance state directory');
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryOnly = fs.constants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directoryOnly !== 'number') {
    fail('acceptance evidence requires no-follow directory support', 77);
  }
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let temporaryDescriptor = null;
  let directoryDescriptor = null;
  let renamed = false;
  try {
    temporaryDescriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.fchmodSync(temporaryDescriptor, 0o600);
    fs.writeFileSync(temporaryDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = null;
    fs.renameSync(temporary, filename);
    renamed = true;
    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | directoryOnly | noFollow,
    );
    const openedDirectory = fs.fstatSync(directoryDescriptor);
    if (!openedDirectory.isDirectory()
        || openedDirectory.dev !== directoryIdentity.dev
        || openedDirectory.ino !== directoryIdentity.ino) {
      fail('acceptance state directory identity changed during persistence', 77);
    }
    fs.fsyncSync(directoryDescriptor);
    assertPrivateRegularFile(filename, 'acceptance state');
  } finally {
    if (temporaryDescriptor !== null) fs.closeSync(temporaryDescriptor);
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
    if (!renamed) {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function linuxProcessOwnsExclusiveStateLock(lockPath) {
  try {
    const lockStat = fs.statSync(lockPath, { bigint: true });
    const major = ((lockStat.dev >> 8n) & 0xfffn)
      | ((lockStat.dev >> 32n) & 0xfffff000n);
    const minor = (lockStat.dev & 0xffn)
      | ((lockStat.dev >> 12n) & 0xffffff00n);
    const ownsDescriptor = fs.readdirSync('/proc/self/fd').some((descriptor) => {
      try {
        const descriptorStat = fs.statSync(`/proc/self/fd/${descriptor}`, { bigint: true });
        return descriptorStat.dev === lockStat.dev && descriptorStat.ino === lockStat.ino;
      } catch {
        return false;
      }
    });
    if (!ownsDescriptor) return false;
    return fs.readFileSync('/proc/locks', 'utf8').split('\n').some((line) => {
      const fields = line.trim().split(/\s+/u);
      const identity = fields[5]?.split(':');
      if (fields.length < 6 || identity?.length !== 3) return false;
      try {
        return fields[1] === 'FLOCK' && fields[3] === 'WRITE'
          && fields[4] === String(process.pid)
          && BigInt(`0x${identity[0]}`) === major
          && BigInt(`0x${identity[1]}`) === minor
          && BigInt(identity[2]) === lockStat.ino;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function runCliUnderStateLock() {
  if (process.platform !== 'linux') return main();
  const stateIndex = process.argv.indexOf('--state');
  const stateValue = stateIndex >= 0 ? process.argv[stateIndex + 1] : undefined;
  if (!stateValue || stateValue.startsWith('--')) fail('--state requires a value', 64);
  const statePath = path.resolve(stateValue);
  assertPrivateDirectory(path.dirname(statePath), 'acceptance state directory');
  const lockPath = `${statePath}.lock`;
  if (fs.existsSync(lockPath)) {
    assertPrivateRegularFile(lockPath, 'acceptance state lock');
    if (linuxProcessOwnsExclusiveStateLock(lockPath)) return main();
  }
  if (['--auth-file-fd', '--workload-release-view-fd', '--predecessor-state-fd']
    .some((argument) => process.argv.includes(argument))) {
    fail('anonymous descriptors require an already-held acceptance state lock', 77);
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') fail('acceptance evidence requires no-follow lock support', 77);
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  assertPrivateRegularFile(lockPath, 'acceptance state lock');
  if (!fs.existsSync('/usr/bin/flock')) fail('production acceptance requires /usr/bin/flock', 69);
  const child = spawnSync('/usr/bin/flock', [
    '-E', '75', '-n', '-x', '-F', lockPath,
    process.execPath, path.resolve(process.argv[1]), ...process.argv.slice(2),
  ], {
    stdio: 'inherit',
    env: process.env,
  });
  if (child.error) fail('acceptance state lock could not be acquired', 69);
  if (child.status === 75) fail('acceptance state is locked by another invocation', 75);
  if (child.signal) fail('locked acceptance invocation was interrupted', 70);
  process.exitCode = child.status ?? 70;
  return undefined;
}

function initialState() {
  return {
    schemaVersion: TEN_SCRIPT_ACCEPTANCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    createdAt: new Date().toISOString(),
    scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map(({ topic, ...scenario }) => ({
      ...scenario,
      topicSha256: sha256(topic),
      status: 'pending',
      jobId: null,
      output: null,
    })),
  };
}

function readState(filename, allowLegacy = false, expectedIdentity = null) {
  let bytes;
  try {
    bytes = readPrivateRegularFileBytes(
      filename,
      'acceptance state',
      MAX_ACCEPTANCE_STATE_BYTES,
      expectedIdentity,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT' || expectedIdentity) throw error;
    const state = initialState();
    atomicPrivateWrite(filename, state);
    return state;
  }
  let state;
  try {
    state = JSON.parse(bytes.toString('utf8'));
    if (allowLegacy && state?.schemaVersion === LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA) {
      // Validate the exact v2 bytes through the stricter v3 row contract, but
      // do not mutate them until a receipt is available to bind atomically.
      migrateLegacyAcceptanceState(state);
      return state;
    }
    return validateAcceptanceStateShape(state);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'acceptance state is invalid', 65);
  }
}

function countWords(value) {
  return String(value ?? '').trim().split(/\s+/u).filter(Boolean).length;
}

async function api(baseUrl, token, method, endpoint, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const safeCode = payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`;
    throw new Error(`${endpoint} returned ${safeCode}`);
  }
  return payload?.data ?? payload;
}

function requestFor(scenario, requestRevision = TEN_SCRIPT_ACCEPTANCE_REVISION) {
  return {
    topic: scenario.topic,
    niche: 'general education',
    format: 'YouTube',
    mode: 'deep',
    deliveryMode: scenario.deliveryMode,
    language: scenario.language,
    renderMode: 'structured',
    scriptStyle: 'detailed',
    maxDurationMinutes: 15,
    targetDurationSeconds: 900,
    forceRefresh: true,
    idempotencyKey: `hybrid-plan-acceptance-${scenario.id}-${requestRevision}`,
  };
}

export function updateAcceptanceScenarioFromView(row, view) {
  if (!view || typeof view !== 'object' || Array.isArray(view)
      || !JOB_STATUSES.has(view.status) || view.status === 'pending'
      || typeof view.stage !== 'string' || view.stage.length < 1 || view.stage.length > 120
      || /[\r\n\u0000]/u.test(view.stage)
      || !Number.isSafeInteger(view.progress) || view.progress < 0 || view.progress > 100) {
    throw new Error('content script job view is invalid');
  }
  canonicalTimestamp(view.updatedAt, 'content script job view updatedAt');
  if (view.errorCode !== undefined && view.errorCode !== null) {
    boundedString(view.errorCode, 'content script job view errorCode', 120);
  }
  if (!Array.isArray(view.warnings) || view.warnings.length > 32
      || view.warnings.some((value) => typeof value !== 'string'
        || value.length < 1 || value.length > 120 || /[\r\n\u0000]/u.test(value))) {
    throw new Error('content script job warnings are invalid');
  }
  if (view.route !== null && view.route !== undefined
      && !['local', 'cloud', 'mixed', 'none'].includes(view.route)) {
    throw new Error('content script job route is invalid');
  }
  if (view.modelDigest !== null && view.modelDigest !== undefined
      && !SHA256.test(view.modelDigest)) {
    throw new Error('content script job model digest is invalid');
  }
  const script = view.result?.script;
  if (view.status === 'completed' && typeof script !== 'string') {
    throw new Error('completed content script job result is invalid');
  }
  const warnings = [...view.warnings];
  const words = countWords(script);
  const sourceConsistent = !warnings.includes('unsupported_source_url');
  row.status = view.status;
  row.stage = view.stage;
  row.progress = view.progress;
  row.updatedAt = view.updatedAt;
  delete row.lastPollError;
  delete row.lastPollErrorAt;
  if (view.errorCode) row.errorCode = view.errorCode;
  else delete row.errorCode;
  if (view.status !== 'completed') {
    row.output = null;
    return;
  }
  row.output = {
    scriptSha256: sha256(String(script ?? '')),
    wordCount: words,
    warnings,
    route: typeof view.route === 'string' ? view.route : null,
    modelDigest: typeof view.modelDigest === 'string' ? view.modelDigest : null,
    sourceConsistent,
    contractPass: typeof script === 'string' && words >= 1900 && words <= 2400
      && warnings.length === 0 && sourceConsistent,
  };
}

export function bindProductionSmokeSource(state, deployedSha, input) {
  validateAcceptanceStateShape(state);
  if (!FULL_SHA.test(deployedSha)) {
    throw new Error('deployed source must be an exact 40-character commit');
  }
  const smoke = state.scenarios.find((row) => row.phase === 'production-smoke');
  if (!smoke) throw new Error('production smoke scenario is missing');
  if (!input || !Buffer.isBuffer(input.releaseViewBytes) || input.releaseViewBytes.length < 1) {
    throw new Error('production smoke requires authoritative workload release-view bytes');
  }
  const release = validateCompletedReleaseView(input.releaseView, deployedSha);
  const boundAt = state.productionSmokeSource?.boundAt ?? input.boundAt ?? new Date().toISOString();
  canonicalTimestamp(boundAt, 'production smoke workload source boundAt');
  if (Date.parse(release.capturedAt) > Date.parse(boundAt)) {
    throw new Error('production smoke workload release view cannot postdate its binding');
  }
  const binding = {
    schemaVersion: TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA,
    sourceSha: deployedSha,
    boundAt,
    releaseViewSha256: sha256(input.releaseViewBytes),
    releaseId: release.releaseId,
    releasePayloadDigest: release.releasePayloadDigest,
    receiptCompletedAt: release.receiptCompletedAt,
    viewCapturedAt: release.capturedAt,
  };
  validateWorkloadSourceBinding(binding);
  if (state.productionSmokeSource !== undefined) {
    if (JSON.stringify(state.productionSmokeSource) !== JSON.stringify(binding)) {
      throw new Error('production smoke source is already bound to different release evidence');
    }
    return false;
  }
  if (smoke.jobId) {
    throw new Error('production smoke job exists without an immutable source binding');
  }
  state.productionSmokeSource = binding;
  return true;
}

function summary(state) {
  const rows = state.scenarios;
  const completed = rows.filter((row) => row.status === 'completed');
  const contractPasses = completed.filter((row) => row.output?.contractPass === true);
  return {
    schemaVersion: state.schemaVersion,
    acceptanceRevision: state.acceptanceRevision,
    inventoryCount: rows.length,
    submitted: rows.filter((row) => row.jobId).length,
    completed: completed.length,
    contractPasses: contractPasses.length,
    terminalFailures: rows.filter((row) => row.status === 'failed' || row.status === 'cancelled').length,
    delivery: Object.fromEntries(['standard', 'scheduled', 'priority'].map((mode) => [mode, rows.filter((row) => row.deliveryMode === mode).length])),
    languages: Object.fromEntries(['en', 'pt-BR'].map((language) => [language, rows.filter((row) => row.language === language).length])),
    productionSmokeCompleted: rows.find((row) => row.phase === 'production-smoke')?.status === 'completed',
    acceptancePass: completed.length === 10 && contractPasses.length === 10,
  };
}

async function main() {
  let operationFailed = false;
  const phase = option('--phase', true);
  if (!['pre-release', 'production-smoke', 'status'].includes(phase)) fail('--phase must be pre-release, production-smoke, or status', 64);
  const statePath = path.resolve(option('--state', true));
  const successorPredecessorPathValue = option('--initialize-successor-from');
  let initializedPredecessorBytes = null;
  if (successorPredecessorPathValue) {
    if (fs.existsSync(statePath)) fail('acceptance successor state already exists', 73);
    const predecessorBytes = readPrivateRegularFileBytes(
      path.resolve(successorPredecessorPathValue),
      'acceptance predecessor state',
      MAX_ACCEPTANCE_STATE_BYTES,
    );
    let successor;
    try {
      successor = createSuccessorAcceptanceState(predecessorBytes);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'acceptance successor initialization failed', 78);
    }
    initializedPredecessorBytes = predecessorBytes;
    atomicPrivateWrite(statePath, successor);
  }
  const expectedStateDev = option('--state-expected-dev');
  const expectedStateIno = option('--state-expected-ino');
  const expectedStateSha256 = option('--state-expected-sha256');
  const expectedIdentityCount = [
    expectedStateDev,
    expectedStateIno,
    expectedStateSha256,
  ].filter(Boolean).length;
  if (![0, 3].includes(expectedIdentityCount)
      || (expectedStateDev && (!/^\d+$/u.test(expectedStateDev)
        || !/^\d+$/u.test(expectedStateIno)
        || !/^[0-9a-f]{64}$/u.test(expectedStateSha256)))) {
    fail('state expected identity must contain device, inode, and SHA-256 values', 64);
  }
  const expectedStateIdentity = expectedStateDev
    ? { dev: expectedStateDev, ino: expectedStateIno, sha256: expectedStateSha256 }
    : null;
  if (phase === 'production-smoke'
      && (!expectedStateIdentity || !import.meta.url.startsWith('data:text/javascript;base64,'))) {
    fail('production smoke requires the receipt-bound launcher and reviewed state identity', 77);
  }
  let state = readState(
    statePath,
    phase === 'status' || phase === 'production-smoke',
    expectedStateIdentity,
  );
  const predecessorStatePathValue = option('--predecessor-state');
  const predecessorStateDescriptorValue = option('--predecessor-state-fd');
  if (state.schemaVersion === TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA) {
    const predecessorSourceCount = [
      initializedPredecessorBytes,
      predecessorStatePathValue,
      predecessorStateDescriptorValue,
    ].filter(Boolean).length;
    if (predecessorSourceCount !== 1) {
      fail('successor acceptance requires exactly one predecessor-state source', 64);
    }
    if (phase === 'production-smoke' && !predecessorStateDescriptorValue) {
      fail('production smoke requires an anonymous predecessor-state descriptor', 77);
    }
    let predecessorBytes = initializedPredecessorBytes;
    if (predecessorStateDescriptorValue) {
      const descriptor = Number(predecessorStateDescriptorValue);
      if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
        fail('predecessor-state descriptor is invalid', 64);
      }
      predecessorBytes = readPrivateAnonymousFileDescriptor(
        descriptor,
        'acceptance predecessor state',
        MAX_ACCEPTANCE_STATE_BYTES,
      );
    } else if (predecessorStatePathValue) {
      predecessorBytes = readPrivateRegularFileBytes(
        path.resolve(predecessorStatePathValue),
        'acceptance predecessor state',
        MAX_ACCEPTANCE_STATE_BYTES,
      );
    }
    try {
      validateSuccessorAcceptancePredecessor(state, predecessorBytes);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'acceptance predecessor proof failed', 78);
    }
  } else if (predecessorStatePathValue || predecessorStateDescriptorValue) {
    fail('predecessor-state is valid only for a successor acceptance revision', 64);
  }

  if (phase !== 'status') {
    const authPathValue = option('--auth-file');
    const authDescriptorValue = option('--auth-file-fd');
    if (Boolean(authPathValue) === Boolean(authDescriptorValue)) {
      fail('exactly one auth-file source is required', 64);
    }
    if (phase === 'production-smoke' && !authDescriptorValue) {
      fail('production smoke requires an anonymous auth-file descriptor', 77);
    }
    let authBytes;
    if (authDescriptorValue) {
      const descriptor = Number(authDescriptorValue);
      if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
        fail('auth-file descriptor is invalid', 64);
      }
      authBytes = readPrivateAnonymousFileDescriptor(
        descriptor,
        'auth file',
        MAX_AUTH_FILE_BYTES,
      );
    } else {
      authBytes = readPrivateRegularFileBytes(
        path.resolve(authPathValue),
        'auth file',
        MAX_AUTH_FILE_BYTES,
      );
    }
    const token = authBytes.toString('utf8').trim();
    if (!token || /\s/u.test(token)) fail('auth file must contain exactly one bearer token', 65);
    const baseUrl = option('--base-url', true);
    if (!/^https:\/\//u.test(baseUrl) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/u.test(baseUrl)) {
      fail('--base-url must be HTTPS or loopback HTTP', 64);
    }
    if (phase === 'production-smoke') {
      if (baseUrl !== PRODUCTION_API_ORIGIN) {
        fail('production smoke requires the canonical production API origin', 77);
      }
      const preRelease = state.scenarios.filter((row) => row.phase === 'pre-release');
      if (preRelease.some((row) => row.status !== 'completed' || row.output?.contractPass !== true)) {
        fail('production smoke is locked until all nine pre-release scripts pass', 78);
      }
      const deployedSha = option('--deployed-sha', true);
      if (!FULL_SHA.test(deployedSha)) fail('--deployed-sha must be an exact 40-character source commit', 64);
      if (deployedSha !== EXPECTED_PRODUCTION_SOURCE_SHA) {
        fail('production smoke source is not the reviewed Release A identity', 78);
      }
      const workloadReleaseViewPathValue = option('--workload-release-view');
      const workloadReleaseViewDescriptorValue = option('--workload-release-view-fd');
      if (Boolean(workloadReleaseViewPathValue) === Boolean(workloadReleaseViewDescriptorValue)) {
        fail('exactly one workload release-view source is required', 64);
      }
      if (!workloadReleaseViewDescriptorValue) {
        fail('production smoke requires an anonymous workload release-view descriptor', 77);
      }
      let workloadReleaseViewBytes;
      if (workloadReleaseViewDescriptorValue) {
        const descriptor = Number(workloadReleaseViewDescriptorValue);
        if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
          fail('workload release-view descriptor is invalid', 64);
        }
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 0 || (stat.mode & 0o077) !== 0
            || stat.uid !== process.geteuid() || stat.size < 1
            || stat.size > MAX_RELEASE_VIEW_BYTES) {
          fail('workload release-view descriptor is not a bounded private anonymous file', 77);
        }
        workloadReleaseViewBytes = Buffer.allocUnsafe(stat.size);
        let offset = 0;
        while (offset < workloadReleaseViewBytes.length) {
          const read = fs.readSync(
            descriptor,
            workloadReleaseViewBytes,
            offset,
            workloadReleaseViewBytes.length - offset,
            offset,
          );
          if (read < 1) fail('workload release-view descriptor could not be read completely', 78);
          offset += read;
        }
      } else {
        const workloadReleaseViewPath = path.resolve(workloadReleaseViewPathValue);
        assertPrivateRegularFile(workloadReleaseViewPath, 'workload release view');
        workloadReleaseViewBytes = fs.readFileSync(workloadReleaseViewPath);
      }
      let workloadReleaseView;
      try {
        workloadReleaseView = JSON.parse(workloadReleaseViewBytes.toString('utf8'));
      } catch {
        fail('workload release view is not valid JSON', 65);
      }
      try {
        const authoritative = captureAuthoritativeReleaseView(deployedSha);
        validateAuthoritativeWorkloadReleaseView(
          workloadReleaseViewBytes,
          authoritative.view,
          deployedSha,
        );
        if (state.schemaVersion === LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA) {
          state = migrateLegacyAcceptanceState(state);
        }
        if (bindProductionSmokeSource(state, deployedSha, {
          releaseView: workloadReleaseView,
          releaseViewBytes: workloadReleaseViewBytes,
        })) {
          // Persist the workload identity before the first API call. A crash
          // can therefore never leave a durable tenth job with an unbound or
          // later-rewritable source commit.
          validateAcceptanceStateShape(state);
          atomicPrivateWrite(statePath, state);
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : 'production smoke source binding failed', 78);
      }
    }
    const targets = TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((scenario) => scenario.phase === phase);
    for (const scenario of targets) {
      const row = state.scenarios.find((candidate) => candidate.id === scenario.id);
      if (row.carriedForward === true) continue;
      try {
        if (!row.jobId) {
          const submittedAt = new Date().toISOString();
          const created = await api(
            baseUrl,
            token,
            'POST',
            '/api/v1/content/script-jobs',
            requestFor(scenario, row.requestRevision ?? state.acceptanceRevision),
          );
          row.jobId = created.jobId;
          row.status = created.status;
          row.submittedAt = submittedAt;
          validateAcceptanceStateShape(state);
          atomicPrivateWrite(statePath, state);
        }
        // A failed or cancelled durable job may have been retried through the
        // authenticated retry endpoint between acceptance passes. Always read
        // the server-owned view so the private evidence state can resume that
        // same immutable job identity instead of remaining terminal forever.
        const view = await api(baseUrl, token, 'GET', `/api/v1/content/script-jobs/${encodeURIComponent(row.jobId)}`);
        updateAcceptanceScenarioFromView(row, view);
        validateAcceptanceStateShape(state);
        atomicPrivateWrite(statePath, state);
        if (row.status === 'failed' || row.status === 'cancelled'
            || (row.status === 'completed' && row.output?.contractPass !== true)) {
          operationFailed = true;
        }
      } catch (error) {
        operationFailed = true;
        row.lastPollError = error instanceof Error ? error.message.slice(0, 240) : 'unknown_error';
        row.lastPollErrorAt = new Date().toISOString();
        validateAcceptanceStateShape(state);
        atomicPrivateWrite(statePath, state);
      }
    }
  }

  console.log(JSON.stringify(summary(state), null, 2));
  if (operationFailed) process.exitCode = 70;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runCliUnderStateLock();
}
