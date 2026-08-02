// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import {
  ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
  ROUTING_SYNTHETIC_QA_HEADER_NAMES,
  hasRoutingSyntheticQaHeaders,
  resolveRoutingSyntheticQaRequest,
} from '../../src/services/routing-synthetic-qa-contract';

const DEDICATED_ID = 1_000_050;
const MANIFEST_HEX = 'a'.repeat(64);
const MANIFEST_SHA256 = `sha256:${MANIFEST_HEX}`;
const SURFACE = 'classifierKeyword';
const TURN_ID = `${ROUTING_SYNTHETIC_QA_CONTRACT_VERSION}:${MANIFEST_HEX}:${SURFACE}:001`;

const VALID_HEADERS: Record<string, string> = {
  'x-nexus-routing-synthetic-qa-contract': ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
  'x-nexus-routing-synthetic-qa-manifest-sha256': MANIFEST_SHA256,
  'x-nexus-routing-synthetic-qa-surface': SURFACE,
  'x-nexus-routing-synthetic-qa-ordinal': '1',
  'x-nexus-routing-synthetic-qa-planned-turns': '200',
  'x-nexus-routing-synthetic-qa-turn-id': TURN_ID,
};

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'staging',
  STAGING: 'true',
  NEXUS_RELEASE_ROLE: 'staging',
  CHAT_EVAL_DEDICATED_TENANT_ID: String(DEDICATED_ID),
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_1000050: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_TENANT_1000050: 'true',
  CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_1000050: 'false',
  CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_1000050: 'false',
};

function resolve(input: {
  headers?: Record<string, string | undefined>;
  env?: NodeJS.ProcessEnv;
  userId?: number;
  tenantId?: number;
  principalEmail?: string | null;
  clientMessageId?: string | null;
  requestLocale?: string | null;
  attachmentsCount?: number;
  rawAttachments?: unknown;
} = {}) {
  const headers = input.headers ?? VALID_HEADERS;
  return resolveRoutingSyntheticQaRequest({
    readHeader: (name) => headers[name],
    userId: input.userId ?? DEDICATED_ID,
    tenantId: input.tenantId ?? DEDICATED_ID,
    principalEmail: input.principalEmail === undefined ? 'phase7-routing-qa@example.invalid' : input.principalEmail,
    clientMessageId: input.clientMessageId === undefined ? TURN_ID : input.clientMessageId,
    requestLocale: input.requestLocale === undefined ? 'en-US' : input.requestLocale,
    attachmentsCount: input.attachmentsCount ?? 0,
    rawAttachments: input.rawAttachments,
    env: input.env ?? VALID_ENV,
    runtimeFlagReaders: {
      shadowRouteHookEnabled: (env, scope) => (
        scope.userId != null
          ? env.CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_1000050 === 'true'
          : env.CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_TENANT_1000050 === 'true'
      ),
      shadowPlannerEnabled: (env, scope) => (
        scope.userId != null
          ? env.CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_1000050 === 'true'
          : env.CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_1000050 === 'true'
      ),
    },
  });
}

