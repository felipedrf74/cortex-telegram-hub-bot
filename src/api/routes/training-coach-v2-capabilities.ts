// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../../config';
import { TRAINING_COACH_V2_CONTRACT_VERSION } from '../../services/training-coach-v2-proposals';

export interface CoachV2Capabilities {
  contractVersion: typeof TRAINING_COACH_V2_CONTRACT_VERSION;
  mode: 'active' | 'off';
  lifecycleSupport: {
    compatibility: true;
    revision: true;
  };
  operations: {
    travel: { availability: 'active' | 'off'; methods: readonly ['GET', 'POST', 'PATCH', 'DELETE'] };
    weekReflow: { availability: 'active' | 'off'; proposalFirst: true; preview: true };
    coachPolicy: { availability: 'active' | 'off'; proposalFirst: true; cas: true };
    coachAnalysis: { availability: 'active' | 'off'; selectedWeek: true };
    healthManagement: { availability: 'active'; entitlementRequired: false; corrections: true; export: true };
  };
}

/**
 * Additive Home capability advertisement. Clients must still fail closed on
 * omission, an unknown contractVersion/mode, or an unknown operation value.
 */
export function buildCoachV2Capabilities(): CoachV2Capabilities {
  const availability = config.coaching.periodizationV2Enabled ? 'active' : 'off';
  return {
    contractVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
    mode: availability,
    lifecycleSupport: { compatibility: true, revision: true },
    operations: {
      travel: { availability, methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
      weekReflow: { availability, proposalFirst: true, preview: true },
      coachPolicy: { availability, proposalFirst: true, cas: true },
      coachAnalysis: { availability, selectedWeek: true },
      healthManagement: {
        availability: 'active',
        entitlementRequired: false,
        corrections: true,
        export: true,
      },
    },
  };
}
