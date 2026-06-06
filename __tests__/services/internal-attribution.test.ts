// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInternalAttributionToken,
  verifyInternalAttributionToken,
} from '../../src/services/internal-attribution';

describe('internal attribution tokens', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips scoped user, tenant, and category claims', () => {
    vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'test-secret');
    const token = createInternalAttributionToken({
      userId: 42,
      tenantId: 77,
      category: 'content_engine_script_draft',
      nowMs: Date.parse('2026-05-18T12:00:00Z'),
    });

    const claims = verifyInternalAttributionToken(
      token,
      'content_engine_script_draft',
      Date.parse('2026-05-18T12:01:00Z'),
    );

    expect(claims).toMatchObject({
      userId: 42,
      tenantId: 77,
      category: 'content_engine_script_draft',
    });
  });

  it('rejects tampered signatures, expired tokens, and wrong categories', () => {
    vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'test-secret');
    const token = createInternalAttributionToken({
      userId: 42,
      tenantId: 77,
      category: 'content_engine_script_draft',
      ttlSeconds: 30,
      nowMs: Date.parse('2026-05-18T12:00:00Z'),
    });
    expect(token).toBeTruthy();

    const tampered = `${token!.split('.')[0]}.bad-signature`;
    expect(verifyInternalAttributionToken(tampered, 'content_engine_script_draft')).toBeNull();
    expect(verifyInternalAttributionToken(
      token,
      'content_engine_script_deep',
      Date.parse('2026-05-18T12:00:10Z'),
    )).toBeNull();
    expect(verifyInternalAttributionToken(
      token,
      'content_engine_script_draft',
      Date.parse('2026-05-18T12:01:00Z'),
    )).toBeNull();
  });

  it('allows the direct json-repair child category without opening sibling categories', () => {
    vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'test-secret');
    const token = createInternalAttributionToken({
      userId: 42,
      tenantId: 77,
      category: 'content_engine_report',
      nowMs: Date.parse('2026-05-18T12:00:00Z'),
    });

    expect(verifyInternalAttributionToken(
      token,
      'content_engine_report_json_repair',
      Date.parse('2026-05-18T12:00:10Z'),
    )).toMatchObject({ userId: 42, tenantId: 77, category: 'content_engine_report' });
    expect(verifyInternalAttributionToken(
      token,
      'content_engine_feedback_json_repair',
      Date.parse('2026-05-18T12:00:10Z'),
    )).toBeNull();
  });

  it('fails closed when identity or signing secret is missing', () => {
    expect(createInternalAttributionToken({
      userId: 0,
      tenantId: 77,
      category: 'content_engine_script_draft',
    })).toBeNull();
    expect(createInternalAttributionToken({
      userId: 42,
      tenantId: 77,
      category: 'content_engine_script_draft',
    })).toBeNull();
  });
});
