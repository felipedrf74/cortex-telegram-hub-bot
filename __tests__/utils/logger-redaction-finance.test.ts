import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOGGER_REDACTION_PATHS } from '../../src/utils/logger';

describe('logger finance redaction paths', () => {
  it('redacts finance PII and sensitive monetary fields at top-level, request body, and error mirrors', () => {
    const paths = new Set<string>(LOGGER_REDACTION_PATHS as unknown as string[]);
    for (const field of [
      'amount',
      'category',
      'merchant',
      'vendor',
      'taxDue',
      'tax_due',
      'gross_income',
      'destinationEmail',
    ]) {
      expect(paths.has(field)).toBe(true);
      expect(paths.has(`body.${field}`)).toBe(true);
      expect(paths.has(`err.${field}`)).toBe(true);
      expect(paths.has(`err.response.data.${field}`)).toBe(true);
    }
  });

  it('keeps provider activity telemetry content-free and avoids raw logged errors', () => {
    const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
    const gemini = source('src/services/gemini-provider.ts');
    const openai = source('src/services/openai-provider.ts');
    const anthropic = source('src/services/anthropic-hook.ts');

    expect(gemini).toContain("summary: 'Gemini API call metered'");
    expect(openai).toContain('OpenAI API call metered');
    expect(openai).toContain('OpenAI Batch API call metered');
    expect(anthropic).toContain('Anthropic API call metered');

    for (const providerSource of [gemini, openai, anthropic]) {
      expect(providerSource).not.toContain('billable tokens ($');
      expect(providerSource).not.toContain(' tok, $');
      expect(providerSource).not.toMatch(
        /logger\.(?:debug|info|warn|error)\(\s*\{\s*err(?:\s*[:,}]|\s*$)/u,
      );
    }
    expect(openai).not.toMatch(/detail:\s*`\$\$\{/u);
  });
});
