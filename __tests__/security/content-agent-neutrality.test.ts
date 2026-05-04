import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const RUNTIME_FILES = [
  'src/agents/seo-agent.ts',
  'src/agents/reaction-radar-agent.ts',
  'src/agents/performance-agent.ts',
  'content-engine/services/intelligence/gap_finder.py',
  'content-engine/searchers/reddit.py',
  'content-engine/services/orchestrator.py',
  'content-engine/services/creative/caption_writer.py',
];

const FOUNDER_SHAPED_DEFAULTS = [
  'livre mercado brasil',
  'estado é o problema',
  'valores cristãos homem',
  'disciplina masculina',
  'desenvolvimento pessoal homem',
  'Brazilian men 18-35',
  'free market / libertarian',
  'dieta carnívora resultados',
  'carnívoro e performance esportiva',
  'brasilivre',
  '#carnivorediet',
  '#theoperator',
  '#liberdade',
  '#livremercado',
  '#conservador',
  '#masculinidade',
];

describe('closed-beta content agent neutrality', () => {
  it('does not keep founder-shaped defaults in scheduled content agents or Python sidecar discovery', () => {
    const hits: Array<{ file: string; token: string }> = [];

    for (const file of RUNTIME_FILES) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const lowered = text.toLowerCase();
      for (const token of FOUNDER_SHAPED_DEFAULTS) {
        if (lowered.includes(token.toLowerCase())) {
          hits.push({ file, token });
        }
      }
    }

    expect(hits).toEqual([]);
  });

  it('keeps the strict closed-beta scanner aware of the broader ideology/default vocabulary', () => {
    const scanner = readFileSync(
      path.join(REPO_ROOT, 'scripts/closed-beta-identity-scan.sh'),
      'utf8',
    );

    for (const token of FOUNDER_SHAPED_DEFAULTS) {
      expect(scanner).toContain(token);
    }
  });
});
