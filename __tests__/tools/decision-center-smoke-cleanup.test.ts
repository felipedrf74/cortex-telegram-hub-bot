import { describe, expect, it } from 'vitest';
import {
  DECISION_CENTER_SMOKE_CLEANUP_LARGE_THRESHOLD,
  evaluateDecisionCenterSmokeCleanupPrerequisites,
} from '../../src/tools/decision-center-smoke-cleanup';

describe('Decision Center smoke cleanup helper', () => {
  it('requires smoke env and exactly one execution mode', () => {
    const missingEnv = evaluateDecisionCenterSmokeCleanupPrerequisites({
      env: {},
      dryRun: true,
      confirm: false,
    });
    expect(missingEnv.ok).toBe(false);
    expect(missingEnv.missing).toContain('DECISION_CENTER_NOTIFICATION_SMOKE=1');

    const ambiguousMode = evaluateDecisionCenterSmokeCleanupPrerequisites({
      env: { DECISION_CENTER_NOTIFICATION_SMOKE: '1' },
      dryRun: false,
      confirm: false,
    });
    expect(ambiguousMode.ok).toBe(false);
    expect(ambiguousMode.missing).toContain('exactly one of --dry-run or --confirm');

    const dryRun = evaluateDecisionCenterSmokeCleanupPrerequisites({
      env: { DECISION_CENTER_NOTIFICATION_SMOKE: '1' },
      dryRun: true,
      confirm: false,
    });
    expect(dryRun.ok).toBe(true);
  });

  it('requires an extra acknowledgement for large confirmed cleanup runs', () => {
    const blocked = evaluateDecisionCenterSmokeCleanupPrerequisites({
      env: { DECISION_CENTER_NOTIFICATION_SMOKE: '1' },
      dryRun: false,
      confirm: true,
      previewInspected: DECISION_CENTER_SMOKE_CLEANUP_LARGE_THRESHOLD + 1,
      acknowledgeLargeCleanup: false,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.missing).toContain('--acknowledge-large-cleanup');

    const allowed = evaluateDecisionCenterSmokeCleanupPrerequisites({
      env: { DECISION_CENTER_NOTIFICATION_SMOKE: '1' },
      dryRun: false,
      confirm: true,
      previewInspected: DECISION_CENTER_SMOKE_CLEANUP_LARGE_THRESHOLD + 1,
      acknowledgeLargeCleanup: true,
    });
    expect(allowed.ok).toBe(true);
  });
});
