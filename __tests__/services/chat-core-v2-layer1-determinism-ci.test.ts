import { readFileSync, readdirSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { auditPrepassSourceForDeterminism } from '../../src/services/chat-core-v2/prepass-contract';

// WP-03 / B9: repo-wide determinism sweep. The single-file assertion in
// chat-core-v2-activation-contracts.test.ts only covers the selector; this
// sweep audits EVERY Layer-1-path module so a new prepass/layer1 file cannot
// silently introduce a model/network/cloud import. Flat scan only (no recursion
// into subdirs) — a documented boundary; nested Layer-1 modules would need this
// list widened.
const LAYER1_DIR = 'src/services/chat-core-v2';
const LAYER1_BASENAME_RE = /(prepass|layer1|candidate-selection)/i;

// prepass-contract.ts DEFINES the forbidden-pattern regex literals
// (ollama|openai|anthropic|gemini, fetch(, getActiveProvider(, cloudFallback),
// so auditing its own source is a guaranteed false positive. It holds only
// contracts/constants/patterns — no Layer-1 runtime logic — so it is excluded.
const AUDIT_EXCLUDED = new Set<string>(['prepass-contract.ts']);

function listLayer1PathFiles(): string[] {
  return readdirSync(LAYER1_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.d.ts'))
    .filter((name) => LAYER1_BASENAME_RE.test(name))
    .filter((name) => !AUDIT_EXCLUDED.has(name))
    .sort();
}

describe('Chat Core v2 Layer-1 determinism CI sweep (WP-03 / B9)', () => {
  const files = listLayer1PathFiles();

  it('finds the Layer-1-path modules to audit (meta-guard against an empty sweep)', () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
    // Coverage anchors: the live selector and the recall-eval must be swept.
    expect(files).toContain('prepass-candidate-selection.ts');
    expect(files).toContain('prepass-recall-eval.ts');
  });

  it.each(files)('Layer-1 path module %s has no model/network/cloud references', (file) => {
    const source = readFileSync(`${LAYER1_DIR}/${file}`, 'utf8');
    expect(auditPrepassSourceForDeterminism(source)).toEqual([]);
  });

  it('rolls up to zero determinism issues across every audited Layer-1-path module', () => {
    const offenders = files
      .map((file) => ({
        file,
        issues: auditPrepassSourceForDeterminism(readFileSync(`${LAYER1_DIR}/${file}`, 'utf8')),
      }))
      .filter((entry) => entry.issues.length > 0);
    expect(offenders).toEqual([]);
  });

  it('negative sentinel: the auditor flags a synthetic provider/network import', () => {
    const synthetic = `
      import { getActiveProvider } from '../provider-registry';
      export async function bad() {
        const provider = getActiveProvider();
        return fetch('https://api.openai.com/v1/chat');
      }
    `;
    const issues = auditPrepassSourceForDeterminism(synthetic);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues).toContain('llm_provider_reference');
  });
});
