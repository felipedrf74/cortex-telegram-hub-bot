#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasArg(name) {
  return args.includes(name);
}

const root = path.resolve(readArg('--root', process.cwd()));
const publicPath = path.resolve(root, readArg('--public-key', 'docs/release/evidence/release-evidence-public-key.pem'));
const privatePath = path.resolve(root, readArg('--private-key', '.local/release/evidence-signing-private-key.pem'));
const force = hasArg('--force');

for (const filePath of [publicPath, privatePath]) {
  if (fs.existsSync(filePath) && !force) {
    console.error(`Refusing to overwrite existing key: ${filePath}`);
    console.error('Pass --force only when rotating release evidence keys intentionally.');
    process.exit(1);
  }
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

fs.mkdirSync(path.dirname(publicPath), { recursive: true });
fs.mkdirSync(path.dirname(privatePath), { recursive: true });
fs.writeFileSync(publicPath, publicPem, { mode: 0o644 });
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
fs.chmodSync(privatePath, 0o600);

console.log(`Public verifier written: ${publicPath}`);
console.log(`Private signing key written locally: ${privatePath}`);
console.log('Set GitHub secret NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM from the private key file before enabling signed evidence reuse.');
