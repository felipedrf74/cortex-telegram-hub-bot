import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OLLAMA_DELETE,
  OLLAMA_DIGESTS,
  OLLAMA_RETAINED,
} from './helpers/ollama-observation-fixture';

const read = (path: string) => readFileSync(path, 'utf8');

function writeMode600(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe('Sonar start live Ollama and backup readiness', () => {
  it('binds the sole live retained digest to cleanup evidence and the exact service envelope', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sonar-live-ollama-')));
    chmodSync(root, 0o700);
    try {
      const retainedDigest = OLLAMA_DIGESTS.get(OLLAMA_RETAINED)!;
      const cleanup = join(root, 'cleanup.json');
      const systemd = join(root, 'systemd.txt');
      const tags = join(root, 'tags.json');
      const loaded = join(root, 'loaded.json');
      writeMode600(cleanup, `${JSON.stringify({
        schema: 'nexus.ollama-large-model-cleanup-result.v1',
        host: 'serverdominguez',
        status: 'complete',
        startedAt: '2026-07-20T00:00:00.000Z',
        completedAt: '2026-07-20T00:05:00.000Z',
        plan: {
          schema: 'nexus.ollama-large-model-cleanup-plan.v1',
          host: 'serverdominguez',
          evidenceDigest: `sha256:${'a'.repeat(64)}`,
          inventoryFingerprint: `sha256:${'b'.repeat(64)}`,
          retained: { tag: OLLAMA_RETAINED, digest: retainedDigest },
          delete: OLLAMA_DELETE.map((tag) => ({
            tag,
            digest: OLLAMA_DIGESTS.get(tag),
          })),
          ackPlan: `sha256:${'c'.repeat(64)}`,
        },
        finalInventory: [{ tag: OLLAMA_RETAINED, digest: retainedDigest }],
        retainedDigestVerifiedBeforeAndAfter: true,
      })}\n`);
      writeMode600(systemd, [
        'ActiveState=active',
        'Environment=OLLAMA_HOST=127.0.0.1:11434 OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_MAX_QUEUE=4 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1',
        'MemoryHigh=4294967296',
        'MemoryMax=6442450944',
        'MemorySwapMax=536870912',
        'CPUQuotaPerSecUSec=2s',
        '',
      ].join('\n'));
      writeMode600(tags, `${JSON.stringify({
        models: [{
          name: OLLAMA_RETAINED,
          model: OLLAMA_RETAINED,
          digest: retainedDigest.slice('sha256:'.length),
        }],
      })}\n`);
      writeMode600(loaded, `${JSON.stringify({ models: [] })}\n`);

      const output = execFileSync(process.execPath, [
        'scripts/quality-sonar-live-ollama-state.mjs',
        '--cleanup-result', cleanup,
        '--systemd-state', systemd,
        '--tags', tags,
        '--loaded', loaded,
      ], { encoding: 'utf8' });
      expect(JSON.parse(output)).toMatchObject({
        schema: 'nexus.sonarqube-live-ollama-state.v1',
        status: 'passed',
        retained: { tag: OLLAMA_RETAINED, digest: retainedDigest },
        envelope: {
          memoryHighBytes: 4 * 1024 * 1024 * 1024,
          memoryMaxBytes: 6 * 1024 * 1024 * 1024,
          memorySwapMaxBytes: 512 * 1024 * 1024,
          cpuQuotaUsecPerSec: 2_000_000,
        },
      });

      writeMode600(tags, `${JSON.stringify({
        models: [{
          name: OLLAMA_RETAINED,
          model: OLLAMA_RETAINED,
          digest: 'd'.repeat(64),
        }],
      })}\n`);
      expect(() => execFileSync(process.execPath, [
        'scripts/quality-sonar-live-ollama-state.mjs',
        '--cleanup-result', cleanup,
        '--systemd-state', systemd,
        '--tags', tags,
        '--loaded', loaded,
      ], { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders backup and immediate live authorization before Compose start', () => {
    const stack = read('scripts/quality-sonar-stack.sh');
    const backup = read('scripts/quality-sonar-backup.sh');
    const start = stack.slice(stack.indexOf('start_stack() {'), stack.lastIndexOf('case "$ACTION"'));

    expect(start.indexOf('verify_start_evidence')).toBeLessThan(start.indexOf('verify_backup_readiness'));
    expect(start.indexOf('verify_backup_readiness')).toBeLessThan(start.indexOf('validate_data_layout'));
    expect(start.indexOf('validate_config')).toBeLessThan(start.indexOf('verify_live_ollama'));
    expect(start.indexOf('verify_live_ollama')).toBeLessThan(start.indexOf('"${compose[@]}" up -d'));
    expect(stack).toContain('quality-sonar-live-ollama-state.mjs');
    expect(stack).toContain('--property=ActiveState');
    expect(stack).toContain('http://127.0.0.1:11434/api/tags');
    expect(stack).toContain('http://127.0.0.1:11434/api/ps');
    expect(backup).toContain('age --encrypt --recipient "$SONAR_BACKUP_AGE_RECIPIENT"');
    expect(backup).toContain('s3api head-bucket --bucket "$SONAR_BACKUP_S3_BUCKET"');
  });
});
