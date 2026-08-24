// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Local-model selection is release data, not an environment allowlist.
 *
 * The signed OCI image packages config/local-model-manifest.json. Environment
 * variables may select only the manifest's active production-eligible entry;
 * candidate rows are evidence inventory and cannot be activated accidentally.
 */
export const LOCAL_MODEL_MANIFEST_SCHEMA = 'nexus.local-model-manifest.v1';
export const OLLAMA_FAST_MODEL_DISABLED = 'off';

export interface LocalModelManifestEntry {
  id: string;
  ollamaTag: string;
  role: 'control' | 'candidate' | 'winner';
  license: string;
  commercialUseApproved: boolean;
  quantization: string;
  promptTemplate: string;
  thinkMode: false | 'low';
  runtimeVersion: string;
  evidenceStatus: 'candidate_unverified' | 'verified';
  digest: string | null;
  maxContextTokens: number;
  productionEligible: boolean;
}

export interface LocalModelResourceEnvelope {
  cpuQuotaPercent: number;
  memoryHighBytes: number;
  memoryMaxBytes: number;
  memorySwapMaxBytes: number;
  maxContextTokens: number;
  nice: number;
  minimumHostAvailableBytes?: number;
  maxLoadedModels?: number;
  parallelGenerations?: number;
  waitingQueueDepth?: number;
}

export interface LocalModelSelectionEvidence {
  winningCandidateId: string;
  benchmarkReportDigest: string;
  benchmarkCompletedAt: string;
  benchmarkHostRollbackReceiptDigest: string;
  corpusReference: string;
  licenseReviewReference: string;
  ownerApprovalReference: string;
}

export interface LocalModelManifest {
  schemaVersion: typeof LOCAL_MODEL_MANIFEST_SCHEMA;
  manifestVersion: string;
  selectionStatus: 'control_only' | 'production_selected';
  selectionEvidence: LocalModelSelectionEvidence | null;
  activeModelId: string;
  models: LocalModelManifestEntry[];
  productionEnvelope: LocalModelResourceEnvelope;
  benchmarkEnvelope: LocalModelResourceEnvelope;
}

export type LocalModelManifestLoadResult =
  | { ok: true; manifest: LocalModelManifest }
  | { ok: false; code: 'model_manifest_unavailable' };

let manifestCache: LocalModelManifest | null = null;

