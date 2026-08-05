import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROUTING_SYNTHETIC_QA_MANIFEST_SCHEMA = 'nexus.routing-synthetic-qa-manifest.v1';
export const ROUTING_SYNTHETIC_QA_CONTRACT_VERSION = 'routing-synthetic-qa-v1';
export const ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS = 'owner_authorized_synthetic_staging_qa';
export const ROUTING_SYNTHETIC_QA_SURFACES = Object.freeze([
  'classifierKeyword',
  'orchestratorPrimary',
  'shadowRoute',
  'registrySubset',
]);

const EXPECTED_RESOLVER_SKILL_DOMAIN = Object.freeze({
  secretary: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
});

const FIVE_DOMAIN_PROFILE = {
  expectedDomains: {
    secretary: 68,
    triathlon: 39,
    content: 32,
    cooking: 32,
    finance: 29,
  },
  expectedResolverSkills: {
    secretary: 68,
    training: 39,
    content: 32,
    cooking: 32,
    finance: 29,
  },
  expectedDomainsByLocale: {
    'en-US': { secretary: 34, triathlon: 20, content: 16, cooking: 16, finance: 14 },
    'pt-BR': { secretary: 20, triathlon: 12, content: 10, cooking: 10, finance: 8 },
    'pt-PT': { secretary: 14, triathlon: 7, content: 6, cooking: 6, finance: 7 },
  },
};

const EIGHT_DOMAIN_PROFILE = {
  expectedDomains: {
    secretary: 53,
    triathlon: 30,
    content: 25,
    cooking: 25,
    finance: 23,
    connections: 17,
    notifications: 14,
    decision_center: 13,
  },
  expectedResolverSkills: {
    secretary: 53,
    training: 30,
    content: 25,
    cooking: 25,
    finance: 23,
    connections: 17,
    notifications: 14,
    decision_center: 13,
  },
  expectedDomainsByLocale: {
    'en-US': {
      secretary: 27,
      triathlon: 15,
      content: 13,
      cooking: 12,
      finance: 11,
      connections: 8,
      notifications: 7,
      decision_center: 7,
    },
    'pt-BR': {
      secretary: 16,
      triathlon: 9,
      content: 7,
      cooking: 8,
      finance: 7,
      connections: 5,
      notifications: 4,
      decision_center: 4,
    },
    'pt-PT': {
      secretary: 10,
      triathlon: 6,
      content: 5,
      cooking: 5,
      finance: 5,
      connections: 4,
      notifications: 3,
      decision_center: 2,
    },
  },
};

/**
 * Fixed before traffic. A surface only receives labels its runtime resolver
 * can actually emit. `scenarioGroupId` below is an editorial authoring aid;
 * all 200 texts are standalone requests and no conversational behavior is
 * claimed or relied upon.
 */
export const ROUTING_SYNTHETIC_QA_QUOTAS = deepFreeze({
  plannedTurns: 200,
  locales: {
    'en-US': 100,
    'pt-BR': 60,
    'pt-PT': 40,
  },
  strata: {
    deterministic_state_read: 80,
    missing_field_clarification: 45,
    safe_write_preview_decline: 35,
    restricted_side_effect_boundary: 20,
    cross_skill_preview: 10,
    domain_anchored_noop: 10,
  },
  scenarioGroupsByLocale: {
    'en-US': { 2: 20, 3: 20 },
    'pt-BR': { 2: 15, 3: 10 },
    'pt-PT': { 2: 14, 3: 4 },
  },
  scenarioGroups: {
    total: 83,
    2: 49,
    3: 34,
  },
  surfaces: {
    classifierKeyword: FIVE_DOMAIN_PROFILE,
    orchestratorPrimary: FIVE_DOMAIN_PROFILE,
    shadowRoute: EIGHT_DOMAIN_PROFILE,
    registrySubset: EIGHT_DOMAIN_PROFILE,
  },
});

const TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'contractVersion',
  'trafficClass',
  'runtimeSha',
  'artifactDigest',
  'environment',
  'surface',
  'userId',
  'tenantId',
  'plannedTurns',
  'referenceSources',
  'predecessorManifestSha256s',
  'turns',
]);

const TURN_KEYS = Object.freeze([
  'ordinal',
  'id',
  'scenarioGroupId',
  'text',
  'locale',
  'expectedDomain',
  'expectedResolverSkill',
  'stratum',
  'standalone',
]);

