// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { centsToNumber, toCents } from './money';

/**
 * Regime flag for Portuguese Category B (independent worker) tax estimation.
 *
 *   'flat-estimate'        — no Cat B coefficient, no Segurança Social.
 *                            Suitable for general "what would I owe on €X" math
 *                            (e.g., employment income). Preserves the original
 *                            engine semantics from before 2026-05-18.
 *
 *   'simplified-services'  — Regime Simplificado, services category.
 *                            Applies the 0.75 coefficient to IRS taxable income
 *                            and 21.4% Segurança Social on 70% of gross,
 *                            capped at 12 × IAS monthly.
 *
 *   'simplified-trade'     — Regime Simplificado, accommodation/restoration/
 *                            commercial activities. Applies 0.15 coefficient
 *                            to taxable income. SS calculation identical.
 *
 *   'organized'            — Regime Organizada. Cannot be estimated without
 *                            actual accounting income/expense input — the
 *                            engine throws and the caller must compute
 *                            taxable income externally.
 *
 * See `docs/finance/portuguese-tax-rules.md` for citations. The 2024 IAS
 * (€509.26) is hardcoded as a fallback; pass `iasMonthly` to override.
 */
export type PortugueseTaxRegime =
  | 'flat-estimate'
  | 'simplified-services'
  | 'simplified-trade'
  | 'organized';

export interface PortugueseTaxBreakdown {
  grossIncome: number;
  deductions: number;
  socialSecurityDue: number;
  taxableIncome: number;
  taxDue: number;
  effectiveRate: number;
  bracket: string;
  ptInvoiceCode: string;
  ivaDue: number;
  withholdingDue: number;
  ruleset: 'pt-irs-2026-mainland-estimate';
  regime: PortugueseTaxRegime;
  categoryBCoefficient: number;
  socialSecurityBase: number;
  socialSecurityCapped: boolean;
}

export interface PortugueseTaxOptions {
  ivaRate?: 0 | 0.06 | 0.13 | 0.23;
  withholdingRate?: number;
  ptInvoiceCode?: string;
  regime?: PortugueseTaxRegime;
  /**
   * Override the Cat B coefficient. Defaults: services=0.75, trade=0.15,
   * flat-estimate=1.0. Useful for edge cases (e.g., professional services
   * with sub-category rates) — generally callers should use a regime flag
   * instead.
   */
  categoryBCoefficient?: number;
  /**
   * Override the SS rate. Default = 0.214 (Cat B independent worker
   * standard rate). Some sub-categories use different rates; the operator
   * documents the canonical rate in docs/finance/portuguese-tax-rules.md.
   */
  socialSecurityRate?: number;
  /**
   * Override the IAS (Indexante dos Apoios Sociais) monthly value. The SS
   * monthly contribution base is capped at 12 × IAS. 2024 value: €509.26;
   * 2025 value not yet adopted in code. Caller may pass an updated value.
   */
  iasMonthly?: number;
}

export const PORTUGUESE_TAX_RULESET_2026 = {
  id: 'pt-irs-2026-mainland-estimate',
  reviewedByFelipe: false,
  sources: [
    'https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/cirs_rep/Pages/irs68.aspx',
    'https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/civa_rep/Pages/iva18.aspx',
    'https://www.seg-social.pt/independentes',
  ],
} as const;

/**
 * Standard Cat B independent-worker Segurança Social rate. The relevant-
 * income basis is 70% of gross for services (Cat B simplified, services
 * category). The standard rate is 21.4%. See seg-social.pt/independentes.
 */
export const PT_SOCIAL_SECURITY_DEFAULTS = {
  rate: 0.214,
  servicesRelevantIncomeRate: 0.70,
  // 2024 IAS = €509.26/month; SS contribution base capped at 12 × IAS.
  // Operator should bump this annually; passing `iasMonthly` overrides.
  iasMonthly: 509.26,
  capMultiplier: 12,
} as const;

export const PORTUGAL_MAINLAND_VAT_RATES = {
  reduced: 0.06,
  intermediate: 0.13,
  standard: 0.23,
} as const;

export const PT_IRS_BRACKETS_2026 = [
  { upTo: 8_342, normalRate: 0.125, averageRate: 0.125 },
  { upTo: 12_587, normalRate: 0.157, averageRate: 0.13579 },
  { upTo: 17_838, normalRate: 0.212, averageRate: 0.15823 },
  { upTo: 23_089, normalRate: 0.241, averageRate: 0.17705 },
  { upTo: 29_397, normalRate: 0.311, averageRate: 0.20579 },
  { upTo: 43_090, normalRate: 0.349, averageRate: 0.25130 },
  { upTo: 46_566, normalRate: 0.431, averageRate: 0.26472 },
  { upTo: 86_634, normalRate: 0.446, averageRate: 0.34856 },
  { upTo: Infinity, normalRate: 0.48, averageRate: null },
] as const;

function roundMoney(value: number): number {
  return centsToNumber(toCents(value));
}

