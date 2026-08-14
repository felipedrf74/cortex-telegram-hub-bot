import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateLocalModelManifest } from '../../scripts/validate-local-model-manifest.mjs';
import {
  getActiveLocalModel,
  getLocalModelManifest,
  OllamaSmallOnlyPolicyError,
  resetLocalModelManifestCacheForTests,
  resolveOllamaSmallOnlyRuntimeConfig,
  tryGetLocalModelManifest,
} from '../../src/services/ollama-model-policy';

describe('signed-image local-model manifest', () => {
  it('keeps the current control active and candidates ineligible until bakeoff evidence pins a winner', () => {
    const manifest = getLocalModelManifest({ fresh: true });
    expect(manifest.selectionStatus).toBe('control_only');
    expect(manifest.selectionEvidence).toBeNull();
    expect(getActiveLocalModel()).toMatchObject({
      id: 'qwen2.5-3b-control',
      ollamaTag: 'qwen2.5:3b-instruct-q4_K_M',
      productionEligible: true,
      evidenceStatus: 'verified',
      digest: 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
    });
    expect(manifest.models.filter((model) => model.role === 'candidate'))
      .toHaveLength(4);
    expect(manifest.models.filter((model) => model.role === 'candidate')
      .every((model) => (
        model.productionEligible === false
        && model.digest === null
        && model.evidenceStatus === 'candidate_unverified'
      ))).toBe(true);
  });

  it('enforces the 20GB/8-CPU production envelope and zero swap', () => {
    const envelope = getLocalModelManifest().productionEnvelope;
    expect(envelope).toMatchObject({
      cpuQuotaPercent: 800,
      memoryHighBytes: 18 * 1024 ** 3,
      memoryMaxBytes: 20 * 1024 ** 3,
      memorySwapMaxBytes: 0,
      minimumHostAvailableBytes: 6 * 1024 ** 3,
      maxLoadedModels: 1,
      parallelGenerations: 1,
      waitingQueueDepth: 4,
      maxContextTokens: 16384,
      nice: 10,
    });
  });

  it('pins the attended benchmark window to 22GB high, 24GB max, and the same single-flight controls', () => {
    expect(getLocalModelManifest().benchmarkEnvelope).toMatchObject({
      cpuQuotaPercent: 800,
      memoryHighBytes: 22 * 1024 ** 3,
      memoryMaxBytes: 24 * 1024 ** 3,
      memorySwapMaxBytes: 0,
      minimumHostAvailableBytes: 6 * 1024 ** 3,
      maxLoadedModels: 1,
      parallelGenerations: 1,
      waitingQueueDepth: 4,
      maxContextTokens: 16_384,
      nice: 10,
    });
  });

  it('rejects environment attempts to activate an unselected candidate', () => {
    expect(() => resolveOllamaSmallOnlyRuntimeConfig({ OLLAMA_MODEL: 'qwen3.5:9b' }))
      .toThrow('active signed-manifest model');
  });

  it('preserves the released policy-error identity for external consumers', () => {
    const error = new OllamaSmallOnlyPolicyError('OLLAMA_MODEL', 'untrusted:latest');

    expect(error).toMatchObject({
      name: 'OllamaSmallOnlyPolicyError',
      code: 'ollama_small_only_policy_violation',
      policy: 'signed_model_manifest',
      source: 'OLLAMA_MODEL',
      receivedModel: 'untrusted:latest',
      expectedModel: getActiveLocalModel().ollamaTag,
    });
  });

  it('exposes a content-free fail-closed result instead of throwing when manifest loading fails', () => {
    expect(tryGetLocalModelManifest({
      loader: () => { throw new SyntaxError('private parser detail'); },
    })).toEqual({ ok: false, code: 'model_manifest_unavailable' });

    expect(resolveOllamaSmallOnlyRuntimeConfig({
      OLLAMA_MODEL: 'untrusted:latest',
    }, {
      manifestLoader: () => { throw new SyntaxError('private parser detail'); },
    })).toEqual({
      manifestAvailable: false,
      manifestErrorCode: 'model_manifest_unavailable',
      model: 'off',
      classifierModel: 'off',
      localChatModel: 'off',
      localChatRecipeModel: 'off',
      localChatFastModel: 'off',
    });
  });

  it('clears a previously valid cache when a fresh manifest read fails', () => {
    resetLocalModelManifestCacheForTests();
    getLocalModelManifest({ fresh: true });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('packaged manifest unavailable');
    });

    try {
      expect(tryGetLocalModelManifest({ fresh: true })).toEqual({
        ok: false,
        code: 'model_manifest_unavailable',
      });
      expect(() => getLocalModelManifest()).toThrow('packaged manifest unavailable');
    } finally {
      readSpy.mockRestore();
      resetLocalModelManifestCacheForTests();
    }
  });

  it('binds production selection to the winner, benchmark host receipt, legal review, and owner evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-local-model-manifest-'));
    try {
      const path = join(directory, 'manifest.json');
      const manifest = JSON.parse(readFileSync('config/local-model-manifest.json', 'utf8'));
      manifest.selectionStatus = 'production_selected';
      manifest.models[0].role = 'winner';
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => validateLocalModelManifest(path)).toThrow('requires selectionEvidence');

      manifest.selectionEvidence = {
        winningCandidateId: manifest.activeModelId,
        benchmarkReportDigest: `sha256:${'a'.repeat(64)}`,
        benchmarkCompletedAt: '2026-08-12T12:00:00.000Z',
        benchmarkHostRollbackReceiptDigest: `sha256:${'b'.repeat(64)}`,
        corpusReference: 'nexus-corpus:v1',
        licenseReviewReference: 'legal-review:approved',
        ownerApprovalReference: 'owner-review:approved',
      };
      writeFileSync(path, JSON.stringify(manifest));
      expect(validateLocalModelManifest(path)).toMatchObject({ selectionStatus: 'production_selected' });

      manifest.models[1].role = 'winner';
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => validateLocalModelManifest(path)).toThrow('only verified, digest-pinned winner');
      manifest.models[1].role = 'candidate';

      manifest.selectionEvidence.winningCandidateId = 'different-candidate';
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => validateLocalModelManifest(path)).toThrow('winningCandidateId invalid');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('packages the gateway command in the signed backend image without exposing model mutation paths', () => {
    const source = readFileSync('src/tools/ollama-unix-gateway.ts', 'utf8');
    const dockerfile = readFileSync('Dockerfile.release.node', 'utf8');
    expect(source).toContain("new Set(['/api/version', '/api/tags', '/api/ps'])");
    expect(source).toContain("new Set(['/api/show', '/api/chat'])");
    expect(source).not.toContain("'/api/pull'");
    expect(source).not.toContain("'/api/delete'");
    expect(source).not.toContain("'/api/create'");
    expect(source).toContain('fs.chmodSync(resolvedSocketPath, 0o600)');
    expect(source).toContain("UPSTREAM_HOST = '127.0.0.1'");
    expect(dockerfile).toContain('test -f dist/tools/ollama-unix-gateway.js');
    expect(dockerfile).toContain('COPY config ./config');
  });
});
