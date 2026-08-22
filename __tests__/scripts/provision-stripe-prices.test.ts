// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_STRIPE_OBJECTS,
  archivePrices,
  provisionCatalogObjects,
} from '../../scripts/provision-stripe-prices.mjs';

function stripeMock(overrides: {
  pricesByLookupKey?: Record<string, unknown>;
  productsByCatalogItemId?: Record<string, unknown>;
} = {}) {
  const created: unknown[] = [];
  const updated: Array<[string, unknown]> = [];
  const productsUpdated: Array<[string, unknown]> = [];
  return {
    created,
    updated,
    productsUpdated,
    products: {
      search: vi.fn(async ({ query }: { query: string }) => {
        const id = /nexusCatalogItemId'\]:'([^']+)'/.exec(query)?.[1] ?? '';
        const hit = overrides.productsByCatalogItemId?.[id];
        return { data: hit ? [hit] : [] };
      }),
      create: vi.fn(async (params: Record<string, unknown>) => ({ id: `prod_${params.name}`, ...params })),
      retrieve: vi.fn(async (id: string) => ({ id, tax_code: 'txcd_10103000' })),
      update: vi.fn(async (id: string, params: unknown) => {
        productsUpdated.push([id, params]);
        return { id, ...(params as object) };
      }),
    },
    prices: {
      list: vi.fn(async ({ lookup_keys }: { lookup_keys: string[] }) => {
        const hit = overrides.pricesByLookupKey?.[lookup_keys[0]];
        return { data: hit ? [hit] : [] };
      }),
      create: vi.fn(async (params: Record<string, unknown>) => {
        const price = { id: `price_new_${created.length + 1}`, ...params };
        created.push(price);
        return price;
      }),
      update: vi.fn(async (id: string, params: unknown) => {
        updated.push([id, params]);
        return { id, ...(params as object) };
      }),
    },
  };
}

describe('NH-0036 Stripe provisioning', () => {
  it('requires an explicit --live-ok before applying with a live key (QA3 P3-16)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('scripts/provision-stripe-prices.mjs', 'utf8');
    expect(source).toContain("secretKey.startsWith('sk_live_') && apply && !process.argv.includes('--live-ok')");
    expect(source).toContain('Refusing --apply with a LIVE key');
    expect(source).toContain('STRIPE_EXPECTED_ACCOUNT_ID=acct_... is required with --apply.');
    expect(source).toContain('Stripe key belongs to ${account.id}, expected ${expectedAccountId}');
  });

  it('covers exactly the five §3 catalog objects at the §2 price points', () => {
    expect(CATALOG_STRIPE_OBJECTS.map((spec) => [spec.envVar, spec.unitAmount])).toEqual([
      ['STRIPE_PRICE_ID_PLAN_PRO_MONTHLY', 999],
      ['STRIPE_PRICE_ID_PLAN_MAX_MONTHLY', 1499],
      ['STRIPE_PRICE_ID_PACK_100', 499],
      ['STRIPE_PRICE_ID_PACK_250', 999],
      ['STRIPE_PRICE_ID_PACK_600', 1999],
    ]);
    for (const spec of CATALOG_STRIPE_OBJECTS) {
      expect(spec.currency).toBe('usd');
      expect(spec.taxBehavior).toBe('exclusive');
      expect(spec.taxCode).toBe('txcd_10103000');
      if (spec.envVar.includes('PLAN')) expect(spec.recurring).toEqual({ interval: 'month' });
      else expect(spec.recurring).toBeNull();
    }
  });

  it('dry run plans work without creating anything', async () => {
    const stripe = stripeMock();
    const { actions, envLines } = await provisionCatalogObjects(stripe as never, { apply: false });
    expect(actions.every((action) => action.outcome === 'planned')).toBe(true);
    expect(envLines).toEqual([]);
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(stripe.products.create).not.toHaveBeenCalled();
  });

  it('reuses a matching price by lookup key instead of minting a duplicate', async () => {
    const stripe = stripeMock({
      pricesByLookupKey: {
        'nexus.plan.pro.monthly': {
          id: 'price_pro_existing',
          unit_amount: 999,
          currency: 'usd',
          tax_behavior: 'exclusive',
          product: { id: 'prod_pro', tax_code: 'txcd_10103000' },
          active: true,
          recurring: { interval: 'month' },
        },
      },
    });
    const { actions } = await provisionCatalogObjects(stripe as never, { apply: true });
    const pro = actions.find((action) => action.envVar === 'STRIPE_PRICE_ID_PLAN_PRO_MONTHLY');
    expect(pro).toEqual({
      envVar: 'STRIPE_PRICE_ID_PLAN_PRO_MONTHLY',
      priceId: 'price_pro_existing',
      outcome: 'reused',
    });
    // The other four are created fresh.
    expect(stripe.created).toHaveLength(4);
  });

  it('updates an existing Product to the personal-use SaaS tax code before reusing its Price', async () => {
    const stripe = stripeMock({
      pricesByLookupKey: {
        'nexus.plan.pro.monthly': {
          id: 'price_pro_existing',
          product: { id: 'prod_pro', tax_code: 'txcd_99999999' },
          unit_amount: 999,
          currency: 'usd',
          tax_behavior: 'exclusive',
          active: true,
          recurring: { interval: 'month' },
        },
      },
    });

    const { actions } = await provisionCatalogObjects(stripe as never, { apply: true });

    expect(stripe.productsUpdated).toContainEqual([
      'prod_pro',
      { tax_code: 'txcd_10103000' },
    ]);
    expect(actions.find((action) => action.envVar === 'STRIPE_PRICE_ID_PLAN_PRO_MONTHLY'))
      .toMatchObject({ priceId: 'price_pro_existing', outcome: 'reused' });
  });

  it('replaces an otherwise matching price whose tax behavior is unspecified', async () => {
    const stripe = stripeMock({
      pricesByLookupKey: {
        'nexus.plan.pro.monthly': {
          id: 'price_pro_unspecified_tax',
          unit_amount: 999,
          currency: 'usd',
          tax_behavior: 'unspecified',
          active: true,
          recurring: { interval: 'month' },
        },
      },
    });
    const { actions } = await provisionCatalogObjects(stripe as never, { apply: true });
    const pro = actions.find((action) => action.envVar === 'STRIPE_PRICE_ID_PLAN_PRO_MONTHLY');
    expect(pro?.outcome).toBe('replaced');
    const created = (stripe.created as Array<Record<string, unknown>>)
      .find((price) => price.lookup_key === 'nexus.plan.pro.monthly');
    expect(created?.tax_behavior).toBe('exclusive');
    expect(created?.transfer_lookup_key).toBe(true);
  });

  it('replaces a mismatched price and transfers the lookup key', async () => {
    const stripe = stripeMock({
      pricesByLookupKey: {
        'nexus.pack.credits.100': {
          id: 'price_pack100_stale',
          unit_amount: 599,
          currency: 'usd',
          active: true,
          recurring: null,
        },
      },
    });
    const { actions } = await provisionCatalogObjects(stripe as never, { apply: true });
    const pack = actions.find((action) => action.envVar === 'STRIPE_PRICE_ID_PACK_100');
    expect(pack?.outcome).toBe('replaced');
    const createdPack = (stripe.created as Array<Record<string, unknown>>)
      .find((price) => price.lookup_key === 'nexus.pack.credits.100');
    expect(createdPack?.transfer_lookup_key).toBe(true);
    expect(createdPack?.unit_amount).toBe(499);
  });

  it('archives only well-formed price ids and only with --apply', async () => {
    const stripe = stripeMock();
    const planned = await archivePrices(stripe as never, ['price_old1'], { apply: false });
    expect(planned).toEqual([{ priceId: 'price_old1', outcome: 'planned' }]);
    expect(stripe.updated).toHaveLength(0);

    const applied = await archivePrices(stripe as never, ['price_old1'], { apply: true });
    expect(applied).toEqual([{ priceId: 'price_old1', outcome: 'archived' }]);
    expect(stripe.updated).toEqual([['price_old1', { active: false }]]);

    await expect(archivePrices(stripe as never, ['sub_bogus'], { apply: true }))
      .rejects.toThrow(/refusing to archive/);
  });
});
