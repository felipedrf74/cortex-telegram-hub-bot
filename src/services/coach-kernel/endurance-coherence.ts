// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../../config';
import type {
  DayOfWeek,
  GuardrailResult,
  Session,
  TrainingDecisionReason,
} from './types';
import { deriveSessionLoadMetadata } from './session-load-metadata';

export interface EnduranceCoherenceValidation {
  guardrailResults: GuardrailResult[];
  decisionReasons: TrainingDecisionReason[];
}

const DAY_INDEX: Record<DayOfWeek, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

function isEndurance(session: Session): boolean {
  return session.sport === 'running' || session.sport === 'cycling' || session.sport === 'swimming';
}

function isHardEndurance(session: Session): boolean {
  return isEndurance(session) && (
    session.intensityZone === 'threshold'
    || session.intensityZone === 'vo2'
    || session.sessionRole === 'threshold'
    || session.sessionRole === 'vo2'
  );
}

function isLongEndurance(session: Session): boolean {
  return isEndurance(session) && (session.sessionRole === 'long' || session.tags.includes('long_session'));
}

function reasonFor(session: Session, text: string, code: TrainingDecisionReason['code']): TrainingDecisionReason {
  return {
    code,
    text,
    severity: 'warning',
    affectedEntity: {
      type: 'session',
      id: session.id,
      title: session.title,
      dayOfWeek: session.dayOfWeek,
    },
    sourceConstraint: { type: 'interference', label: 'endurance coherence' },
    evidence: ['TRAINING_ENDURANCE_COHERENCE_V2_ENABLED'],
  };
}

function guardrail(
  ruleId: string,
  session: Session,
  message: string,
  decisionReason: TrainingDecisionReason,
): GuardrailResult {
  return {
    ruleId,
    status: 'warn',
    adjusted: false,
    message,
    metadata: {
      sessionId: session.id,
      sessionType: session.sessionType,
      dayOfWeek: session.dayOfWeek,
      sessionRole: session.sessionRole,
    },
    decisionReasons: [decisionReason],
  };
}

function segmentDurationSec(session: Session): number {
  return (session.intensityProfile?.segments ?? []).reduce((sum, segment) => {
    const reps = segment.reps ?? 1;
    return sum + (segment.durationSec ?? 0) * reps;
  }, 0);
}

function validateIntervalMath(session: Session): { ruleId: string; message: string } | null {
  const segments = session.intensityProfile?.segments ?? [];
  if (segments.length === 0) return null;
  const plannedSec = session.durationMinutes * 60;
  if (plannedSec <= 0) return null;
  const actualSec = segmentDurationSec(session);
  const drift = Math.abs(actualSec - plannedSec) / plannedSec;
  if (drift <= 0.08) return null;
  return {
    ruleId: `endurance_interval_duration_mismatch_${session.id}`,
    message: `${session.title} interval segments do not sum to the planned duration.`,
  };
}

function validateHardWarmupCooldown(session: Session): { ruleId: string; message: string } | null {
  if (!isHardEndurance(session)) return null;
  const segments = session.intensityProfile?.segments ?? [];
  const hasWarmup = segments.some((segment) => segment.role === 'warmup' && (segment.durationSec ?? 0) >= 5 * 60);
  const hasCooldown = segments.some((segment) => segment.role === 'cooldown' && (segment.durationSec ?? 0) >= 5 * 60);
  if (hasWarmup && hasCooldown) return null;
  return {
    ruleId: `endurance_warmup_cooldown_missing_${session.id}`,
    message: `${session.title} needs a warmup and cooldown because it is a hard endurance session.`,
  };
}

function validateLongCap(session: Session): { ruleId: string; message: string } | null {
  if (!isLongEndurance(session)) return null;
  if (session.sport === 'running' && session.durationMinutes > 180) {
    return {
      ruleId: `endurance_long_run_cap_${session.id}`,
      message: `${session.title} exceeds the long-run duration cap.`,
    };
  }
  if (session.sport === 'cycling' && session.durationMinutes > 300) {
    return {
      ruleId: `endurance_long_ride_cap_${session.id}`,
      message: `${session.title} exceeds the long-ride duration cap.`,
    };
  }
  return null;
}

