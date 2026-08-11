import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_MANIFEST_SCHEMA_POLICY_PATH =
  'ops/nexus-release/release-manifest-schema-policy.json';
export const RELEASE_MANIFEST_SCHEMA_POLICY_SCHEMA =
  'nexus.release-manifest-schema-policy.v1';
export const RELEASE_MANIFEST_VERIFICATION_MODES = Object.freeze({
  CANDIDATE: 'candidate',
  RETAINED: 'retained',
});

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_GENERATIONS = 64;
const MAX_GENERATION = 1_000_000;
const TOP_LEVEL_FIELDS = Object.freeze([
  'schema',
  'writerGeneration',
  'candidateReaders',
  'retainedReaders',
  'generations',
]);
const GENERATION_FIELDS = Object.freeze([
  'generation',
  'envelopeSchema',
  'payloadSchema',
  'requiresControlPlane',
]);

function fail(message) {
  throw new Error(`release manifest schema policy ${message}`);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((field, index) => field !== wanted[index])) {
    fail(`${label} fields must be exactly ${wanted.join(', ')}`);
  }
  return value;
}

function assertGeneration(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GENERATION) {
    fail(`${label} must be an integer between 1 and ${MAX_GENERATION}`);
  }
  return value;
}

function assertSortedGenerationArray(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GENERATIONS) {
    fail(`${label} must be a non-empty array with at most ${MAX_GENERATIONS} entries`);
  }
  let previous = 0;
  return Object.freeze(value.map((entry, index) => {
    const generation = assertGeneration(entry, `${label}[${index}]`);
    if (generation <= previous) {
      fail(`${label} must be sorted ascending with unique generations`);
    }
    previous = generation;
    return generation;
  }));
}

function assertSchemaIdentity(value, expected, label) {
  if (typeof value !== 'string' || value !== expected) {
    fail(`${label} must be ${expected}`);
  }
  return value;
}

function assertGenerationRow(value, index) {
  const label = `generations[${index}]`;
  const row = assertExactKeys(value, GENERATION_FIELDS, label);
  const generation = assertGeneration(row.generation, `${label}.generation`);
  const envelopeSchema = assertSchemaIdentity(
    row.envelopeSchema,
    `nexus.release-manifest.v${generation}`,
    `${label}.envelopeSchema`,
  );
  const payloadSchema = assertSchemaIdentity(
    row.payloadSchema,
    `nexus.release-manifest-payload.v${generation}`,
    `${label}.payloadSchema`,
  );
  if (typeof row.requiresControlPlane !== 'boolean') {
    fail(`${label}.requiresControlPlane must be a boolean`);
  }
  if (generation === 2 && row.requiresControlPlane !== false) {
    fail(`${label}.requiresControlPlane must be false for retained generation 2`);
  }
  if (generation > 2 && row.requiresControlPlane !== true) {
    fail(`${label}.requiresControlPlane must remain true after generation 2`);
  }
  return Object.freeze({
    generation,
    envelopeSchema,
    payloadSchema,
    requiresControlPlane: row.requiresControlPlane,
  });
}

/**
 * Validate and normalize the complete policy without mutating caller input.
 * Unknown fields, implicit coercions, unsorted reader sets, and unknown
 * generation references all fail closed.
 */
export function assertReleaseManifestSchemaPolicyShape(value) {
  const policy = assertExactKeys(value, TOP_LEVEL_FIELDS, 'root');
  if (policy.schema !== RELEASE_MANIFEST_SCHEMA_POLICY_SCHEMA) {
    fail(`schema is unsupported; expected ${RELEASE_MANIFEST_SCHEMA_POLICY_SCHEMA}`);
  }

  const writerGeneration = assertGeneration(policy.writerGeneration, 'writerGeneration');
  const candidateReaders = assertSortedGenerationArray(
    policy.candidateReaders,
    'candidateReaders',
  );
  const retainedReaders = assertSortedGenerationArray(
    policy.retainedReaders,
    'retainedReaders',
  );
  if (!Array.isArray(policy.generations)
      || policy.generations.length < 1
      || policy.generations.length > MAX_GENERATIONS) {
    fail(`generations must be a non-empty array with at most ${MAX_GENERATIONS} rows`);
  }

  const generations = [];
  let previousGeneration = 0;
  for (let index = 0; index < policy.generations.length; index += 1) {
    const row = assertGenerationRow(policy.generations[index], index);
    if (row.generation <= previousGeneration) {
      fail('generations must be sorted ascending with unique generation rows');
    }
    previousGeneration = row.generation;
    generations.push(row);
  }
  const known = new Set(generations.map((row) => row.generation));
  for (const [label, readers] of [
    ['candidateReaders', candidateReaders],
    ['retainedReaders', retainedReaders],
  ]) {
    for (const generation of readers) {
      if (!known.has(generation)) {
        fail(`${label} references unknown generation ${generation}`);
      }
    }
  }
  for (const generation of candidateReaders) {
    if (!retainedReaders.includes(generation)) {
      fail(`candidate reader ${generation} must also be a retained reader`);
    }
  }
  if (!known.has(writerGeneration)) {
    fail(`writerGeneration references unknown generation ${writerGeneration}`);
  }
  if (!candidateReaders.includes(writerGeneration)) {
    fail(`writerGeneration ${writerGeneration} must be candidate-readable`);
  }

  return Object.freeze({
    schema: RELEASE_MANIFEST_SCHEMA_POLICY_SCHEMA,
    writerGeneration,
    candidateReaders,
    retainedReaders,
    generations: Object.freeze(generations),
  });
}

export function loadReleaseManifestSchemaPolicy(root = process.cwd()) {
  const policyPath = path.join(root, RELEASE_MANIFEST_SCHEMA_POLICY_PATH);
  let stat;
  try {
    stat = fs.lstatSync(policyPath);
  } catch {
    fail(`is missing at ${RELEASE_MANIFEST_SCHEMA_POLICY_PATH}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_POLICY_BYTES) {
    fail('must be a bounded regular file, not a symbolic link');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    fail('is not valid JSON');
  }
  return assertReleaseManifestSchemaPolicyShape(parsed);
}

export function getReleaseManifestGeneration(policy, generation) {
  const validated = assertReleaseManifestSchemaPolicyShape(policy);
  const exactGeneration = assertGeneration(generation, 'requested generation');
  const row = validated.generations.find((candidate) => (
    candidate.generation === exactGeneration
  ));
  if (!row) fail(`does not define generation ${exactGeneration}`);
  return row;
}

export function assertReleaseManifestGenerationReadable(policy, generation, mode) {
  const validated = assertReleaseManifestSchemaPolicyShape(policy);
  const exactGeneration = assertGeneration(generation, 'requested generation');
  let readers;
  if (mode === RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE) {
    readers = validated.candidateReaders;
  } else if (mode === RELEASE_MANIFEST_VERIFICATION_MODES.RETAINED) {
    readers = validated.retainedReaders;
  } else {
    fail(`verification mode is unsupported: ${String(mode)}`);
  }
  if (!readers.includes(exactGeneration)) {
    fail(`generation ${exactGeneration} is not readable in ${mode} mode`);
  }
  return getReleaseManifestGeneration(validated, exactGeneration);
}
