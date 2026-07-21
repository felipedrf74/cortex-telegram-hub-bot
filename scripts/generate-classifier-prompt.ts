// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M15 — regenerate prompts/classifier-manifest.md from the CapabilityManifest.
 *
 * Usage:
 *   npm run classifier:prompt          # write the file
 *   npm run classifier:prompt:check    # exit 1 if the checked-in file is stale
 *
 * The generated file is the STATIC portion of the manifest classifier prompt
 * (flag AI_CLASSIFY_MANIFEST_PROMPT). The per-call candidate shortlist is
 * appended at runtime by classifyWithClaude. A CI-style test
 * (__tests__/router/classifier-prompt-builder.test.ts) asserts the checked-in
 * file is byte-identical to a fresh regeneration.
 */

import fs from 'fs';
import path from 'path';
import { buildManifestClassifierPrompt } from '../src/router/classifier-prompt-builder';

const OUTPUT_PATH = path.resolve(__dirname, '..', 'prompts', 'classifier-manifest.md');

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const generated = `${buildManifestClassifierPrompt()}\n`;

  if (checkOnly) {
    const existing = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf-8') : null;
    if (existing !== generated) {
      console.error('prompts/classifier-manifest.md is stale. Run: npm run classifier:prompt');
      process.exit(1);
    }
    console.log('prompts/classifier-manifest.md is up to date.');
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, generated, 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH} (${generated.length} chars).`);
}

main();
