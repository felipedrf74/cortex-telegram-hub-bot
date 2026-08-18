// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Server-owned versioned billing catalog (hybrid AI plan §3).
 *
 * Clients submit catalog item IDs only. Prices, credit amounts, provider
 * price/product identifiers, and ownership are resolved server-side. An item
 * without a configured provider object, or without a live fulfillment path,
 * fails closed as not purchasable instead of guessing.
 */

import { config } from '../config';

export const BILLING_CATALOG_VERSION = '2026-08-18.1';

/**
 * Web pack sales open only when the Stripe fulfillment switch is on
 * (STRIPE_PACK_FULFILLMENT_ENABLED, default OFF): selling a pack without its
 * webhook fulfillment path would take money without granting credits. The
 * switch gates NEW checkouts; fulfillment of paid sessions always runs.
 */
function isStripePackSalesEnabled(): boolean {
  return config.hybridCommerce.stripePackFulfillmentEnabled === true;
}

export type BillingCatalogItemKind = 'subscription' | 'credit_pack';

export interface BillingCatalogItem {
  id: string;
  kind: BillingCatalogItemKind;
  title: string;
  displayPriceUsd: number;
  plan?: 'pro' | 'max';
  monthlyCredits?: number;
  dailyCreditCap?: number;
  credits?: number;
  requiresActivePaidPlan: boolean;
  purchasable: boolean;
  unavailableReason?: 'provider_price_missing' | 'fulfillment_pending';
}

export interface ResolvedBillingCatalogItem extends BillingCatalogItem {
  stripePriceId: string | null;
  appleProductId: string | null;
}

function catalogDefinitions(): ResolvedBillingCatalogItem[] {
  const stripeIds = config.hybridCommerce.stripePriceIds;
  const appleIds = config.hybridCommerce.appleProductIds;

  const subscription = (
    id: string,
    plan: 'pro' | 'max',
    title: string,
    displayPriceUsd: number,
    monthlyCredits: number,
    dailyCreditCap: number,
    stripePriceId: string,
  ): ResolvedBillingCatalogItem => ({
    id,
    kind: 'subscription',
    title,
    displayPriceUsd,
    plan,
    monthlyCredits,
    dailyCreditCap,
    requiresActivePaidPlan: false,
    stripePriceId: stripePriceId || null,
    appleProductId: null,
    purchasable: Boolean(stripePriceId),
    ...(stripePriceId ? {} : { unavailableReason: 'provider_price_missing' as const }),
  });

  const pack = (
    id: string,
    title: string,
    displayPriceUsd: number,
    credits: number,
    stripePriceId: string,
    appleProductId: string,
  ): ResolvedBillingCatalogItem => {
    const providerConfigured = Boolean(stripePriceId);
    const purchasable = providerConfigured && isStripePackSalesEnabled();
    return {
      id,
      kind: 'credit_pack',
      title,
      displayPriceUsd,
      credits,
      requiresActivePaidPlan: true,
      stripePriceId: stripePriceId || null,
      appleProductId: appleProductId || null,
      purchasable,
      ...(purchasable
        ? {}
        : {
          unavailableReason: (providerConfigured
            ? 'fulfillment_pending'
            : 'provider_price_missing') as 'fulfillment_pending' | 'provider_price_missing',
        }),
    };
  };

  return [
    subscription('plan.pro.monthly', 'pro', 'Nexus Hub Pro', 9.99, 500, 50, stripeIds.planProMonthly),
    subscription('plan.max.monthly', 'max', 'Nexus Hub Max', 14.99, 1200, 100, stripeIds.planMaxMonthly),
    pack('pack.credits.100', '100 AI credits', 4.99, 100, stripeIds.pack100, appleIds.pack100),
    pack('pack.credits.250', '250 AI credits', 9.99, 250, stripeIds.pack250, appleIds.pack250),
    pack('pack.credits.600', '600 AI credits', 19.99, 600, stripeIds.pack600, appleIds.pack600),
  ];
}

/** Client-safe catalog view: provider identifiers never leave the server. */
export function getBillingCatalog(): { catalogVersion: string; items: BillingCatalogItem[] } {
  const items = catalogDefinitions().map((item) => {
    const { stripePriceId: _stripe, appleProductId: _apple, ...clientSafe } = item;
    return clientSafe;
  });
  return { catalogVersion: BILLING_CATALOG_VERSION, items };
}

export function resolveBillingCatalogItem(catalogItemId: string): ResolvedBillingCatalogItem | null {
  return catalogDefinitions().find((item) => item.id === catalogItemId) ?? null;
}

/** Apple consumable fulfillment resolves packs by their provisioned product id. */
export function resolveBillingCatalogItemByAppleProductId(
  appleProductId: string,
): ResolvedBillingCatalogItem | null {
  if (!appleProductId) return null;
  return catalogDefinitions().find(
    (item) => item.kind === 'credit_pack' && item.appleProductId === appleProductId,
  ) ?? null;
}
