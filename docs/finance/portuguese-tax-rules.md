# Portuguese Tax Rules — Nexus Finance

Status: implementation guardrail, not tax advice.

Nexus must not use the legacy Brazilian Carnê-Leão / IRPF / INSS / DARF engine
for Felipe's Portugal-based finance workflow. The backend now routes tax
estimates through `src/services/finance-tax-pt.ts`, using Portugal-facing
fields such as `pt_invoice_code` and keeping legacy `darf_code` null for new
calculations.

## Sources

- Autoridade Tributária e Aduaneira, CIRS Artigo 68.º, 2026 wording:
  https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/cirs_rep/Pages/irs68.aspx
- Autoridade Tributária e Aduaneira, Código do IVA Artigo 18.º:
  https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/civa_rep/Pages/iva18.aspx
- Autoridade Tributária e Aduaneira, Despacho SEAF 2026-01-05 / retenção na
  fonte 2026:
  https://info.portaldasfinancas.gov.pt/pt/destaques/Paginas/Despacho-SEAF-2026-01-05-novas-tabela-RF-IRS-2026.aspx

## Current Implementation Boundary

The Phase 16 hardening patch implements a monthly Portugal IRS estimate by
annualizing the taxable monthly amount and applying the 2026 CIRS Article 68
mainland bracket table. It also estimates mainland IVA using 6%, 13%, or 23%
rates. This is enough to remove the unsafe Brazil-specific runtime behavior.

The implementation is not a filing engine. It does not generate SAFT-PT,
Modelo 3, official recibo-verde submissions, or accountant-ready final tax
advice.

## Mandatory Review Gate

`PORTUGUESE_TAX_RULESET_2026.reviewedByFelipe` is intentionally `false` until
Felipe and/or an accountant confirms:

- fiscal regime handling (`regime simplificado` vs. contabilidade organizada),
- category B coefficients and deductible treatment,
- withholding rules for Felipe's actual activities and customers,
- regional edge cases if activity is not mainland Portugal,
- whether monthly estimates should be presented as IRS estimate, retenção na
  fonte, IVA, or separate accountant workflow cards.

Until that review is complete, UI copy must label these values as estimates.

## Retention

Finance transaction deletion is soft-delete only. Portuguese fiscal records and
supporting documents must remain recoverable for audit/accountant workflows.
Nexus filters deleted records from normal reads but keeps tombstones and audit
rows.

