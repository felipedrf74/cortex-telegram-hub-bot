#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export function validateLocalModelManifest(
  manifestPath = path.resolve(process.cwd(), 'config/local-model-manifest.json'),
) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = [];

  if (manifest.schemaVersion !== 'nexus.local-model-manifest.v1') errors.push('unsupported schemaVersion');
  if (!['control_only', 'production_selected'].includes(manifest.selectionStatus)) errors.push('invalid selectionStatus');
  if (typeof manifest.manifestVersion !== 'string' || !manifest.manifestVersion.trim()) errors.push('missing manifestVersion');
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) errors.push('models must be non-empty');

  const ids = new Set();
  const tags = new Set();
  for (const [index, model] of (manifest.models ?? []).entries()) {
    const prefix = `models[${index}]`;
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) errors.push(`${prefix}.id invalid or duplicate`);
    else ids.add(model.id);
    if (typeof model.ollamaTag !== 'string' || !model.ollamaTag.trim() || tags.has(model.ollamaTag)) errors.push(`${prefix}.ollamaTag invalid or duplicate`);
    else tags.add(model.ollamaTag);
    if (!['control', 'candidate', 'winner'].includes(model.role)) errors.push(`${prefix}.role invalid`);
    if (typeof model.license !== 'string' || !model.license.trim()) errors.push(`${prefix}.license missing`);
    if (typeof model.quantization !== 'string' || !model.quantization.trim()) errors.push(`${prefix}.quantization missing`);
    if (typeof model.promptTemplate !== 'string' || !model.promptTemplate.trim()) errors.push(`${prefix}.promptTemplate missing`);
    if (typeof model.runtimeVersion !== 'string' || !model.runtimeVersion.trim()) errors.push(`${prefix}.runtimeVersion missing`);
    if (!['candidate_unverified', 'verified'].includes(model.evidenceStatus)) errors.push(`${prefix}.evidenceStatus invalid`);
    if (model.digest !== null && (typeof model.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(model.digest))) {
      errors.push(`${prefix}.digest invalid`);
    }
    if (!positiveInteger(model.maxContextTokens)) errors.push(`${prefix}.maxContextTokens invalid`);
    if (typeof model.productionEligible !== 'boolean') errors.push(`${prefix}.productionEligible invalid`);
  }

  const active = (manifest.models ?? []).find((model) => model.id === manifest.activeModelId);
  if (!active || active.productionEligible !== true) errors.push('active model missing or not production eligible');
  if (active && (active.evidenceStatus !== 'verified'
      || !/^sha256:[0-9a-f]{64}$/.test(active.digest ?? ''))) {
    errors.push('active model must always be verified and digest-pinned');
  }
  const winners = (manifest.models ?? []).filter((model) => model?.role === 'winner');
  if (manifest.selectionStatus === 'control_only' && winners.length !== 0) {
    errors.push('control-only manifest cannot claim a winner');
  }
  if (manifest.selectionStatus === 'production_selected'
      && (!active || active.role !== 'winner' || winners.length !== 1 || winners[0]?.id !== active.id)) {
    errors.push('production-selected active model must be the only verified, digest-pinned winner');
  }
  if (manifest.selectionStatus === 'control_only') {
    if (manifest.selectionEvidence !== null) errors.push('control-only manifest must not claim selectionEvidence');
  } else {
    const evidence = manifest.selectionEvidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      errors.push('production-selected manifest requires selectionEvidence');
    } else {
      if (typeof evidence.winningCandidateId !== 'string'
          || evidence.winningCandidateId.trim() !== manifest.activeModelId) {
        errors.push('selectionEvidence.winningCandidateId invalid');
      }
      if (typeof evidence.benchmarkReportDigest !== 'string'
          || !/^sha256:[0-9a-f]{64}$/.test(evidence.benchmarkReportDigest)) {
        errors.push('selectionEvidence.benchmarkReportDigest invalid');
      }
      if (typeof evidence.benchmarkCompletedAt !== 'string'
          || Number.isNaN(Date.parse(evidence.benchmarkCompletedAt))
          || new Date(evidence.benchmarkCompletedAt).toISOString() !== evidence.benchmarkCompletedAt) {
        errors.push('selectionEvidence.benchmarkCompletedAt invalid');
      }
      if (typeof evidence.benchmarkHostRollbackReceiptDigest !== 'string'
          || !/^sha256:[0-9a-f]{64}$/.test(evidence.benchmarkHostRollbackReceiptDigest)) {
        errors.push('selectionEvidence.benchmarkHostRollbackReceiptDigest invalid');
      }
      for (const field of [
        'corpusReference',
        'licenseReviewReference',
        'ownerApprovalReference',
      ]) {
        if (typeof evidence[field] !== 'string' || !evidence[field].trim() || evidence[field].trim().length > 512) {
          errors.push(`selectionEvidence.${field} invalid`);
        }
      }
    }
  }

  for (const name of ['productionEnvelope', 'benchmarkEnvelope']) {
    const envelope = manifest[name];
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      errors.push(`${name} missing`);
      continue;
    }
    for (const field of ['cpuQuotaPercent', 'memoryHighBytes', 'memoryMaxBytes', 'maxContextTokens']) {
      if (!positiveInteger(envelope[field])) errors.push(`${name}.${field} invalid`);
    }
    if (!Number.isSafeInteger(envelope.memorySwapMaxBytes) || envelope.memorySwapMaxBytes < 0) {
      errors.push(`${name}.memorySwapMaxBytes invalid`);
    }
    if (!Number.isInteger(envelope.nice) || envelope.nice < -20 || envelope.nice > 19) errors.push(`${name}.nice invalid`);
    if (positiveInteger(envelope.memoryHighBytes)
        && positiveInteger(envelope.memoryMaxBytes)
        && envelope.memoryHighBytes > envelope.memoryMaxBytes) errors.push(`${name}.memoryHighBytes exceeds memoryMaxBytes`);
  }

  if (active && active.maxContextTokens > manifest.productionEnvelope?.maxContextTokens) {
    errors.push('active model context exceeds production envelope');
  }
  if (manifest.productionEnvelope?.memoryMaxBytes !== 20 * 1024 ** 3
      || manifest.productionEnvelope?.memoryHighBytes !== 18 * 1024 ** 3
      || manifest.productionEnvelope?.memorySwapMaxBytes !== 0
      || manifest.productionEnvelope?.cpuQuotaPercent !== 800
      || manifest.productionEnvelope?.minimumHostAvailableBytes !== 6 * 1024 ** 3
      || manifest.productionEnvelope?.maxLoadedModels !== 1
      || manifest.productionEnvelope?.parallelGenerations !== 1
      || manifest.productionEnvelope?.waitingQueueDepth !== 4
      || manifest.productionEnvelope?.maxContextTokens !== 16_384
      || manifest.productionEnvelope?.nice !== 10) {
    errors.push('production envelope drifted from the approved 20GB/8CPU/zero-swap policy');
  }
  if (manifest.benchmarkEnvelope?.memoryMaxBytes !== 24 * 1024 ** 3
      || manifest.benchmarkEnvelope?.memoryHighBytes !== 22 * 1024 ** 3
      || manifest.benchmarkEnvelope?.memorySwapMaxBytes !== 0
      || manifest.benchmarkEnvelope?.cpuQuotaPercent !== 800
      || manifest.benchmarkEnvelope?.minimumHostAvailableBytes !== 6 * 1024 ** 3
      || manifest.benchmarkEnvelope?.maxLoadedModels !== 1
      || manifest.benchmarkEnvelope?.parallelGenerations !== 1
      || manifest.benchmarkEnvelope?.waitingQueueDepth !== 4
      || manifest.benchmarkEnvelope?.maxContextTokens !== 16_384
      || manifest.benchmarkEnvelope?.nice !== 10) {
    errors.push('benchmark envelope drifted from the approved 24GB/8CPU/zero-swap policy');
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  return {
    ok: true,
    schemaVersion: manifest.schemaVersion,
    manifestVersion: manifest.manifestVersion,
    selectionStatus: manifest.selectionStatus,
    activeModelId: manifest.activeModelId,
    candidates: manifest.models.filter((model) => model.role === 'candidate').length,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    console.log(JSON.stringify(validateLocalModelManifest(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
