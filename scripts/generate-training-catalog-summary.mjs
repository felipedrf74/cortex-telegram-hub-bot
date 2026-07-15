#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const catalogRoot = path.join(root, 'catalog/training/exercise-media/v1');
const attestation = JSON.parse(fs.readFileSync(path.join(catalogRoot, 'materialization-attestation.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(catalogRoot, 'manifest.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(catalogRoot, 'authored-content/materialization-policy.json'), 'utf8'));
const compiledPath = path.join(catalogRoot, 'compiled-manifest.json');
const compiledDigest = createHash('sha256').update(fs.readFileSync(compiledPath)).digest('hex');

const summary = {
  schema: 'nexus.training-catalog-summary.v1',
  generatedFrom: 'materialization-attestation.json',
  catalogVersion: attestation.catalogVersion ?? manifest.catalogVersion ?? null,
  status: attestation.status ?? null,
  manifestId: attestation.manifestId ?? manifest.manifestId ?? null,
  approvedOrigin: policy.approvedOrigin,
  activationState: policy.activationState ?? attestation.status ?? 'unknown',
  releaseSubjectHash: attestation.releaseSubjectHash,
  compiledPackageHash: attestation.compiledPackageHash,
  compiledManifestSha256: compiledDigest,
  counts: attestation.counts ?? manifest.counts ?? null,
  sourceFiles: {
    largeCompiledManifest: 'compiled-manifest.json',
    releaseAttestation: 'materialization-attestation.json',
    policy: 'authored-content/materialization-policy.json',
  },
};

const output = path.join(catalogRoot, 'summary.json');
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(path.relative(root, output));
