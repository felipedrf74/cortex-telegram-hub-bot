#!/usr/bin/env node
/**
 * Plan and verify bounded SonarQube backup retention from an AWS
 * list-objects-v2 response. Retention is counted by distinct UTC days or ISO
 * weeks, not by raw object count, so retries cannot consume policy slots.
 */

import fs from 'node:fs';

const usage = () => {
  process.stderr.write(
    'Usage: quality-sonar-retention.mjs <plan|verify|bind> ' +
      '--listing <list-objects-v2.json> --prefix <tier-prefix/> ' +
      '--tier <daily|weekly> --retain <count> ' +
      '[--protected-key <exact-data-key>] ' +
      '--output <new-json> [--plan <plan-json>] or ' +
      'bind --evidence <inventory-evidence> --attestations <jsonl> ' +
      '--output <new-json>\n',
  );
};

const fail = (message) => {
  throw new Error(`Sonar retention: ${message}`);
};

const parseArguments = (arguments_) => {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index];
    if (!key.startsWith('--') || index + 1 >= arguments_.length) {
      fail(`invalid argument ${key}`);
    }
    if (values.has(key)) fail(`duplicate argument ${key}`);
    values.set(key, arguments_[index + 1]);
    index += 1;
  }
  return values;
};

const required = (arguments_, key) => {
  const value = arguments_.get(key);
  if (typeof value !== 'string' || value.length === 0) {
    fail(`missing ${key}`);
  }
  return value;
};

const writeNewJson = (path, value) => {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
};

const escapeRegularExpression = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const formatTimestamp = (date) =>
  date
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('.000', '');