function validateSelectionEvidence(
  value: unknown,
  selectionStatus: LocalModelManifest['selectionStatus'],
  activeModelId: string,
): LocalModelSelectionEvidence | null {
  if (selectionStatus === 'control_only') {
    if (value !== null) {
      throw new Error('Control-only local-model manifest must not claim production selection evidence');
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Production-selected local-model manifest requires selectionEvidence');
  }
  const row = value as Record<string, unknown>;
  const benchmarkReportDigest = typeof row.benchmarkReportDigest === 'string'
    ? row.benchmarkReportDigest.trim()
    : '';
  const benchmarkCompletedAt = typeof row.benchmarkCompletedAt === 'string'
    ? row.benchmarkCompletedAt.trim()
    : '';
  const winningCandidateId = typeof row.winningCandidateId === 'string'
    ? row.winningCandidateId.trim()
    : '';
  if (!winningCandidateId || winningCandidateId !== activeModelId) {
    throw new Error('Invalid local-model manifest selectionEvidence.winningCandidateId');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(benchmarkReportDigest)) {
    throw new Error('Invalid local-model manifest selectionEvidence.benchmarkReportDigest');
  }
  if (!benchmarkCompletedAt
      || Number.isNaN(Date.parse(benchmarkCompletedAt))
      || new Date(benchmarkCompletedAt).toISOString() !== benchmarkCompletedAt) {
    throw new Error('Invalid local-model manifest selectionEvidence.benchmarkCompletedAt');
  }
  const benchmarkHostRollbackReceiptDigest = typeof row.benchmarkHostRollbackReceiptDigest === 'string'
    ? row.benchmarkHostRollbackReceiptDigest.trim()
    : '';
  if (!/^sha256:[0-9a-f]{64}$/.test(benchmarkHostRollbackReceiptDigest)) {
    throw new Error('Invalid local-model manifest selectionEvidence.benchmarkHostRollbackReceiptDigest');
  }
  const reference = (field: keyof Pick<
    LocalModelSelectionEvidence,
    'corpusReference' | 'licenseReviewReference' | 'ownerApprovalReference'
  >): string => {
    const normalized = typeof row[field] === 'string' ? row[field].trim() : '';
    if (!normalized || normalized.length > 512) {
      throw new Error(`Invalid local-model manifest selectionEvidence.${field}`);
    }
    return normalized;
  };
  return {
    winningCandidateId,
    benchmarkReportDigest,
    benchmarkCompletedAt,
    benchmarkHostRollbackReceiptDigest,
    corpusReference: reference('corpusReference'),
    licenseReviewReference: reference('licenseReviewReference'),
    ownerApprovalReference: reference('ownerApprovalReference'),
  };
}

function manifestPath(): string {
  return path.resolve(__dirname, '../../config/local-model-manifest.json');
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Invalid local-model manifest ${field}`);
  }
  return Number(value);
}

function validateEnvelope(value: unknown, field: string): LocalModelResourceEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid local-model manifest ${field}`);
  }
  const row = value as Record<string, unknown>;
  const memoryHighBytes = assertPositiveInteger(row.memoryHighBytes, `${field}.memoryHighBytes`);
  const memoryMaxBytes = assertPositiveInteger(row.memoryMaxBytes, `${field}.memoryMaxBytes`);
  if (memoryHighBytes > memoryMaxBytes) {
    throw new Error(`Invalid local-model manifest ${field}: MemoryHigh exceeds MemoryMax`);
  }
  if (!Number.isSafeInteger(row.memorySwapMaxBytes) || Number(row.memorySwapMaxBytes) < 0) {
    throw new Error(`Invalid local-model manifest ${field}.memorySwapMaxBytes`);
  }
  const nice = Number(row.nice);
  if (!Number.isInteger(nice) || nice < -20 || nice > 19) {
    throw new Error(`Invalid local-model manifest ${field}.nice`);
  }
  const envelope: LocalModelResourceEnvelope = {
    cpuQuotaPercent: assertPositiveInteger(row.cpuQuotaPercent, `${field}.cpuQuotaPercent`),
    memoryHighBytes,
    memoryMaxBytes,
    memorySwapMaxBytes: Number(row.memorySwapMaxBytes),
    maxContextTokens: assertPositiveInteger(row.maxContextTokens, `${field}.maxContextTokens`),
    nice,
  };
  for (const optionalField of [
    'minimumHostAvailableBytes',
    'maxLoadedModels',
    'parallelGenerations',
    'waitingQueueDepth',
  ] as const) {
    if (row[optionalField] !== undefined) {
      envelope[optionalField] = assertPositiveInteger(row[optionalField], `${field}.${optionalField}`);
    }
  }
  return envelope;
}

