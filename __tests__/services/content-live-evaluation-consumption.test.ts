import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeReleaseQualifiedContentLiveEvalArtifact } from '../fixtures/content-live-evaluation';
import {
  claimContentLiveEvalArtifactForRelease,
  contentLiveEvalConsumptionReceiptPath,
  finalizeContentLiveEvalArtifactClaim,
} from '../../src/services/content-live-evaluation-consumption';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function ledgerRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-live-eval-consumption-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'ledger');
}

describe('content live-evaluation consumption receipts', () => {
  it('atomically claims by artifact digest, not the artifact filename, with owner-only permissions', () => {
    const ledger = ledgerRoot();
    const artifact = makeReleaseQualifiedContentLiveEvalArtifact();
    const receiptPath = claimContentLiveEvalArtifactForRelease(artifact, {
      ledgerRoot: ledger,
      now: new Date('2026-07-19T10:10:00.000Z'),
    });

    expect(receiptPath).toBe(contentLiveEvalConsumptionReceiptPath(artifact, ledger));
    expect(fs.statSync(ledger).mode & 0o777).toBe(0o700);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    const claim = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    expect(claim).toMatchObject({
      schemaVersion: 'nexus.content-live-eval-consumption.v2',
      scope: 'local_fail_closed_digest_replay_control',
      state: 'claimed_for_release_evaluation',
      runId: artifact.runId,
      sourceCommit: artifact.sourceIdentity.gitCommit,
      artifactBindingDigest: artifact.bindingDigest,
      keyFingerprint: artifact.attestation.keyFingerprint,
      claimedAt: '2026-07-19T10:10:00.000Z',
      completedAt: null,
    });
    expect(JSON.stringify(claim)).not.toContain('script');

    finalizeContentLiveEvalArtifactClaim(
      receiptPath,
      artifact,
      'pass',
      new Date('2026-07-19T10:11:00.000Z'),
    );
    expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))).toMatchObject({
      state: 'completed_pass',
      completedAt: '2026-07-19T10:11:00.000Z',
    });
  });

  it('blocks copied-path replay and two parallel claims before either gate can run', async () => {
    const ledger = ledgerRoot();
    const artifact = makeReleaseQualifiedContentLiveEvalArtifact();
    // No artifact path participates in this key, so copying or renaming the
    // same authenticated JSON cannot produce a second claim location.
    expect(contentLiveEvalConsumptionReceiptPath(artifact, ledger))
      .toBe(contentLiveEvalConsumptionReceiptPath(structuredClone(artifact), ledger));

    const claims = await Promise.allSettled([
      Promise.resolve().then(() => claimContentLiveEvalArtifactForRelease(artifact, { ledgerRoot: ledger })),
      Promise.resolve().then(() => claimContentLiveEvalArtifactForRelease(structuredClone(artifact), { ledgerRoot: ledger })),
    ]);
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'rejected')).toHaveLength(1);
    expect((claims.find((claim) => claim.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'EEXIST' });
  });
});