const REFERENCE_SOURCE_KEYS = Object.freeze(['kind', 'sha256', 'textCount']);
const REFERENCE_SOURCE_KINDS = Object.freeze([
  'routing_corpus',
  'chat_eval_fixtures',
  'qa_history',
]);
const REQUIRED_REFERENCE_SOURCE_KINDS = Object.freeze([
  'routing_corpus',
  'chat_eval_fixtures',
]);

const REFERENCE_TEXT_KEYS = new Set([
  'text',
  'utteranceText',
  'utterance_text',
  'prompt',
  'message',
  'sourceText',
  'source_text',
  'pt',
  'en',
]);

const FULL_RUNTIME_SHA = /^[0-9a-f]{40}$/u;
const FULL_ARTIFACT_DIGEST = /^[0-9a-f]{64}$/u;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

// Deliberately bounded to markers that are not ordinary English/Portuguese
// vocabulary. This is a fail-closed supported-locale gate, not a claim of
// general language identification.
const SPANISH_MARKER = /[¿¡ñÑ]|\b(?:tareas?|entrenamiento|correo|reuni[oó]n|ma[ñn]ana|hoy|ayer|puedes?|quiero|necesito|borrar|notificaciones|decisión|receta|gimnasio)\b/iu;

export function getRoutingSyntheticQaSurfaceQuota(surface) {
  if (!ROUTING_SYNTHETIC_QA_SURFACES.includes(surface)) {
    throw new Error('surface must select one governed routing-divergence surface');
  }
  return ROUTING_SYNTHETIC_QA_QUOTAS.surfaces[surface];
}

export function validateRoutingSyntheticQaManifest(value, options = {}) {
  assertPlainObject(value, 'manifest');
  assertExactKeys(value, TOP_LEVEL_KEYS, 'manifest');
  assertEqual(value.schema, ROUTING_SYNTHETIC_QA_MANIFEST_SCHEMA, 'manifest schema');
  assertEqual(value.contractVersion, ROUTING_SYNTHETIC_QA_CONTRACT_VERSION, 'contractVersion');
  assertEqual(value.trafficClass, ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS, 'trafficClass');
  assertStringMatch(value.runtimeSha, FULL_RUNTIME_SHA, 'runtimeSha');
  assertStringMatch(value.artifactDigest, FULL_ARTIFACT_DIGEST, 'artifactDigest');
  assertEqual(value.environment, 'staging', 'environment');
  if (!ROUTING_SYNTHETIC_QA_SURFACES.includes(value.surface)) {
    throw new Error('surface must select one governed routing-divergence surface');
  }
  assertCanonicalPositiveId(value.userId, 'userId');
  assertCanonicalPositiveId(value.tenantId, 'tenantId');
  if (value.userId !== value.tenantId) {
    throw new Error('dedicated user and tenant must be the same positive canonical ID');
  }
  assertEqual(value.plannedTurns, ROUTING_SYNTHETIC_QA_QUOTAS.plannedTurns, 'plannedTurns');
  const referenceSources = validateReferenceSources(value.referenceSources);
  const predecessorManifestSha256s = validatePredecessorManifestSha256s(
    value.predecessorManifestSha256s,
    value.surface,
  );

  bindExpected(value, options);

  if (!Array.isArray(value.turns) || value.turns.length !== ROUTING_SYNTHETIC_QA_QUOTAS.plannedTurns) {
    throw new Error(`turns must contain exactly ${ROUTING_SYNTHETIC_QA_QUOTAS.plannedTurns} ordered rows`);
  }

  const seenIds = new Set();
  const seenNormalizedTexts = new Map();
  const rows = value.turns.map((turn, index) => validateTurn(turn, index, seenIds, seenNormalizedTexts));
  validateQuotas(rows, value.surface);
  const scenarioGroupSummary = validateScenarioGroups(rows);
  validateAntiLeakage(rows, options.referenceTexts ?? []);

  // Construct from allowlisted fields so callers never receive unclassified
  // prototype or descriptor state from the parsed input object.
  const manifest = {
    schema: value.schema,
    contractVersion: value.contractVersion,
    trafficClass: value.trafficClass,
    runtimeSha: value.runtimeSha,
    artifactDigest: value.artifactDigest,
    environment: value.environment,
    surface: value.surface,
    userId: value.userId,
    tenantId: value.tenantId,
    plannedTurns: value.plannedTurns,
    referenceSources: referenceSources.map((source) => ({ ...source })),
    predecessorManifestSha256s: [...predecessorManifestSha256s],
    turns: rows.map((turn) => ({ ...turn })),
  };

  return {
    manifest,
    summary: {
      plannedTurns: rows.length,
      providerCallsAllowed: 0,
      standaloneTurns: rows.length,
      scenarioGroups: scenarioGroupSummary.total,
      twoTurnScenarioGroups: scenarioGroupSummary[2],
      threeTurnScenarioGroups: scenarioGroupSummary[3],
      locales: countBy(rows, (row) => row.locale),
      expectedDomains: countBy(rows, (row) => row.expectedDomain),
      expectedResolverSkills: countBy(rows, (row) => row.expectedResolverSkill),
      strata: countBy(rows, (row) => row.stratum),
      referenceSources: referenceSources.map((source) => ({ ...source })),
      predecessorManifestSha256s: [...predecessorManifestSha256s],
      referenceTextsChecked: options.referenceTexts?.length ?? 0,
    },
  };
}

