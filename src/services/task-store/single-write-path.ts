// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M5 single-write-path flag (Gate R1).
 *
 * When enabled (the default), every task/list WRITE — chat/AI tool-executor,
 * chat-core-v2 command executor, chat planner skills executors, inline
 * callbacks, content-topic secretary sync, and the two list REST endpoints —
 * flows through the offline-first ledger
 * (src/services/task-store/offline-first-task-service.ts) instead of writing
 * providers directly. This closes NEX-08 (chat-created tasks invisible in the
 * Tasks tab until the next pull), NEX-09 (chat completions silently reverted
 * by the next pull), and NEX-10 (created lists invisible / list delete
 * broken).
 *
 * The flag exists ONLY as an operational revert lever: setting
 * TASK_SINGLE_WRITE_PATH=0 (or 'false') restores the legacy direct-provider
 * branches without a deploy. The env is re-read on every call (with the
 * boot-parsed config value as the unset default) so tests can exercise both
 * states without module re-imports. Flag removal is a post-soak cleanup.
 */

import { config } from '../../config';

export function isSingleWritePathEnabled(): boolean {
  const raw = String(process.env.TASK_SINGLE_WRITE_PATH ?? '').trim().toLowerCase();
  // Optional-chained so partially-mocked configs in tests keep the ON default.
  if (raw === '') return config.todo?.singleWritePath !== false;
  return raw !== '0' && raw !== 'false';
}
