// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  buildIntensitySummary,
  buildSessionIntensityProfile,
} from './intensity-profile';
import type { AthleteProfile, IntensitySegment, Session, SessionIntensityProfile, WorkoutTemplate } from './types';

function minutes(seconds: number | undefined): number {
  if (!seconds || seconds <= 0) return 0;
  return Math.round(seconds / 60);
}

function segmentSummary(segment: IntensitySegment): string | null {
  const reps = segment.reps && segment.reps > 1 ? `${segment.reps}x ` : '';
  const duration = minutes(segment.durationSec);
  const durationText = duration > 0 ? `${duration}min` : segment.distanceMeters ? `${segment.distanceMeters}m` : '';
  if (!durationText) return null;
  const zone = segment.targetZone ? ` ${segment.targetZone}` : '';
  return `${reps}${durationText}${zone}`.trim();
}

function targetSummaryText(session: Session, segments: IntensitySegment[]): string {
  const intervals = segments.filter((segment) => segment.role === 'interval');
  if (intervals.length > 0) {
    const first = intervals[0];
    const intervalText = segmentSummary({ ...first, reps: intervals.length }) ?? `${intervals.length} intervals`;
    return `${intervalText} with warmup and cooldown.`;
  }
  const main = segments.find((segment) => segment.role === 'steady' || segment.role === 'main') ?? segments[0];
  const mainText = main ? segmentSummary(main) : null;
  if (mainText) return `${mainText} continuous work.`;
  return `${session.durationMinutes}min ${session.intensityZone} session.`;
}

export function attachSessionIntensityMetadata(
  session: Session,
  template: WorkoutTemplate,
  profile: Pick<
    AthleteProfile,
    'thresholdPaceSecondsPerKm' | 'cyclingFtpWatts' | 'swimCssSecondsPer100m'
  >,
): Session {
  if (session.sport === 'strength') return session;
  const intensityProfile = buildSessionIntensityProfile(template, session.durationMinutes, profile);
  return {
    ...session,
    intensityProfile,
    intensitySummary: buildIntensitySummary(
      intensityProfile,
      targetSummaryText(session, intensityProfile.segments),
    ),
  };
}

/**
 * Replace metadata inherited from an earlier prescription after a guardrail
 * changes the session's zone/type. Recovery adaptations are deliberately
 * simple continuous work; retaining the original threshold/VO2 segments
 * would make the public read model contradict the final session.
 */
export function replaceSessionIntensityMetadataWithFinalSteadyPrescription(session: Session): Session {
  if (session.sport === 'strength' || session.sessionType === 'rest' || session.durationMinutes <= 0) {
    return {
      ...session,
      intensityProfile: undefined,
      intensitySummary: undefined,
    };
  }
  const intensityProfile: SessionIntensityProfile = {
    primaryZone: session.intensityZone,
    segments: [{
      role: 'steady',
      modality: session.sport,
      durationSec: Math.round(session.durationMinutes * 60),
      targetZone: session.intensityZone,
    }],
    intensityDistribution: { [session.intensityZone]: 1 },
  };
  return {
    ...session,
    intensityProfile,
    intensitySummary: buildIntensitySummary(
      intensityProfile,
      `${session.durationMinutes}min ${session.intensityZone} continuous adjusted work.`,
    ),
  };
}
