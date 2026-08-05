import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

describe('routing synthetic QA operator wiring', () => {
  it('ships the provider-free campaign runner and manifest validator in the exact artifact', () => {
    const releaseManifest = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/release-artifact-manifest.mjs'),
      'utf8',
    );

    expect(releaseManifest).toContain("'scripts/run-routing-synthetic-qa.mjs'");
    expect(releaseManifest).toContain("'scripts/lib/routing-synthetic-qa-manifest.mjs'");
  });

  it('requires a manifest digest for every staging routing-enable inspection', () => {
    const localOperator = fs.readFileSync(
      path.join(ROOT, 'scripts/chat-capability-flag-operator.sh'),
      'utf8',
    );
    const remoteOperator = fs.readFileSync(
      path.join(ROOT, 'scripts/remote-chat-capability-flag-transaction.sh'),
      'utf8',
    );

    expect(localOperator).toContain('--synthetic-qa-manifest-sha256');
    expect(localOperator).toContain('staging routing enable inspect requires the exact synthetic QA manifest digest');
    expect(remoteOperator).toContain('SYNTHETIC_QA_MANIFEST_SHA256');
    expect(remoteOperator).toContain('--synthetic-qa-manifest=');
    expect(remoteOperator).toContain('--synthetic-qa-receipt=');
  });

  it('documents and exposes a single provider-free runner command', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const runbook = fs.readFileSync(
      path.join(ROOT, 'docs/release/chat-quality-operations.md'),
      'utf8',
    );

    expect(packageJson.scripts?.['chat:routing-synthetic-qa']).toBe(
      'node scripts/run-routing-synthetic-qa.mjs',
    );
    expect(runbook).toContain('owner_authorized_synthetic_staging_qa');
    expect(runbook).toContain('--synthetic-qa-manifest-sha256');
    expect(runbook).toContain('No synthetic routing QA window is organic traffic');
  });
});
