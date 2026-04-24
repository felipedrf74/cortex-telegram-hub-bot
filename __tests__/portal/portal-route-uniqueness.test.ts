import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('portal route registration hygiene', () => {
  it('does not register duplicate literal method/path pairs in portal route modules', () => {
    const portalDir = path.resolve(__dirname, '../../src/portal');
    const source = fs.readdirSync(portalDir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => fs.readFileSync(path.join(portalDir, file), 'utf-8'))
      .join('\n');
    const routePattern = /app\.(get|post|put|delete|patch)\(\s*['`]([^'`]+)['`]/g;
    const counts = new Map<string, number>();

    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(source)) !== null) {
      const key = `${match[1].toUpperCase()} ${match[2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const duplicates = Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([route, count]) => `${route} (${count})`);

    expect(duplicates).toEqual([]);
  });
});