export function buildRoutingSyntheticQaManifest(value, options = {}) {
  const validated = validateRoutingSyntheticQaManifest(value, options);
  // Fixed construction order above is the wire-canonical order consumed by
  // the installed report/runner. Do not sort keys here: raw file bytes are the
  // evidence identity from which request IDs are derived.
  const bytes = `${JSON.stringify(validated.manifest)}\n`;
  return {
    ...validated,
    bytes,
    sha256: sha256Hex(bytes),
  };
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeQaText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .match(/[a-z0-9]+/gu)?.join(' ') ?? '';
}

export function fourGramJaccard(left, right) {
  const leftSet = ngramSet(tokenize(left), 4);
  const rightSet = ngramSet(tokenize(right), 4);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const gram of leftSet) if (rightSet.has(gram)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

export function loadReferenceTexts(specifications) {
  if (!Array.isArray(specifications)) throw new Error('reference specifications must be an array');
  const texts = [];
  const sources = [];
  const seenKinds = new Set();
  for (const specification of specifications) {
    if (typeof specification !== 'string') {
      throw new Error('each reference must use the typed kind=path form');
    }
    const separator = specification.indexOf('=');
    if (separator <= 0 || separator === specification.length - 1) {
      throw new Error('each reference must use the typed kind=path form');
    }
    const kind = specification.slice(0, separator);
    const inputPath = specification.slice(separator + 1);
    if (!REFERENCE_SOURCE_KINDS.includes(kind)) {
      throw new Error(`unsupported reference kind: ${kind}`);
    }
    if (seenKinds.has(kind)) throw new Error(`duplicate reference kind: ${kind}`);
    seenKinds.add(kind);
    const absolute = path.resolve(inputPath);
    const bytes = readPrivateFile(absolute, `reference source ${kind}`);
    const content = bytes.toString('utf8');
    const before = texts.length;
    if (absolute.endsWith('.json')) {
      collectReferenceTexts(JSON.parse(content), texts, null, true);
    } else if (absolute.endsWith('.jsonl')) {
      for (const [index, line] of content.split(/\r?\n/u).entries()) {
        if (!line.trim()) continue;
        try {
          collectReferenceTexts(JSON.parse(line), texts, null, true);
        } catch {
          throw new Error(`invalid JSONL reference row ${index + 1} in ${path.basename(absolute)}`);
        }
      }
    } else {
      for (const line of content.split(/\r?\n/u)) {
        if (line.trim()) texts.push(line.trim());
      }
    }
    const textCount = texts.length - before;
    if (textCount < 1) throw new Error(`reference source ${kind} must contain at least one supported text`);
    sources.push({
      kind,
      sha256: `sha256:${sha256Hex(bytes)}`,
      textCount,
    });
  }
  for (const requiredKind of REQUIRED_REFERENCE_SOURCE_KINDS) {
    if (!seenKinds.has(requiredKind)) throw new Error(`reference kind ${requiredKind} is required`);
  }
  sources.sort((left, right) => (
    REFERENCE_SOURCE_KINDS.indexOf(left.kind) - REFERENCE_SOURCE_KINDS.indexOf(right.kind)
  ));
  return { texts, sources };
}

function validateReferenceSources(value) {
  if (!Array.isArray(value)) throw new Error('referenceSources must be an array');
  const seenKinds = new Set();
  let previousKindIndex = -1;
  const sources = value.map((source, index) => {
    assertPlainObject(source, `reference source ${index + 1}`);
    assertExactKeys(source, REFERENCE_SOURCE_KEYS, `reference source ${index + 1}`);
    if (!REFERENCE_SOURCE_KINDS.includes(source.kind)) {
      throw new Error(`reference source ${index + 1} kind is not governed`);
    }
    const kindIndex = REFERENCE_SOURCE_KINDS.indexOf(source.kind);
    if (kindIndex <= previousKindIndex) {
      throw new Error('referenceSources must use unique kinds in governed canonical order');
    }
    previousKindIndex = kindIndex;
    seenKinds.add(source.kind);
    assertStringMatch(source.sha256, PREFIXED_SHA256, `reference source ${source.kind} sha256`);
    if (!Number.isSafeInteger(source.textCount) || source.textCount < 1) {
      throw new Error(`reference source ${source.kind} textCount must be a positive safe integer`);
    }
    return {
      kind: source.kind,
      sha256: source.sha256,
      textCount: source.textCount,
    };
  });
  for (const requiredKind of REQUIRED_REFERENCE_SOURCE_KINDS) {
    if (!seenKinds.has(requiredKind)) throw new Error(`reference source ${requiredKind} is required`);
  }
  return sources;
}

function validatePredecessorManifestSha256s(value, surface) {
  if (!Array.isArray(value)) throw new Error('predecessorManifestSha256s must be an array');
  const expectedCount = ROUTING_SYNTHETIC_QA_SURFACES.indexOf(surface);
  if (value.length !== expectedCount) {
    throw new Error(`surface ${surface} requires exactly ${expectedCount} predecessor manifest digests`);
  }
  const seen = new Set();
  return value.map((digest, index) => {
    assertStringMatch(digest, PREFIXED_SHA256, `predecessor manifest digest ${index + 1}`);
    if (seen.has(digest)) throw new Error('predecessor manifest digests must be unique and ordered');
    seen.add(digest);
    return digest;
  });
}

function validateTurn(turn, index, seenIds, seenNormalizedTexts) {
  assertPlainObject(turn, `turn ${index + 1}`);
  assertExactKeys(turn, TURN_KEYS, `turn ${index + 1}`);
  if (turn.ordinal !== index + 1) throw new Error(`turn ordinal must be ${index + 1}`);
  assertStringMatch(turn.id, SAFE_ROW_ID, `turn ${index + 1} id`);
  if (seenIds.has(turn.id)) throw new Error(`turn id is not unique at ordinal ${index + 1}`);
  seenIds.add(turn.id);
  assertStringMatch(turn.scenarioGroupId, SAFE_ROW_ID, `turn ${index + 1} scenarioGroupId`);
  if (typeof turn.text !== 'string' || turn.text !== turn.text.trim() || turn.text.length < 12 || turn.text.length > 600) {
    throw new Error(`turn ${index + 1} text must be trimmed and 12-600 characters`);
  }
  if (CONTROL_CHARACTER.test(turn.text)) throw new Error(`turn ${index + 1} text contains a control character`);
  if (SPANISH_MARKER.test(turn.text)) throw new Error(`turn ${index + 1} text contains a retired Spanish marker`);
  const normalized = normalizeQaText(turn.text);
  if (normalized.split(' ').length < 4) throw new Error(`turn ${index + 1} text must contain at least four normalized tokens`);
  if (seenNormalizedTexts.has(normalized)) {
    throw new Error(`turn normalized text is not unique at ordinals ${seenNormalizedTexts.get(normalized)} and ${index + 1}`);
  }
  seenNormalizedTexts.set(normalized, index + 1);
  if (!Object.hasOwn(ROUTING_SYNTHETIC_QA_QUOTAS.locales, turn.locale)) {
    throw new Error(`turn ${index + 1} locale is not supported`);
  }
  if (!Object.hasOwn(EXPECTED_RESOLVER_SKILL_DOMAIN, turn.expectedResolverSkill)) {
    throw new Error(`turn ${index + 1} expectedResolverSkill is not governed`);
  }
  if (EXPECTED_RESOLVER_SKILL_DOMAIN[turn.expectedResolverSkill] !== turn.expectedDomain) {
    throw new Error(`turn ${index + 1} expectedDomain does not match expectedResolverSkill`);
  }
  if (!Object.hasOwn(ROUTING_SYNTHETIC_QA_QUOTAS.strata, turn.stratum)) {
    throw new Error(`turn ${index + 1} stratum is not governed`);
  }
  if (turn.standalone !== true) {
    throw new Error(`turn ${index + 1} standalone must equal true`);
  }
  return {
    ordinal: turn.ordinal,
    id: turn.id,
    scenarioGroupId: turn.scenarioGroupId,
    text: turn.text,
    locale: turn.locale,
    expectedDomain: turn.expectedDomain,
    expectedResolverSkill: turn.expectedResolverSkill,
    stratum: turn.stratum,
    standalone: true,
  };
}

function validateQuotas(rows, surface) {
  const profile = getRoutingSyntheticQaSurfaceQuota(surface);
  assertCountMap(countBy(rows, (row) => row.locale), ROUTING_SYNTHETIC_QA_QUOTAS.locales, 'locale quota');
  assertCountMap(countBy(rows, (row) => row.expectedDomain), profile.expectedDomains, 'expected domain quota');
  assertCountMap(
    countBy(rows, (row) => row.expectedResolverSkill),
    profile.expectedResolverSkills,
    'expected resolver skill quota',
  );
  assertCountMap(countBy(rows, (row) => row.stratum), ROUTING_SYNTHETIC_QA_QUOTAS.strata, 'stratum quota');
  for (const [locale, expected] of Object.entries(profile.expectedDomainsByLocale)) {
    assertCountMap(
      countBy(rows.filter((row) => row.locale === locale), (row) => row.expectedDomain),
      expected,
      `${locale} domain-by-locale quota`,
    );
  }
}

function validateScenarioGroups(rows) {
  const groups = new Map();
  let previousScenarioGroupId = null;
  const closed = new Set();
  for (const row of rows) {
    if (row.scenarioGroupId !== previousScenarioGroupId) {
      if (closed.has(row.scenarioGroupId)) {
        throw new Error(`editorial scenario group ${row.scenarioGroupId} is not contiguous in ordered turns`);
      }
      if (previousScenarioGroupId !== null) closed.add(previousScenarioGroupId);
      previousScenarioGroupId = row.scenarioGroupId;
    }
    const group = groups.get(row.scenarioGroupId) ?? [];
    group.push(row);
    groups.set(row.scenarioGroupId, group);
  }
  const summary = { total: groups.size, 2: 0, 3: 0 };
  const byLocale = Object.fromEntries(Object.keys(ROUTING_SYNTHETIC_QA_QUOTAS.locales).map((locale) => [locale, { 2: 0, 3: 0 }]));
  for (const [scenarioGroupId, turns] of groups) {
    if (turns.length !== 2 && turns.length !== 3) {
      throw new Error(`editorial scenario group ${scenarioGroupId} must contain exactly two or three standalone turns`);
    }
    const locales = new Set(turns.map((turn) => turn.locale));
    if (locales.size !== 1) throw new Error(`editorial scenario group ${scenarioGroupId} must keep one supported locale`);
    summary[turns.length] += 1;
    byLocale[turns[0].locale][turns.length] += 1;
  }
  if (summary.total !== ROUTING_SYNTHETIC_QA_QUOTAS.scenarioGroups.total
    || summary[2] !== ROUTING_SYNTHETIC_QA_QUOTAS.scenarioGroups[2]
    || summary[3] !== ROUTING_SYNTHETIC_QA_QUOTAS.scenarioGroups[3]) {
    throw new Error('scenario-group shape quota does not match the fixed 83-group editorial plan');
  }
  for (const [locale, expected] of Object.entries(ROUTING_SYNTHETIC_QA_QUOTAS.scenarioGroupsByLocale)) {
    assertCountMap(byLocale[locale], expected, `${locale} scenario-group quota`);
  }
  return summary;
}

function validateAntiLeakage(rows, referenceTexts) {
  if (!Array.isArray(referenceTexts) || referenceTexts.some((text) => typeof text !== 'string')) {
    throw new Error('referenceTexts must be an array of strings');
  }
  const references = referenceTexts
    .map((text, index) => ({ index: index + 1, normalized: normalizeQaText(text), tokens: tokenize(text) }))
    .filter((entry) => entry.normalized.length > 0);
  const exactReferences = new Map(references.map((entry) => [entry.normalized, entry.index]));

  for (const row of rows) {
    const normalized = normalizeQaText(row.text);
    if (exactReferences.has(normalized)) {
      throw new Error(`turn ${row.ordinal} has a normalized exact reference match`);
    }
    const rowTokens = tokenize(row.text);
    for (const reference of references) {
      if (hasSharedNgram(rowTokens, reference.tokens, 8)) {
        throw new Error(`turn ${row.ordinal} has a shared contiguous 8-token passage with reference ${reference.index}`);
      }
      if (fourGramJaccard(row.text, reference.normalized) >= 0.65) {
        throw new Error(`turn ${row.ordinal} exceeds the 0.65 reference 4-gram similarity ceiling`);
      }
    }
  }

  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const leftTokens = tokenize(rows[left].text);
      const rightTokens = tokenize(rows[right].text);
      if (hasSharedNgram(leftTokens, rightTokens, 8)) {
        throw new Error(`within-manifest 8-token overlap at ordinals ${left + 1} and ${right + 1}`);
      }
      if (fourGramJaccard(rows[left].text, rows[right].text) >= 0.70) {
        throw new Error(`within-manifest 4-gram similarity reaches 0.70 at ordinals ${left + 1} and ${right + 1}`);
      }
    }
  }
}

