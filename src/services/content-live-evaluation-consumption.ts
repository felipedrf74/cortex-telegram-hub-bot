// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import type { ContentLiveEvaluationArtifact } from './content-live-evaluation-artifact';

export type ContentLiveEvalConsumptionOutcome = 'pass' | 'fail';

export function contentLiveEvalConsumptionLedgerRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, '.local', 'content-eval', 'consumed');
}

export function contentLiveEvalConsumptionReceiptPath(
  artifact: Pick<ContentLiveEvaluationArtifact, 'bindingDigest'>,
  ledgerRoot = contentLiveEvalConsumptionLedgerRoot(),
): string {
  if (!/^[a-f0-9]{64}$/.test(artifact.bindingDigest)) {
    throw new Error('CONTENT_LIVE_EVAL_CONSUMPTION_BINDING_INVALID');
  }
  return path.join(path.resolve(ledgerRoot), `${artifact.bindingDigest}.json`);
}

function receiptPayload(
  artifact: ContentLiveEvaluationArtifact,
  claimedAt: string,
  state: 'claimed_for_release_evaluation' | 'completed_pass' | 'completed_fail',
  completedAt: string | null,
): Record<string, unknown> {
  return {
    schemaVersion: 'nexus.content-live-eval-consumption.v2',
    scope: 'local_fail_closed_digest_replay_control',
    state,
    runId: artifact.runId,
    sourceCommit: artifact.sourceIdentity.gitCommit,
    artifactBindingDigest: artifact.bindingDigest,
    keyFingerprint: artifact.attestation.keyFingerprint,
    claimedAt,
    completedAt,
  };
}

/**
 * Atomically claims one authenticated artifact by content digest before any
 * release gate consumes it. Copies and renamed files resolve to the same
 * ledger key. This is local fail-closed replay control, not an immutable
 * external transparency ledger.
 */
export function claimContentLiveEvalArtifactForRelease(
  artifact: ContentLiveEvaluationArtifact,
  options: { ledgerRoot?: string; now?: Date } = {},
): string {
  const ledgerRoot = path.resolve(options.ledgerRoot ?? contentLiveEvalConsumptionLedgerRoot());
  fs.mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(ledgerRoot, 0o700);
  const receiptPath = contentLiveEvalConsumptionReceiptPath(artifact, ledgerRoot);
  const claimedAt = (options.now ?? new Date()).toISOString();
  fs.writeFileSync(receiptPath, `${JSON.stringify(receiptPayload(
    artifact,
    claimedAt,
    'claimed_for_release_evaluation',
    null,
  ), null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(receiptPath, 0o600);
  return receiptPath;
}

export function finalizeContentLiveEvalArtifactClaim(
  claimPath: string,
  artifact: ContentLiveEvaluationArtifact,
  outcome: ContentLiveEvalConsumptionOutcome,
  completedAt = new Date(),
): void {
  const resolved = path.resolve(claimPath);
  const existing = JSON.parse(fs.readFileSync(resolved, 'utf8')) as Record<string, unknown>;
  if (
    existing.artifactBindingDigest !== artifact.bindingDigest
    || existing.runId !== artifact.runId
    || existing.state !== 'claimed_for_release_evaluation'
    || typeof existing.claimedAt !== 'string'
  ) {
    throw new Error('CONTENT_LIVE_EVAL_CONSUMPTION_CLAIM_MISMATCH');
  }
  const temporaryPath = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(receiptPayload(
    artifact,
    existing.claimedAt,
    outcome === 'pass' ? 'completed_pass' : 'completed_fail',
    completedAt.toISOString(),
  ), null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporaryPath, resolved);
  fs.chmodSync(resolved, 0o600);
}
