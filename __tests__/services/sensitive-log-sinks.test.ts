import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

describe('sensitive durable/log sink regression guards', () => {
  it('does not log raw Content topic-generation response previews', () => {
    const src = readSource('src/services/content-workflow.ts');
    expect(src).toContain('responseChars: textContent.length');
    expect(src).not.toContain('textContent: textContent.slice');
    expect(src).not.toContain('responsePreview: textContent');
  });

  it('does not log raw Training plan model response previews', () => {
    const src = readSource('src/services/plan-generator.ts');
    expect(src).toContain('responseChars: result.text.length');
    expect(src).not.toContain('responsePreview: result.text.slice');
  });

  it('does not log raw finance vision model text after parse failures', () => {
    const src = readSource('src/services/invoice-filer.ts');
    expect(src).toContain('responseChars: text.length');
    expect(src).not.toContain('{ text, err }');
  });
});
