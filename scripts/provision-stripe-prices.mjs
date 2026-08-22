// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// NH-0036: provision the hybrid AI commerce catalog's Stripe objects
// (plan §3: "Use new Stripe Price objects; archive old prices from new
// sale while preserving historical billing and webhook compatibility").
//
// Usage:
//   STRIPE_SECRET_KEY=sk_... node scripts/provision-stripe-prices.mjs            # dry run
//   STRIPE_SECRET_KEY=sk_... node scripts/provision-stripe-prices.mjs --apply
//   STRIPE_SECRET_KEY=sk_... node scripts/provision-stripe-prices.mjs --apply \
//     --archive price_old1,price_old2
//
// Behavior:
// - Idempotent by Stripe lookup key: an existing price with the expected
//   lookup key and amount is reused; a mismatched amount mints a new price
//   and transfers the lookup key (the old price keeps selling history).
// - Never prints or stores the secret key. Prints the exact .env lines to
//   paste for the catalog (STRIPE_PRICE_ID_*).
// - --apply requires STRIPE_EXPECTED_ACCOUNT_ID and verifies the key's account
//   before the first mutation.
// - --archive only sets active=false on the listed price ids: existing
//   subscriptions and webhooks are untouched; the prices stop NEW sale.

export const STRIPE_CATALOG_TAX_CODE = 'txcd_10103000';

export const CATALOG_STRIPE_OBJECTS = [
  {
    envVar: 'STRIPE_PRICE_ID_PLAN_PRO_MONTHLY',
    lookupKey: 'nexus.plan.pro.monthly',
    productName: 'Nexus Hub Pro',
    catalogItemId: 'plan.pro.monthly',
    unitAmount: 999,
    currency: 'usd',
    taxBehavior: 'exclusive',
    taxCode: STRIPE_CATALOG_TAX_CODE,
    recurring: { interval: 'month' },
  },
  {
    envVar: 'STRIPE_PRICE_ID_PLAN_MAX_MONTHLY',
    lookupKey: 'nexus.plan.max.monthly',
    productName: 'Nexus Hub Max',
    catalogItemId: 'plan.max.monthly',
    unitAmount: 1499,
    currency: 'usd',
    taxBehavior: 'exclusive',
    taxCode: STRIPE_CATALOG_TAX_CODE,
    recurring: { interval: 'month' },
  },
  {
    envVar: 'STRIPE_PRICE_ID_PACK_100',
    lookupKey: 'nexus.pack.credits.100',
    productName: '100 AI credits',
    catalogItemId: 'pack.credits.100',
    unitAmount: 499,
    currency: 'usd',
    taxBehavior: 'exclusive',
    taxCode: STRIPE_CATALOG_TAX_CODE,
    recurring: null,
  },
  {
    envVar: 'STRIPE_PRICE_ID_PACK_250',
    lookupKey: 'nexus.pack.credits.250',
    productName: '250 AI credits',
    catalogItemId: 'pack.credits.250',
    unitAmount: 999,
    currency: 'usd',
    taxBehavior: 'exclusive',
    taxCode: STRIPE_CATALOG_TAX_CODE,
    recurring: null,
  },
  {
    envVar: 'STRIPE_PRICE_ID_PACK_600',
    lookupKey: 'nexus.pack.credits.600',
    productName: '600 AI credits',
    catalogItemId: 'pack.credits.600',
    unitAmount: 1999,
    currency: 'usd',
    taxBehavior: 'exclusive',
    taxCode: STRIPE_CATALOG_TAX_CODE,
    recurring: null,
  },
];

async function findProductByCatalogItemId(stripe, catalogItemId) {
  const result = await stripe.products.search({
    query: `metadata['nexusCatalogItemId']:'${catalogItemId}' AND active:'true'`,
    limit: 1,
  });
  return result.data[0] ?? null;
}

async function findPriceByLookupKey(stripe, lookupKey) {
  const result = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  return result.data[0] ?? null;
}

function priceMatches(price, spec) {
  const recurringMatches = spec.recurring
    ? price.recurring?.interval === spec.recurring.interval
    : !price.recurring;
  return price.unit_amount === spec.unitAmount
    && price.currency === spec.currency
    && price.tax_behavior === spec.taxBehavior
    && recurringMatches
    && price.active === true;
}

/**
 * Provision every catalog object. Returns { envLines, actions } where each
 * action is {envVar, priceId, outcome: 'reused'|'created'|'replaced'|'planned'}.
 */
