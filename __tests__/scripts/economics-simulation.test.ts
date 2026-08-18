// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildProfiles,
  computeEconomics,
  validateRateCard,
} from '../../scripts/economics-simulation.mjs';

function healthyRateCard() {
  return {
    version: 'test-1',
    capturedAt: '2026-08-18',
    providerRatesUsdPerMTok: {
      standardOp: { input: 0.10, output: 0.40 },
      deepOp: { input: 0.25, output: 1.00 },
      standardScript: { input: 0.50, output: 2.00 },
      scheduledScript: { input: 0.25, output: 1.00 },
      priorityScript: { input: 0.50, output: 2.00 },
    },
    p95Tokens: {
      standardOp: { input: 2000, output: 600 },
      deepOp: { input: 6000, output: 2500 },
      script: { input: 9000, output: 4200 },
    },
    searchToolUsdPerOp: 0.0002,
    stripeFeePct: 0.029,
    stripeFeeFixedUsd: 0.30,
    appleProceedsPct: 0.85,
    vpsAllocationUsdPerPaidUser: 0.35,
    refundsPct: 0.01,
    taxesPct: 0.0,
  };
}

describe('economics simulation', () => {
  it('fails closed on missing or null rate-card fields', () => {
    const rates = healthyRateCard() as any;
    rates.providerRatesUsdPerMTok.priorityScript.output = null;
    expect(() => validateRateCard(rates)).toThrow(/priorityScript\.output/);
    expect(() => computeEconomics({} as any)).toThrow(/incomplete/);
  });

  it('rejects the checked-in template outright', () => {
    const template = JSON.parse(
      readFileSync(join(process.cwd(), 'config/economics-rate-card.template.json'), 'utf8'),
    );
    expect(() => computeEconomics(template)).toThrow(/incomplete/);
  });

  it('models the five required usage profiles deterministically', () => {
    const profiles = buildProfiles(healthyRateCard());
    expect(profiles.map((profile) => profile.id)).toEqual([
      'pro_script_heavy',
      'max_script_heavy',
      'chat_heavy',
      'reasoning_heavy',
      'priority_pack_buyer',
    ]);
    const proScriptHeavy = profiles[0];
    // 30 scripts at (9000*0.5 + 4200*2.0)/1e6 = 0.0129 each, plus
    // 200 standard ops at (2000*0.1 + 600*0.4)/1e6 + 0.0002 = 0.00064 each.
    expect(proScriptHeavy.providerCostUsd).toBeCloseTo(30 * 0.0129 + 200 * 0.00064, 10);
    expect(proScriptHeavy.revenueUsd).toBe(9.99);
  });

  it('passes the launch gates on healthy account rates', () => {
    const result = computeEconomics(healthyRateCard());
    expect(result.gates).toEqual({
      blendedAtLeast80: true,
      webAtLeast80: true,
      appleFloor: true,
    });
    expect(result.launchEligible).toBe(true);
    expect(result.blendedMarginPct).toBeGreaterThan(0.80);
    expect(result.webMarginPct).toBeGreaterThan(0.80);
  });

  it('fails the gates when provider rates blow the margin, without hiding it', () => {
    const rates = healthyRateCard();
    rates.providerRatesUsdPerMTok.standardScript = { input: 20, output: 80 };
    rates.providerRatesUsdPerMTok.priorityScript = { input: 40, output: 160 };
    const result = computeEconomics(rates);
    expect(result.launchEligible).toBe(false);
    expect(result.gates.blendedAtLeast80).toBe(false);
  });

  it('reports the Apple channel separately and applies its bounded floor', () => {
    const result = computeEconomics(healthyRateCard());
    const appleProfile = result.profiles.find((profile) => profile.channel === 'apple');
    expect(appleProfile?.id).toBe('priority_pack_buyer');
    expect(result.appleMarginPct).not.toBeNull();
    expect(result.appleMarginPct).toBeLessThan(result.webMarginPct as number);
  });
});