function bindExpected(value, options) {
  const bindings = [
    ['expectedRuntimeSha', 'runtimeSha', 'runtime SHA'],
    ['expectedArtifactDigest', 'artifactDigest', 'artifact digest'],
    ['expectedSurface', 'surface', 'surface'],
  ];
  for (const [option, field, label] of bindings) {
    if (options[option] !== undefined && options[option] !== value[field]) {
      throw new Error(`${label} does not match operator binding`);
    }
  }
  if (options.expectedDedicatedId !== undefined) {
    const expectedDedicatedId = Number(options.expectedDedicatedId);
    if (!Number.isSafeInteger(expectedDedicatedId)
        || expectedDedicatedId < 1
        || String(expectedDedicatedId) !== String(options.expectedDedicatedId)
        || expectedDedicatedId !== value.userId
        || expectedDedicatedId !== value.tenantId) {
      throw new Error('dedicated ID does not match user and tenant binding');
    }
  }
  if (options.expectedReferenceSources !== undefined
    && canonicalJson(options.expectedReferenceSources) !== canonicalJson(value.referenceSources)) {
    throw new Error('reference source lineage does not match operator-derived binding');
  }
  if (options.expectedPredecessorManifestSha256s !== undefined
    && canonicalJson(options.expectedPredecessorManifestSha256s)
      !== canonicalJson(value.predecessorManifestSha256s)) {
    throw new Error('predecessor manifest lineage does not match operator-derived binding');
  }
}

