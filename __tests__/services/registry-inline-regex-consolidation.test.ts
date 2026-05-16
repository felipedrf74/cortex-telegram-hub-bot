// Phase 13 batch 71 (2026-05-16): inline-regex-consolidation lint.
//
// Phase 0 audit MERGE-2 flagged three files with inline phrase regexes
// that duplicated canonical parser logic:
//
//   • src/domains/domain-handler.ts  (training intent detector)
//   • src/services/secretary-fastpath.ts  (date/weekday/time helpers)
//   • src/api/routes/chat-message-local-responses.ts  (phrase keyword check)
//
// This test pins the consolidation state per file so a regression
// (someone adding a new inline phrase regex) trips a CI failure. The
// allowed inline patterns are:
//
//   • Single-keyword token tests like `/\boutlook\b/` (provider hints)
//   • Date numeric-component patterns like `NUMERIC_DATE_PATTERN`
//
// Disallowed inline patterns are:
//
//   • Multi-locale phrase alternations covering ≥3 locale variants
//     (those belong in the per-skill parser or calendar NLP module)

import { readFileSync, existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readSource(relPath: string): string {
  const fullPath = resolve(REPO_ROOT, relPath);
  expect(existsSync(fullPath), `file must exist: ${relPath}`).toBe(true);
  return readFileSync(fullPath, 'utf8');
}

describe('domain-handler.ts inline-regex consolidation (Phase 13 batch 71)', () => {
  it('no longer defines isTrainingPrescriptionIntent inline (moved to intent-detectors.ts)', () => {
    const src = readSource('src/domains/domain-handler.ts');
    // The function should be IMPORTED, not declared in this file.
    expect(src).toMatch(/import\s+\{\s*isTrainingPrescriptionIntent\s*\}/);
    // And there should be no inline `function isTrainingPrescriptionIntent`.
    expect(src).not.toMatch(/function\s+isTrainingPrescriptionIntent\s*\(/);
  });

  it('does not contain inline regex phrase tests (the file orchestrates, it does not parse phrases)', () => {
    const src = readSource('src/domains/domain-handler.ts');
    // `.test(folded)` is the canonical inline-phrase-test signature. The
    // moved detectors use this in their own modules, not here.
    expect(src.match(/\.test\(folded\)/g)).toBeNull();
  });
});

describe('chat-message-local-responses.ts inline-regex consolidation', () => {
  it('does not run inline phrase regex tests against user message text', () => {
    const src = readSource('src/api/routes/chat-message-local-responses.ts');
    expect(src.match(/\.test\(folded\)/g)).toBeNull();
  });
});

describe('intent-detectors module presence', () => {
  it('per-skill training intent-detectors module exists and exports isTrainingPrescriptionIntent', () => {
    const src = readSource('src/services/skills/training/intent-detectors.ts');
    expect(src).toMatch(/export\s+(function|const)\s+isTrainingPrescriptionIntent/);
  });
});

// Phase 14 batch 76 follow-up (2026-05-16): secretary-fastpath parser
// consolidation. The fastpath should delegate calendar-create parsing to
// `calendar-natural-language-parser.ts` instead of keeping drift-prone local
// date/weekday/time helpers.
describe('secretary-fastpath internal-parser inventory (Phase 14 batch 76)', () => {
  it('does not keep duplicate calendar-create parser helpers in the fastpath', () => {
    const src = readSource('src/services/secretary-fastpath.ts');
    expect(src).not.toMatch(/function\s+resolveCalendarCreateDate/);
    expect(src).not.toMatch(/function\s+parseCalendarTimeRange/);
  });

  it('delegates calendar-create parsing to the canonical calendar NLP module', () => {
    const src = readSource('src/services/secretary-fastpath.ts');
    expect(src).toMatch(/import\s+\{[^}]*parseNaturalLanguageCalendarEvent[^}]*\}\s+from\s+['"][^'"]*calendar-natural-language-parser['"]/);
    expect(src).toMatch(/parseNaturalLanguageCalendarEvent\(text,\s*\{\s*timezone\s*\}\)/);
  });
});
