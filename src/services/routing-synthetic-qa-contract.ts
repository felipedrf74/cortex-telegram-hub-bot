// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Staging-only contract for owner-authorized synthetic routing QA turns.
 *
 * This is deliberately separate from the paid chat-live-eval contract. A
 * valid request records the ordinary routing shadow bundle and then terminates
 * before every provider, tool, external integration, and domain mutation
 * owner. Any partial or malformed contract fails closed.
 */

import {
  isChatCoreV2ShadowPlannerEnabled,
  isChatCoreV2ShadowRouteHookEnabled,
} from './runtime-flags';

export const ROUTING_SYNTHETIC_QA_CONTRACT_VERSION = 'routing-synthetic-qa-v1';
export const ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS = 'owner_authorized_synthetic_staging_qa';
export const ROUTING_SYNTHETIC_QA_PLANNED_TURNS = 200;

export const ROUTING_SYNTHETIC_QA_SURFACES = Object.freeze([
  'classifierKeyword',
  'orchestratorPrimary',
  'shadowRoute',
  'registrySubset',
] as const);

export type RoutingSyntheticQaSurface = typeof ROUTING_SYNTHETIC_QA_SURFACES[number];
export const ROUTING_SYNTHETIC_QA_LOCALES = Object.freeze([
  'en-US',
  'pt-BR',
  'pt-PT',
] as const);
export type RoutingSyntheticQaLocale = typeof ROUTING_SYNTHETIC_QA_LOCALES[number];

export const ROUTING_SYNTHETIC_QA_HEADERS = Object.freeze({
  contract: 'x-nexus-routing-synthetic-qa-contract',
  manifestSha256: 'x-nexus-routing-synthetic-qa-manifest-sha256',
  surface: 'x-nexus-routing-synthetic-qa-surface',
  ordinal: 'x-nexus-routing-synthetic-qa-ordinal',
  plannedTurns: 'x-nexus-routing-synthetic-qa-planned-turns',
  turnId: 'x-nexus-routing-synthetic-qa-turn-id',
} as const);

export const ROUTING_SYNTHETIC_QA_HEADER_NAMES = Object.freeze(
  Object.values(ROUTING_SYNTHETIC_QA_HEADERS),
);

export interface RoutingSyntheticQaTrafficProvenance {
  contractVersion: typeof ROUTING_SYNTHETIC_QA_CONTRACT_VERSION;
  trafficClass: typeof ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS;
  manifestSha256: string;
  surface: RoutingSyntheticQaSurface;
  ordinal: number;
  plannedTurns: typeof ROUTING_SYNTHETIC_QA_PLANNED_TURNS;
  turnId: string;
  locale: RoutingSyntheticQaLocale;
}

type HeaderValue = string | string[] | undefined;
export type RoutingSyntheticQaHeaderReader = (name: string) => HeaderValue;
type RoutingSyntheticQaRuntimeScope = { userId?: number; tenantId?: number };
export interface RoutingSyntheticQaRuntimeFlagReaders {
  shadowRouteHookEnabled: (env: NodeJS.ProcessEnv, scope: RoutingSyntheticQaRuntimeScope) => boolean;
  shadowPlannerEnabled: (env: NodeJS.ProcessEnv, scope: RoutingSyntheticQaRuntimeScope) => boolean;
}

export class RoutingSyntheticQaContractError extends Error {
  constructor(
    readonly code: 'ROUTING_SYNTHETIC_QA_INVALID' | 'ROUTING_SYNTHETIC_QA_DISABLED',
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
    this.name = 'RoutingSyntheticQaContractError';
  }
}

function failInvalid(message: string): never {
  throw new RoutingSyntheticQaContractError('ROUTING_SYNTHETIC_QA_INVALID', message, 400);
}

function failDisabled(message: string): never {
  throw new RoutingSyntheticQaContractError('ROUTING_SYNTHETIC_QA_DISABLED', message, 403);
}

function rawHeader(readHeader: RoutingSyntheticQaHeaderReader, name: string): HeaderValue {
  try {
    return readHeader(name);
  } catch {
    failInvalid('Routing synthetic QA contract headers could not be read.');
  }
}

function requiredHeader(readHeader: RoutingSyntheticQaHeaderReader, name: string): string {
  const raw = rawHeader(readHeader, name);
  if (Array.isArray(raw)) {
    failInvalid('Routing synthetic QA contract headers must be single-valued.');
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    failInvalid('Routing synthetic QA contract headers must be complete.');
  }
  if (raw !== raw.trim()) {
    failInvalid('Routing synthetic QA contract headers must use canonical values.');
  }
  return raw;
}

