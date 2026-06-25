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
    expect(compose).toContain('SQLITE_JOURNAL_MODE: "DELETE"');
    expect(compose).toContain('TRAINING_CALENDAR_WRITES_ENABLED: "false"');
    expect(compose).toContain('TRAINING_CALENDAR_SYNC_ENABLED: "false"');
  });

  it('records engine identity and refuses default local ports as evidence', () => {
    const up = read('scripts/training-e2e-up.sh');
    const env = read('scripts/training-e2e-env.sh');
    const smoke = read('scripts/training-e2e-smoke.sh');

    expect(env).toContain('training_e2e_git_dir()');
    expect(env).toContain('training_e2e_git()');
    expect(up).toContain('$(training_e2e_git rev-parse --short HEAD)');
    expect(up).toContain('export NEXUS_TRAINING_E2E_GIT_DIR="$(training_e2e_git_dir)"');
    expect(up).toContain("export NEXUS_TRAINING_E2E_GIT_DIR='$NEXUS_TRAINING_E2E_GIT_DIR'");
    expect(up).toContain('process.env.NEXUS_TRAINING_E2E_GIT_DIR');
    expect(up).toContain('git --git-dir=${gitDir} --work-tree=${workTree}');
    expect(up).toContain("commit: git('rev-parse HEAD')");
    expect(up).toContain("backendImageName = process.env.NEXUS_TRAINING_E2E_NODE_IMAGE || 'nexus-hub-node:training-e2e'");
    expect(up).toContain("contentImageName = process.env.NEXUS_TRAINING_E2E_CONTENT_IMAGE || 'nexus-hub-content-engine:training-e2e'");
    expect(up).toContain('docker image inspect ${JSON.stringify(backendImageName)}');
    expect(up).toContain('repoDigests');
    expect(up).toContain('NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK=sandbox-non-prod-calendar');
    expect(up).toContain('docker-compose.live-calendar.override.yml');
    expect(up).toContain('NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN');
    expect(up).toContain('NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN');
    expect(up).toContain('require_sandbox_label');
    expect(up).toContain('GOOGLE_REFRESH_TOKEN: ""');
    expect(up).toContain('OUTLOOK_REFRESH_TOKEN: ""');
    expect(up).toContain('metadata.json');
    expect(up).toContain('liveCalendar');
    expect(up).toContain("PORT_TS\" == \"8200\"");
    expect(up).toContain("PORT_PY\" == \"8100\"");
    expect(smoke).toContain('refusing to accept default local backend port');
    expect(smoke).toContain('Authorization: Bearer ${NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN}');
    expect(smoke).toContain('/api/snapshot');
  });

  it('runs iOS against an explicit dedicated simulator without shutting down unrelated simulators', () => {
    const ios = read('scripts/training-e2e-ios.sh');

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
    expect(ios).toContain('training-e2e-ios-seed.mjs" prepare');
    expect(ios).toContain('training-e2e-ios-seed.mjs" cleanup');
    expect(ios).toContain('NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN');
    expect(ios).toContain('IOS_REQUIRE_UDID=1');
    expect(ios).toContain('IOS_SHUTDOWN_OTHER_SIMS=0');
    expect(ios).toContain('IOS_ALLOW_MULTIPLE_BOOTED=1');
    expect(ios).toContain('IOS_QUIT_SIMULATOR_APP=0');
    expect(ios).toContain('IOS_TRIM_SIMULATOR_PROCESSES=0');
    expect(ios).not.toContain('simctl shutdown all');
    expect(ios).toContain('-only-testing:"Nexus HubUITests/TrainingIsolatedBackendE2EUITests"');
    expect(ios).toContain('-only-testing:"Nexus HubUITests/TrainingFixtureBypassUITests"');
    expect(ios).toContain('-only-testing:"Nexus HubUITests/TrainingValidationUITests"');
  });

  it('exposes npm scripts for the isolated Training E2E lane', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

    expect(pkg.scripts['training:e2e:up']).toBe('scripts/training-e2e-up.sh');
    expect(pkg.scripts['training:e2e:smoke']).toBe('scripts/training-e2e-smoke.sh');
    expect(pkg.scripts['training:e2e:flow']).toBe('scripts/training-e2e-flow.mjs');
    expect(pkg.scripts['training:e2e:ios-seed']).toBe('scripts/training-e2e-ios-seed.mjs prepare');
    expect(pkg.scripts['training:e2e:ios']).toBe('scripts/training-e2e-ios.sh');
    expect(pkg.scripts['training:e2e:live-calendar']).toBe('npx tsx scripts/training-e2e-live-calendar.ts');
    expect(pkg.scripts['training:e2e:down']).toBe('scripts/training-e2e-down.sh');
  });

  it('covers feedback variants, repeated skips, persistence, read models, and reflow', () => {
    const flow = read('scripts/training-e2e-flow.mjs');

    expect(flow).toContain('readCompletionFeedbackRows');
    expect(flow).toContain('flowAttemptId');
    expect(flow).toContain('Generated plan was not persisted in the isolated database');
    expect(flow).toContain('Generated plan sessions were not persisted in the isolated database');
    expect(flow).toContain('noActiveSession !== true');
    expect(flow).toContain('calendarSyncRetry');
    expect(flow).toContain('[200, 409, 503]');
    expect(flow).toContain('feedback_variants_and_repeated_skips');
    expect(flow).toContain('Fixture-safe E2E easy feedback');
    expect(flow).toContain('Fixture-safe E2E normal completion feedback');
    expect(flow).toContain('Fixture-safe E2E hard partial feedback with pain signal');
    expect(flow).toContain("painLocation: 'left knee'");
    expect(flow).toContain('sorenessLevel: 8');
    expect(flow).toContain('skipSessions.length >= 3');
    expect(flow).toContain("item.status === 'partial'");
    expect(flow).toContain('/reflow-preview');
    expect(flow).toContain('readTrainingPlanRowCount');
    expect(flow).toContain('FROM fitness_training_plans WHERE id = ?');
    expect(flow).toContain('cancel_cleanup_and_no_plan_recovery');
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
