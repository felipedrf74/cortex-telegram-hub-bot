// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Pre-release economics simulation (hybrid AI plan §4, NH-0034).
//
// Usage:
//   node scripts/economics-simulation.mjs --rates <rate-card.json> [--json]
//
// The rate card must carry ACTUAL provider-account rates and measured p95
// token consumption (NH-0036 captures them). The loader fails closed on
// missing or null fields: the plan forbids substituting public list prices
// when the account contract or invoice provides the applicable rate.
//
// Launch gates (plan §4): blended contribution margin >= 80%, web
// subscriptions >= 80%. Apple is reported separately; a 70–75% initial Apple
// floor is acceptable only while blended stays >= 80%.

import { readFileSync } from 'node:fs';

export const REQUIRED_RATE_FIELDS = [
  'version',
  'capturedAt',
  'providerRatesUsdPerMTok.standardOp.input',
  'providerRatesUsdPerMTok.standardOp.output',
  'providerRatesUsdPerMTok.deepOp.input',
  'providerRatesUsdPerMTok.deepOp.output',
  'providerRatesUsdPerMTok.standardScript.input',
  'providerRatesUsdPerMTok.standardScript.output',
  'providerRatesUsdPerMTok.scheduledScript.input',
  'providerRatesUsdPerMTok.scheduledScript.output',
  'providerRatesUsdPerMTok.priorityScript.input',
  'providerRatesUsdPerMTok.priorityScript.output',
  'p95Tokens.standardOp.input',
  'p95Tokens.standardOp.output',
  'p95Tokens.deepOp.input',
  'p95Tokens.deepOp.output',
  'p95Tokens.script.input',
  'p95Tokens.script.output',
  'searchToolUsdPerOp',
  'stripeFeePct',
  'stripeFeeFixedUsd',
  'appleProceedsPct',
  'vpsAllocationUsdPerPaidUser',
  'refundsPct',
  'taxesPct',
];

function readPath(object, path) {
  return path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
}

