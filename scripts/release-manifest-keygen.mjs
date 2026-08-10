#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';

/**
 * Generate the release-manifest signing keypair.
 *
 * The private key is never committed and never printed to a shared log: it is
 * written to a 0600 file the operator then loads into the GitHub Actions secret
 * and deletes. The public key is committed and installed on the deployment host,
 * which is the actual trust root for unattended releases.
 *
 * This is deliberately a manual, operator-run step. Generating the production
 * keypair automatically would mean some process other than the owner had it.
 *
 * Usage:
 *   node scripts/release-manifest-keygen.mjs --out-dir .local/release/keys
 */

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadContinuousDeploymentPolicy(root);
const outDir = arg('--out-dir', '.local/release/keys');
const keyId = arg('--key-id', policy.trust.signingKeyId);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const privatePath = path.join(outDir, `${keyId}.private.pem`);
const publicPath = path.join(outDir, `${keyId}.pem`);
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
fs.writeFileSync(publicPath, publicPem, { mode: 0o644 });

process.stdout.write(`Generated Ed25519 release signing keypair "${keyId}".

Private key: ${privatePath}  (0600 — never commit this)
Public key:  ${publicPath}

Next steps, all manual and all owner-only:

1. Store the private key as the GitHub Actions secret
   NEXUS_RELEASE_MANIFEST_SIGNING_KEY in the repository's release environment,
   then shred ${privatePath}.
2. Commit the public key to
   docs/release/evidence/release-manifest-public-key.pem
3. Install the public key on the deployment host as
   ${policy.trust.publicKeyPath}
   owned by root:root with mode 0644, and confirm the parent directory is
   root-owned and not group- or world-writable.
4. Re-run a release; the poller refuses any manifest that does not verify
   against this exact key id.
`);
