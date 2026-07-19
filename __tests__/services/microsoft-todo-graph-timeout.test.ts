// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M14 (NEX-25 residual): the chat-path Graph calls in microsoft-todo.ts had no
 * request timeout — only the offline-first adapter and mutation worker wrapped
 * their own. A hung Graph socket could therefore stall a chat/AI read
 * indefinitely. These tests prove every raw Graph call in the module is now
 * bounded: the retry-wrapped path (getLists) AND the non-retry raw path
 * (createTask), plus the MS_TODO_GRAPH_REQUEST_TIMEOUT_MS override.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/microsoft-auth', () => ({
  getGraphClient: vi.fn(),
  isMicrosoftConfigured: vi.fn(() => true),
}));

import { getGraphClient } from '../../src/services/microsoft-auth';
import { createTask, getLists, invalidateListCache } from '../../src/services/microsoft-todo';

/** A Graph client whose every verb returns a promise that never settles. */
function hungGraphClient() {
  const request: any = {
    query: () => request,
    header: () => request,
    get: () => new Promise(() => {}),
    post: () => new Promise(() => {}),
    patch: () => new Promise(() => {}),
    delete: () => new Promise(() => {}),
  };
  return { api: () => request };
}

describe('microsoft-todo chat-path Graph request timeouts (NEX-25 residual)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (getGraphClient as any).mockReturnValue(hungGraphClient());
    invalidateListCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('bounds a hung retry-path Graph call (getLists) at the default 15s', async () => {
    const promise = getLists();
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it('bounds a hung raw Graph call that does not go through withRetry (createTask)', async () => {
    const promise = createTask('list-1', 'Tasks', { title: 'hung create', timeZone: 'UTC' });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it('honors the MS_TODO_GRAPH_REQUEST_TIMEOUT_MS override', async () => {
    vi.stubEnv('MS_TODO_GRAPH_REQUEST_TIMEOUT_MS', '2000');
    const promise = getLists();
    // Not yet elapsed at ~1.9s → still pending (no synchronous failure).
    await vi.advanceTimersByTimeAsync(1_900);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});