/** Fail closed: every required field must be a present, non-null value. */
export function validateRateCard(rates) {
  const missing = REQUIRED_RATE_FIELDS.filter((field) => {
    const value = readPath(rates, field);
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw new Error(`rate card is incomplete (actual account rates required): ${missing.join(', ')}`);
  }
  return rates;
}

const PLAN_PRICES_USD = { pro: 9.99, max: 14.99 };
const PACK_600_PRICE_USD = 19.99;

function scriptCostUsd(rates, cls) {
  const rate = rates.providerRatesUsdPerMTok[cls];
  const tokens = rates.p95Tokens.script;
  return (tokens.input * rate.input + tokens.output * rate.output) / 1_000_000;
}

function opCostUsd(rates, cls) {
  const rate = rates.providerRatesUsdPerMTok[cls];
  const tokens = rates.p95Tokens[cls];
  return (tokens.input * rate.input + tokens.output * rate.output) / 1_000_000 + rates.searchToolUsdPerOp;
}

/**
 * The five required monthly usage profiles (plan §4). Channel is modeled per
 * profile so web and Apple margins report separately.
 */
export function buildProfiles(rates) {
  const standardOp = opCostUsd(rates, 'standardOp');
  const deepOp = opCostUsd(rates, 'deepOp');
  const standardScript = scriptCostUsd(rates, 'standardScript');
  const priorityScript = scriptCostUsd(rates, 'priorityScript');

  return [
    {
      id: 'pro_script_heavy',
      channel: 'web',
      revenueUsd: PLAN_PRICES_USD.pro,
      providerCostUsd: 30 * standardScript + 200 * standardOp,
    },
    {
      id: 'max_script_heavy',
      channel: 'web',
      revenueUsd: PLAN_PRICES_USD.max,
      providerCostUsd: 60 * standardScript + 600 * standardOp,
    },
    {
      id: 'chat_heavy',
      channel: 'web',
      revenueUsd: PLAN_PRICES_USD.max,
      providerCostUsd: 1200 * standardOp,
    },
    {
      id: 'reasoning_heavy',
      channel: 'web',
      revenueUsd: PLAN_PRICES_USD.max,
      providerCostUsd: 400 * deepOp,
    },
    {
      // Priority scripts plus purchased-credit consumption and Apple channel
      // fees: Max subscriber buying the 600 pack, spending the entire pool
      // (1,200 included + 600 purchased) on priority scripts (150 scripts).
      id: 'priority_pack_buyer',
      channel: 'apple',
      revenueUsd: PLAN_PRICES_USD.max + PACK_600_PRICE_USD,
      providerCostUsd: 150 * priorityScript,
    },
  ];
}

function channelFeeUsd(rates, channel, revenueUsd) {
  if (channel === 'apple') return revenueUsd * (1 - rates.appleProceedsPct);
  return revenueUsd * rates.stripeFeePct + rates.stripeFeeFixedUsd;
}

export function computeEconomics(rates) {
  validateRateCard(rates);
  const profiles = buildProfiles(rates).map((profile) => {
    const channelFee = channelFeeUsd(rates, profile.channel, profile.revenueUsd);
    const refunds = profile.revenueUsd * rates.refundsPct;
    const taxes = profile.revenueUsd * rates.taxesPct;
    const totalCostUsd = profile.providerCostUsd
      + channelFee
      + refunds
      + taxes
      + rates.vpsAllocationUsdPerPaidUser;
    const marginUsd = profile.revenueUsd - totalCostUsd;
    return {
      ...profile,
      channelFeeUsd: channelFee,
      totalCostUsd,
      marginUsd,
      marginPct: profile.revenueUsd > 0 ? marginUsd / profile.revenueUsd : 0,
    };
  });

  const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
  const blendedMarginPct = sum(profiles, (p) => p.marginUsd) / sum(profiles, (p) => p.revenueUsd);
  const webProfiles = profiles.filter((p) => p.channel === 'web');
  const appleProfiles = profiles.filter((p) => p.channel === 'apple');
  const webMarginPct = webProfiles.length
    ? sum(webProfiles, (p) => p.marginUsd) / sum(webProfiles, (p) => p.revenueUsd)
    : null;
  const appleMarginPct = appleProfiles.length
    ? sum(appleProfiles, (p) => p.marginUsd) / sum(appleProfiles, (p) => p.revenueUsd)
    : null;

  const gates = {
    blendedAtLeast80: blendedMarginPct >= 0.80,
    webAtLeast80: webMarginPct !== null && webMarginPct >= 0.80,
    appleFloor: appleMarginPct === null || appleMarginPct >= 0.70,
  };
  const launchEligible = gates.blendedAtLeast80 && gates.webAtLeast80 && gates.appleFloor;

  return {
    rateCardVersion: rates.version,
    rateCardCapturedAt: rates.capturedAt,
    profiles,
    blendedMarginPct,
    webMarginPct,
    appleMarginPct,
    gates,
    launchEligible,
  };
}

function main() {
  const args = process.argv.slice(2);
  const ratesIndex = args.indexOf('--rates');
  if (ratesIndex === -1 || !args[ratesIndex + 1]) {
    console.error('usage: node scripts/economics-simulation.mjs --rates <rate-card.json> [--json]');
    process.exit(64);
  }
  let rates;
  try {
    rates = JSON.parse(readFileSync(args[ratesIndex + 1], 'utf8'));
  } catch (error) {
    console.error(`cannot read rate card: ${error.message}`);
    process.exit(1);
  }
  let result;
  try {
    result = computeEconomics(rates);
  } catch (error) {
    console.error(`economics simulation refused: ${error.message}`);
    process.exit(1);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const pct = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
    console.log(`rate card ${result.rateCardVersion} (${result.rateCardCapturedAt})`);
    for (const profile of result.profiles) {
      console.log(`  ${profile.id.padEnd(20)} ${profile.channel.padEnd(6)} margin ${pct(profile.marginPct)}`);
    }
    console.log(`blended ${pct(result.blendedMarginPct)} | web ${pct(result.webMarginPct)} | apple ${pct(result.appleMarginPct)}`);
    console.log(result.launchEligible ? '✅ economics gates pass' : '❌ economics gates FAIL — adjust routing, credit costs, allowances, or pack pricing');
  }
  process.exit(result.launchEligible ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
