import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  canonicalRegistryMarkdownPaths,
  hasGitCheckoutMetadata,
  isWorkspaceArchitectureDecision,
  missingCanonicalRegistryMarkdownPaths,
  resolveCanonicalRegistryMarkdownPath,
} from '../../scripts/lib/docs-audit-paths.mjs';
import { gitHistoryOnlyDocumentationIssues } from '../../scripts/lib/documentation-policy.mjs';

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

  it('extracts local inline-code Markdown paths from canonical registries', () => {
    const source = [
      '## Canonical standards',
      '| Runtime | `runtime-and-observability-standard.md` |',
      '| Reward | `../agents/VERIFIABLE_REWARD_PROTOCOL.md` |',
      '## Related cross-repo standards',
      '| iOS | `ios/docs/engineering/ios-standard.md` |',
    ].join('\n');

    expect(canonicalRegistryMarkdownPaths(
      'docs/engineering/ENGINEERING_STANDARDS_INDEX.md',
      source,
    )).toEqual([
      'runtime-and-observability-standard.md',
      '../agents/VERIFIABLE_REWARD_PROTOCOL.md',
    ]);
  });

  it('resolves repository-root and registry-relative Markdown paths', () => {
    const repoRoot = '/tmp/backend';
    expect(resolveCanonicalRegistryMarkdownPath(
      'docs/DOCS_INDEX.md',
      'docs/release/README.md',
      repoRoot,
    )).toBe('/tmp/backend/docs/release/README.md');
    expect(resolveCanonicalRegistryMarkdownPath(
      'docs/engineering/ENGINEERING_STANDARDS_INDEX.md',
      '../release/README.md',
      repoRoot,
    )).toBe('/tmp/backend/docs/release/README.md');
  });

  it('reports a deleted inline-code path from a canonical registry', () => {
    const missing = missingCanonicalRegistryMarkdownPaths({
      registryFile: 'docs/DOCS_INDEX.md',
      source: '| Release | `docs/release/deleted.md` |',
      repoRoot: '/tmp/backend',
      exists: () => false,
    });

    expect(missing).toEqual([{
      reference: 'docs/release/deleted.md',
      target: '/tmp/backend/docs/release/deleted.md',
    }]);
  });

  it('allows active documentation records in the docs-only audit lane', () => {
    expect(gitHistoryOnlyDocumentationIssues([{
      path: 'docs/current.md',
      status: 'canonical',
      active: true,
    }])).toEqual([]);
  });

  it('rejects inactive historical and archive records in the docs-only audit lane', () => {
    expect(gitHistoryOnlyDocumentationIssues([
      { path: 'docs/history.md', status: 'historical', active: false },
      { path: 'docs/archive/note.md', status: 'archive', active: false },
    ])).toEqual([
      {
        type: 'inactive-document-prohibited',
        file: 'docs/history.md',
        message: 'Tracked Markdown cannot use inactive status historical; Git history is the archive.',
      },
      {
        type: 'inactive-document-prohibited',
        file: 'docs/archive/note.md',
        message: 'Tracked Markdown cannot use inactive status archive; Git history is the archive.',
      },
    ]);
  });
});
