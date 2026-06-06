/**
 * Creator-config neutrality guard.
 *
 * Closed-beta-readiness-hardening (2026-05-03).
 *
 * `prompts/creator-config.md` is the FALLBACK creator block that the
 * Python content-engine endpoints fall back to when a request does
 * not carry an explicit per-user creator block. v4.14.118 sanitized
 * it to a neutral template; the closed-beta hardening pass
 * (v4.14.126+) re-confirmed the same contract and added this unit
 * test as the trip-wire.
 *
 * The contract: this file must NOT contain any name, persona,
 * worldview, audience, dietary, ideological, or political token. If
 * it ever regains one, EVERY authenticated user using one of the
 * 7 Python content-engine endpoints that fall through to
 * `creator-config.md` would inherit that token simultaneously — the
 * exact regression that triggered the v4.14.118 P0.
 *
 * If you need to add an example or section here that mentions a
 * specific name (e.g. a documentation example), add it to a
 * docs/examples/ file instead and link it from the markdown — never
 * inline it.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CREATOR_CONFIG_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'prompts',
  'creator-config.md',
);

// Forbidden tokens. Categories:
//   - founder identity:   names, emails, handles, brand IDs
//   - dietary identity:   carnivore, ketogenic, vegan, vegetarian
//   - political identity: conservador, liberdade, livremercado,
//                          progressista, esquerda, direita
//   - faith identity:     cristão, católico, evangélico, religião,
//                          fé, masculinidade, fe_familia
//   - persona handles:    theoperator, founder, owner, dono
//
// Each token is checked case-insensitively. Hits report the matched
// token and the line number so a regression is traceable.
const FORBIDDEN_TOKENS: readonly string[] = [
  // Founder identity
  'felipe',
  'dominguez',
  'felipedrf74',
  'nexushubbot',
  // Dietary
  'carnivore',
  'carnivorediet',
  'ketogenic',
  'vegan',
  'vegetarian',
  // Political (PT-BR + EN)
  'conservador',
  'conservative',
  'liberdade',
  'livremercado',
  'free market',
  'progressista',
  'progressive',
  'esquerda',
  'left-wing',
  'direita',
  'right-wing',
  // Faith / family
  'cristão',
  'cristao',
  'christian',
  'católico',
  'catolico',
  'catholic',
  'evangélico',
  'evangelico',
  'evangelical',
  'masculinidade',
  'masculinity',
  'fe_familia',
  // Persona handles
  'theoperator',
  '#theoperator',
];

// Allow-listed substrings — phrases that legitimately contain a
// forbidden lexical token but are explicitly NEUTRAL guidance about
// not injecting that token. Each line containing an allow-listed
// substring is skipped during the forbidden-token scan.
const ALLOW_LISTED_SUBSTRINGS: readonly string[] = [
  'do not inject political, religious, dietary, or ideological',
  'do not inject political, religious, or ideological',
  'do not assume a "founder voice"',
  'never substitute a default founder/owner identity',
  'inject a specific creator',
];

function isAllowListed(line: string): boolean {
  const lowered = line.toLowerCase();
  return ALLOW_LISTED_SUBSTRINGS.some((s) => lowered.includes(s.toLowerCase()));
}

describe('creator-config.md neutrality (closed-beta v4.14.126+ hardening)', () => {
  test('contains no founder/dietary/political/faith/persona tokens outside allow-listed neutrality guidance', () => {
    const text = readFileSync(CREATOR_CONFIG_PATH, 'utf8');
    const lines = text.split(/\r?\n/);

    const hits: Array<{ line: number; token: string; content: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isAllowListed(line)) continue;
      const lowered = line.toLowerCase();
      for (const token of FORBIDDEN_TOKENS) {
        if (lowered.includes(token.toLowerCase())) {
          hits.push({ line: i + 1, token, content: line.trim() });
        }
      }
    }

    if (hits.length > 0) {
      const report = hits
        .map((h) => `  L${h.line} [${h.token}] ${h.content}`)
        .join('\n');
      throw new Error(
        `creator-config.md regressed — found ${hits.length} forbidden token hit(s):\n${report}\n\n` +
          'Move name/persona/dietary/political/faith examples to a separate ' +
          'docs/examples/ file and link from the markdown. The fallback ' +
          'template must stay neutral or every authenticated user using a ' +
          'Python content-engine endpoint will inherit the regression.',
      );
    }

    expect(hits).toEqual([]);
  });

  test('preserves the explicit "neutral template" header', () => {
    const text = readFileSync(CREATOR_CONFIG_PATH, 'utf8');
    expect(text).toMatch(/CREATOR CONFIGURATION \(NEUTRAL TEMPLATE\)/);
    expect(text).toMatch(/NEUTRAL fallback template/);
  });

  test('preserves the explicit "no political/religious/dietary defaults" guard line', () => {
    const text = readFileSync(CREATOR_CONFIG_PATH, 'utf8');
    expect(text.toLowerCase()).toContain('do not inject political');
  });
});
