#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildReleaseArtifactManifest } from './lib/release-artifact-manifest.mjs';

const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

const root = path.resolve(readArg('--root', process.cwd()));
const output = readArg('--format', args.includes('--digest') ? 'digest' : 'json');
const writePath = readArg('--write', '');

const manifest = buildReleaseArtifactManifest(root);

const body = output === 'digest' ? `${manifest.digest}\n` : `${JSON.stringify(manifest, null, 2)}\n`;
if (writePath) {
  fs.mkdirSync(path.dirname(path.resolve(writePath)), { recursive: true });
  fs.writeFileSync(path.resolve(writePath), body);
} else {
  process.stdout.write(body);
}
