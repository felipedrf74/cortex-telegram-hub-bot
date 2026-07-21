// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M11 perf hygiene: prompt-loader TTL-throttled stat re-checks.
 *
 * loadPrompt used to fs.statSync on EVERY call (hot path: chat /message
 * builds prompts per request). It now throttles the mtime re-check behind a
 * ~30s TTL while keeping a Map-backed content cache. resetPromptLoaderForTests
 * clears both content cache and TTL clocks so hot-reload tests stay instant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

import {
  loadPrompt,
  writePrompt,
  getPromptPath,
  resetPromptLoaderForTests,
  PROMPT_STAT_TTL_MS,
} from '../../src/utils/prompt-loader';

const PROMPT_NAME = 'm11-ttl-test-prompt';

describe('prompt-loader TTL stat throttling', () => {
  let statSpy: ReturnType<typeof vi.spyOn>;
  let readSpy: ReturnType<typeof vi.spyOn>;
  let mtimeMs: number;
  let content: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
    resetPromptLoaderForTests();
    mtimeMs = 1_000;
    content = 'original prompt body';
    statSpy = vi.spyOn(fs, 'statSync').mockImplementation(
      () => ({ mtimeMs }) as unknown as fs.Stats,
    );
    readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => content);
  });

  afterEach(() => {
    statSpy.mockRestore();
    readSpy.mockRestore();
    vi.useRealTimers();
    resetPromptLoaderForTests();
  });

  it('performs at most 2 stat calls for 1000 loadPrompt calls within the TTL', () => {
    for (let i = 0; i < 1000; i++) {
      expect(loadPrompt(PROMPT_NAME)).toBe('original prompt body');
    }
    expect(statSpy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('picks up an edited file after the TTL expires', () => {
    expect(loadPrompt(PROMPT_NAME)).toBe('original prompt body');

    // Edit on disk (mtime bump) inside the TTL window: stale content served.
    mtimeMs = 2_000;
    content = 'edited prompt body';
    expect(loadPrompt(PROMPT_NAME)).toBe('original prompt body');

    // After TTL expiry the mtime re-check runs and the edit is picked up.
    vi.advanceTimersByTime(PROMPT_STAT_TTL_MS + 1);
    expect(loadPrompt(PROMPT_NAME)).toBe('edited prompt body');
  });

  it('serves cached content without re-reading when mtime is unchanged after TTL expiry', () => {
    loadPrompt(PROMPT_NAME);
    vi.advanceTimersByTime(PROMPT_STAT_TTL_MS + 1);
    loadPrompt(PROMPT_NAME);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(statSpy).toHaveBeenCalledTimes(2);
  });

  it('resetPromptLoaderForTests forces an immediate re-stat + re-read (hot-reload tests stay instant)', () => {
    expect(loadPrompt(PROMPT_NAME)).toBe('original prompt body');
    mtimeMs = 2_000;
    content = 'edited prompt body';
    resetPromptLoaderForTests();
    expect(loadPrompt(PROMPT_NAME)).toBe('edited prompt body');
  });
});

describe('writePrompt production guard', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetPromptLoaderForTests();
    writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.unstubAllEnvs();
    resetPromptLoaderForTests();
  });

  it('is a warned no-op when NODE_ENV=production (never mutates prompt files in prod)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    writePrompt(PROMPT_NAME, 'mutated');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes and invalidates the cache in non-production (auto-research mutation path)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(
      () => ({ mtimeMs: 1 }) as unknown as fs.Stats,
    );
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => 'v1');
    try {
      expect(loadPrompt(PROMPT_NAME)).toBe('v1');
      readSpy.mockImplementation(() => 'v2');
      writePrompt(PROMPT_NAME, 'v2');
      expect(writeSpy).toHaveBeenCalledWith(getPromptPath(PROMPT_NAME), 'v2', 'utf-8');
      // Cache invalidated: next load re-reads immediately even inside TTL.
      expect(loadPrompt(PROMPT_NAME)).toBe('v2');
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
