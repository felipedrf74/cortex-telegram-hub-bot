/**
 * M5 single-write-path prohibition ratchet (Gate R1).
 *
 * Provider task/list WRITE calls may exist ONLY inside the ledger-internal
 * sync machinery and the explicitly flag-gated legacy branches retained for
 * the TASK_SINGLE_WRITE_PATH=0 revert lever. Any new provider write call in
 * product code must instead go through the offline-first ledger
 * (src/services/task-store/offline-first-task-service.ts): create/update/
 * move/checklist mutations, recordLocalTaskMutation for complete/reopen/
 * delete, and createOfflineFirstTaskList/deleteOfflineFirstTaskList for
 * lists. Do NOT add files to the allowlists without an M-milestone reason.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

const PROVIDER_WRITE_CALL = /\.(createTask|updateTask|completeTask|uncompleteTask|deleteTask|createList|deleteList|moveTask|addChecklistItem)\(/;

/**
 * Ledger-internal sync machinery: these files ARE the single write path's
 * provider-facing side (worker pushes, raw client wrappers, provider
 * adapters) or legacy implementations reachable only via flag-gated callers.
 * Alphabetized; paths relative to src/.
 */
const LEDGER_INTERNAL_FILES = [
  // Microsoft adapter delegates completeTask → this.updateTask internally.
  'services/task-store/microsoft-todo-adapter.ts',
  // The worker IS the single write path's provider-facing side.
  'services/task-store/task-mutation-sync-worker.ts',
  // Provider wrapper definitions (microsoft-todo/todoist/native call-throughs).
  'services/task-store/task-router.ts',
  // completeTask here is the legacy implementation reached ONLY through the
  // flag-gated chat-core-v2 command-executor branch (its sole consumer).
  'services/task-store/task-service.ts',
].sort();

/**
 * Flag-gated legacy call sites: retained direct-provider branches reachable
 * only with TASK_SINGLE_WRITE_PATH=0. Each file MUST reference the flag
 * helper; each is deleted with the flag after the staging soak.
 * Alphabetized; paths relative to src/.
 */
const FLAG_GATED_LEGACY_FILES = [
  'api/routes/chat-callback-routes.ts',
  'api/routes/tasks.ts',
  'services/chat-core-v2/command-executor.ts',
  'services/content-topic-secretary-sync.ts',
  'services/skills/tasks/executor.ts',
  'services/tool-executor.ts',
].sort();

const ALLOWED_FILES = new Set([...LEDGER_INTERNAL_FILES, ...FLAG_GATED_LEGACY_FILES]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function providerWriteFiles(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const file of listSourceFiles(SRC_ROOT)) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const matching = lines
      .map((line, index) => (PROVIDER_WRITE_CALL.test(line) ? `${index + 1}: ${line.trim()}` : null))
      .filter((line): line is string => line != null);
    if (matching.length > 0) hits.set(relative, matching);
  }
  return hits;
}

describe('M5 single-write-path prohibition ratchet', () => {
  it('confines provider task/list write calls to the ledger-internal and flag-gated allowlists', () => {
    const offenders: string[] = [];
    for (const [file, lines] of providerWriteFiles()) {
      if (ALLOWED_FILES.has(file)) continue;
      offenders.push(`${file}\n  ${lines.join('\n  ')}`);
    }
    expect(
      offenders,
      [
        'Provider task/list writes outside the single-write-path allowlist.',
        'Route the write through the offline-first ledger instead',
        '(src/services/task-store/offline-first-task-service.ts):',
        'createOfflineFirstTask / updateOfflineFirstTask / moveOfflineFirstTask,',
        'recordLocalTaskMutation (task.complete|task.reopen|task.delete),',
        'addOfflineTaskChecklistItem / toggleOfflineTaskChecklistItem,',
        'createOfflineFirstTaskList / deleteOfflineFirstTaskList.',
        'If this file is genuinely ledger-internal sync machinery, add it to the',
        'allowlist in this test with a comment explaining why.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('keeps every flag-gated legacy file wired to isSingleWritePathEnabled', () => {
    for (const file of FLAG_GATED_LEGACY_FILES) {
      const contents = fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
      expect(
        contents.includes('isSingleWritePathEnabled'),
        `${file} retains direct provider writes but no longer references isSingleWritePathEnabled — `
        + 'its legacy branch must stay behind the TASK_SINGLE_WRITE_PATH flag (or be deleted along with its allowlist entry).',
      ).toBe(true);
    }
  });

  it('has no stale allowlist entries', () => {
    const hits = providerWriteFiles();
    for (const file of ALLOWED_FILES) {
      expect(fs.existsSync(path.join(SRC_ROOT, file)), `Allowlisted file ${file} no longer exists — remove it from the allowlist.`).toBe(true);
      expect(
        hits.has(file),
        `Allowlisted file ${file} no longer contains provider write calls — remove it from the allowlist to keep the ratchet tight.`,
      ).toBe(true);
    }
  });
});
