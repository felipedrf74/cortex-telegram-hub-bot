import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ALLOWED_TOOLS,
  DISPATCHABLE_TOOL_NAMES,
  executeToolCall,
} from '../../src/services/tool-executor';

describe('tool executor dispatch allowlist', () => {
  it('rejects unknown tools before switch dispatch or side effects', async () => {
    const result = await executeToolCall('not_a_real_tool', { anything: true }, 7, 70);

    expect(result).toEqual({
      success: false,
      error: 'Tool "not_a_real_tool" is not registered for execution',
      code: 'TOOL_NOT_ALLOWED',
    });
  });

  it('keeps every switch case represented in the dispatch allowlist', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'tool-executor.ts'),
      'utf8',
    );
    const caseNames = [...src.matchAll(/case '([^']+)'/g)].map((match) => match[1]).sort();

    expect(caseNames).toEqual([...DISPATCHABLE_TOOL_NAMES].sort());
    for (const toolName of caseNames) {
      expect(ALLOWED_TOOLS.has(toolName)).toBe(true);
    }
  });
});