function validateHardDaySpacing(sessions: readonly Session[]): Array<{ session: Session; ruleId: string; message: string; code: TrainingDecisionReason['code'] }> {
  const hard = sessions
    .filter(isHardEndurance)
    .sort((left, right) => DAY_INDEX[left.dayOfWeek] - DAY_INDEX[right.dayOfWeek]);
  const findings: Array<{ session: Session; ruleId: string; message: string; code: TrainingDecisionReason['code'] }> = [];
  for (let index = 1; index < hard.length; index++) {
    const gap = DAY_INDEX[hard[index].dayOfWeek] - DAY_INDEX[hard[index - 1].dayOfWeek];
    if (gap >= 2) continue;
    findings.push({
      session: hard[index],
      ruleId: `endurance_hard_day_spacing_${hard[index].id}`,
      message: `${hard[index].title} is stacked too close to another hard endurance session.`,
      code: 'endurance_coherence_warning',
    });
  }
  return findings;
}

function validateStrengthEnduranceInterference(sessions: readonly Session[]): Array<{ session: Session; ruleId: string; message: string; code: TrainingDecisionReason['code'] }> {
  const findings: Array<{ session: Session; ruleId: string; message: string; code: TrainingDecisionReason['code'] }> = [];
  const lowerStrengthDays = sessions
    .filter((session) => session.sport === 'strength' && deriveSessionLoadMetadata(session).legLoadScore >= 6)
    .map((session) => DAY_INDEX[session.dayOfWeek]);
  for (const session of sessions.filter((item) => isHardEndurance(item) || isLongEndurance(item))) {
    const day = DAY_INDEX[session.dayOfWeek];
    if (lowerStrengthDays.some((strengthDay) => day - strengthDay >= 0 && day - strengthDay <= 1)) {
      findings.push({
        session,
        ruleId: `endurance_strength_interference_${session.id}`,
        message: `${session.title} is close to heavy lower-body strength; keep intensity conservative or reflow before launch.`,
        code: 'endurance_interference_warning',
      });
    }
  }
  return findings;
}

function validateBrickPlacement(sessions: readonly Session[]): Array<{ session: Session; ruleId: string; message: string; code: TrainingDecisionReason['code'] }> {
  const findings: Array<{ session: Session; ruleId: string; message: string; code: TrainingDecisionReason['code'] }> = [];
  for (const brick of sessions.filter((session) => session.sessionRole === 'brick' || session.sessionType === 'brick')) {
    const sameDayRide = sessions.some((session) =>
      session.sport === 'cycling' && session.dayOfWeek === brick.dayOfWeek && (session.keySession || session.tags.includes('long_session'))
    );
    if (!sameDayRide) {
      findings.push({
        session: brick,
        ruleId: `endurance_brick_placement_${brick.id}`,
        message: `${brick.title} is labeled as a brick but is not placed with a key bike session.`,
        code: 'endurance_coherence_warning',
      });
    }
  }
  return findings;
}

export function validateEnduranceCoherence(sessions: readonly Session[]): EnduranceCoherenceValidation {
  if (!config.coaching.trainingEnduranceCoherenceV2Enabled) {
    return { guardrailResults: [], decisionReasons: [] };
  }

  const findings: Array<{ session: Session; ruleId: string; message: string; code: TrainingDecisionReason['code'] }> = [];
  for (const session of sessions.filter(isEndurance)) {
    const intervalMath = validateIntervalMath(session);
    if (intervalMath) findings.push({ session, ...intervalMath, code: 'endurance_coherence_warning' });
    const warmupCooldown = validateHardWarmupCooldown(session);
    if (warmupCooldown) findings.push({ session, ...warmupCooldown, code: 'endurance_coherence_warning' });
    const longCap = validateLongCap(session);
    if (longCap) findings.push({ session, ...longCap, code: 'endurance_coherence_warning' });
  }
  findings.push(...validateHardDaySpacing(sessions));
  findings.push(...validateStrengthEnduranceInterference(sessions));
  findings.push(...validateBrickPlacement(sessions));

  const decisionReasons = findings.map((finding) => reasonFor(finding.session, finding.message, finding.code));
  const guardrailResults = findings.map((finding, index) =>
    guardrail(finding.ruleId, finding.session, finding.message, decisionReasons[index])
  );
  return { guardrailResults, decisionReasons };
}
