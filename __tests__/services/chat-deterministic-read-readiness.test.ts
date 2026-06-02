// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  evaluateChatDeterministicReadReadiness,
  type ChatDeterministicReadGateId,
  type ChatDeterministicReadSample,
  type ChatTokenZeroSurfaceSample,
} from '../../src/services/chat-deterministic-read-readiness';

describe('evaluateChatDeterministicReadReadiness', () => {
  it('passes when deterministic read Phase 4 gates are satisfied', () => {
    const result = evaluateChatDeterministicReadReadiness({
      readSamples: readSamples(12),
      tokenZeroSamples: tokenZeroSamples(),
    });

    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['deterministic_read_response_contracts', true],
      ['deterministic_read_tenant_user_isolation', true],
      ['explicit_token_zero_surfaces_preserved', true],
    ]);
  });

  it('fails closed when deterministic read samples are missing', () => {
    const result = evaluateChatDeterministicReadReadiness({
      readSamples: [],
      tokenZeroSamples: tokenZeroSamples(),
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'deterministic_read_response_contracts')).toMatchObject({
      passed: false,
      reasonCode: 'missing_deterministic_read_samples',
    });
    expect(gate(result, 'deterministic_read_tenant_user_isolation')).toMatchObject({
      passed: false,
      reasonCode: 'missing_tenant_user_isolation_samples',
    });
  });

  it('fails when any deterministic read response lacks the response contract', () => {
    const samples = readSamples(4);
    samples[1] = { ...samples[1], responseContractValid: false };

    const result = evaluateChatDeterministicReadReadiness({
      readSamples: samples,
      tokenZeroSamples: tokenZeroSamples(),
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'deterministic_read_response_contracts')).toMatchObject({
      passed: false,
      observed: 0.75,
      threshold: 1,
    });
  });

  it('fails when tenant/user isolation has a violation', () => {
    const samples = readSamples(4);
    samples[2] = { ...samples[2], tenantUserIsolationPassed: false };

    const result = evaluateChatDeterministicReadReadiness({
      readSamples: samples,
      tokenZeroSamples: tokenZeroSamples(),
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'deterministic_read_tenant_user_isolation')).toMatchObject({
      passed: false,
      observed: 1,
      threshold: 0,
    });
  });

  it('fails when an explicit token-zero surface is missing or broken', () => {
    const result = evaluateChatDeterministicReadReadiness({
      readSamples: readSamples(4),
      tokenZeroSamples: [
        { sampleId: 'slash-1', surface: 'slash', preserved: true },
        { sampleId: 'button-1', surface: 'button', preserved: false },
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'explicit_token_zero_surfaces_preserved')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_token_zero_surface_samples',
    });
    expect(result.tokenZeroResults).toEqual([
      { surface: 'slash', preserved: 1, total: 1, passed: true },
      { surface: 'button', preserved: 0, total: 1, passed: false },
      { surface: 'api', preserved: 0, total: 0, passed: false },
    ]);
  });

  it('can scope the required token-zero surfaces for focused local validation', () => {
    const result = evaluateChatDeterministicReadReadiness({
      readSamples: readSamples(4),
      tokenZeroSamples: [
        { sampleId: 'slash-1', surface: 'slash', preserved: true },
      ],
      thresholds: {
        requiredTokenZeroSurfaces: ['slash'],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.tokenZeroResults).toEqual([
      { surface: 'slash', preserved: 1, total: 1, passed: true },
    ]);
  });
});

function readSamples(total: number): ChatDeterministicReadSample[] {
  return Array.from({ length: total }, (_, index) => ({
    sampleId: `read-${index}`,
    responseContractValid: true,
    tenantUserIsolationPassed: true,
  }));
}

function tokenZeroSamples(): ChatTokenZeroSurfaceSample[] {
  return [
    { sampleId: 'slash-1', surface: 'slash', preserved: true },
    { sampleId: 'button-1', surface: 'button', preserved: true },
    { sampleId: 'api-1', surface: 'api', preserved: true },
  ];
}

function gate(
  result: ReturnType<typeof evaluateChatDeterministicReadReadiness>,
  gateId: ChatDeterministicReadGateId,
) {
  const found = result.gates.find((item) => item.gateId === gateId);
  expect(found).toBeDefined();
  return found!;
}
