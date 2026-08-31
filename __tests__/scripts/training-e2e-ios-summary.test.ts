import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(__dirname, '../..');
const temporaryRoots: string[] = [];

function writeExecutable(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

interface HarnessExitCodes {
  prepare?: number;
  test?: number;
  verify?: number;
  cleanup?: number;
}

function runHarness(
  exitCodes: HarnessExitCodes,
  scenario: 'active-plan' | 'clarification' = 'clarification',
) {
  const {
    prepare: prepareExitCode = 0,
    test: testExitCode = 0,
    verify: verifyExitCode = 0,
    cleanup: cleanupExitCode = 0,
  } = exitCodes;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'training-e2e-ios-summary-'));
  temporaryRoots.push(fixtureRoot);

  const scriptsRoot = path.join(fixtureRoot, 'scripts');
  const iosRoot = path.join(fixtureRoot, 'ios-repo');
  const stateRoot = path.join(fixtureRoot, 'state');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const callLogPath = path.join(fixtureRoot, 'calls.log');
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  fs.copyFileSync(
    path.join(sourceRoot, 'scripts/training-e2e-ios.sh'),
    path.join(scriptsRoot, 'training-e2e-ios.sh'),
  );
  fs.chmodSync(path.join(scriptsRoot, 'training-e2e-ios.sh'), 0o755);

  fs.writeFileSync(path.join(scriptsRoot, 'training-e2e-env.sh'), `
set -euo pipefail
training_e2e_load_latest_env() { :; }
training_e2e_git() {
  if [[ "$1" == "rev-parse" ]]; then
    printf '%s\\n' '1111111111111111111111111111111111111111'
  fi
}
`);
  writeExecutable(path.join(scriptsRoot, 'training-e2e-run-ios-seed.sh'), `#!/usr/bin/env bash
mode="$1"
printf '%s\\n' "seed:$mode" >> "$FAKE_CALL_LOG"
case "$mode" in
  prepare|prepare-clarification) exit "$FAKE_PREPARE_EXIT_CODE" ;;
  verify-clarification) exit "$FAKE_VERIFY_EXIT_CODE" ;;
  cleanup|cleanup-clarification) exit "$FAKE_CLEANUP_EXIT_CODE" ;;
  *) exit 64 ;;
esac
`);

  writeExecutable(path.join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$3" == "rev-parse" ]]; then
  printf '%s\\n' '2222222222222222222222222222222222222222'
fi
`);
  writeExecutable(path.join(fakeBin, 'xcrun'), `#!/usr/bin/env bash
if [[ "$1" == "simctl" && "$2" == "list" && "$3" == "devices" ]]; then
  printf '%s\\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"udid":"SIM-UDID-1"}]}}'
elif [[ "$1" == "simctl" && "$2" == "list" && "$3" == "runtimes" ]]; then
  printf '%s\\n' '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-0","version":"26.0","isAvailable":true}]}'
fi
`);
  writeExecutable(path.join(iosRoot, 'scripts/ios-single-simulator-test.sh'), `#!/usr/bin/env bash
printf '%s\\n' "test:$*" >> "$FAKE_CALL_LOG"
exit "${testExitCode}"
`);

  const result = spawnSync('/bin/bash', [path.join(scriptsRoot, 'training-e2e-ios.sh')], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Keep the active Node runtime on PATH. GitHub's Linux runner installs
      // Node under /opt/hostedtoolcache rather than Homebrew, and replacing
      // PATH with macOS-only locations made the harness exit before it could
      // write the unified summary that these assertions protect.
      PATH: `${fakeBin}:${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      FAKE_CALL_LOG: callLogPath,
      FAKE_PREPARE_EXIT_CODE: String(prepareExitCode),
      FAKE_VERIFY_EXIT_CODE: String(verifyExitCode),
      FAKE_CLEANUP_EXIT_CODE: String(cleanupExitCode),
      NEXUS_TRAINING_E2E_ROOT: stateRoot,
      NEXUS_TRAINING_E2E_RUN_ID: 'semantic-contract-run',
      NEXUS_TRAINING_E2E_BASE_URL: 'http://127.0.0.1:19273',
      NEXUS_TRAINING_E2E_AUTH_FILE: path.join(fixtureRoot, 'auth.json'),
      NEXUS_TRAINING_E2E_IOS_ROOT: iosRoot,
      NEXUS_TRAINING_E2E_IOS_SIM_UDID: 'SIM-UDID-1',
      NEXUS_TRAINING_E2E_IOS_PRESEED_PLAN: '1',
      NEXUS_TRAINING_E2E_IOS_SCENARIO: scenario,
      NEXUS_TRAINING_E2E_DERIVED_DATA: path.join(fixtureRoot, 'DerivedData'),
    },
  });
  const summary = JSON.parse(
    fs.readFileSync(path.join(stateRoot, 'ios/training-e2e-ios-summary.json'), 'utf8'),
  );

  const calls = fs.existsSync(callLogPath)
    ? fs.readFileSync(callLogPath, 'utf8').trim().split('\n')
    : [];

  return { result, summary, calls };
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('Training E2E iOS unified result contract', () => {
  it('preserves the active-plan lane while recording verification as not required', () => {
    const { result, summary, calls } = runHarness({}, 'active-plan');

    expect(result.status).toBe(0);
    expect(calls).toEqual([
      'seed:prepare',
      'test:-only-testing:Nexus HubUITests/TrainingIsolatedBackendE2EUITests/test_isolatedBackendPlanRendersTodayPlanProgressAndPersistsFeedback -only-testing:Nexus HubUITests/TrainingFixtureBypassUITests -only-testing:Nexus HubUITests/TrainingValidationUITests',
      'seed:cleanup',
    ]);
    expect(summary).toMatchObject({
      schemaVersion: 'training_e2e_ios_run.v2',
      scenario: 'active-plan',
      prepare: { status: 'passed', exitCode: 0 },
      test: { status: 'passed', exitCode: 0 },
      verify: { status: 'not_required', exitCode: null },
      cleanup: {
        status: 'passed',
        exitCode: 0,
        fixturePrepared: true,
        planSeeded: true,
      },
    });
  });

  it('runs the clarification journey in strict prepare, UI, verify, cleanup order', () => {
    const { result, summary, calls } = runHarness({});

    expect(result.status).toBe(0);
    expect(calls).toEqual([
      'seed:prepare-clarification',
      'test:-only-testing:Nexus HubUITests/TrainingIsolatedBackendE2EUITests/test_isolatedBackendClarificationWritesProfileRepreviewsAndCreatesExactlyOnce',
      'seed:verify-clarification',
      'seed:cleanup-clarification',
    ]);
    expect(summary).toMatchObject({
      schemaVersion: 'training_e2e_ios_run.v2',
      scenario: 'clarification',
      prepare: { status: 'passed', exitCode: 0 },
      test: { status: 'passed', exitCode: 0 },
      verify: { status: 'passed', exitCode: 0 },
      // Stronger evidence guarantee: clarification prepare writes incomplete
      // profile fixtures/sentinel only; it does not pre-seed an active plan.
      cleanup: {
        status: 'passed',
        exitCode: 0,
        fixturePrepared: true,
        planSeeded: false,
      },
      harness: { preCleanupExitCode: 0, finalExitCode: 0 },
    });
    expect(summary.cleanup.seededPlan).toBeUndefined();
  });

  it('fails a passing test when fixture cleanup fails and records exact runtime identities', () => {
    const { result, summary } = runHarness({ cleanup: 7 });

    expect(result.status).toBe(7);
    expect(summary).toMatchObject({
      schemaVersion: 'training_e2e_ios_run.v2',
      runId: 'semantic-contract-run',
      scenario: 'clarification',
      backend: {
        gitSha: '1111111111111111111111111111111111111111',
        gitStatus: 'clean',
      },
      ios: {
        gitSha: '2222222222222222222222222222222222222222',
        gitStatus: 'clean',
      },
      simulator: {
        udid: 'SIM-UDID-1',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
        runtimeVersion: '26.0',
      },
      prepare: { status: 'passed', exitCode: 0 },
      test: { status: 'passed', exitCode: 0 },
      verify: { status: 'passed', exitCode: 0 },
      cleanup: {
        status: 'failed',
        exitCode: 7,
        fixturePrepared: true,
        planSeeded: false,
      },
      harness: { preCleanupExitCode: 0, finalExitCode: 7 },
    });
  });

  it('preserves the primary test failure while separately recording cleanup failure', () => {
    const { result, summary } = runHarness({ test: 5, cleanup: 7 });

    expect(result.status).toBe(5);
    expect(summary.test).toEqual({ status: 'failed', exitCode: 5 });
    expect(summary.cleanup).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(summary.harness).toEqual({ preCleanupExitCode: 5, finalExitCode: 5 });
  });

  it('runs verification after a UI failure and preserves the UI exit code', () => {
    const { result, summary, calls } = runHarness({ test: 5 });

    expect(result.status).toBe(5);
    expect(calls).toEqual([
      'seed:prepare-clarification',
      'test:-only-testing:Nexus HubUITests/TrainingIsolatedBackendE2EUITests/test_isolatedBackendClarificationWritesProfileRepreviewsAndCreatesExactlyOnce',
      'seed:verify-clarification',
      'seed:cleanup-clarification',
    ]);
    expect(summary.test).toEqual({ status: 'failed', exitCode: 5 });
    expect(summary.verify).toEqual({ status: 'passed', exitCode: 0 });
    expect(summary.cleanup).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(summary.harness).toEqual({ preCleanupExitCode: 5, finalExitCode: 5 });
  });

  it('fails a passing UI journey when authoritative verification fails', () => {
    const { result, summary } = runHarness({ verify: 9 });

    expect(result.status).toBe(9);
    expect(summary.test).toEqual({ status: 'passed', exitCode: 0 });
    expect(summary.verify).toEqual({ status: 'failed', exitCode: 9 });
    expect(summary.cleanup).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(summary.harness).toEqual({ preCleanupExitCode: 9, finalExitCode: 9 });
  });
});
