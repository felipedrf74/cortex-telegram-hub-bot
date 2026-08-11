#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  createReleaseNotifier,
  RELEASE_FAILSAFE_NOTIFICATION_POLICY,
} from './lib/release-notify.mjs';
import {
  createReleaseBackupAlertStore,
  deliverDueReleaseBackupAlert,
} from './lib/release-backup-alert-state.mjs';

export const RELEASE_OPERATIONAL_ALERT_SCHEMA = 'nexus.release-operational-alert.v1';

const OPERATIONS = Object.freeze({
  'nexus-local-backup.service': Object.freeze({
    failureCode: 'local_backup_failed',
  }),
  'nexus-local-backup-restore-verify.service': Object.freeze({
    failureCode: 'restore_verification_failed',
  }),
});

export function parseOperationalAlertArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 1
      || typeof argv[0] !== 'string' || !argv[0].startsWith('--unit=')) {
    return null;
  }
  const unit = argv[0].slice('--unit='.length);
  return Object.hasOwn(OPERATIONS, unit) ? unit : null;
}

/**
 * Convert systemd's ExecStopPost result into one closed, sanitized notification.
 * The raw unit journal, exit text, provider response body, and inherited service
 * environment are deliberately not inputs.
 */
export async function runOperationalAlert({
  unit,
  env = process.env,
  policy,
  notifier,
  alertStore,
} = {}) {
  const operation = OPERATIONS[unit];
  if (!operation) {
    return {
      schema: RELEASE_OPERATIONAL_ALERT_SCHEMA,
      accepted: false,
      alerted: false,
      delivered: false,
      reason: 'invalid_unit',
      exitCode: 64,
    };
  }

  if (env.SERVICE_RESULT === 'exit-code'
      && env.EXIT_CODE === 'exited'
      && env.EXIT_STATUS === '75') {
    return {
      schema: RELEASE_OPERATIONAL_ALERT_SCHEMA,
      accepted: true,
      alerted: false,
      delivered: false,
      reason: 'lock_retry_pending',
      unit,
      exitCode: 0,
    };
  }

  if (env.SERVICE_RESULT === 'success') {
    try {
      alertStore?.resolveSource(unit);
    } catch {
      return {
        schema: RELEASE_OPERATIONAL_ALERT_SCHEMA,
        accepted: true,
        alerted: false,
        delivered: false,
        reason: 'alert_state_failed',
        unit,
        exitCode: 1,
      };
    }
    return {
      schema: RELEASE_OPERATIONAL_ALERT_SCHEMA,
      accepted: true,
      alerted: false,
      delivered: false,
      reason: 'service_succeeded',
      unit,
      exitCode: 0,
    };
  }

  if (!alertStore) {
    return {
      schema: RELEASE_OPERATIONAL_ALERT_SCHEMA,
      accepted: true,
      alerted: false,
      delivered: false,
      reason: 'alert_state_missing',
      unit,
      exitCode: 1,
    };
  }

  let delivery = { delivered: false, reason: 'notification_failed' };
  try {
    const opened = alertStore.openFailure({
      source: unit,
      failureCode: operation.failureCode,
    });
    if (opened.deduped) {
      delivery = { delivered: true, reason: 'deduped' };
    } else if (opened.due) {
      const deliveryNotifier = notifier ?? createReleaseNotifier({ policy, env });
      delivery = await deliverDueReleaseBackupAlert({
        store: alertStore,
        event: opened.event,
        notifier: deliveryNotifier,
      });
    } else {
      delivery = {
        delivered: false,
        reason: opened.event.lifecycle === 'dead_letter' ? 'dead_letter' : 'retry_pending',
      };
    }
  } catch {
    // The originating service failure remains systemd's primary verdict. This
    // helper reports only its own bounded delivery status and never raw errors.
  }

  return {
    schema: RELEASE_OPERATIONAL_ALERT_SCHEMA,
    accepted: true,
    alerted: true,
    delivered: delivery.delivered,
    reason: delivery.reason,
    unit,
    exitCode: delivery.delivered ? 0 : 1,
  };
}

export async function runOperationalAlertCli({
  argv = process.argv.slice(2),
  env = process.env,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  loadPolicy = loadContinuousDeploymentPolicy,
  createAlertStore = createReleaseBackupAlertStore,
  notifier,
} = {}) {
  const unit = parseOperationalAlertArgv(argv);
  const successful = env.SERVICE_RESULT === 'success';
  const alertStore = createAlertStore();
  let policy;
  if (unit && !successful) {
    try {
      policy = loadPolicy(root);
    } catch {
      policy = RELEASE_FAILSAFE_NOTIFICATION_POLICY;
    }
  }
  return runOperationalAlert({ unit, env, policy, notifier, alertStore });
}

async function main() {
  const result = await runOperationalAlertCli();
  const { exitCode, ...output } = result;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    process.stdout.write(`${JSON.stringify({
      schema: RELEASE_OPERATIONAL_ALERT_SCHEMA,
      accepted: false,
      alerted: false,
      delivered: false,
      reason: 'alert_helper_failed',
    })}\n`);
    process.exitCode = 1;
  }
}
