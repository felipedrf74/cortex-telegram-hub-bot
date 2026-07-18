import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('content privacy-safe operational logging', () => {
  it('never attaches raw script topics or discovery titles to active-path logs', () => {
    const engine = readFileSync(resolve(process.cwd(), 'src/services/content-engine.ts'), 'utf8');
    const engineLogContext = readFileSync(resolve(process.cwd(), 'src/services/content-engine-log-context.ts'), 'utf8');
    const discovery = readFileSync(resolve(process.cwd(), 'src/services/content-discovery.ts'), 'utf8');
    const workflow = readFileSync(resolve(process.cwd(), 'src/services/content-workflow.ts'), 'utf8');
    const dedup = readFileSync(resolve(process.cwd(), 'src/services/content-dedup.ts'), 'utf8');
    const learning = readFileSync(resolve(process.cwd(), 'src/services/content-learning-store.ts'), 'utf8');
    const routes = readFileSync(resolve(process.cwd(), 'src/api/routes/content.ts'), 'utf8');

    expect(engine).not.toMatch(/logger\.info\(\{\s*topic\s*[,}]/);
    expect(engineLogContext).toContain('topicHash:');
    expect(engineLogContext).toContain('topicLength:');
    expect(discovery).not.toMatch(/logger\.(?:info|warn|error)\(\{\s*(?:err,\s*)?title\s*[,}]/);
    expect(discovery).not.toContain('similarTo: dedup.similarTo');
    expect(discovery).toContain('titleHash:');
    expect(discovery).toContain('titleLength:');
    expect(workflow).not.toMatch(/logger\.(?:debug|info|warn|error)\(\{[^}]*\btitle:\s*candidate\.title/s);
    expect(workflow).not.toContain('similarTo: duplicate.similarTo');
    expect(workflow).toContain('titleHash:');
    expect(dedup).not.toMatch(/logger\.(?:debug|info|warn|error)\(\{[^}]*\bnewIdea\s*[,}]/s);
    expect(dedup).not.toContain('similarTo: result.similarTo');
    expect(dedup).toContain('titleHash:');
    expect(learning).not.toContain('topic: opts.topic');
    expect(learning).toContain('topicHash:');
    expect(routes).not.toMatch(/logger\.warn\(\{[^}]*\btitle\s*[,}]/s);
    expect(routes).toContain('titleHash:');
  });
});
