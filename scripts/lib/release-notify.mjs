import { sanitizeDetail } from './release-state-store.mjs';
import { fail } from './release-canonical.mjs';
import { releaseBackupAlertContract } from './release-backup-alert-state.mjs';
import {
  RELEASE_DISCOVERY_ALERT_SOURCE,
  classifyReleaseDiscoveryFailure,
  drainDueReleaseDiscoveryAlerts,
  releaseDiscoveryAlertContract,
} from './release-discovery-alert-state.mjs';

/**
 * Release notifications.
 *
 * Successes are silent; failures page the owner. A weekly heartbeat proves the
 * notifier itself still works, because a silent-on-success channel that has
 * quietly broken is indistinguishable from a quarter with no failures.
 *
 * Every field that reaches Telegram is built here from structured values.
 * Free text passes through `sanitizeDetail`; the release id and source SHA use
 * their exact receipt-schema validators so generic text redaction never has to
 * treat opaque hex as safe. Nothing is interpolated from command output, a
 * provider response, or a database row.
 */

export const RELEASE_NOTIFICATION_KINDS = Object.freeze({
  FAILURE: 'failure',
  RECOVERY: 'recovery',
  HEARTBEAT: 'heartbeat',
});

export const RELEASE_FAILSAFE_NOTIFICATION_POLICY = Object.freeze({
  notifications: Object.freeze({
    failureEnabled: true,
    recoveryEnabled: true,
    heartbeatEnabled: true,
    maxMessageChars: 900,
  }),
});

const MAX_MESSAGE_CHARS_FLOOR = 200;
const RELEASE_ID = /^[0-9a-f]{32}$/;
const FULL_SOURCE_SHA = /^[0-9a-f]{40}$/;
const RELEASE_DEPLOYMENT_ABORT_DIAGNOSTICS = Object.freeze({
  STAGING_APNS_MATERIAL_UNAVAILABLE: 'staging_apns_material_unavailable',
  PRODUCTION_APNS_MATERIAL_UNAVAILABLE: 'production_apns_material_unavailable',
  CONTROLLER_EXCEPTION: 'release_controller_exception',
});

function classifyReleaseDeploymentAbortDiagnostic(error) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'staging APNs auth key file is absent or unsafe') {
    return RELEASE_DEPLOYMENT_ABORT_DIAGNOSTICS.STAGING_APNS_MATERIAL_UNAVAILABLE;
  }
  if (message === 'production APNs auth key file is absent or unsafe') {
    return RELEASE_DEPLOYMENT_ABORT_DIAGNOSTICS.PRODUCTION_APNS_MATERIAL_UNAVAILABLE;
  }
  return RELEASE_DEPLOYMENT_ABORT_DIAGNOSTICS.CONTROLLER_EXCEPTION;
}

function releaseIdForNotification(value, fallback) {
  return typeof value === 'string' && RELEASE_ID.test(value) ? value : fallback;
}

function sourceShaForNotification(value) {
  return typeof value === 'string' && FULL_SOURCE_SHA.test(value) ? value : 'unknown';
}

function roundedNonNegative(value) {
  return Math.max(0, Math.round(value));
}

function shortDigest(digest) {
  if (typeof digest !== 'string') return 'unknown';
  const hex = digest.replace(/^sha256:/, '');
  return hex.slice(0, 12);
}

function operationalAlertContract(source, failureCode) {
  return source === RELEASE_DISCOVERY_ALERT_SOURCE
    ? releaseDiscoveryAlertContract(failureCode)
    : releaseBackupAlertContract(source, failureCode);
}

/**
 * Build the exact message text. Kept pure and exported so the redaction rules
 * can be asserted directly, without a network stub.
 */
