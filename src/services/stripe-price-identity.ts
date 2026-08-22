// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Historical subscription Prices remain valid only for webhook reconciliation.
 * They must never be rebound as the canonical Prices used by new Checkout
 * sessions, because their commercial/tax contract predates the current catalog.
 */
export const STRIPE_HISTORICAL_MONTHLY_PRICE_IDS = Object.freeze([
  'price_1U55BS3kbWVFdS6025onefOr',
  'price_1U55Cl3kbWVFdS60VAeMzEyf',
] as const);

// Nexus Hub is non-customized cloud software intended for personal use.
// Stripe's product-specific tax code keeps automatic tax from falling back to
// the account-wide preset for tangible goods or a different service class.
export const STRIPE_PERSONAL_SAAS_TAX_CODE = 'txcd_10103000' as const;

export function isHistoricalStripeMonthlyPriceId(priceId: string): boolean {
  return (STRIPE_HISTORICAL_MONTHLY_PRICE_IDS as readonly string[]).includes(priceId);
}
