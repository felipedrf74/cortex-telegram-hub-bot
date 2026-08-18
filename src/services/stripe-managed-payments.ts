// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Stripe Managed Payments is currently exposed through a preview API version. */
export const STRIPE_MANAGED_PAYMENTS_API_VERSION = '2026-03-04.preview' as const;

export const STRIPE_MANAGED_PAYMENTS_CHECKOUT_OPTIONS = Object.freeze({
  enabled: true,
});
