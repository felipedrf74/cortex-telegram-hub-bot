#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROUTING_SYNTHETIC_QA_MANIFEST_SCHEMA,
  ROUTING_SYNTHETIC_QA_SURFACES,
  buildRoutingSyntheticQaManifest,
  canonicalJson,
  loadReferenceTexts,
  sha256Hex,
} from './lib/routing-synthetic-qa-manifest.mjs';

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputPath = required(args, 'input');
  const outputPath = required(args, 'output');
  const expectedRuntimeSha = required(args, 'runtime-sha');
  const expectedArtifactDigest = required(args, 'artifact-digest');
  const expectedSurface = required(args, 'surface');
  const expectedDedicatedId = parseDedicatedId(required(args, 'dedicated-id'));
  const draft = readPrivateJson(inputPath);
  for (const generatedField of ['referenceSources', 'predecessorManifestSha256s']) {
    if (Object.hasOwn(draft, generatedField)) {
      throw new Error(`input draft must not provide operator-derived lineage field ${generatedField}`);
    }
  }
  const references = loadReferenceTexts(args.reference ?? []);
  const predecessors = loadPredecessorManifests(args['predecessor-manifest'] ?? [], {
    expectedRuntimeSha,
    expectedArtifactDigest,
    expectedSurface,
    expectedDedicatedId,
  });
  const result = buildRoutingSyntheticQaManifest({
    ...draft,
    referenceSources: references.sources,
    predecessorManifestSha256s: predecessors.sha256s,
  }, {
    referenceTexts: [...references.texts, ...predecessors.texts],
    expectedRuntimeSha,
    expectedArtifactDigest,
    expectedSurface,
    expectedDedicatedId,
    expectedReferenceSources: references.sources,
    expectedPredecessorManifestSha256s: predecessors.sha256s,
  });
  writePrivateCanonicalOutput(outputPath, result.bytes);
  process.stdout.write(`${JSON.stringify({
    schema: ROUTING_SYNTHETIC_QA_MANIFEST_SCHEMA,
    status: 'passed',
    manifestSha256: `sha256:${result.sha256}`,
    output: path.basename(path.resolve(outputPath)),
    plannedTurns: result.summary.plannedTurns,
    scenarioGroups: result.summary.scenarioGroups,
    standaloneTurns: result.summary.standaloneTurns,
    providerCallsAllowed: 0,
    referenceSources: result.summary.referenceSources,
    predecessorManifestSha256s: result.summary.predecessorManifestSha256s,
  })}\n`);
}

function parseArgs(argv) {
  const parsed = { reference: [], 'predecessor-manifest': [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    index += 1;
    if (key === 'reference') parsed.reference.push(value);
    else if (key === 'predecessor-manifest') parsed['predecessor-manifest'].push(value);
    else if (Object.hasOwn(parsed, key)) throw new Error(`duplicate --${key}`);
    else parsed[key] = value;
  }
  const supported = new Set([
    'input',
    'output',
    'runtime-sha',
    'artifact-digest',
    'surface',
    'dedicated-id',
    'reference',
    'predecessor-manifest',
  ]);
  for (const key of Object.keys(parsed)) if (!supported.has(key)) throw new Error(`unknown argument --${key}`);
  return parsed;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${key} is required`);
  return value;
}

function parseDedicatedId(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('--dedicated-id must be a positive canonical integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new Error('--dedicated-id exceeds the safe canonical integer range');
  }
  return parsed;
}

function readPrivateJson(inputPath) {
  const absolute = path.resolve(inputPath);
  return JSON.parse(readPrivateFile(absolute, 'input').toString('utf8'));
}

function writePrivateCanonicalOutput(outputPath, bytes) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  if (fs.existsSync(absolute)) throw new Error('output already exists; refusing to overwrite immutable evidence');
  const temporary = `${absolute}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.linkSync(temporary, absolute);
    fs.unlinkSync(temporary);
    fs.chmodSync(absolute, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function loadPredecessorManifests(paths, binding) {
  if (!Array.isArray(paths)) throw new Error('predecessor manifest paths must be an array');
  const surfaceIndex = ROUTING_SYNTHETIC_QA_SURFACES.indexOf(binding.expectedSurface);
  if (surfaceIndex < 0) throw new Error('surface must select one governed routing-divergence surface');
  const expectedSurfaces = ROUTING_SYNTHETIC_QA_SURFACES.slice(0, surfaceIndex);
  if (paths.length !== expectedSurfaces.length) {
    throw new Error(`surface ${binding.expectedSurface} requires exactly ${expectedSurfaces.length} predecessor manifest files`);
  }

  const sha256s = [];
  const texts = [];
  for (let index = 0; index < expectedSurfaces.length; index += 1) {
    const absolute = path.resolve(paths[index]);
    const bytes = readPrivateFile(absolute, `predecessor manifest ${index + 1}`);
    const parsed = JSON.parse(bytes.toString('utf8'));
    const built = buildRoutingSyntheticQaManifest(parsed, {
      expectedRuntimeSha: binding.expectedRuntimeSha,
      expectedArtifactDigest: binding.expectedArtifactDigest,
      expectedSurface: expectedSurfaces[index],
      expectedDedicatedId: binding.expectedDedicatedId,
    });
    if (bytes.toString('utf8') !== built.bytes) {
      throw new Error(`predecessor manifest ${index + 1} bytes are not canonical`);
    }
    if (canonicalJson(built.manifest.predecessorManifestSha256s) !== canonicalJson(sha256s)) {
      throw new Error(`predecessor manifest ${index + 1} does not bind the strict prior-surface digest chain`);
    }
    const digest = `sha256:${sha256Hex(bytes)}`;
    sha256s.push(digest);
    texts.push(...built.manifest.turns.map((turn) => turn.text));
  }
  return { sha256s, texts };
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
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (stat.nlink !== 1) throw new Error(`${label} must have link count 1`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current uid`);
  }
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`routing synthetic QA manifest failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
