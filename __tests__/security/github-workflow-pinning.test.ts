import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

describe('GitHub workflow release trust boundary', () => {
  it('pins every third-party action to an immutable commit SHA', () => {
    const mutableReferences: string[] = [];
    const workflowDir = path.join(repoRoot, '.github/workflows');
    for (const name of fs.readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      for (const match of source.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)) {
        if (!/^[a-f0-9]{40}$/i.test(match[2])) {
          mutableReferences.push(`.github/workflows/${name}: ${match[1]}@${match[2]}`);
        }
      }
    }
    expect(mutableReferences).toEqual([]);
  });

  it('binds one explicit checkpoint to protected-main checks and the exact CI artifact', () => {
    const checkpoint = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release-candidate-evidence.yml'),
      'utf8',
    );
    expect(checkpoint).toContain('name: Release Checkpoint — exact main artifact');
    expect(checkpoint).toContain("for required in '🧪 Tests' '🔍 Lint & Type Check' '🔨 Build'");
    expect(checkpoint).toContain('prefix="release-bundle-$RUNTIME_SHA-"');
    expect(checkpoint).toContain('protected-main-test-selection-$run_id-$run_attempt');
    expect(checkpoint).toContain('node scripts/release-test-remainder.mjs run');
    expect(checkpoint).not.toContain('npm run test:full:sharded');
    expect(checkpoint).toContain("matrix:\n        shard: [1, 2, 3, 4]");
    expect(checkpoint).toContain('node scripts/release-checksum-manifest.mjs');
    expect(checkpoint).not.toContain('ReleaseManifestV2');
    expect(checkpoint).not.toContain('sign-release-manifest');
  });

  it('keeps protected-main artifacts uncompressed and digest-verifiable', () => {
    const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('artifact_name="release-bundle-$GITHUB_SHA-$digest"');
    expect(ci).toContain('compression-level: 0');
    expect(ci).toContain('--verify-bundle .local/ci-evidence/downloaded-runtime-bundle');
  });
});
