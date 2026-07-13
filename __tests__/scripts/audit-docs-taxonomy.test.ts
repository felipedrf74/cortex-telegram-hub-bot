import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  hasGitCheckoutMetadata,
  isWorkspaceArchitectureDecision,
} from '../../scripts/lib/docs-audit-paths.mjs';

describe('docs audit canonical taxonomy', () => {
  const workspaceRoot = path.resolve('/tmp/nexus-docs-audit-workspace');

  it('classifies numbered workspace ADRs as canonical architecture decisions', () => {
    expect(
      isWorkspaceArchitectureDecision(
        path.join(workspaceRoot, 'docs', 'adr', '0007-training-boundary.md'),
        workspaceRoot,
      ),
    ).toBe(true);
  });

  it('does not broaden the allowlist to arbitrary workspace markdown', () => {
    expect(
      isWorkspaceArchitectureDecision(
        path.join(workspaceRoot, 'docs', 'notes', 'training-boundary.md'),
        workspaceRoot,
      ),
    ).toBe(false);
  });

  it('does not accept a sibling path that only shares the adr prefix', () => {
    expect(
      isWorkspaceArchitectureDecision(
        path.join(workspaceRoot, 'docs', 'adr-backup', '0007-training-boundary.md'),
        workspaceRoot,
      ),
    ).toBe(false);
  });

  it('recognizes primary checkouts and linked worktrees by either .git metadata shape', () => {
    const checked: string[] = [];
    const exists = (candidate: string) => {
      checked.push(candidate);
      return true;
    };

    expect(hasGitCheckoutMetadata('/tmp/repo-worktree', exists)).toBe(true);
    expect(checked).toEqual([path.resolve('/tmp/repo-worktree/.git')]);
  });

  it('rejects a directory with no git metadata', () => {
    expect(hasGitCheckoutMetadata('/tmp/not-a-repo', () => false)).toBe(false);
  });
});
