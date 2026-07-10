// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';
import { setMfaNotifier } from './garmin';
import { createNotificationIntent } from './notification-orchestrator';
import { recordOperatorAlert } from './operator-alerts';
import { getOwnerBootstrapTarget } from './user-service';

function listOwnerTenantIds(): number[] {
  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget ? [ownerTarget.tenantId] : [];
}

export async function notifyGarminMfaRequired(_legacyMessage?: string): Promise<void> {
  const ownerTenantIds = listOwnerTenantIds();

  const alert = recordOperatorAlert({
    severity: 'warning',
    source: 'garmin_mfa',
    dedupeKey: 'garmin:mfa:required',
    title: 'Garmin needs verification',
    detail: 'Garmin requested an MFA code. Open Nexus on iOS and finish the Garmin reconnect flow.',
    metadata: {
      ownerTenantCount: ownerTenantIds.length,
      delivery: 'operator_alert_and_apns',
    },
    owner: 'ops',
    suspectedArea: 'garmin_auth',
    userImpact: 'Training readiness and coach reports may use stale Garmin data until verification completes.',
    runbookUrl: 'docs/OBSERVABILITY-ONCALL.md',
  });

  if (!alert.ok) {
    logger.warn({ reason: alert.reason }, 'Failed to record Garmin MFA operator alert');
  }

  if (ownerTenantIds.length === 0) {
    logger.warn('Garmin MFA required but no owner tenant is available for APNs notification');
    return;
  }

  const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  for (const userId of ownerTenantIds) {
    try {
      await createNotificationIntent({
        userId,
        tenantId: userId,
        sourceSkill: 'security',
        type: 'security_account',
        priority: 'time_sensitive',
        relatedEntityId: 'garmin-mfa',
        relatedEntityType: 'garmin_connection',
        title: 'Garmin needs verification',
        body: 'Open Nexus and finish Garmin verification to keep Training data current.',
        sensitiveBody: 'Garmin requested an MFA code. Open Nexus on iOS and enter the code from your email.',
        actionButtons: [
          {
            id: 'open_detail',
            label: 'Open Garmin',
            style: 'primary',
            deeplink: 'nexus://connections/garmin/reauth',
          },
        ],
        deeplink: 'nexus://connections/garmin/reauth',
        expiresAt: deadline,
        decisionDeadline: deadline,
        dedupeKey: `security:garmin:mfa:${userId}`,
        requiresUserAction: true,
        quietHoursPolicy: 'allow_time_sensitive',
        deliveryPolicy: 'auto',
        privacyPolicy: 'sensitive',
        visibilityScope: 'user_private',
        decisionContext: {
          entityTitle: 'Garmin Connect',
          providerName: 'Garmin',
          sourceState: 'mfa_pending',
          reasonCodes: ['garmin_mfa_required'],
          visibilityScope: 'user_private',
        },
      });
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to create Garmin MFA APNs notification intent');
    }
  }
}

export function registerGarminMfaNotifier(): void {
  setMfaNotifier(notifyGarminMfaRequired);
}