function validateManifest(value: unknown): LocalModelManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local-model manifest must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== LOCAL_MODEL_MANIFEST_SCHEMA) {
    throw new Error(`Unsupported local-model manifest schema: ${String(raw.schemaVersion)}`);
  }
  if (raw.selectionStatus !== 'control_only' && raw.selectionStatus !== 'production_selected') {
    throw new Error('Invalid local-model manifest selectionStatus');
  }
  const manifestVersion = typeof raw.manifestVersion === 'string' ? raw.manifestVersion.trim() : '';
  const activeModelId = typeof raw.activeModelId === 'string' ? raw.activeModelId.trim() : '';
  if (!manifestVersion || !activeModelId || !Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error('Local-model manifest is missing version, active model, or candidates');
  }
  const seenIds = new Set<string>();
  const seenTags = new Set<string>();
  const models = raw.models.map((candidate, index): LocalModelManifestEntry => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Invalid local-model manifest models[${index}]`);
    }
    const row = candidate as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const ollamaTag = typeof row.ollamaTag === 'string' ? row.ollamaTag.trim() : '';
    const license = typeof row.license === 'string' ? row.license.trim() : '';
    const quantization = typeof row.quantization === 'string' ? row.quantization.trim() : '';
    const promptTemplate = typeof row.promptTemplate === 'string' ? row.promptTemplate.trim() : '';
    const runtimeVersion = typeof row.runtimeVersion === 'string' ? row.runtimeVersion.trim() : '';
    if (!id || !ollamaTag || !license || !quantization || !promptTemplate || !runtimeVersion
        || seenIds.has(id) || seenTags.has(ollamaTag)) {
      throw new Error(`Invalid or duplicate local-model manifest models[${index}]`);
    }
    if (row.role !== 'control' && row.role !== 'candidate' && row.role !== 'winner') {
      throw new Error(`Invalid local-model manifest models[${index}].role`);
    }
    const digest = row.digest === null ? null : (typeof row.digest === 'string' ? row.digest.trim() : '');
    if (digest !== null && !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`Invalid local-model manifest models[${index}].digest`);
    }
    if (typeof row.productionEligible !== 'boolean') {
      throw new Error(`Invalid local-model manifest models[${index}].productionEligible`);
    }
    if (typeof row.commercialUseApproved !== 'boolean') {
      throw new Error(`Invalid local-model manifest models[${index}].commercialUseApproved`);
    }
    if (row.evidenceStatus !== 'candidate_unverified' && row.evidenceStatus !== 'verified') {
      throw new Error(`Invalid local-model manifest models[${index}].evidenceStatus`);
    }
    if (row.thinkMode !== false && row.thinkMode !== 'low') {
      throw new Error(`Invalid local-model manifest models[${index}].thinkMode`);
    }
    seenIds.add(id);
    seenTags.add(ollamaTag);
    return {
      id,
      ollamaTag,
      role: row.role,
      license,
      commercialUseApproved: row.commercialUseApproved,
      quantization,
      promptTemplate,
      thinkMode: row.thinkMode,
      runtimeVersion,
      evidenceStatus: row.evidenceStatus,
      digest,
      maxContextTokens: assertPositiveInteger(row.maxContextTokens, `models[${index}].maxContextTokens`),
      productionEligible: row.productionEligible,
    };
  });
  const active = models.find((model) => model.id === activeModelId);
  if (!active || !active.productionEligible) {
    throw new Error('Local-model manifest active model is missing or not production eligible');
  }
  if (active.digest === null || active.evidenceStatus !== 'verified') {
    throw new Error('Local-model manifest active model must always be verified and digest-pinned');
  }
  const winners = models.filter((model) => model.role === 'winner');
  if (raw.selectionStatus === 'control_only' && winners.length !== 0) {
    throw new Error('Control-only local-model manifest cannot claim a winner');
  }
  if (raw.selectionStatus === 'production_selected'
      && (active.role !== 'winner' || winners.length !== 1 || winners[0]?.id !== active.id)) {
    throw new Error('Production-selected local model must be the only verified, digest-pinned winner');
  }
  if (raw.selectionStatus === 'production_selected' && !active.commercialUseApproved) {
    throw new Error('Production-selected local model must have approved commercial use');
  }
  const selectionEvidence = validateSelectionEvidence(
    raw.selectionEvidence,
    raw.selectionStatus,
    activeModelId,
  );
  const productionEnvelope = validateEnvelope(raw.productionEnvelope, 'productionEnvelope');
  const benchmarkEnvelope = validateEnvelope(raw.benchmarkEnvelope, 'benchmarkEnvelope');
  if (productionEnvelope.memoryMaxBytes !== 20 * 1024 ** 3
      || productionEnvelope.memoryHighBytes !== 18 * 1024 ** 3
      || productionEnvelope.memorySwapMaxBytes !== 0
      || productionEnvelope.cpuQuotaPercent !== 800
      || productionEnvelope.minimumHostAvailableBytes !== 6 * 1024 ** 3
      || productionEnvelope.maxLoadedModels !== 1
      || productionEnvelope.parallelGenerations !== 1
      || productionEnvelope.waitingQueueDepth !== 4
      || productionEnvelope.maxContextTokens !== 16_384
      || productionEnvelope.nice !== 10) {
    throw new Error('Local-model manifest production envelope drifted from the approved policy');
  }
  if (benchmarkEnvelope.memoryMaxBytes !== 24 * 1024 ** 3
      || benchmarkEnvelope.memoryHighBytes !== 22 * 1024 ** 3
      || benchmarkEnvelope.memorySwapMaxBytes !== 0
      || benchmarkEnvelope.cpuQuotaPercent !== 800
      || benchmarkEnvelope.minimumHostAvailableBytes !== 6 * 1024 ** 3
      || benchmarkEnvelope.maxLoadedModels !== 1
      || benchmarkEnvelope.parallelGenerations !== 1
      || benchmarkEnvelope.waitingQueueDepth !== 4
      || benchmarkEnvelope.maxContextTokens !== 16_384
      || benchmarkEnvelope.nice !== 10) {
    throw new Error('Local-model manifest benchmark envelope drifted from the approved policy');
  }
  if (active.maxContextTokens > productionEnvelope.maxContextTokens) {
    throw new Error('Active model context exceeds the production envelope');
  }
  return {
    schemaVersion: LOCAL_MODEL_MANIFEST_SCHEMA,
    manifestVersion,
    selectionStatus: raw.selectionStatus,
    selectionEvidence,
    activeModelId,
    models,
    productionEnvelope,
    benchmarkEnvelope,
  };
}

export function getLocalModelManifest(options: { fresh?: boolean } = {}): LocalModelManifest {
  if (options.fresh) manifestCache = null;
  if (manifestCache) return manifestCache;
  const parsed = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as unknown;
  manifestCache = validateManifest(parsed);
  return manifestCache;
}

/**
 * Read the signed manifest without making process startup depend on its
 * availability. Runtime admission still uses the throwing accessor once the
 * provider is enabled; this result exists so a missing/corrupt image asset can
 * disable Ollama while the cloud-capable application continues to boot.
 */
export function tryGetLocalModelManifest(options: {
  fresh?: boolean;
  loader?: () => LocalModelManifest;
} = {}): LocalModelManifestLoadResult {
  if (options.fresh) manifestCache = null;
  try {
    return {
      ok: true,
      manifest: options.loader
        ? options.loader()
        : getLocalModelManifest({ fresh: options.fresh }),
    };
  } catch {
    return { ok: false, code: 'model_manifest_unavailable' };
  }
}

export function getActiveLocalModel(options: { fresh?: boolean } = {}): LocalModelManifestEntry {
  const manifest = getLocalModelManifest({ fresh: options.fresh ?? true });
  return manifest.models.find((model) => model.id === manifest.activeModelId)!;
}

export class OllamaSmallOnlyPolicyError extends Error {
  // Preserve the released machine contract while the implementation moves
  // from a hard-coded small-model allowlist to signed-manifest authority.
  readonly code = 'ollama_small_only_policy_violation';
  readonly policy = 'signed_model_manifest';
  readonly source: string;
  readonly receivedModel: string;
  readonly expectedModel: string;

  constructor(source: string, model: string, expectedModel?: string) {
    const expected = expectedModel ?? (() => {
      const loaded = tryGetLocalModelManifest({ fresh: true });
      if (!loaded.ok) return 'unavailable signed-manifest model';
      return loaded.manifest.models.find((candidate) => candidate.id === loaded.manifest.activeModelId)!.ollamaTag;
    })();
    super(
      `${source} must be the active signed-manifest model "${expected}"`
      + ` (or "${OLLAMA_FAST_MODEL_DISABLED}" where explicitly supported); received "${model}"`,
    );
    this.name = 'OllamaSmallOnlyPolicyError';
    this.source = source;
    this.receivedModel = model;
    this.expectedModel = expected;
  }
}

export function assertSmallOnlyOllamaModel(
  model: string,
  source: string,
  options: { allowOff?: boolean; expectedModel?: string } = {},
): string {
  const normalized = model.trim();
  if (options.allowOff && normalized.toLowerCase() === OLLAMA_FAST_MODEL_DISABLED) {
    return OLLAMA_FAST_MODEL_DISABLED;
  }
  const activeTag = options.expectedModel ?? (() => {
    const loaded = tryGetLocalModelManifest({ fresh: true });
    if (!loaded.ok) {
      throw new OllamaSmallOnlyPolicyError(source, normalized || '(empty)');
    }
    return loaded.manifest.models.find((candidate) => candidate.id === loaded.manifest.activeModelId)!.ollamaTag;
  })();
  if (normalized !== activeTag) {
    throw new OllamaSmallOnlyPolicyError(source, normalized || '(empty)', activeTag);
  }
  return activeTag;
}

export interface OllamaSmallOnlyRuntimeConfig {
  manifestAvailable: boolean;
  manifestErrorCode: 'model_manifest_unavailable' | null;
  model: string;
  classifierModel: string;
  localChatModel: string;
  localChatRecipeModel: string;
  localChatFastModel: string;
}

/** Validate every environment-controlled local-model selection at startup. */
export function resolveOllamaSmallOnlyRuntimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: { manifestLoader?: () => LocalModelManifest } = {},
): OllamaSmallOnlyRuntimeConfig {
  const legacyRollback = String(env.OLLAMA_OPERATIONAL_ROLLBACK_MODEL ?? '').trim();
  if (legacyRollback) {
    throw new OllamaSmallOnlyPolicyError('OLLAMA_OPERATIONAL_ROLLBACK_MODEL (removed)', legacyRollback);
  }

  const loaded = tryGetLocalModelManifest({ loader: options.manifestLoader });
  if (!loaded.ok) {
    return {
      manifestAvailable: false,
      manifestErrorCode: loaded.code,
      model: OLLAMA_FAST_MODEL_DISABLED,
      classifierModel: OLLAMA_FAST_MODEL_DISABLED,
      localChatModel: OLLAMA_FAST_MODEL_DISABLED,
      localChatRecipeModel: OLLAMA_FAST_MODEL_DISABLED,
      localChatFastModel: OLLAMA_FAST_MODEL_DISABLED,
    };
  }
  const activeTag = loaded.manifest.models.find((model) => model.id === loaded.manifest.activeModelId)!.ollamaTag;
  const expectedSelection = { expectedModel: activeTag } as const;
  const model = assertSmallOnlyOllamaModel(
    String(env.OLLAMA_MODEL ?? activeTag),
    'OLLAMA_MODEL',
    expectedSelection,
  );
  const classifierModel = assertSmallOnlyOllamaModel(
    String(env.OLLAMA_CLASSIFIER_MODEL ?? model),
    'OLLAMA_CLASSIFIER_MODEL',
    expectedSelection,
  );
  const localChatModel = assertSmallOnlyOllamaModel(
    String(env.CHAT_CORE_V2_LOCAL_CHAT_MODEL ?? classifierModel),
    'CHAT_CORE_V2_LOCAL_CHAT_MODEL',
    expectedSelection,
  );
  const localChatRecipeModel = assertSmallOnlyOllamaModel(
    String(env.CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL ?? localChatModel),
    'CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL',
    expectedSelection,
  );
  const localChatFastModel = assertSmallOnlyOllamaModel(
    String(env.CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL ?? OLLAMA_FAST_MODEL_DISABLED),
    'CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL',
    { allowOff: true, expectedModel: activeTag },
  );

  return {
    manifestAvailable: true,
    manifestErrorCode: null,
    model,
    classifierModel,
    localChatModel,
    localChatRecipeModel,
    localChatFastModel,
  };
}

export function resetLocalModelManifestCacheForTests(): void {
  manifestCache = null;
}
