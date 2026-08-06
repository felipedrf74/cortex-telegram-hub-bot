import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKEND_IOS_CONTRACT_FIXTURE_PATH,
  backendIosContractDigest,
  backendIosContractFixtureIdentity,
  validateBackendIosContractFixtureBytes,
} from '../../scripts/lib/backend-ios-contract-fixture.mjs';
import { buildBackendIosContractFixture } from '../../src/release/backend-ios-contract-fixture';

const roots: string[] = [];

function fixtureDocument() {
  return {
    schema: 'nexus.backend-ios-contract-fixtures.v1',
    contracts: [
      { id: 'dashboard.home.v1', method: 'GET', path: '/api/v1/dashboard/home', decoder: 'HomeViewState', payload: { hero: {} } },
      { id: 'training.home.v1', method: 'GET', path: '/api/v1/training/home', decoder: 'TrainingHomeViewState', payload: { hero: {} } },
      { id: 'content.home.v1', method: 'GET', path: '/api/v1/content/home', decoder: 'ContentHomeViewState', payload: { hero: {} } },
      {
        id: 'training.plan.generate.created.v1',
        method: 'POST',
        path: '/api/v1/training/plan/generate',
        decoder: 'PlanGenerateResponse',
        payload: {
          schemaVersion: 'training_plan_generation_response.v1',
          status: 'created',
          planId: 9001,
          eventsCreated: 0,
          calendarSync: { status: 'not_synced', pending: true },
        },
      },
      {
        id: 'training.plan.generate.needs-clarification.v1',
        method: 'POST',
        path: '/api/v1/training/plan/generate',
        decoder: 'PlanGenerateResponse',
        payload: {
          schemaVersion: 'training_plan_generation_response.v1',
          status: 'needs_clarification',
          clarificationIssues: [{
            id: 'equipment_clarification',
            severity: 'blocker',
            question: 'What equipment can you use?',
            reason: 'Equipment must be explicit.',
            resolution: {
              profileType: 'triathlon-gym',
              fields: [{ fieldKey: 'equipment_access', answerType: 'choice', allowedValues: ['Full commercial gym'] }],
            },
          }],
        },
      },
      {
        id: 'training.plan.generation-attempt-status.created.v1',
        method: 'POST',
        path: '/api/v1/training/plan/generation-attempt/status',
        decoder: 'TrainingPlanGenerationAttemptStatus',
        payload: {
          schemaVersion: 'training_plan_generation_attempt_status.v1',
          state: 'created',
          recovery: 'use_created_plan',
          canStartNew: false,
          planId: 9001,
        },
      },
    ],
  };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('backend/iOS candidate contract fixture', () => {
  it('carries the real Training create, clarification-resolution, and attempt-status contracts', () => {
    const fixture = buildBackendIosContractFixture();
    const validated = validateBackendIosContractFixtureBytes(
      Buffer.from(`${JSON.stringify(fixture)}\n`),
    );

    expect(fixture.contracts.map((contract) => contract.id)).toEqual(
      fixtureDocument().contracts.map((contract) => contract.id),
    );
    expect(validated.fixture.contracts).toHaveLength(6);
    const created = fixture.contracts[3].payload;
    expect(created).toMatchObject({
      schemaVersion: 'training_plan_generation_response.v1',
      status: 'created',
      calendarSync: { status: 'not_synced', pending: true },
    });
    const clarification = fixture.contracts[4].payload;
    expect(clarification).toMatchObject({
      schemaVersion: 'training_plan_generation_response.v1',
      status: 'needs_clarification',
      clarificationIssues: [{
        id: 'equipment_clarification',
        severity: 'blocker',
        resolution: {
          profileType: 'triathlon-gym',
          fields: [{ fieldKey: 'equipment_access', answerType: 'choice' }],
        },
      }],
    });
    expect(fixture.contracts[5].payload).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'created',
      recovery: 'use_created_plan',
      canStartNew: false,
      planId: 9001,
    });
  });

  it('binds canonical fixture bytes into both the runtime artifact and contract subject', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backend-ios-fixture-'));
    roots.push(root);
    const bytes = Buffer.from(`${JSON.stringify(fixtureDocument())}\n`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const file = path.join(root, BACKEND_IOS_CONTRACT_FIXTURE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    const artifact = {
      files: [{ path: BACKEND_IOS_CONTRACT_FIXTURE_PATH, size: bytes.length, sha256: digest }],
    };

    expect(validateBackendIosContractFixtureBytes(bytes)).toMatchObject({ digest });
    expect(backendIosContractFixtureIdentity({ bundleRoot: root, artifact })).toMatchObject({
      digest,
      relativePath: BACKEND_IOS_CONTRACT_FIXTURE_PATH,
    });
    const subject = backendIosContractDigest({
      runtimeSha: 'a'.repeat(40),
      artifactDigest: 'b'.repeat(64),
      fixtureDigest: digest,
    });
    expect(subject).toMatch(/^[0-9a-f]{64}$/);
    expect(backendIosContractDigest({
      runtimeSha: 'a'.repeat(40),
      artifactDigest: 'b'.repeat(64),
      fixtureDigest: 'c'.repeat(64),
    })).not.toBe(subject);
  });

  it('rejects incompatible, substituted, non-canonical, or undeclared candidate fixtures', () => {
    const compatible = fixtureDocument();
    const incompatible = structuredClone(compatible);
    incompatible.contracts[2].decoder = 'ArbitraryFutureModel';
    expect(() => validateBackendIosContractFixtureBytes(
      Buffer.from(`${JSON.stringify(incompatible)}\n`),
    )).toThrow('identity or payload is invalid');

    expect(() => validateBackendIosContractFixtureBytes(
      Buffer.from(JSON.stringify(compatible, null, 2)),
    )).toThrow('bytes are not canonical');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backend-ios-fixture-'));
    roots.push(root);
    const bytes = Buffer.from(`${JSON.stringify(compatible)}\n`);
    const file = path.join(root, BACKEND_IOS_CONTRACT_FIXTURE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    expect(() => backendIosContractFixtureIdentity({
      bundleRoot: root,
      artifact: { files: [] },
    })).toThrow('missing or duplicated');
    expect(() => backendIosContractFixtureIdentity({
      bundleRoot: root,
      artifact: {
        files: [{
          path: BACKEND_IOS_CONTRACT_FIXTURE_PATH,
          size: bytes.length,
          sha256: '0'.repeat(64),
        }],
      },
    })).toThrow('differs from the runtime artifact manifest');
  });
});