describe('routing synthetic QA request contract', () => {
  it('leaves ordinary traffic untouched only when every contract header is absent', () => {
    const empty = {} as Record<string, string | undefined>;
    expect(hasRoutingSyntheticQaHeaders((name) => empty[name])).toBe(false);
    expect(resolve({ headers: empty })).toBeNull();
  });

  it('returns the exact strict traffic provenance for a valid dedicated staging turn', () => {
    expect(hasRoutingSyntheticQaHeaders((name) => VALID_HEADERS[name])).toBe(true);
    expect(resolve()).toEqual({
      contractVersion: 'routing-synthetic-qa-v1',
      trafficClass: 'owner_authorized_synthetic_staging_qa',
      manifestSha256: MANIFEST_SHA256,
      surface: SURFACE,
      ordinal: 1,
      plannedTurns: 200,
      turnId: TURN_ID,
      locale: 'en-US',
    });
  });

  it('fails closed for every partial header set', () => {
    expect(ROUTING_SYNTHETIC_QA_HEADER_NAMES).toHaveLength(6);
    for (const missing of ROUTING_SYNTHETIC_QA_HEADER_NAMES) {
      const headers = { ...VALID_HEADERS, [missing]: undefined };
      expect(() => resolve({ headers })).toThrow(/contract headers/i);
    }
  });

  it('rejects production, default, wrong identity, non-synthetic principals, and unsafe recorder state', () => {
    expect(() => resolve({ env: { ...VALID_ENV, NODE_ENV: 'production', STAGING: 'false', NEXUS_RELEASE_ROLE: 'production' } }))
      .toThrow(/staging/i);
    expect(() => resolve({ env: { ...VALID_ENV, NODE_ENV: undefined, STAGING: undefined, NEXUS_RELEASE_ROLE: undefined } }))
      .toThrow(/staging/i);
    expect(() => resolve({ userId: DEDICATED_ID + 1 })).toThrow(/dedicated/i);
    expect(() => resolve({ tenantId: DEDICATED_ID + 1 })).toThrow(/dedicated/i);
    expect(() => resolve({ principalEmail: 'real-user@example.com' })).toThrow(/synthetic/i);
    expect(() => resolve({ env: { ...VALID_ENV, CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_1000050: 'false' } }))
      .toThrow(/recorder/i);
    expect(() => resolve({ env: { ...VALID_ENV, CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_1000050: 'true' } }))
      .toThrow(/planner/i);
  });

  it('requires the external manifest hash, fixed surface/size, canonical ordinal, and exact turn/client binding', () => {
    const invalid = (name: string, value: string, clientMessageId: string | null = TURN_ID) =>
      resolve({ headers: { ...VALID_HEADERS, [name]: value }, clientMessageId });

    expect(() => invalid('x-nexus-routing-synthetic-qa-manifest-sha256', MANIFEST_HEX)).toThrow(/manifest/i);
    expect(() => invalid('x-nexus-routing-synthetic-qa-surface', 'classifier')).toThrow(/surface/i);
    expect(() => invalid('x-nexus-routing-synthetic-qa-ordinal', '0')).toThrow(/ordinal/i);
    expect(() => invalid('x-nexus-routing-synthetic-qa-ordinal', '201')).toThrow(/ordinal/i);
    expect(() => invalid('x-nexus-routing-synthetic-qa-ordinal', '001')).toThrow(/ordinal/i);
    expect(() => invalid('x-nexus-routing-synthetic-qa-planned-turns', '199')).toThrow(/planned/i);
    expect(() => invalid('x-nexus-routing-synthetic-qa-turn-id', `${TURN_ID}-forged`)).toThrow(/turn id/i);
    expect(() => resolve({ clientMessageId: `${TURN_ID}-different` })).toThrow(/client message/i);
    expect(() => resolve({ clientMessageId: null })).toThrow(/client message/i);
  });

  it('requires one exact governed locale and refuses every attachment', () => {
    expect(() => resolve({ requestLocale: null })).toThrow(/locale/i);
    expect(() => resolve({ requestLocale: 'en' })).toThrow(/locale/i);
    expect(() => resolve({ requestLocale: 'es-419' })).toThrow(/locale/i);
    expect(() => resolve({ requestLocale: ' en-US ' })).toThrow(/locale/i);
    expect(() => resolve({ attachmentsCount: 1 })).toThrow(/attachment/i);
    expect(() => resolve({ attachmentsCount: -1 })).toThrow(/attachment/i);
    expect(() => resolve({ rawAttachments: null })).toThrow(/attachment/i);
    expect(() => resolve({ rawAttachments: {} })).toThrow(/attachment/i);
    expect(() => resolve({ rawAttachments: [{ id: 'smuggled' }] })).toThrow(/attachment/i);
    expect(resolve({ rawAttachments: [] })).toMatchObject({ locale: 'en-US' });
    expect(resolve({ requestLocale: 'pt-BR' })).toMatchObject({ locale: 'pt-BR' });
    expect(resolve({ requestLocale: 'pt-PT' })).toMatchObject({ locale: 'pt-PT' });
  });
});
