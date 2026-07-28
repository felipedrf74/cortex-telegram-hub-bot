#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function valueOf(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function fail(message) {
  throw new Error(`Sonar coverage evidence: ${message}`);
}

function sha256(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function boundedRegularFile(filename, label) {
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0
      || metadata.size > 128 * 1024 * 1024) {
    fail(`${label} must be a bounded non-symlink regular file`);
  }
}

function reportIdentity(manifestDirectory, filename, label) {
  const resolved = path.resolve(filename);
  boundedRegularFile(resolved, label);
  const relative = path.relative(manifestDirectory, resolved).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    fail(`${label} must stay beside the coverage evidence`);
  }
  return {
    path: relative,
    sha256: sha256(resolved),
  };
}

const runtimeSha = valueOf('--runtime-sha');
const coverageDirectory = path.resolve(valueOf('--coverage-dir'));
const output = path.resolve(valueOf('--output'));
const pythonXml = valueOf('--python-xml');

if (!/^[0-9a-f]{40}$/.test(runtimeSha)
    || !valueOf('--coverage-dir')
    || !valueOf('--output')) {
  fail(
    'usage: quality-sonar-coverage-manifest.mjs --runtime-sha <sha> '
    + '--coverage-dir <dir> --output <json> [--python-xml <file>]',
  );
}
const coverageMetadata = fs.lstatSync(coverageDirectory);
if (!coverageMetadata.isDirectory() || coverageMetadata.isSymbolicLink()) {
  fail('coverage directory must be a non-symlink directory');
}
const outputRelative = path.relative(coverageDirectory, output);
if (!outputRelative || outputRelative === '..' || outputRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(outputRelative)) {
  fail('output must stay below the coverage directory');
}
if (fs.existsSync(output) || fs.lstatSync(path.dirname(output)).isSymbolicLink()) {
  fail('output must be a new file below a non-symlink parent');
}

const manifestDirectory = path.dirname(output);
const javascriptLcov = path.join(coverageDirectory, 'lcov.info');
const reports = {
  javascriptLcov: reportIdentity(
    manifestDirectory,
    javascriptLcov,
    'JavaScript LCOV report',
  ),
  pythonXml: pythonXml
    ? reportIdentity(manifestDirectory, pythonXml, 'Python coverage report')
    : null,
};
const body = Buffer.from(`${JSON.stringify({
  schemaVersion: 'SonarCoverageEvidenceV1',
  runtimeSha,
  generatedAt: new Date().toISOString(),
  reports,
}, null, 2)}\n`);
const temporary = `${output}.next-${process.pid}`;
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try {
  fs.writeFileSync(descriptor, body);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(temporary, output);
const parent = fs.openSync(manifestDirectory, 'r');
try {
  fs.fsyncSync(parent);
} finally {
  fs.closeSync(parent);
}
process.stdout.write(`${output}\n`);
