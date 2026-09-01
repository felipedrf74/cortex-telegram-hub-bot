import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('isolated Training E2E harness', () => {
  it('uses a dedicated compose file without fixed names, default ports, or shared named volumes', () => {
    const compose = read('docker-compose.training-e2e.yml');

    expect(compose).not.toMatch(/container_name\s*:/);
    expect(compose).not.toContain('127.0.0.1:8200:8200');
    expect(compose).not.toContain('127.0.0.1:8100:8100');
    expect(compose).not.toMatch(/name:\s*nexus_hub_local_/);
    expect(compose).toContain('${NEXUS_TRAINING_E2E_ROOT');
    expect(compose).toContain('${NEXUS_TRAINING_E2E_PORT_TS:-18200}:8200');
    expect(compose).toContain('${NEXUS_TRAINING_E2E_PORT_PY:-18100}:8100');
    expect(compose).toContain('PORTAL_READ_TOKEN');
    expect(compose).toContain('IOS_API_JWT_KEYS: ""');
    expect(compose).toContain('IOS_API_JWT_ACTIVE_KID: ""');
    expect(compose).toContain('SQLITE_JOURNAL_MODE: "DELETE"');
    expect(compose).toContain('SQLITE_SYNCHRONOUS: "FULL"');
    // Stronger Docker fixture guarantee: keep the documented rollback-mode
    // posture even though live fixture writes now stay inside Linux.
    expect(compose).toContain('SQLITE_MMAP_SIZE: "0"');
    // Stronger lock-domain guarantee: executable fixture scripts and state
    // are available inside the backend container, so no host process writes
    // SQLite while the Linux backend has the database open.
    expect(compose).toContain('${NEXUS_TRAINING_E2E_SOURCE_ROOT:?Training E2E source root is required}/scripts:/app/scripts:ro');
    expect(compose).toContain('${NEXUS_TRAINING_E2E_ROOT:-./.local/training-e2e/default}:/app/training-e2e-state');
    expect(compose).toContain('DATABASE_PATH: "/app/training-e2e-state/data/training-e2e.db"');
    expect(compose).toContain('TRAINING_CALENDAR_WRITES_ENABLED: "false"');
    expect(compose).toContain('TRAINING_CALENDAR_SYNC_ENABLED: "false"');
    expect(compose).toContain('TRAINING_PLAN_REVISION_V1_MODE_USER_2: "active"');
    expect(compose).toContain('TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_2: "true"');
    expect(compose).toContain('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_2: "true"');
    expect(compose).toContain('TRAINING_ADAPTATION_V1_MODE_USER_2: "active"');
    expect(compose).toContain('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: "training-e2e-revision-snapshot-key-20260830"');
    expect(compose).toContain('TRAINING_CALENDAR_CAPACITY_KERNEL_ENABLED: ${NEXUS_TRAINING_E2E_CAPACITY_KERNEL:-on}');
    expect(compose).not.toContain('./content-engine:/engine');
  });

  it('records engine identity and refuses default local ports as evidence', () => {
    const up = read('scripts/training-e2e-up.sh');
    const contract = read('scripts/lib/training-e2e-contract.mjs');
    const env = read('scripts/training-e2e-env.sh');
    const smoke = read('scripts/training-e2e-smoke.sh');

    expect(env).toContain('training_e2e_git_dir()');
    expect(env).toContain('training_e2e_git()');
    expect(up).toContain('$(training_e2e_git rev-parse --short HEAD)');
    // Stronger provenance guarantee: resolve and validate the repository
    // identity once, then export that same pinned value to every consumer.
    expect(up).toContain('GIT_DIR="$(training_e2e_git_dir)"');
    expect(up).toContain('export NEXUS_TRAINING_E2E_SOURCE_ROOT="$ROOT"');
    expect(up).toContain('export NEXUS_TRAINING_E2E_GIT_DIR="$GIT_DIR"');
    expect(up).toContain("export NEXUS_TRAINING_E2E_GIT_DIR='$NEXUS_TRAINING_E2E_GIT_DIR'");
    expect(up).toContain('IOS_JWT_SECRET_FILE="$STATE_DIR/quality-ios-jwt-secret"');
    expect(up).toContain('chmod 600 "$IOS_JWT_SECRET_FILE"');
    expect(up).toContain("export NEXUS_TRAINING_E2E_IOS_JWT_SECRET_FILE='$IOS_JWT_SECRET_FILE'");
    expect(up).toContain('process.env.NEXUS_TRAINING_E2E_GIT_DIR');
    expect(up).toContain('git --git-dir=${gitDir} --work-tree=${workTree}');
    // Metadata must carry the exact pre-build commit instead of re-reading a
    // potentially changed HEAD after the containers have been built.
    expect(up).toContain('commit: process.env.NEXUS_TRAINING_E2E_BACKEND_COMMIT');
    // Stronger source-identity guarantee: mutable shared fallback tags are
    // gone and both image names must carry the current run id.
    expect(up).toContain('nexus-hub-node:training-e2e-${RUN_ID}');
    expect(up).toContain('nexus-hub-content-engine:training-e2e-${RUN_ID}');
    expect(up).toContain('actualContainerImageId');
    expect(up).toContain('NEXUS_TRAINING_E2E_RESUME');
    expect(up).toContain('docker image inspect ${JSON.stringify(backendImageName)}');
    expect(up).toContain('repoDigests');
    expect(up).toContain('NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK=sandbox-non-prod-calendar');
    expect(up).toContain('docker-compose.live-calendar.override.yml');
    expect(up).toContain('NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN');
    expect(up).toContain('NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN');
    expect(up).toContain('require_sandbox_label');
    expect(contract).toContain('GOOGLE_REFRESH_TOKEN: ""');
    expect(contract).toContain('OUTLOOK_REFRESH_TOKEN: ""');
    expect(up).toContain('metadata.json');
    expect(up).toContain('liveCalendar');
    expect(up).toContain("synchronous: 'FULL'");
    expect(up).toContain('mmapSize: 0');
    expect(up).toContain("fixtureLockDomain: 'container'");
    expect(up).toContain("PORT_TS\" == \"8200\"");
    expect(up).toContain("PORT_PY\" == \"8100\"");
    expect(smoke).toContain('refusing to accept default local backend port');
    expect(smoke).toContain('Authorization: Bearer ${NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN}');
    expect(smoke).toContain('/api/snapshot');
    expect(smoke).toContain('SNAPSHOT_PATH="$(mktemp)"');
    expect(smoke).toContain('--output "$SNAPSHOT_PATH"');
    expect(smoke).toContain("JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))");
    expect(smoke).not.toContain('"$SNAPSHOT"');
  });

  it('runs iOS against an explicit dedicated simulator without shutting down unrelated simulators', () => {
    const ios = read('scripts/training-e2e-ios.sh');
    const seed = read('scripts/training-e2e-ios-seed.mjs');
    const seedRunner = read('scripts/training-e2e-run-ios-seed.sh');

    expect(ios).toContain('NEXUS_TRAINING_E2E_BASE_URL');
    expect(ios).toContain('NEXUS_TRAINING_E2E_RUN_ID="$NEXUS_TRAINING_E2E_RUN_ID"');
    expect(ios).toContain('IOS_CONFIG_DIR="$STATE_DIR/config"');
    expect(ios).toContain('training-e2e-config.json');
    expect(ios).toContain('${NEXUS_TRAINING_E2E_RUN_ID}.json');
    expect(ios).not.toContain('current-config.json');
    expect(ios).toContain('write_ios_config');
    expect(ios).toContain('NEXUS_TRAINING_E2E_CONFIG_PATH="${IOS_CONFIG_PATHS[0]}"');
    expect(ios).toContain('IOS_TEST_ARGS=("$@")');
    expect(ios).toContain('IOS_SCHEME="${NEXUS_TRAINING_E2E_IOS_SCHEME:-Nexus Hub Debug UI Smoke}"');
    // Stronger scenario guarantee: prepare/verify/cleanup are selected from
    // one validated scenario, so cleanup cannot drift from the seeded mode.
    expect(ios).toContain('FIXTURE_PREPARE_MODE=prepare');
    expect(ios).toContain('FIXTURE_CLEANUP_MODE=cleanup');
    expect(ios).toContain('IOS_SEED_RUNNER="$ROOT/scripts/training-e2e-run-ios-seed.sh"');
    expect(ios).toContain('"$IOS_SEED_RUNNER" "$FIXTURE_PREPARE_MODE"');
    expect(ios).toContain('"$IOS_SEED_RUNNER" "$FIXTURE_VERIFY_MODE"');
    expect(ios).toContain('"$IOS_SEED_RUNNER" "$FIXTURE_CLEANUP_MODE"');
    expect(ios).not.toContain('node "$ROOT/scripts/training-e2e-ios-seed.mjs"');
    // SQLite-bearing prepare/verify/cleanup work stays in the same Linux lock
    // domain as the backend, with host-side provenance checks around it.
    expect(seedRunner).toContain('exec -T');
    expect(seedRunner).toContain('NEXUS_TRAINING_E2E_IN_CONTAINER=1');
    expect(seedRunner).toContain('NEXUS_TRAINING_E2E_ROOT=/app/training-e2e-state');
    expect(seedRunner).toContain('NEXUS_TRAINING_E2E_AUTH_FILE=/app/training-e2e-state/local-ios-auth.json');
    expect(seedRunner).toContain('NEXUS_TRAINING_E2E_API_BASE_URL=http://127.0.0.1:8200');
    expect(seedRunner.match(/training-e2e-verify-freshness\.mjs/g)).toHaveLength(2);
    expect(seed).toContain("const inContainer = process.env.NEXUS_TRAINING_E2E_IN_CONTAINER === '1'");
    expect(seed).toContain("metadata.sqlite?.fixtureLockDomain === 'container'");
    expect(seed).toContain("path.join(env.NEXUS_TRAINING_E2E_ROOT, 'data', 'training-e2e.db')");
    expect(seed).toContain('NEXUS_TRAINING_E2E_API_BASE_URL');
    expect(ios).toContain('NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN');
    expect(ios).toContain('IOS_REQUIRE_UDID=1');
    expect(ios).toContain('IOS_SHUTDOWN_OTHER_SIMS=0');
    expect(ios).toContain('IOS_ALLOW_MULTIPLE_BOOTED=1');
    expect(ios).toContain('IOS_QUIT_SIMULATOR_APP=0');
    expect(ios).toContain('IOS_TRIM_SIMULATOR_PROCESSES=0');
    // The clarification fixture must keep the required Fitness key present
    // without accidentally resolving equipment before the athlete answers.
    expect(seed).toContain("available_equipment: omitPlanClarifications ? 'unknown' : 'Full gym'");
    expect(ios).not.toContain('simctl shutdown all');
    expect(ios).toContain(
      '-only-testing:"Nexus HubUITests/TrainingIsolatedBackendE2EUITests/test_isolatedBackendPlanRendersTodayPlanProgressAndPersistsFeedback"',
    );
    expect(ios).toContain(
      '-only-testing:"Nexus HubUITests/TrainingIsolatedBackendE2EUITests/test_isolatedBackendClarificationWritesProfileRepreviewsAndCreatesExactlyOnce"',
    );
    expect(ios).not.toContain('-only-testing:"Nexus HubUITests/TrainingIsolatedBackendE2EUITests"\n');
    expect(ios).toContain('-only-testing:"Nexus HubUITests/TrainingFixtureBypassUITests"');
    expect(ios).toContain('-only-testing:"Nexus HubUITests/TrainingValidationUITests"');
  });

  it('exposes npm scripts for the isolated Training E2E lane', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const flowRunner = read('scripts/training-e2e-run-flow.sh');
    const qualityRunner = read('scripts/training-e2e-run-quality.sh');

    expect(pkg.scripts['training:e2e:up']).toBe('scripts/training-e2e-up.sh');
    expect(pkg.scripts['training:e2e:smoke']).toBe('scripts/training-e2e-smoke.sh');
    // Stronger guarantee: lifecycle and persona database work runs inside the
    // backend container's Linux lock domain. Host-side checks still attest the
    // exact source and image before and after the evidence writers run.
    expect(pkg.scripts['training:e2e:flow']).toBe('scripts/training-e2e-run-flow.sh');
    expect(flowRunner).toContain('training-e2e-verify-freshness.mjs');
    expect(flowRunner.match(/training-e2e-verify-freshness\.mjs/g)).toHaveLength(2);
    expect(flowRunner).toContain('exec -T');
    expect(flowRunner).toContain('NEXUS_TRAINING_E2E_IN_CONTAINER=1');
    expect(flowRunner).toContain('node scripts/training-e2e-flow.mjs');
    expect(flowRunner).toContain('npx tsx scripts/training-e2e-quality.ts');
    // Stronger guarantee: a quality-only diagnostic rerun must preserve the
    // same Linux SQLite lock domain as the combined lifecycle runner. The old
    // direct tsx command reopened the bind-mounted database from macOS.
    expect(pkg.scripts['training:e2e:quality']).toBe('scripts/training-e2e-run-quality.sh');
    expect(qualityRunner.match(/training-e2e-verify-freshness\.mjs/g)).toHaveLength(2);
    expect(qualityRunner).toContain('exec -T');
    expect(qualityRunner).toContain('NEXUS_TRAINING_E2E_IN_CONTAINER=1');
    expect(qualityRunner).toContain('npx tsx scripts/training-e2e-quality.ts');
    expect(pkg.scripts['training:e2e:ios-seed']).toBe('scripts/training-e2e-run-ios-seed.sh prepare');
    expect(pkg.scripts['training:e2e:ios']).toBe('scripts/training-e2e-ios.sh');
    expect(pkg.scripts['training:e2e:live-calendar']).toBe('npx tsx scripts/training-e2e-live-calendar.ts');
    expect(pkg.scripts['training:e2e:down']).toBe('scripts/training-e2e-down.sh');
  });

  it('covers feedback variants, repeated skips, persistence, read models, and reflow', () => {
    const flow = read('scripts/training-e2e-flow.mjs');

    expect(flow).toContain('if (!inContainer && !env.NEXUS_TRAINING_E2E_GIT_DIR)');
    expect(flow).toContain('readCompletionFeedbackRows');
    expect(flow).toContain("strongConfirmationText: 'CONFIRM'");
    expect(flow).toContain("approvedDecisionItem?.decisionState === 'approved'");
    expect(flow).toContain("approvedCandidateDecisionItem?.decisionState === 'approved'");
    expect(flow).toContain("actionId: 'activate_training_plan_revision'");
    expect(flow).toContain('expectedVersion: approvedCandidateDecisionItem.recordVersion');
    expect(flow).toContain('contextVersion: approvedCandidateDecisionItem.contextVersion');
    expect(flow).toContain('/api/v1/training/plan/candidates');
    expect(flow).toContain('TRAINING_REVISION_PROFILE_REQUIRED');
    expect(flow).toContain("'/api/v1/health-data/sync'");
    expect(flow).not.toContain("'/api/v1/training/plan/generate'");
    expect(flow).toContain('flowAttemptId');
    expect(flow).toContain('Activated candidate plan was not persisted in the isolated database');
    expect(flow).toContain('Activated candidate sessions were not persisted in the isolated database');
    expect(flow).toContain('noActiveSession !== true');
    expect(flow).toContain('calendarSyncRetry');
    expect(flow).toContain('[200, 409, 503]');
    expect(flow).toContain('feedback_variants_and_repeated_skips');
    expect(flow).toContain('Fixture-safe E2E easy feedback');
    expect(flow).toContain('Fixture-safe E2E normal completion feedback');
    expect(flow).toContain('Fixture-safe E2E hard partial feedback with pain signal');
    // Stronger F18/E2 guarantee: use the released explicit disposition and
    // recompute completion percentages from post-reflow durable sessions.
    expect(flow).toContain("completionState: 'partial'");
    expect(flow).toContain("status: 'partial'");
    expect(flow).toContain('const refreshedSessions = readPersistedSessions(planId)');
    expect(flow).toContain('partialSessionIds: [hardPartialSession.id]');
    expect(flow).toContain("painLocation: 'left knee'");
    expect(flow).toContain('sorenessLevel: 8');
    expect(flow).toContain('skipSessions.length >= 3');
    expect(flow).toContain("item.status === 'partial'");
    expect(flow).toContain('/reflow-preview');
    expect(flow).toContain('revision_owned_legacy_reflow_guard');
    expect(flow).toContain('readTrainingPlanRowCount');
    expect(flow).toContain('FROM fitness_training_plans WHERE id = ?');
    expect(flow).toContain('revision_owned_legacy_cancel_guard');
    expect(flow).toContain('TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED');
    expect(flow).toContain("'/api/v1/training/plan/cancel'");
  });

  it('has explicit iOS seed and live sandbox calendar lifecycle harnesses', () => {
    const iosSeed = read('scripts/training-e2e-ios-seed.mjs');
    const liveCalendar = read('scripts/training-e2e-live-calendar.ts');

    expect(iosSeed).toContain('Training E2E Active Plan');
    expect(iosSeed).toContain('seedAttemptId');
    expect(iosSeed).toContain('was not persisted in the isolated database');
    expect(iosSeed).toContain('did not persist any sessions for iOS assertions');
    expect(iosSeed).toContain('pinFirstSeededSessionToToday');
    expect(iosSeed).toContain('training-ios-seed-evidence.json');
    expect(iosSeed).toContain("mode === 'cleanup'");
    expect(iosSeed).toContain("'/api/v1/training/plan/cancel'");

    expect(liveCalendar).toContain('sandbox-non-prod-calendar');
    expect(liveCalendar).toContain('NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN');
    expect(liveCalendar).toContain('NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN');
    expect(liveCalendar).toContain('seedProviderToken');
    expect(liveCalendar).toContain('verifyIdempotentSync');
    expect(liveCalendar).toContain('verifyExternalMoveRepair');
    expect(liveCalendar).toContain('verifyExternalDeleteRepair');
    expect(liveCalendar).toContain('cleanupPlanAndProviderEvents');
    expect(liveCalendar).toContain('readProviderEventsByRunMarker');
    expect(liveCalendar).toContain('leftovers.length === 0');
    expect(liveCalendar).toContain("metadata.liveCalendar?.enabled !== true");
    expect(liveCalendar).toContain("baseUrl.includes(':8200')");
  });
});
