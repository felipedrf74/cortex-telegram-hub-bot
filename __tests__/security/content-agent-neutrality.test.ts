import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function listFiles(root: string, predicate: (file: string) => boolean): string[] {
  const absoluteRoot = path.join(REPO_ROOT, root);
  const out: string[] = [];
  for (const entry of readdirSync(absoluteRoot)) {
    const absolute = path.join(absoluteRoot, entry);
    const relative = path.relative(REPO_ROOT, absolute);
    if (statSync(absolute).isDirectory()) {
      out.push(...listFiles(relative, predicate));
    } else if (predicate(relative)) {
      out.push(relative);
    }
  }
  return out.sort();
}

const TYPESCRIPT_RUNTIME_FILES = [
  ...listFiles('src/agents', (file) => file.endsWith('.ts')),
  ...listFiles('src/services', (file) => file.endsWith('.ts')),
];

const PYTHON_RUNTIME_FILES = [
  ...listFiles('content-engine/services/intelligence', (file) => file.endsWith('.py')),
  ...listFiles('content-engine/services/creative', (file) => file.endsWith('.py')),
];

const RUNTIME_FILES = [
  'content-engine/searchers/reddit.py',
  'content-engine/services/orchestrator.py',
  ...TYPESCRIPT_RUNTIME_FILES,
  ...PYTHON_RUNTIME_FILES,
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

  it('does not read a global configured YouTube channel as creator identity in runtime agents', () => {
    const hits: string[] = [];
    const globalYoutubePattern = /config\.youtube\??\.\s*channelId|config\.youtube\??\[['"]channelId['"]\]|(?:process\.env\.|os\.environ\.get\(|getenv\()(['"])YOUTUBE_CHANNEL_ID\1/;
    for (const file of RUNTIME_FILES.filter((item) => item.startsWith('src/agents/') || item.startsWith('src/services/') || item.endsWith('.py'))) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      if (globalYoutubePattern.test(text)) hits.push(file);
    }

    expect(hits).toEqual([]);
  });
});
