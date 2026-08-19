// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAiCreditReplayCacheForTests,
  getAiCreditReplayResult,
  rememberAiCreditReplayResult,
} from '../../src/services/ai-credit-replay-cache';

beforeEach(() => {
  _resetAiCreditReplayCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ai-credit-replay-cache', () => {
  it('returns a remembered result non-destructively for repeated retries', () => {
    rememberAiCreditReplayResult(11, 'the answer');
    expect(getAiCreditReplayResult(11)).toBe('the answer');
    expect(getAiCreditReplayResult(11)).toBe('the answer');
  });

  it('misses unknown reservations and rejects unusable inputs', () => {
    expect(getAiCreditReplayResult(999)).toBeNull();
    rememberAiCreditReplayResult(0, 'x');
    rememberAiCreditReplayResult(-1, 'x');
    rememberAiCreditReplayResult(12, '');
    expect(getAiCreditReplayResult(0)).toBeNull();
    expect(getAiCreditReplayResult(12)).toBeNull();
  });

  it('expires entries after the reconnect window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00Z'));
    rememberAiCreditReplayResult(21, 'short-lived');
    vi.setSystemTime(new Date('2026-08-19T12:14:59Z'));
    expect(getAiCreditReplayResult(21)).toBe('short-lived');
    vi.setSystemTime(new Date('2026-08-19T12:15:01Z'));
    expect(getAiCreditReplayResult(21)).toBeNull();
  });

  it('is bounded: the oldest entry is evicted past capacity', () => {
    for (let i = 1; i <= 257; i += 1) {
      rememberAiCreditReplayResult(i, `answer-${i}`);
    }
    expect(getAiCreditReplayResult(1)).toBeNull();
    expect(getAiCreditReplayResult(2)).toBe('answer-2');
    expect(getAiCreditReplayResult(257)).toBe('answer-257');
  });

  it('re-remembering refreshes recency so hot entries survive eviction', () => {
    for (let i = 1; i <= 256; i += 1) {
      rememberAiCreditReplayResult(i, `answer-${i}`);
    }
    rememberAiCreditReplayResult(1, 'answer-1-refreshed');
    rememberAiCreditReplayResult(300, 'answer-300');
    expect(getAiCreditReplayResult(1)).toBe('answer-1-refreshed');
    expect(getAiCreditReplayResult(2)).toBeNull();
  });
});