function collectReferenceTexts(value, output, key, rootArray = false) {
  if (typeof value === 'string') {
    if (rootArray || (key !== null && REFERENCE_TEXT_KEYS.has(key))) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceTexts(item, output, key, rootArray || key === null);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) {
    collectReferenceTexts(child, output, childKey, false);
  }
}

function tokenize(value) {
  const normalized = normalizeQaText(value);
  return normalized ? normalized.split(' ') : [];
}

function ngramSet(tokens, width) {
  const result = new Set();
  for (let index = 0; index + width <= tokens.length; index += 1) {
    result.add(tokens.slice(index, index + width).join('\u0000'));
  }
  return result;
}

function hasSharedNgram(leftTokens, rightTokens, width) {
  if (leftTokens.length < width || rightTokens.length < width) return false;
  const left = ngramSet(leftTokens, width);
  for (let index = 0; index + width <= rightTokens.length; index += 1) {
    if (left.has(rightTokens.slice(index, index + width).join('\u0000'))) return true;
  }
  return false;
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = selector(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function assertCountMap(actual, expected, label) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) throw new Error(`${label} has unexpected categories`);
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) throw new Error(`${label} for ${key} must equal ${expected[key]}`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain JSON object`);
  }
}

function assertExactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} fields must match the governed schema exactly`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must equal ${String(expected)}`);
}

function assertStringMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
}

function assertCanonicalPositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function readPrivateFile(absolute, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be an accessible regular non-symlink file`, { cause: error });
  }
  try {
    assertPrivateFileStat(fs.fstatSync(descriptor), label);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateFileStat(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (stat.nlink !== 1) throw new Error(`${label} must have link count 1`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current uid`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
