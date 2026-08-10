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

  it('keeps the explicit checkpoint owner-triggered and scoped to the PM2 fallback', () => {
    const checkpoint = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release-candidate-evidence.yml'),
      'utf8',
    );
    expect(checkpoint).toContain('name: Release Checkpoint — exact main artifact');
    expect(checkpoint).toContain('Owner-triggered manual evidence for the PM2 first-cutover fallback only');
    expect(checkpoint).toContain('never authorizes the default signed-container release path');
    expect(checkpoint).not.toMatch(/^  (?:push|pull_request|schedule):/m);
    expect(checkpoint).toContain("for required in '🧪 Tests' '🔍 Lint & Type Check' '🔨 Build'");
    expect(checkpoint).toContain('name: Build and verify exact PM2 fallback bundle');
    expect(checkpoint).toContain('artifact_name="release-bundle-$RUNTIME_SHA-$artifact_digest"');
    expect(checkpoint).toContain('name: ${{ steps.fallback_bundle.outputs.artifact_name }}');
    expect(checkpoint).not.toContain('needs.verify-main.outputs.artifact_name');
    expect(checkpoint).not.toContain('prefix="release-bundle-$RUNTIME_SHA-"');
    expect(checkpoint).toContain('protected-main-test-selection-$run_id-$run_attempt');
    expect(checkpoint).toContain('node scripts/release-test-remainder.mjs run');
    expect(checkpoint).not.toContain('npm run test:full:sharded');
    expect(checkpoint).toContain("matrix:\n        shard: [1, 2, 3, 4]");
    expect(checkpoint).toContain('node scripts/release-checksum-manifest.mjs');
    expect(checkpoint).not.toContain('ReleaseManifestV2');
    expect(checkpoint).not.toContain('sign-release-manifest');
  });

  it('produces the deployable artifact as a digest-pinned container image, not a bundle', () => {
    // Replaces the bundle + checksum-manifest + artifact-manifest chain: the image
    // digest IS the manifest. CI is test-only and must not produce or publish an
    // artifact at all; publication happens once, in release.yml.
    const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toContain('release-bundle-$GITHUB_SHA');
    expect(ci).not.toContain('ghcr.io');
    expect(ci).not.toContain('docker/build-push-action');

    const release = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    expect(release).toContain('runs-on: ubuntu-24.04');
    expect(release).toContain("test \"$(uname -m)\" = 'x86_64'");
    expect(release).toContain('Dockerfile.release.node');
    expect(release).toContain('Dockerfile.release.python');
    expect(release).toContain('platforms: linux/amd64');
    // The release manifest is signed, unlike the retired checksum manifest.
    expect(release).toContain('scripts/release-manifest-build.mjs');
    expect(release).toContain('NEXUS_RELEASE_MANIFEST_SIGNING_KEY');
  });

  it('exposes the long-lived signing key only in a fresh hosted publication job', () => {
    const release = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    const buildStart = release.indexOf('\n  build:\n');
    const publishStart = release.indexOf('\n  publish:\n');
    expect(buildStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(buildStart);
    const build = release.slice(buildStart, publishStart);
    const publish = release.slice(publishStart);
    const signingStep = publish.indexOf('Build and sign the release manifest');

    expect(build).toContain('run: npm ci');
    expect(build).not.toContain('environment:');
    expect(build).not.toContain('NEXUS_RELEASE_MANIFEST_SIGNING_KEY');
    expect(publish).toContain('needs: build');
    expect(publish).toContain('runs-on: ubuntu-24.04');
    expect(publish).toContain('environment:\n      name: release-publish');
    expect(signingStep).toBeGreaterThan(-1);
    expect(publish.slice(0, signingStep)).not.toContain('npm ci');
    expect(publish.slice(0, signingStep)).not.toContain('docker/build-push-action');
    expect(release.match(/NEXUS_RELEASE_MANIFEST_SIGNING_KEY:/g)).toHaveLength(1);
    expect(release).toContain('artifact-ids: ${{ needs.build.outputs.handoff_artifact_id }}');
    expect(release).not.toContain('const EXPECTED_FILES');
    expect(
      fs.readFileSync(path.join(repoRoot, 'scripts/release-signing-handoff.mjs'), 'utf8'),
    ).toContain(
      'const EXPECTED_FILES = [COMPOSE_NAME, HOSTED_RESULT_NAME, MANIFEST_NAME]',
    );
  });
});