export function hasRoutingSyntheticQaHeaders(readHeader: RoutingSyntheticQaHeaderReader): boolean {
  return ROUTING_SYNTHETIC_QA_HEADER_NAMES.some((name) => rawHeader(readHeader, name) !== undefined);
}

function isStagingRuntime(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
  const staging = String(env.STAGING ?? '').trim().toLowerCase();
  return env.NEXUS_RELEASE_ROLE === 'staging'
    && (nodeEnv === 'staging' || staging === 'true' || staging === '1');
}

function parseCanonicalPositiveInteger(raw: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) failInvalid(`Routing synthetic QA ${label} is invalid.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== raw) {
    failInvalid(`Routing synthetic QA ${label} is invalid.`);
  }
  return parsed;
}

function canonicalTurnId(
  manifestSha256: string,
  surface: RoutingSyntheticQaSurface,
  ordinal: number,
): string {
  const manifestHex = manifestSha256.slice('sha256:'.length);
  return `${ROUTING_SYNTHETIC_QA_CONTRACT_VERSION}:${manifestHex}:${surface}:${String(ordinal).padStart(3, '0')}`;
}

const ROUTING_SYNTHETIC_QA_PROVENANCE_KEYS = new Set([
  'contractVersion',
  'trafficClass',
  'manifestSha256',
  'surface',
  'ordinal',
  'plannedTurns',
  'turnId',
  'locale',
]);

/**
 * Strictly canonicalize the persisted provenance block. `null` represents
 * ordinary traffic; every non-null value must have exactly the v1 eight-key
 * shape and a turn id derived from the remaining fields.
 */
export function normalizeRoutingSyntheticQaTrafficProvenance(
  value: unknown,
): RoutingSyntheticQaTrafficProvenance | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failInvalid('Routing synthetic QA traffic provenance is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== ROUTING_SYNTHETIC_QA_PROVENANCE_KEYS.size
    || !keys.every((key) => ROUTING_SYNTHETIC_QA_PROVENANCE_KEYS.has(key))
  ) {
    failInvalid('Routing synthetic QA traffic provenance is invalid.');
  }
  if (
    record.contractVersion !== ROUTING_SYNTHETIC_QA_CONTRACT_VERSION
    || record.trafficClass !== ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS
    || typeof record.manifestSha256 !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(record.manifestSha256)
    || !ROUTING_SYNTHETIC_QA_SURFACES.includes(record.surface as RoutingSyntheticQaSurface)
    || !Number.isSafeInteger(record.ordinal)
    || (record.ordinal as number) < 1
    || (record.ordinal as number) > ROUTING_SYNTHETIC_QA_PLANNED_TURNS
    || record.plannedTurns !== ROUTING_SYNTHETIC_QA_PLANNED_TURNS
    || !ROUTING_SYNTHETIC_QA_LOCALES.includes(record.locale as RoutingSyntheticQaLocale)
  ) {
    failInvalid('Routing synthetic QA traffic provenance is invalid.');
  }
  const surface = record.surface as RoutingSyntheticQaSurface;
  const ordinal = record.ordinal as number;
  if (record.turnId !== canonicalTurnId(record.manifestSha256, surface, ordinal)) {
    failInvalid('Routing synthetic QA traffic provenance is invalid.');
  }
  return Object.freeze({
    contractVersion: ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
    trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
    manifestSha256: record.manifestSha256,
    surface,
    ordinal,
    plannedTurns: ROUTING_SYNTHETIC_QA_PLANNED_TURNS,
    turnId: record.turnId as string,
    locale: record.locale as RoutingSyntheticQaLocale,
  });
}

export function resolveRoutingSyntheticQaRequest(input: {
  readHeader: RoutingSyntheticQaHeaderReader;
  userId: number;
  tenantId: number;
  principalEmail: string | null;
  clientMessageId: string | null;
  requestLocale: unknown;
  attachmentsCount: number;
  rawAttachments: unknown;
  env?: NodeJS.ProcessEnv;
  /** Test seam only; live callers omit this and use the boot-guarded readers. */
  runtimeFlagReaders?: RoutingSyntheticQaRuntimeFlagReaders;
}): RoutingSyntheticQaTrafficProvenance | null {
  if (!hasRoutingSyntheticQaHeaders(input.readHeader)) return null;

  const values = {
    contract: requiredHeader(input.readHeader, ROUTING_SYNTHETIC_QA_HEADERS.contract),
    manifestSha256: requiredHeader(input.readHeader, ROUTING_SYNTHETIC_QA_HEADERS.manifestSha256),
    surface: requiredHeader(input.readHeader, ROUTING_SYNTHETIC_QA_HEADERS.surface),
    ordinal: requiredHeader(input.readHeader, ROUTING_SYNTHETIC_QA_HEADERS.ordinal),
    plannedTurns: requiredHeader(input.readHeader, ROUTING_SYNTHETIC_QA_HEADERS.plannedTurns),
    turnId: requiredHeader(input.readHeader, ROUTING_SYNTHETIC_QA_HEADERS.turnId),
  };
  const env = input.env ?? process.env;

  if (!isStagingRuntime(env)) {
    failDisabled('Routing synthetic QA is restricted to an exact staging release.');
  }
  if (values.contract !== ROUTING_SYNTHETIC_QA_CONTRACT_VERSION) {
    failInvalid('Routing synthetic QA contract version is invalid.');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(values.manifestSha256)) {
    failInvalid('Routing synthetic QA manifest SHA256 is invalid.');
  }
  if (!ROUTING_SYNTHETIC_QA_SURFACES.includes(values.surface as RoutingSyntheticQaSurface)) {
    failInvalid('Routing synthetic QA surface is invalid.');
  }
  const surface = values.surface as RoutingSyntheticQaSurface;
  const ordinal = parseCanonicalPositiveInteger(values.ordinal, 'ordinal');
  if (ordinal > ROUTING_SYNTHETIC_QA_PLANNED_TURNS) {
    failInvalid('Routing synthetic QA ordinal is invalid.');
  }
  if (values.plannedTurns !== String(ROUTING_SYNTHETIC_QA_PLANNED_TURNS)) {
    failInvalid('Routing synthetic QA planned turns must equal 200.');
  }
  const expectedTurnId = canonicalTurnId(values.manifestSha256, surface, ordinal);
  if (values.turnId !== expectedTurnId) {
    failInvalid('Routing synthetic QA turn id is invalid.');
  }
  if (input.clientMessageId !== values.turnId) {
    failInvalid('Routing synthetic QA client message id must equal the canonical turn id.');
  }
  if (
    typeof input.requestLocale !== 'string'
    || !ROUTING_SYNTHETIC_QA_LOCALES.includes(input.requestLocale as RoutingSyntheticQaLocale)
  ) {
    failInvalid('Routing synthetic QA locale must be exactly en-US, pt-BR, or pt-PT.');
  }
  if (!Number.isSafeInteger(input.attachmentsCount) || input.attachmentsCount !== 0) {
    failInvalid('Routing synthetic QA does not allow attachments.');
  }
  if (
    input.rawAttachments !== undefined
    && (!Array.isArray(input.rawAttachments) || input.rawAttachments.length !== 0)
  ) {
    failInvalid('Routing synthetic QA raw attachments must be absent or an empty array.');
  }

  const dedicatedId = Number(String(env.CHAT_EVAL_DEDICATED_TENANT_ID ?? '').trim());
  if (
    !Number.isSafeInteger(dedicatedId)
    || dedicatedId <= 0
    || input.userId !== dedicatedId
    || input.tenantId !== dedicatedId
  ) {
    failDisabled('Routing synthetic QA requires the configured dedicated evaluation identity.');
  }
  if (!input.principalEmail?.trim().toLowerCase().endsWith('.invalid')) {
    failDisabled('Routing synthetic QA requires a synthetic .invalid principal.');
  }

  const userScope = { userId: dedicatedId };
  const tenantScope = { tenantId: dedicatedId };
  const shadowRouteHookEnabled = input.runtimeFlagReaders?.shadowRouteHookEnabled
    ?? isChatCoreV2ShadowRouteHookEnabled;
  const shadowPlannerEnabled = input.runtimeFlagReaders?.shadowPlannerEnabled
    ?? isChatCoreV2ShadowPlannerEnabled;
  if (
    !shadowRouteHookEnabled(env, userScope)
    || !shadowRouteHookEnabled(env, tenantScope)
  ) {
    failDisabled('Routing synthetic QA requires the effective dedicated shadow route recorder.');
  }
  if (
    shadowPlannerEnabled(env, userScope)
    || shadowPlannerEnabled(env, tenantScope)
  ) {
    failDisabled('Routing synthetic QA requires the dedicated shadow planner to remain disabled.');
  }

  return normalizeRoutingSyntheticQaTrafficProvenance({
    contractVersion: ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
    trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
    manifestSha256: values.manifestSha256,
    surface,
    ordinal,
    plannedTurns: ROUTING_SYNTHETIC_QA_PLANNED_TURNS,
    turnId: values.turnId,
    locale: input.requestLocale,
  });
}
