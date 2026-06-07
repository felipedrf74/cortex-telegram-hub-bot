import { describe, expect, it } from 'vitest';
import {
  calculatePortugueseMonthlyTaxEstimate,
  PORTUGAL_MAINLAND_VAT_RATES,
  PORTUGUESE_TAX_RULESET_2026,
  PT_IRS_BRACKETS_2026,
} from '../../src/services/finance-tax-pt';

describe('finance-tax-pt', () => {
  it('pins the official 2026 mainland IRS bracket table source metadata', () => {
    expect(PORTUGUESE_TAX_RULESET_2026.reviewedByFelipe).toBe(false);
    expect(PORTUGUESE_TAX_RULESET_2026.sources[0]).toContain('portaldasfinancas');
    expect(PT_IRS_BRACKETS_2026).toHaveLength(9);
    expect(PT_IRS_BRACKETS_2026[0]).toMatchObject({ upTo: 8342, normalRate: 0.125 });
    expect(PT_IRS_BRACKETS_2026.at(-1)).toMatchObject({ upTo: Infinity, normalRate: 0.48 });
  });

  it('calculates a first-bracket monthly IRS estimate', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(500);
    expect(result.bracket).toBe('12.5%');
    expect(result.taxDue).toBe(62.5);
    expect(result.ivaDue).toBe(0);
    expect(result.ruleset).toBe('pt-irs-2026-mainland-estimate');
  });

  it('only charges IVA when an IVA rate is explicitly supplied', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(500, 0, {
      ivaRate: PORTUGAL_MAINLAND_VAT_RATES.standard,
    });
    expect(result.ivaDue).toBe(115);
  });

  it('calculates the second bracket using previous average plus marginal excess', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(900);
    expect(result.bracket).toBe('15.7%');
    expect(result.taxDue).toBe(119.06);
  });

  it('calculates mid and top bracket estimates', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(2500).bracket).toBe('34.9%');
    const high = calculatePortugueseMonthlyTaxEstimate(9000);
    expect(high.bracket).toBe('48.0%');
    expect(high.taxDue).toBeGreaterThan(3000);
  });

  it('covers the third Portugal IRS bracket boundary', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(1300).bracket).toBe('21.2%');
  });

  it('covers the fourth Portugal IRS bracket boundary', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(1800).bracket).toBe('24.1%');
  });

  it('covers the fifth Portugal IRS bracket boundary', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(2200).bracket).toBe('31.1%');
  });

  it('covers the seventh Portugal IRS bracket boundary', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(3700).bracket).toBe('43.1%');
  });

  it('covers the eighth Portugal IRS bracket boundary', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(5000).bracket).toBe('44.6%');
  });

  it('applies deductions before annualizing taxable income', () => {
    const withoutDeductions = calculatePortugueseMonthlyTaxEstimate(2000, 0);
    const withDeductions = calculatePortugueseMonthlyTaxEstimate(2000, 500);
    expect(withDeductions.taxableIncome).toBe(1500);
    expect(withDeductions.taxDue).toBeLessThan(withoutDeductions.taxDue);
  });

  it('supports IVA and withholding estimate inputs without changing IRS taxable income', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(1000, 0, {
      ivaRate: PORTUGAL_MAINLAND_VAT_RATES.reduced,
      withholdingRate: 0.25,
    });
    expect(result.ivaDue).toBe(60);
    expect(result.withholdingDue).toBe(250);
    expect(result.taxableIncome).toBe(1000);
  });

  it('supports the intermediate mainland IVA rate', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(1000, 0, {
      ivaRate: PORTUGAL_MAINLAND_VAT_RATES.intermediate,
    }).ivaDue).toBe(130);
  });

  it('supports custom Portugal invoice reference codes', () => {
    expect(calculatePortugueseMonthlyTaxEstimate(1000, 0, {
      ptInvoiceCode: 'PT-INV-2026-0001',
    }).ptInvoiceCode).toBe('PT-INV-2026-0001');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Skill-hardening 2026-05-18 P0-5: Segurança Social + Category B regime.
  // QA found socialSecurityDue was hardcoded to 0; this group pins the new
  // regime-aware calculation. References:
  //   https://www.seg-social.pt/independentes (Cat B SS rules)
  //   docs/finance/portuguese-tax-rules.md
  // ─────────────────────────────────────────────────────────────────────

  it('flat-estimate regime (default) preserves pre-2026-05-18 SS=0 behavior', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(2000);
    expect(result.regime).toBe('flat-estimate');
    expect(result.socialSecurityDue).toBe(0);
    expect(result.socialSecurityBase).toBe(0);
    expect(result.categoryBCoefficient).toBe(1);
  });

  it('simplified-services regime applies 0.75 coefficient + 21.4% SS on 70% of gross', () => {
    // €1000/mo gross. Coefficient 0.75 → taxable €750/mo → annual €9000 →
    // bracket 2 (15.7%). SS base = 0.70 × 1000 = €700; SS = 0.214 × 700 = €149.80.
    const result = calculatePortugueseMonthlyTaxEstimate(1000, 0, {
      regime: 'simplified-services',
    });
    expect(result.regime).toBe('simplified-services');
    expect(result.categoryBCoefficient).toBe(0.75);
    expect(result.taxableIncome).toBe(750);
    expect(result.bracket).toBe('15.7%');
    expect(result.socialSecurityBase).toBe(700);
    expect(result.socialSecurityDue).toBe(149.80);
    expect(result.socialSecurityCapped).toBe(false);
  });

  it('simplified-trade regime applies 0.15 coefficient (presumed-expenses for trade)', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(3000, 0, {
      regime: 'simplified-trade',
    });
    expect(result.regime).toBe('simplified-trade');
    expect(result.categoryBCoefficient).toBe(0.15);
    expect(result.taxableIncome).toBe(450); // 3000 × 0.15
    expect(result.socialSecurityDue).toBeGreaterThan(0);
  });

  it('caps Segurança Social at 12 × IAS monthly (2024 IAS=€509.26 → cap €6111.12)', () => {
    // Pass a clearly above-the-cap gross. Base would be 0.70 × 20_000 = 14_000,
    // capped to 6111.12. SS = 0.214 × 6111.12 = €1307.78.
    const result = calculatePortugueseMonthlyTaxEstimate(20_000, 0, {
      regime: 'simplified-services',
    });
    expect(result.socialSecurityCapped).toBe(true);
    expect(result.socialSecurityBase).toBe(6111.12);
    expect(result.socialSecurityDue).toBeCloseTo(1307.78, 1);
  });

  it('honors override iasMonthly for forward-year IAS bumps', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(20_000, 0, {
      regime: 'simplified-services',
      iasMonthly: 522.50, // hypothetical 2026 IAS
    });
    expect(result.socialSecurityCapped).toBe(true);
    expect(result.socialSecurityBase).toBe(6270);
  });

  it('honors override socialSecurityRate for sub-category SS rates', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(1000, 0, {
      regime: 'simplified-services',
      socialSecurityRate: 0.10,
    });
    expect(result.socialSecurityDue).toBe(70); // 0.10 × 700
  });

  it('honors explicit categoryBCoefficient override even when regime is set', () => {
    const result = calculatePortugueseMonthlyTaxEstimate(1000, 0, {
      regime: 'simplified-services',
      categoryBCoefficient: 0.50,
    });
    expect(result.categoryBCoefficient).toBe(0.50);
    expect(result.taxableIncome).toBe(500);
  });

  it('organized regime throws — caller must supply external taxable income + SS', () => {
    expect(() => calculatePortugueseMonthlyTaxEstimate(2000, 0, {
      regime: 'organized',
    })).toThrow(/PT_TAX_ORGANIZED_REQUIRES_EXPLICIT_INPUT/);
  });
});
