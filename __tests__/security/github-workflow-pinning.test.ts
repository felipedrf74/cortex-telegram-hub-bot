import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

const privilegedWorkflowFiles = [
  '.github/workflows/release.yml',
  '.github/workflows/changelog.yml',
  '.github/workflows/cd-production.yml.archived',
];

describe('privileged GitHub workflow action pinning', () => {
  it('pins write-capable workflow actions to immutable commit SHAs', () => {
    const mutableReferences: string[] = [];

    for (const file of privilegedWorkflowFiles) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      const actionReferences = source.matchAll(/uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)/g);

      for (const match of actionReferences) {
        const [, action, ref] = match;
        if (!/^[a-f0-9]{40}$/i.test(ref)) {
          mutableReferences.push(`${file}: ${action}@${ref}`);
        }
      }
    }

    expect(mutableReferences).toEqual([]);
  });
});