export function buildReleaseNotification({ kind, policy, release }) {
  const maxChars = Math.max(
    MAX_MESSAGE_CHARS_FLOOR,
    Number(policy?.notifications?.maxMessageChars ?? 900),
  );
  const lines = [];
  if (kind === RELEASE_NOTIFICATION_KINDS.FAILURE) {
    lines.push('Nexus Hub release FAILED');
    lines.push(`release: ${releaseIdForNotification(release.releaseId, 'unknown')}`);
    lines.push(`commit: ${sourceShaForNotification(release.sourceSha)}`);
    lines.push(`phase: ${sanitizeDetail(release.phase) ?? 'unknown'}`);
    lines.push(`outcome: ${sanitizeDetail(release.outcome) ?? 'unknown'}`);
    if (release.failureCode) lines.push(`reason: ${sanitizeDetail(release.failureCode)}`);
    lines.push(`rollback: ${sanitizeDetail(release.rollbackResult) ?? 'not_attempted'}`);
    if (release.actionRequired) {
      lines.push(`action: ${sanitizeDetail(release.actionRequired)}`);
    }
    if (release.alertSource) {
      const contract = operationalAlertContract(release.alertSource, release.failureCode);
      if (release.phase !== contract.phase || release.outcome !== contract.outcome
          || release.actionRequired !== contract.actionRequired
          || release.alertSeverity !== contract.severity
          || release.alertRunbookUrl !== contract.runbookUrl
          || release.alertDedupeKey !== contract.dedupeKey) {
        fail('release operational alert notification contract mismatch');
      }
      lines.push(`source: ${contract.source}`);
      lines.push(`severity: ${contract.severity}`);
      lines.push(`dedupe: ${contract.dedupeKey}`);
      lines.push(`runbook: ${contract.runbookUrl}`);
    }
    if (Number.isFinite(release.incidentRecoverySeconds)) {
      lines.push(`incident recovery seconds: ${roundedNonNegative(release.incidentRecoverySeconds)}`);
    }
    if (Number.isFinite(release.predecessorSwitchSeconds)) {
      lines.push(`predecessor switch seconds: ${roundedNonNegative(release.predecessorSwitchSeconds)}`);
    }
    if (Number.isFinite(release.predecessorSwitchObjectiveSeconds)) {
      lines.push(
        `predecessor switch objective seconds: ${roundedNonNegative(release.predecessorSwitchObjectiveSeconds)}`,
      );
    }
  } else if (kind === RELEASE_NOTIFICATION_KINDS.RECOVERY) {
    lines.push('Nexus Hub release RECOVERED');
    lines.push(`release: ${releaseIdForNotification(release.releaseId, 'unknown')}`);
    lines.push(`commit: ${sourceShaForNotification(release.sourceSha)}`);
    lines.push(`restored backend: ${shortDigest(release.restored?.backend?.digest)}`);
    lines.push(`restored content-engine: ${shortDigest(release.restored?.contentEngine?.digest)}`);
    const incidentSeconds = Number.isFinite(release.incidentRecoverySeconds)
      ? roundedNonNegative(release.incidentRecoverySeconds)
      : 'unknown';
    const switchSeconds = Number.isFinite(release.predecessorSwitchSeconds)
      ? roundedNonNegative(release.predecessorSwitchSeconds)
      : 'unknown';
    const objectiveSeconds = Number.isFinite(release.predecessorSwitchObjectiveSeconds)
      ? roundedNonNegative(release.predecessorSwitchObjectiveSeconds)
      : 'unknown';
    lines.push(`incident recovery seconds: ${incidentSeconds}`);
    lines.push(`predecessor switch seconds: ${switchSeconds}`);
    lines.push(`predecessor switch objective seconds: ${objectiveSeconds}`);
  } else if (kind === RELEASE_NOTIFICATION_KINDS.HEARTBEAT) {
    lines.push('Nexus Hub release pipeline heartbeat');
    lines.push(`active release: ${releaseIdForNotification(release.releaseId, 'none')}`);
    lines.push(`status: ${sanitizeDetail(release.status) ?? 'idle'}`);
    lines.push(`blocked: ${release.blocked ? (sanitizeDetail(release.blocked) ?? 'yes') : 'no'}`);
    lines.push(`completed releases recorded: ${Number(release.completedCount ?? 0)}`);
    if (Number.isFinite(release.backupAgeSeconds)) {
      lines.push(`encrypted backup age seconds: ${roundedNonNegative(release.backupAgeSeconds)}`);
    }
    if (Number.isFinite(release.restoreVerificationAgeSeconds)) {
      lines.push(
        `restore verification age seconds: ${roundedNonNegative(
          release.restoreVerificationAgeSeconds,
        )}`,
      );
    }
  } else {
    fail(`unknown release notification kind ${kind}`);
  }
  return lines.join('\n').slice(0, maxChars);
}

