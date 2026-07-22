/**
 * M15 adversarial fix — hard runtime guard for AI_CLASSIFY_MANIFEST_PROMPT.
 *
 * The former flag-flip blockers (missing draft_email/send_email/
 * connections_retry_sync step executors; missing legacy domain handlers for
 * connections/notifications/decision_center) are now closed. The guard must:
 *   - force-disable the flag for the process when it is requested ON while
 *     either gap class is open (flag reads false afterwards),
 *   - record a warning operator alert with a stable dedupe key,
 *   - stay silent when the gaps are closed (simulated via a mock dispatch
 *     table / domain-handler map),
 *   - cost nothing when the flag is off (no dependency lookups at all).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRecordOperatorAlert = vi.hoisted(() => vi.fn(() => ({ alert: null, created: true })));
vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: mockRecordOperatorAlert,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  enforceManifestClassifierRuntimeGuard,
  MANIFEST_CLASSIFIER_GUARD_ALERT_DEDUPE_KEY,
  MANIFEST_PROMPT_REQUIRED_STEP_EXECUTOR_ACTIONS,
} from '../../src/router/classifier-manifest-runtime-guard';
import {
  _resetManifestClassifierPromptRuntimeOverrideForTests,
  isManifestClassifierPromptEnabled,
  isManifestClassifierPromptRuntimeForceDisabled,
} from '../../src/router/classifier-prompt-builder';

const FLAG_ON_ENV = { AI_CLASSIFY_MANIFEST_PROMPT: 'true' };

const NL_REACHABLE_DOMAINS = [
  'secretary', 'triathlon', 'content', 'finance', 'cooking',
  'connections', 'notifications', 'decision_center',
];

/** Mock dispatch table with the gaps CLOSED (every action executable). */
const fullDispatchTable = (action: string) => () => ({ ok: true, action });
/** Mock legacy domain-handler map with the gaps CLOSED (every domain handled). */
const fullDomainHandlers = (domain: string) => () => ({ ok: true, domain });

describe('enforceManifestClassifierRuntimeGuard', () => {
  beforeEach(() => {
    _resetManifestClassifierPromptRuntimeOverrideForTests();
    mockRecordOperatorAlert.mockClear();
  });

  afterEach(() => {
    _resetManifestClassifierPromptRuntimeOverrideForTests();
  });

  it('zero cost with the flag off: returns without consulting any dependency', () => {
    const getStepExecutor = vi.fn();
    const getDomainHandler = vi.fn();
    const listNlReachableDomains = vi.fn();

    const result = enforceManifestClassifierRuntimeGuard({
      env: {},
      getStepExecutor,
      getDomainHandler,
      listNlReachableDomains,
    });

    expect(result).toEqual({ flagRequested: false, forcedOff: false, gaps: [] });
    expect(getStepExecutor).not.toHaveBeenCalled();
    expect(getDomainHandler).not.toHaveBeenCalled();
    expect(listNlReachableDomains).not.toHaveBeenCalled();
    expect(mockRecordOperatorAlert).not.toHaveBeenCalled();
    expect(isManifestClassifierPromptRuntimeForceDisabled()).toBe(false);
  });

  it('fires on missing step executors: force-disables the flag and records a warning alert', () => {
    const result = enforceManifestClassifierRuntimeGuard({
      env: FLAG_ON_ENV,
      // The REAL current gap: the three actions have no executor.
      getStepExecutor: (action) => (
        (MANIFEST_PROMPT_REQUIRED_STEP_EXECUTOR_ACTIONS as readonly string[]).includes(action)
          ? undefined
          : fullDispatchTable(action)
      ),
      getDomainHandler: fullDomainHandlers,
      listNlReachableDomains: () => NL_REACHABLE_DOMAINS,
    });

    expect(result.flagRequested).toBe(true);
    expect(result.forcedOff).toBe(true);
    expect(result.gaps).toEqual([
      'missing_step_executor:draft_email',
      'missing_step_executor:send_email',
      'missing_step_executor:connections_retry_sync',
    ]);
    // The flag now reads FALSE for this process, even with the env still on.
    expect(isManifestClassifierPromptEnabled(FLAG_ON_ENV)).toBe(false);
    expect(isManifestClassifierPromptRuntimeForceDisabled()).toBe(true);
    expect(mockRecordOperatorAlert).toHaveBeenCalledTimes(1);
    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warning',
      dedupeKey: MANIFEST_CLASSIFIER_GUARD_ALERT_DEDUPE_KEY,
      source: 'classifier_manifest_runtime_guard',
    }));
  });

  it('fires on a missing legacy domain handler for an NL-reachable manifest domain', () => {
    const result = enforceManifestClassifierRuntimeGuard({
      env: FLAG_ON_ENV,
      getStepExecutor: fullDispatchTable,
      // The REAL current gap: legacy handlers cover only the 5 legacy domains.
      getDomainHandler: (domain) => (
        ['secretary', 'triathlon', 'content', 'finance', 'cooking'].includes(domain)
          ? fullDomainHandlers(domain)
          : undefined
      ),
      listNlReachableDomains: () => NL_REACHABLE_DOMAINS,
    });

    expect(result.forcedOff).toBe(true);
    expect(result.gaps).toEqual([
      'missing_domain_handler:connections',
      'missing_domain_handler:notifications',
      'missing_domain_handler:decision_center',
    ]);
    expect(isManifestClassifierPromptEnabled(FLAG_ON_ENV)).toBe(false);
    expect(mockRecordOperatorAlert).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the gaps are closed (mock dispatch table + handler map)', () => {
    const result = enforceManifestClassifierRuntimeGuard({
      env: FLAG_ON_ENV,
      getStepExecutor: fullDispatchTable,
      getDomainHandler: fullDomainHandlers,
      listNlReachableDomains: () => NL_REACHABLE_DOMAINS,
    });

    expect(result).toEqual({ flagRequested: true, forcedOff: false, gaps: [] });
    expect(isManifestClassifierPromptEnabled(FLAG_ON_ENV)).toBe(true);
    expect(mockRecordOperatorAlert).not.toHaveBeenCalled();
    expect(isManifestClassifierPromptRuntimeForceDisabled()).toBe(false);
  });

  it('against the REAL dispatch table and handler map, all executable-surface gaps are closed', () => {
    // No injected deps: the guard consults the real dispatch table, the real
    // legacy domain-handler map, and the real manifest. The flag is eligible
    // for its separately owner-gated rollout only while this remains gap-free.
    const result = enforceManifestClassifierRuntimeGuard({ env: FLAG_ON_ENV });

    expect(result).toEqual({ flagRequested: true, forcedOff: false, gaps: [] });
    expect(isManifestClassifierPromptEnabled(FLAG_ON_ENV)).toBe(true);
    expect(isManifestClassifierPromptRuntimeForceDisabled()).toBe(false);
    expect(mockRecordOperatorAlert).not.toHaveBeenCalled();
  });
});
