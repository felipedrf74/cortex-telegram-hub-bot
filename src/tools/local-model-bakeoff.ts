// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  buildLocalModelBakeoff,
  type LocalModelBakeoffObservation,
} from '../services/local-model-bakeoff';
import { getLocalModelManifest } from '../services/ollama-model-policy';

const path = readRequired('--observations');
const observationBytes = fs.readFileSync(path);
const observations = observationBytes.toString('utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    try { return JSON.parse(line) as LocalModelBakeoffObservation; } catch (error) {
      throw new Error(`Invalid bakeoff observation on line ${index + 1}: ${(error as Error).message}`);
    }
  });
const manifest = getLocalModelManifest({ fresh: true });
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'nexus-local-model-bakeoff-report-v3',
  generatedAt: new Date().toISOString(),
  manifestVersion: manifest.manifestVersion,
  observationInputDigest: `sha256:${crypto.createHash('sha256').update(observationBytes).digest('hex')}`,
  observationCount: observations.length,
  productionEnvelope: manifest.productionEnvelope,
  benchmarkEnvelope: manifest.benchmarkEnvelope,
  results: buildLocalModelBakeoff(observations, manifest),
}, null, 2)}\n`);

function readRequired(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a JSONL path`);
  return value;
}