export async function provisionCatalogObjects(stripe, { apply = false } = {}) {
  const actions = [];
  for (const spec of CATALOG_STRIPE_OBJECTS) {
    const existing = await findPriceByLookupKey(stripe, spec.lookupKey);
    let product = null;
    if (existing?.product && typeof existing.product === 'object') {
      product = existing.product;
    } else if (typeof existing?.product === 'string') {
      product = await stripe.products.retrieve(existing.product);
    } else {
      product = await findProductByCatalogItemId(stripe, spec.catalogItemId);
    }
    const productTaxReady = product?.tax_code === spec.taxCode;
    if (existing && priceMatches(existing, spec) && productTaxReady) {
      actions.push({ envVar: spec.envVar, priceId: existing.id, outcome: 'reused' });
      continue;
    }
    if (!apply) {
      actions.push({
        envVar: spec.envVar,
        priceId: existing ? `(replace ${existing.id})` : '(new)',
        outcome: 'planned',
      });
      continue;
    }
    if (!product) {
      product = await stripe.products.create({
        name: spec.productName,
        tax_code: spec.taxCode,
        metadata: { nexusCatalogItemId: spec.catalogItemId },
      });
    } else if (!productTaxReady) {
      product = await stripe.products.update(product.id, { tax_code: spec.taxCode });
    }
    if (existing && priceMatches(existing, spec)) {
      actions.push({ envVar: spec.envVar, priceId: existing.id, outcome: 'reused' });
      continue;
    }
    const created = await stripe.prices.create({
      product: product.id,
      unit_amount: spec.unitAmount,
      currency: spec.currency,
      tax_behavior: spec.taxBehavior,
      ...(spec.recurring ? { recurring: spec.recurring } : {}),
      lookup_key: spec.lookupKey,
      // A mismatched existing price keeps its history; the lookup key moves.
      ...(existing ? { transfer_lookup_key: true } : {}),
      metadata: { nexusCatalogItemId: spec.catalogItemId },
    });
    actions.push({
      envVar: spec.envVar,
      priceId: created.id,
      outcome: existing ? 'replaced' : 'created',
    });
  }
  const envLines = actions
    .filter((action) => action.outcome !== 'planned')
    .map((action) => `${action.envVar}=${action.priceId}`);
  return { actions, envLines };
}

/** Stop NEW sale on the listed price ids. History and webhooks untouched. */
export async function archivePrices(stripe, priceIds, { apply = false } = {}) {
  const archived = [];
  for (const priceId of priceIds) {
    if (!/^price_[A-Za-z0-9]+$/.test(priceId)) {
      throw new Error(`refusing to archive non-price id: ${priceId}`);
    }
    if (apply) {
      await stripe.prices.update(priceId, { active: false });
    }
    archived.push({ priceId, outcome: apply ? 'archived' : 'planned' });
  }
  return archived;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const archiveArgIndex = process.argv.indexOf('--archive');
  const archiveIds = archiveArgIndex !== -1
    ? String(process.argv[archiveArgIndex + 1] || '').split(',').filter(Boolean)
    : [];

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY is required (never pass it as an argument).');
    process.exit(2);
  }
  // A live key mutates the real account: require an explicit --live-ok so a
  // copy-pasted sandbox command can never run against production by accident.
  if (secretKey.startsWith('sk_live_') && apply && !process.argv.includes('--live-ok')) {
    console.error('Refusing --apply with a LIVE key: add --live-ok to confirm.');
    process.exit(2);
  }
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(secretKey);
  if (apply) {
    const expectedAccountId = process.env.STRIPE_EXPECTED_ACCOUNT_ID;
    if (!/^acct_[A-Za-z0-9]+$/.test(expectedAccountId || '')) {
      console.error('STRIPE_EXPECTED_ACCOUNT_ID=acct_... is required with --apply.');
      process.exit(2);
    }
    const account = await stripe.accounts.retrieve();
    if (account.id !== expectedAccountId) {
      console.error('Refusing --apply: Stripe account binding check failed.');
      process.exit(2);
    }
  }

  const { actions, envLines } = await provisionCatalogObjects(stripe, { apply });
  for (const action of actions) {
    console.log(`${action.outcome.padEnd(8)} ${action.envVar} -> ${action.priceId}`);
  }
  if (archiveIds.length > 0) {
    for (const entry of await archivePrices(stripe, archiveIds, { apply })) {
      console.log(`${entry.outcome.padEnd(8)} archive ${entry.priceId}`);
    }
  }
  if (envLines.length > 0) {
    console.log('\nPaste into the runtime .env (local and VPS):');
    for (const line of envLines) console.log(line);
  }
  if (!apply) {
    console.log('\nDry run only — re-run with --apply to execute.');
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].split('/').pop(),
);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