/**
 * Surface failures that happen before a release identity or receipt exists.
 * Registry discovery, payload extraction, signature verification, and Compose
 * verification all fail before runReleaseDeployment can use its normal terminal
 * receipt path. They still need to page the owner, and a notifier failure must
 * never replace the original poll failure.
 */
export async function reportReleaseDeploymentAbort({
  notifier,
  alertStore,
  error,
  log = () => {},
}) {
  const failureCode = classifyReleaseDiscoveryFailure(error);
  const diagnostic = classifyReleaseDeploymentAbortDiagnostic(error);
  // The outer catch spans both pre-identity discovery and post-admission
  // controller failures. Log only a closed diagnostic code: raw exception text
  // can contain registry URLs, provider bodies, credential paths, or secrets.
  log(`release deployment aborted: ${failureCode}; diagnostic=${diagnostic}`);
  try {
    const opened = alertStore?.openFailure({ failureCode });
    if (!opened) throw new Error('release discovery alert store is unavailable');
    if (opened.deduped) {
      log(`release discovery alert deduped: ${opened.event.dedupeKey}`);
    }
    await drainDueReleaseDiscoveryAlerts({ store: alertStore, notifier });
  } catch {
    // The deployment failure remains the process verdict. Never bypass the
    // durable source with a direct best-effort page when its state is unsafe.
    log('release discovery alert persistence or delivery failed');
  }
  return { failureCode };
}

export async function drainReleaseDeploymentAbort({
  alertStore,
  notifier,
  log = () => {},
}) {
  if (!alertStore) return [];
  try {
    return await drainDueReleaseDiscoveryAlerts({ store: alertStore, notifier });
  } catch {
    log('release discovery alert retry persistence or delivery failed');
    return [];
  }
}

export async function resolveReleaseDeploymentAbort({
  alertStore,
  notifier,
  log = () => {},
}) {
  if (!alertStore) return null;
  try {
    // Persisted failures remain deliverable even when the next poll is healthy.
    // Drain first, then rearm the edge; an undelivered open event remains due.
    await drainDueReleaseDiscoveryAlerts({ store: alertStore, notifier });
    return alertStore.resolve();
  } catch {
    log('release discovery alert recovery persistence or delivery failed');
    return null;
  }
}

export function createReleaseNotifier({
  policy,
  fetchImpl = globalThis.fetch,
  env = process.env,
  requestTimeoutMs = 10_000,
  log = () => {},
}) {
  function credentials() {
    const token = env.NEXUS_RELEASE_TELEGRAM_BOT_TOKEN || '';
    const chatId = env.NEXUS_RELEASE_TELEGRAM_CHAT_ID || '';
    if (!token || !chatId) return null;
    return { token, chatId };
  }

  /**
   * Notification delivery is never a release gate. A release that succeeded but
   * could not be announced is still a successful release, and a release that
   * failed must not be reported as something else because Telegram was down.
   */
  async function send({ kind, release }) {
    if (kind === RELEASE_NOTIFICATION_KINDS.FAILURE && !policy.notifications.failureEnabled) {
      return { delivered: false, reason: 'disabled' };
    }
    if (kind === RELEASE_NOTIFICATION_KINDS.RECOVERY && !policy.notifications.recoveryEnabled) {
      return { delivered: false, reason: 'disabled' };
    }
    if (kind === RELEASE_NOTIFICATION_KINDS.HEARTBEAT && !policy.notifications.heartbeatEnabled) {
      return { delivered: false, reason: 'disabled' };
    }
    const text = buildReleaseNotification({ kind, policy, release });
    const secret = credentials();
    if (!secret) {
      log('release notification skipped: telegram credentials are not provisioned');
      return { delivered: false, reason: 'not_configured', text };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${secret.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: secret.chatId,
            text,
            disable_notification: kind === RELEASE_NOTIFICATION_KINDS.HEARTBEAT,
          }),
          signal: controller.signal,
        },
      );
      // The provider response body is never read into state, a receipt, or a
      // log line: only the status class is retained.
      return { delivered: response.ok, reason: response.ok ? 'sent' : 'provider_rejected', text };
    } catch {
      return { delivered: false, reason: 'transport_failed', text };
    } finally {
      clearTimeout(timer);
    }
  }

  return { send };
}