const isoWeek = (date) => {
  const working = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const weekday = working.getUTCDay() || 7;
  working.setUTCDate(working.getUTCDate() + 4 - weekday);
  const weekYear = working.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(
    ((working.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
};

const parseInventory = ({ listingPath, prefix, tier }) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/u.test(prefix)
      || prefix.includes('..') || prefix.includes('//')) {
    fail('prefix is unsafe');
  }
  if (!prefix.endsWith(`/${tier}/`)) {
    fail('prefix does not match the selected tier');
  }

  const listing = JSON.parse(fs.readFileSync(listingPath, 'utf8'));
  if (listing.IsTruncated === true || listing.NextContinuationToken) {
    fail('bounded S3 inventory is truncated');
  }
  if (listing.Contents !== undefined && !Array.isArray(listing.Contents)) {
    fail('S3 inventory Contents is not an array');
  }
  const contents = listing.Contents ?? [];
  if (contents.length > 1000) fail('S3 inventory exceeds the bounded limit');

  const dataPattern = new RegExp(
    `^${escapeRegularExpression(prefix)}` +
      '(nexus-sonarqube-' +
      '([0-9]{8}T[0-9]{6}Z)' +
      '\\.dump\\.age)$',
    'u',
  );
  const seen = new Set();
  const data = new Map();
  const checksumKeys = new Set();

  for (const item of contents) {
    const key = item?.Key;
    if (typeof key !== 'string' || !key.startsWith(prefix)) {
      fail('S3 inventory contains an invalid key');
    }
    if (seen.has(key)) fail(`S3 inventory repeats key ${key}`);
    seen.add(key);

    const candidate = key.endsWith('.sha256') ? key.slice(0, -7) : key;
    const match = dataPattern.exec(candidate);
    if (!match) fail(`unexpected object in governed prefix: ${key}`);
    const timestamp = match[2];
    const date = new Date(
      `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-` +
        `${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:` +
        `${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}Z`,
    );
    if (!Number.isFinite(date.getTime()) || formatTimestamp(date) !== timestamp) {
      fail(`object timestamp is invalid: ${key}`);
    }

    if (key.endsWith('.sha256')) {
      checksumKeys.add(key);
    } else {
      data.set(key, {
        key,
        checksumKey: `${key}.sha256`,
        timestamp,
        period:
          tier === 'daily'
            ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`
            : isoWeek(date),
      });
    }
  }

  return { data, checksumKeys, allKeys: seen };
};

const buildPlan = ({
  listingPath,
  prefix,
  tier,
  retain,
  protectedKey,
}) => {
  const inventory = parseInventory({ listingPath, prefix, tier });
  const complete = [...inventory.data.values()]
    .filter((item) => inventory.checksumKeys.has(item.checksumKey))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  const newestByPeriod = new Map();
  for (const item of complete) {
    if (!newestByPeriod.has(item.period)) {
      newestByPeriod.set(item.period, item);
    }
  }
  const selected = [...newestByPeriod.values()].slice(0, retain);
  const selectedKeys = selected.map((item) => item.key);
  const selectedPeriods = selected.map((item) => item.period);
  const keep = new Set(
    selected.flatMap((item) => [item.key, item.checksumKey]),
  );
  const deleteKeys = [...inventory.allKeys]
    .filter((key) => !keep.has(key))
    .sort();

  if (protectedKey !== null) {
    if (!inventory.data.has(protectedKey)
        || !inventory.checksumKeys.has(`${protectedKey}.sha256`)) {
      fail('protected backup is not a complete data/checksum pair');
    }
    if (!selectedKeys.includes(protectedKey)) {
      fail('protected backup would not survive distinct-period retention');
    }
  }

  return {
    schemaVersion: 'SonarRetentionPlanV1',
    tier,
    periodKind: tier === 'daily' ? 'utc-day' : 'iso-week',
    targetDistinctPeriods: retain,
    protectedKey,
    selectedPeriods,
    selectedKeys,
    deleteKeys,
    inputObjectCount: inventory.allKeys.size,
  };
};

const validateTierAndRetain = (arguments_) => {
  const tier = required(arguments_, '--tier');
  if (tier !== 'daily' && tier !== 'weekly') fail('tier must be daily or weekly');
  const retain = Number(required(arguments_, '--retain'));
  const expected = tier === 'daily' ? 7 : 4;
  if (!Number.isSafeInteger(retain) || retain !== expected) {
    fail(`${tier} retention must be ${expected} distinct periods`);
  }
  return { tier, retain };
};

const command = process.argv[2];
if (command !== 'plan' && command !== 'verify' && command !== 'bind') {
  usage();
  process.exit(64);
}

try {
  const arguments_ = parseArguments(process.argv.slice(3));
  if (command === 'bind') {
    const allowed = new Set(['--evidence', '--attestations', '--output']);
    for (const key of arguments_.keys()) {
      if (!allowed.has(key)) fail(`unknown argument ${key}`);
    }
    const evidencePath = required(arguments_, '--evidence');
    const attestationsPath = required(arguments_, '--attestations');
    const output = required(arguments_, '--output');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    if (evidence.schemaVersion !== 'SonarRetentionEvidenceV1'
        || (evidence.tier !== 'daily' && evidence.tier !== 'weekly')
        || !Array.isArray(evidence.selectedPeriods)
        || !Array.isArray(evidence.selectedKeys)
        || evidence.selectedPeriods.length !== evidence.selectedKeys.length
        || evidence.completePairNamesVerified !== true
        || evidence.completePairsVerified !== false
        || evidence.excessObjectsAbsent !== true) {
      fail('inventory retention evidence is invalid');
    }
    const body = fs.readFileSync(attestationsPath, 'utf8');
    const points = body.length === 0
      ? []
      : body
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    if (points.length !== evidence.selectedKeys.length) {
      fail('remote pair attestations do not cover every selected point');
    }
    const opaqueVersionId = (value) => {
      if (typeof value !== 'string' || value === 'null') return false;
      const encoded = Buffer.from(value, 'utf8');
      return encoded.length >= 1
        && encoded.length <= 1024
        && encoded.toString('utf8') === value
        && !/[\u0000-\u001f\u007f]/u.test(value);
    };
    const base64Sha256 = /^[A-Za-z0-9+/]{43}=$/u;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (point?.schemaVersion !== 'SonarRetentionPointV1'
          || point.tier !== evidence.tier
          || point.period !== evidence.selectedPeriods[index]
          || point.key !== evidence.selectedKeys[index]
          || point.checksumKey !== `${point.key}.sha256`
          || !opaqueVersionId(point.dataVersionId)
          || !opaqueVersionId(point.checksumVersionId)
          || !/^[a-f0-9]{64}$/u.test(point.encryptedSha256 || '')
          || !base64Sha256.test(point.dataChecksumSha256 || '')
          || !base64Sha256.test(point.checksumObjectChecksumSha256 || '')
          || Buffer.from(point.dataChecksumSha256, 'base64').toString('hex')
            !== point.encryptedSha256
          || !Number.isSafeInteger(point.encryptedSizeBytes)
          || point.encryptedSizeBytes <= 0
          || !Number.isSafeInteger(point.checksumSizeBytes)
          || point.checksumSizeBytes <= 0
          || point.checksumSizeBytes > 4096) {
        fail(`remote pair attestation ${index} is invalid`);
      }
    }
    writeNewJson(output, {
      ...evidence,
      inventoryVerifiedAt: evidence.verifiedAt,
      selectedPoints: points,
      completePairsVerified: true,
      remotePairsVerified: true,
      postPruneVerified: true,
      verifiedAt: new Date().toISOString(),
    });
    process.exit(0);
  }

  const allowed = new Set([
    '--listing',
    '--prefix',
    '--tier',
    '--retain',
    '--output',
    ...(command === 'plan' ? ['--protected-key'] : ['--plan']),
  ]);
  for (const key of arguments_.keys()) {
    if (!allowed.has(key)) fail(`unknown argument ${key}`);
  }
  const listingPath = required(arguments_, '--listing');
  const prefix = required(arguments_, '--prefix');
  const output = required(arguments_, '--output');
  const { tier, retain } = validateTierAndRetain(arguments_);

  if (command === 'plan') {
    const protectedKey = arguments_.has('--protected-key')
      ? required(arguments_, '--protected-key')
      : null;
    const plan = buildPlan({
      listingPath,
      prefix,
      tier,
      retain,
      protectedKey,
    });
    writeNewJson(output, plan);
  } else {
    const planPath = required(arguments_, '--plan');
    const expectedPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    if (expectedPlan.schemaVersion !== 'SonarRetentionPlanV1'
        || expectedPlan.tier !== tier
        || expectedPlan.targetDistinctPeriods !== retain
        || !Array.isArray(expectedPlan.selectedPeriods)
        || !Array.isArray(expectedPlan.selectedKeys)
        || !Array.isArray(expectedPlan.deleteKeys)
        || (expectedPlan.protectedKey !== null
          && typeof expectedPlan.protectedKey !== 'string')) {
      fail('retention plan is invalid');
    }
    const observedPlan = buildPlan({
      listingPath,
      prefix,
      tier,
      retain,
      protectedKey: expectedPlan.protectedKey,
    });
    if (observedPlan.deleteKeys.length !== 0
        || JSON.stringify(observedPlan.selectedPeriods)
          !== JSON.stringify(expectedPlan.selectedPeriods)
        || JSON.stringify(observedPlan.selectedKeys)
          !== JSON.stringify(expectedPlan.selectedKeys)) {
      fail('post-prune S3 inventory differs from the retention plan');
    }

    writeNewJson(output, {
      schemaVersion: 'SonarRetentionEvidenceV1',
      tier,
      periodKind: observedPlan.periodKind,
      targetDistinctPeriods: retain,
      retainedDistinctPeriods: observedPlan.selectedPeriods.length,
      targetReached: observedPlan.selectedPeriods.length === retain,
      maturityStatus:
        observedPlan.selectedPeriods.length === retain ? 'mature' : 'warming',
      selectedPeriods: observedPlan.selectedPeriods,
      selectedKeys: observedPlan.selectedKeys,
      protectedKeyVerified:
        observedPlan.protectedKey !== null
        && observedPlan.selectedKeys.includes(observedPlan.protectedKey),
      completePairNamesVerified: true,
      completePairsVerified: false,
      remotePairsVerified: false,
      postPruneVerified: true,
      excessObjectsAbsent: true,
      verifiedAt: new Date().toISOString(),
    });
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