function calculateAnnualIrs(taxableAnnualIncome: number): { taxDue: number; bracket: string } {
  if (taxableAnnualIncome <= 0) {
    return { taxDue: 0, bracket: 'Isento' };
  }

  for (let index = 0; index < PT_IRS_BRACKETS_2026.length; index += 1) {
    const bracket = PT_IRS_BRACKETS_2026[index];
    if (taxableAnnualIncome > bracket.upTo) continue;

    if (index === 0) {
      return {
        taxDue: roundMoney(taxableAnnualIncome * bracket.normalRate),
        bracket: `${(bracket.normalRate * 100).toFixed(1)}%`,
      };
    }

    const previous = PT_IRS_BRACKETS_2026[index - 1];
    const baseTax = previous.upTo * (previous.averageRate ?? previous.normalRate);
    const marginalTax = (taxableAnnualIncome - previous.upTo) * bracket.normalRate;
    return {
      taxDue: roundMoney(baseTax + marginalTax),
      bracket: `${(bracket.normalRate * 100).toFixed(1)}%`,
    };
  }

  return { taxDue: 0, bracket: 'Isento' };
}

function coefficientForRegime(regime: PortugueseTaxRegime, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  switch (regime) {
    case 'simplified-services': return 0.75;
    case 'simplified-trade':    return 0.15;
    case 'flat-estimate':       return 1.0;
    case 'organized':
      throw new Error(
        'PT_TAX_ORGANIZED_REQUIRES_EXPLICIT_INPUT: ' +
        'Regime Organizada requires the caller to compute taxable income and SS ' +
        'externally (full accounting). Pass regime="flat-estimate" with pre-' +
        'computed taxable income, or implement the organized branch.',
      );
  }
}

function calculateSocialSecurityMonthly(
  grossIncome: number,
  regime: PortugueseTaxRegime,
  opts: PortugueseTaxOptions,
): { due: number; base: number; capped: boolean } {
  // Flat-estimate path: caller is doing generic IRS math (e.g., employment
  // income or one-shot estimates). SS is paid via employer for employees;
  // not modeled here. Return 0 with a clear `base: 0`.
  if (regime === 'flat-estimate') {
    return { due: 0, base: 0, capped: false };
  }
  const ssRate = opts.socialSecurityRate ?? PT_SOCIAL_SECURITY_DEFAULTS.rate;
  const relevantIncomeRate = PT_SOCIAL_SECURITY_DEFAULTS.servicesRelevantIncomeRate;
  const ias = opts.iasMonthly ?? PT_SOCIAL_SECURITY_DEFAULTS.iasMonthly;
  const capMonthly = ias * PT_SOCIAL_SECURITY_DEFAULTS.capMultiplier;

  // SS monthly contribution base = relevant_income_rate × gross, capped at
  // 12 × IAS. Above the cap, no additional SS.
  const rawBase = grossIncome * relevantIncomeRate;
  const base = Math.min(rawBase, capMonthly);
  const capped = rawBase > capMonthly;
  return {
    due: roundMoney(base * ssRate),
    base: roundMoney(base),
    capped,
  };
}

export function calculatePortugueseMonthlyTaxEstimate(
  grossIncome: number,
  deductions = 0,
  opts: PortugueseTaxOptions = {},
): PortugueseTaxBreakdown {
  const regime = opts.regime ?? 'flat-estimate';
  const coefficient = coefficientForRegime(regime, opts.categoryBCoefficient);

  const gross = roundMoney(Math.max(0, grossIncome));
  const deductible = roundMoney(Math.max(0, deductions));

  // For simplified regimes, the Cat B coefficient determines what fraction of
  // gross enters taxable income (the rest is presumed-expenses).
  // Deductions still apply below the coefficient (e.g., specific deductible
  // expenses the user logs separately).
  const incomeAfterCoefficient = roundMoney(Math.max(0, gross * coefficient));
  const taxableMonthlyIncome = roundMoney(Math.max(0, incomeAfterCoefficient - deductible));

  const annualizedTaxableIncome = roundMoney(taxableMonthlyIncome * 12);
  const annualIrs = calculateAnnualIrs(annualizedTaxableIncome);
  const taxDue = roundMoney(annualIrs.taxDue / 12);

  const ivaRate = opts.ivaRate ?? PORTUGAL_MAINLAND_VAT_RATES.standard;
  const withholdingRate = opts.withholdingRate ?? 0;

  const socialSecurity = calculateSocialSecurityMonthly(gross, regime, opts);

  return {
    grossIncome: gross,
    deductions: deductible,
    socialSecurityDue: socialSecurity.due,
    taxableIncome: taxableMonthlyIncome,
    taxDue,
    effectiveRate: gross > 0 ? roundMoney((taxDue / gross) * 100) : 0,
    bracket: annualIrs.bracket,
    ptInvoiceCode: opts.ptInvoiceCode ?? 'PT-IRS-ESTIMATE',
    ivaDue: roundMoney(gross * ivaRate),
    withholdingDue: roundMoney(gross * withholdingRate),
    ruleset: PORTUGUESE_TAX_RULESET_2026.id,
    regime,
    categoryBCoefficient: coefficient,
    socialSecurityBase: socialSecurity.base,
    socialSecurityCapped: socialSecurity.capped,
  };
}

