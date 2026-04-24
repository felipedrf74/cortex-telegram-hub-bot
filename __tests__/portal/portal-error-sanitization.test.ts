import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('portal error sanitization', () => {
  it('does not serialize raw Error.message values in portal server responses', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf-8',
    );

    expect(source).not.toContain('(err as Error).message');
    expect(source).not.toContain('err.message');
    expect(source).not.toContain('Action failed: ${');
  });
});
