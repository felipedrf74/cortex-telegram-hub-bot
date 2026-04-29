/**
 * Thin Domain Wrapper Tests
 *
 * Verifies triathlon.ts and content-creator.ts correctly delegate
 * to handleSimpleDomain with the right domain name and defaults.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared handler — we're testing delegation, not the handler itself
vi.mock('../../src/domains/domain-handler', () => ({
  handleSimpleDomain: vi.fn().mockResolvedValue({ text: 'mock response', domain: 'triathlon' }),
}));

import { handleTriathlon } from '../../src/domains/triathlon';
import { handleContent } from '../../src/domains/content-creator';
import { handleSimpleDomain } from '../../src/domains/domain-handler';

const mockHandler = vi.mocked(handleSimpleDomain);

beforeEach(() => {
  vi.clearAllMocks();
  mockHandler.mockResolvedValue({ text: 'mock response', domain: 'triathlon' });
});

describe('handleTriathlon', () => {
  it('delegates to handleSimpleDomain with domain "triathlon"', async () => {
    await handleTriathlon('How was my swim?', 42);
    expect(mockHandler).toHaveBeenCalledWith('triathlon', 'How was my swim?', 5, 42, undefined, undefined);
  });

  it('passes userId to handleSimpleDomain', async () => {
    await handleTriathlon('Apply coach recs', 123);
    expect(mockHandler).toHaveBeenCalledWith('triathlon', 'Apply coach recs', 5, 123, undefined, undefined);
  });

  it('returns the result from handleSimpleDomain', async () => {
    mockHandler.mockResolvedValue({ text: 'Your swim was great', domain: 'triathlon' });
    const result = await handleTriathlon('Analyze swim');
    expect(result).toEqual({ text: 'Your swim was great', domain: 'triathlon' });
  });
});

describe('handleContent', () => {
  it('delegates to handleSimpleDomain with domain "content"', async () => {
    mockHandler.mockResolvedValue({ text: 'hook draft', domain: 'content' });
    await handleContent('Write a hook');
    expect(mockHandler).toHaveBeenCalledWith('content', 'Write a hook', 5, undefined, undefined, undefined);
  });

  it('passes userId to handleSimpleDomain', async () => {
    await handleContent('Script idea', 99);
    expect(mockHandler).toHaveBeenCalledWith('content', 'Script idea', 5, 99, undefined, undefined);
  });
});
