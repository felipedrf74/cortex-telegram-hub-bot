// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Session, TrainingSessionRole, WorkoutTemplate } from './types';

export interface TrainingSessionRoleClassification {
  role: TrainingSessionRole;
  label: string;
  summary: string;
  keySessionLabel?: string;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function roleFromTemplate(template: WorkoutTemplate): TrainingSessionRole | null {
  const raw = String(template.sessionRole ?? '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('brick')) return 'brick';
  if (raw.includes('long')) return 'long';
  if (raw.includes('vo2') || raw.includes('interval')) return 'vo2';
  if (raw.includes('threshold') || raw.includes('tempo')) return 'threshold';
  if (raw.includes('recovery') || raw.includes('flush')) return 'recovery';
  if (raw.includes('technique') || raw.includes('skill')) return 'technique';
  if (raw.includes('taper')) return 'taper';
  if (raw.includes('race')) return 'race_specific';
  if (raw.includes('easy') || raw.includes('aerobic')) return 'easy';
  return null;
}

function roleFromSession(session: Pick<Session, 'sessionType' | 'intensityZone' | 'tags' | 'sport'>): TrainingSessionRole {
  const tags = new Set((session.tags ?? []).map((tag) => tag.toLowerCase()));
  if (session.sessionType === 'brick' || tags.has('brick')) return 'brick';
  if (tags.has('long_session') || session.sessionType === 'long_run' || session.sessionType === 'endurance_ride') return 'long';
  if (session.sessionType === 'interval_run' || session.sessionType === 'vo2_ride' || session.intensityZone === 'vo2') return 'vo2';
  if (session.sessionType === 'threshold_run' || session.sessionType === 'threshold_ride' || session.sessionType === 'threshold_swim' || session.intensityZone === 'threshold') return 'threshold';
  if (session.sessionType === 'recovery_run' || session.sessionType === 'recovery_ride' || session.sessionType === 'recovery_swim' || session.intensityZone === 'recovery') return 'recovery';
  if (session.sessionType === 'technique_swim') return 'technique';
  if (session.sport === 'strength' && session.sessionType === 'strength_maintenance') return 'strength_maintenance';
  if (session.sport === 'strength') return 'strength_build';
  if (session.sessionType === 'mobility') return 'mobility';
  if (session.sessionType === 'rest') return 'rest';
  return 'easy';
}

export function classifyTrainingSessionRole(
  session: Pick<Session, 'sessionType' | 'intensityZone' | 'tags' | 'sport' | 'keySession'>,
  template?: WorkoutTemplate,
): TrainingSessionRoleClassification {
  const role = (template ? roleFromTemplate(template) : null) ?? roleFromSession(session);
  switch (role) {
    case 'long':
      return {
        role,
        label: session.sport === 'cycling' ? 'Long ride' : 'Long run',
        summary: 'Builds durable aerobic capacity; keep it controlled enough to recover.',
        keySessionLabel: session.keySession ? 'key long session' : undefined,
      };
    case 'threshold':
      return {
        role,
        label: 'Threshold',
        summary: 'Raises sustainable pace or power with controlled hard work.',
        keySessionLabel: session.keySession ? 'key threshold session' : undefined,
      };
    case 'vo2':
      return {
        role,
        label: 'VO2 intervals',
        summary: 'Shorter high-intensity work; protect recovery around this session.',
        keySessionLabel: session.keySession ? 'key interval session' : undefined,
      };
    case 'brick':
      return {
        role,
        label: 'Brick',
        summary: 'Practices the bike-to-run transition without turning it into a race.',
        keySessionLabel: 'key brick session',
      };
    case 'recovery':
      return {
        role,
        label: 'Recovery',
        summary: 'Keeps movement easy so adaptation can catch up.',
      };
    case 'technique':
      return {
        role,
        label: 'Technique',
        summary: 'Sharpens skill and efficiency at low physiological cost.',
      };
    case 'taper':
      return {
        role,
        label: 'Taper',
        summary: 'Preserves feel while reducing accumulated fatigue.',
        keySessionLabel: session.keySession ? 'key taper session' : undefined,
      };
    case 'race_specific':
      return {
        role,
        label: 'Race specific',
        summary: 'Rehearses event-specific demands while staying inside the week plan.',
        keySessionLabel: session.keySession ? 'key race-specific session' : undefined,
      };
    case 'strength_maintenance':
      return {
        role,
        label: 'Strength maintenance',
        summary: 'Keeps strength touchpoints without competing with key endurance work.',
      };
    case 'strength_build':
      return {
        role,
        label: 'Strength build',
        summary: 'Builds strength with progression controlled by recovery and feedback.',
      };
    case 'mobility':
      return {
        role,
        label: 'Mobility',
        summary: 'Restores range and reduces stiffness without adding training load.',
      };
    case 'rest':
      return {
        role,
        label: 'Rest',
        summary: 'No training load planned.',
      };
    case 'easy':
    default:
      return {
        role: 'easy',
        label: session.sport === 'swimming' ? 'Aerobic swim' : titleCase(`${session.sport} easy`),
        summary: 'Builds aerobic base while leaving room for the week’s key work.',
      };
  }
}

export function attachTrainingSessionRole(
  session: Session,
  template?: WorkoutTemplate,
): Session {
  const classification = classifyTrainingSessionRole(session, template);
  return {
    ...session,
    sessionRole: classification.role,
    sessionRoleLabel: classification.label,
    sessionRoleSummary: classification.summary,
    keySessionLabel: classification.keySessionLabel,
    tags: [...new Set([
      ...(session.tags ?? []),
      `role_${classification.role}`,
      ...(classification.keySessionLabel ? ['key_session_classified'] : []),
    ])],
  };
}
