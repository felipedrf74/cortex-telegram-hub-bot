import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCapabilityManifestEntry, loadCapabilityManifest } from '../../src/services/capability-manifest';

describe('runtime manifests', () => {
  it('keeps capability and scheduled-job registries in parity with runtime sources', () => {
    const result = JSON.parse(execFileSync(process.execPath, ['scripts/validate-runtime-manifests.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }));
    expect(result).toMatchObject({ ok: true, capabilities: 8 });
    expect(result.jobs).toBeGreaterThan(40);
  });

  it('requires zero provider calls for unchanged scheduled-job inputs', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('config/agent-job-manifest.json'), 'utf8'));
    expect(manifest.jobs.every((job: any) => job.inputFingerprint.unchangedInputProviderCalls === 0)).toBe(true);
  });

  it('loads governed capability metadata through the runtime registry', () => {
    expect(loadCapabilityManifest().capabilities).toHaveLength(8);
    expect(getCapabilityManifestEntry('training')).toMatchObject({
      id: 'triathlon',
      lifecycle: 'active',
      owner: 'training',
      memoryScope: 'tenant-user',
      providerPolicy: 'routed',
    });
  });
});
