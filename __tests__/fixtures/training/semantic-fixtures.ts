import type { PlanLintInput } from '../../../src/services/coach-kernel/plan-linter';
import type { SessionDescriptionInput } from '../../../src/services/training-session-description';

export type TrainingFixtureProductionStatus = 'production_real' | 'fixture_only' | 'blocked';
export type TrainingFixtureGateStatus = 'pass' | 'needs_user_input' | 'needs_repair' | 'internal_only' | 'blocked';

export interface TrainingSemanticFixture {
  id: string;
  area: string;
  productionStatus: TrainingFixtureProductionStatus;
  inputState: string;
  sourceTrace: {
    originatingSkill: 'training' | 'secretary' | 'cooking' | 'decision_center' | 'chat';
    originatingSignal: string;
    sourceEntityIds: string[];
    verifier: string | null;
  };
  expected: {
    gateStatus: TrainingFixtureGateStatus;
    planQuality: string[];
    sessionQuality: {
      modality?: 'strength' | 'running' | 'cycling' | 'swimming' | 'triathlon' | 'hybrid';
      requiredCopy: string[];
      forbiddenCopy: string[];
    };
    ui: {
      primaryCopy: string[];
      hiddenDebugCopy: string[];
      collapsedDetails: string[];
    };
    integrations: {
      secretary: boolean;
      cooking: boolean;
      decisionCenter: boolean;
      chatCorrection: boolean;
    };
    privacy: {
      userId: number;
      tenantId: number;
      forbiddenPreviewCopy: string[];
    };
  };
  planLintInput?: PlanLintInput;
  sessionDescriptionInput?: SessionDescriptionInput;
}

const now = new Date('2026-05-12T08:00:00.000Z');

const baseSessionDescription: Omit<SessionDescriptionInput, 'session' | 'sport'> = {
  planName: 'Training Semantic Fixture',
  objective: 'Training semantic fixture',
  totalWeeks: 6,
  startDate: '2026-05-11',
  periodization: 'block',
  weekNumber: 1,
  weekFocus: 'base',
  weekIntensityPct: 70,
  allWeeks: [
    { weekNumber: 1, focus: 'base', sessions: [] },
    { weekNumber: 2, focus: 'base', sessions: [] },
  ],
  profiles: {
    runProfile: { threshold_pace: '5:00' },
    fitnessProfile: { max_heart_rate: 184, threshold_heart_rate: 166, ftp_watts: 260 },
  },
};

function planLintInput(overrides: Partial<PlanLintInput>): PlanLintInput {
  return {
    now,
    weeks: [],
    ...overrides,
  };
}

export const trainingSemanticFixtures: TrainingSemanticFixture[] = [
  {
    id: 'advanced-marathon-5-gym-6-run',
    area: 'Training plan quality',
    productionStatus: 'production_real',
    inputState: 'Advanced marathon user requests high strength plus high run frequency.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'profile_goal_mode', sourceEntityIds: ['profile-advanced-marathon'], verifier: 'plan_linter_result' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['profile_fit', 'interference_guardrails', 'long_run_protected'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['protect key run', 'strength support'], forbiddenCopy: ['debug', 'calendar_busy_blocks'] },
      ui: { primaryCopy: ['what to do today', 'what this protects'], hiddenDebugCopy: ['mp1', 'session_prescription'], collapsedDetails: ['sourceTrace'] },
      integrations: { secretary: true, cooking: true, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 101, tenantId: 101, forbiddenPreviewCopy: ['injury detail', 'private calendar title'] },
    },
  },
  {
    id: 'beginner-no-equipment',
    area: 'Training plan quality',
    productionStatus: 'production_real',
    inputState: 'Beginner user has bodyweight-only equipment.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'equipment_profile', sourceEntityIds: ['profile-beginner-bodyweight'], verifier: 'plan_linter_result' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['equipment_fit', 'beginner_complexity_cap'],
      sessionQuality: { modality: 'strength', requiredCopy: ['chair squat', 'incline push-up'], forbiddenCopy: ['barbell', 'dumbbell', 'machine', 'cable'] },
      ui: { primaryCopy: ['safe foundation', 'simple session'], hiddenDebugCopy: ['equipment_compatibility'], collapsedDetails: ['planLint'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 102, tenantId: 102, forbiddenPreviewCopy: ['limitation notes'] },
    },
    planLintInput: planLintInput({
      equipmentProfile: 'bodyweight',
      weeks: [{
        weekNumber: 1,
        focus: 'base',
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Bodyweight Foundation',
          status: 'scheduled',
          scheduledDate: '2026-05-13T08:00:00.000Z',
          exerciseTokens: ['chair squat', 'incline push-up', 'dead bug'],
        }],
      }],
    }),
  },
  {
    id: 'continuous-strength-maintenance',
    area: 'Roadmap',
    productionStatus: 'production_real',
    inputState: 'Continuous strength plan has no event date.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'goal_mode_continuous', sourceEntityIds: ['plan-continuous-strength'], verifier: 'roadmap_focus_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['rolling_mesocycle', 'maintenance_deload'],
      sessionQuality: { modality: 'strength', requiredCopy: ['maintenance', 'review'], forbiddenCopy: ['race taper', 'marathon taper'] },
      ui: { primaryCopy: ['maintain strength', 'review week'], hiddenDebugCopy: ['fake taper'], collapsedDetails: ['roadmap source'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 103, tenantId: 103, forbiddenPreviewCopy: [] },
    },
  },
  {
    id: 'long-run-saturday-conflict',
    area: 'Secretary + Training',
    productionStatus: 'production_real',
    inputState: 'Preferred Saturday long run cannot fit because Secretary has a protected event.',
    sourceTrace: { originatingSkill: 'secretary', originatingSignal: 'calendar_conflict', sourceEntityIds: ['training-session-long-run', 'secretary-agenda-family'], verifier: 'secretary_agenda_item_state' },
    expected: {
      gateStatus: 'needs_user_input',
      planQuality: ['schedule_fit', 'long_run_preference'],
      sessionQuality: { modality: 'running', requiredCopy: ['moved from Saturday', 'protected'], forbiddenCopy: ['generic conflict', 'Review'] },
      ui: { primaryCopy: ['move to Sunday', 'what changed'], hiddenDebugCopy: ['calendar_busy_blocks'], collapsedDetails: ['sourceTrace'] },
      integrations: { secretary: true, cooking: false, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 104, tenantId: 104, forbiddenPreviewCopy: ['family event'] },
    },
  },
  {
    id: 'low-sleep-readiness-cap',
    area: 'Readiness',
    productionStatus: 'production_real',
    inputState: 'Low sleep and fatigue reduce hard work to recovery-first training.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'readiness_low_sleep', sourceEntityIds: ['readiness-2026-05-12'], verifier: 'guardrail_results' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['recovery_fit', 'load_monitoring'],
      sessionQuality: { modality: 'running', requiredCopy: ['cap intensity', 'protect recovery'], forbiddenCopy: ['diagnose', 'medical treatment'] },
      ui: { primaryCopy: ['protect recovery', 'easy today'], hiddenDebugCopy: ['readiness_raw'], collapsedDetails: ['body battery source'] },
      integrations: { secretary: true, cooking: true, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 105, tenantId: 105, forbiddenPreviewCopy: ['sleep score raw'] },
    },
  },
  {
    id: 'calendar-packed-reflow',
    area: 'Secretary + Training',
    productionStatus: 'production_real',
    inputState: 'Calendar is packed and Secretary must reflow the session.',
    sourceTrace: { originatingSkill: 'secretary', originatingSignal: 'capacity_conflict', sourceEntityIds: ['training-session-tempo', 'secretary-day-capacity'], verifier: 'secretary_agenda_item_state' },
    expected: {
      gateStatus: 'needs_user_input',
      planQuality: ['schedule_fit', 'capacity_fit'],
      sessionQuality: { modality: 'running', requiredCopy: ['moved from', 'moved to', 'what this protects'], forbiddenCopy: ['calendar is packed', 'needs attention'] },
      ui: { primaryCopy: ['reflow', 'protected key session'], hiddenDebugCopy: ['calendar_busy_blocks'], collapsedDetails: ['Secretary source'] },
      integrations: { secretary: true, cooking: false, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 106, tenantId: 106, forbiddenPreviewCopy: ['private meeting title'] },
    },
  },
  {
    id: 'fueling-missing-hard-session',
    area: 'Cooking + Training',
    productionStatus: 'production_real',
    inputState: 'Hard training day has no meal support.',
    sourceTrace: { originatingSkill: 'cooking', originatingSignal: 'fueling_gap_risk', sourceEntityIds: ['training-session-hard-001'], verifier: 'meal_plan_state' },
    expected: {
      gateStatus: 'needs_user_input',
      planQuality: ['fueling_support'],
      sessionQuality: { modality: 'running', requiredCopy: ['meal support', 'skip today'], forbiddenCopy: ['diet diagnosis', 'must eat'] },
      ui: { primaryCopy: ['Add meal support', 'Skip today'], hiddenDebugCopy: ['fueling_gap_risk'], collapsedDetails: ['Cooking context'] },
      integrations: { secretary: false, cooking: true, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 107, tenantId: 107, forbiddenPreviewCopy: ['weight', 'calorie'] },
    },
  },
  {
    id: 'strength-session-modality-copy',
    area: 'Session prescription',
    productionStatus: 'production_real',
    inputState: 'Strength session was mislabeled as easy_run upstream but carries strength evidence.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'session_prescription', sourceEntityIds: ['session-strength-copy'], verifier: 'session_description_sections' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['modality_correct_prescription'],
      sessionQuality: { modality: 'strength', requiredCopy: ['EXERCISES', 'RPE'], forbiddenCopy: ['Zone 2', 'walk breaks', 'HR drifts'] },
      ui: { primaryCopy: ['sets', 'reps', 'rest'], hiddenDebugCopy: ['session_prescription', 'mp3'], collapsedDetails: ['sourceTrace'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 108, tenantId: 108, forbiddenPreviewCopy: [] },
    },
    sessionDescriptionInput: {
      ...baseSessionDescription,
      sport: 'running',
      session: {
        sessionType: 'easy_run',
        title: 'Upper Hypertrophy',
        durationMinutes: 50,
        dayOfWeek: 'Thursday',
        description: 'Strict Zone 2 with walk breaks if HR drifts.\nsession_prescription · mp3\nKeep elbows stacked.',
        exercises: [
          { name: 'Dumbbell Bench Press', sets: 4, reps: '8-10', rpe: '7', rest_sec: 90 },
          { name: 'Seated Row', sets: 3, reps: '10-12', rpe: '7', rest_sec: 75 },
        ],
      },
    },
  },
  {
    id: 'running-session-modality-copy',
    area: 'Session prescription',
    productionStatus: 'production_real',
    inputState: 'Running session should not show strength/RIR language.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'session_prescription', sourceEntityIds: ['session-run-copy'], verifier: 'session_description_sections' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['modality_correct_prescription'],
      sessionQuality: { modality: 'running', requiredCopy: ['Pace', 'RPE'], forbiddenCopy: ['reps in reserve', 'RIR', 'barbell'] },
      ui: { primaryCopy: ['controlled effort'], hiddenDebugCopy: ['calendar_busy_blocks'], collapsedDetails: ['sourceTrace'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 109, tenantId: 109, forbiddenPreviewCopy: [] },
    },
    sessionDescriptionInput: {
      ...baseSessionDescription,
      sport: 'running',
      session: {
        sessionType: 'tempo_run',
        title: 'Tempo Run',
        durationMinutes: 42,
        dayOfWeek: 'Tuesday',
        description: 'Run controlled.\nKeep 2 reps in reserve.\ncalendar_busy_blocks · mp1',
      },
    },
  },
  {
    id: 'cycling-session-modality-copy',
    area: 'Session prescription',
    productionStatus: 'production_real',
    inputState: 'Cycling session should use bike-specific execution and scrub lifting cues.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'session_prescription', sourceEntityIds: ['session-bike-copy'], verifier: 'session_description_sections' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['modality_correct_prescription'],
      sessionQuality: { modality: 'cycling', requiredCopy: ['Power', 'RPE'], forbiddenCopy: ['squat', 'lunge', 'deadlift'] },
      ui: { primaryCopy: ['bike', 'cadence'], hiddenDebugCopy: ['decision_trail'], collapsedDetails: ['sourceTrace'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 110, tenantId: 110, forbiddenPreviewCopy: [] },
    },
    sessionDescriptionInput: {
      ...baseSessionDescription,
      sport: 'cycling',
      session: {
        sessionType: 'endurance_ride',
        title: 'Endurance Ride',
        durationMinutes: 60,
        dayOfWeek: 'Wednesday',
        description: 'Steady pressure on the pedals.\nAdd lunges after each interval.\ndecision_trail mp2',
      },
    },
  },
  {
    id: 'triathlon-hybrid-balance',
    area: 'Roadmap',
    productionStatus: 'fixture_only',
    inputState: 'Hybrid week balances swim, bike, run, and strength without overloading one modality.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'goal_mode_triathlon', sourceEntityIds: ['plan-tri-hybrid'], verifier: 'weekly_plan_sport_balance' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['discipline_balance', 'brick_clarity'],
      sessionQuality: { modality: 'triathlon', requiredCopy: ['brick', 'separate blocks'], forbiddenCopy: ['single-modality only'] },
      ui: { primaryCopy: ['swim', 'bike', 'run'], hiddenDebugCopy: ['raw split'], collapsedDetails: ['sourceTrace'] },
      integrations: { secretary: true, cooking: true, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 111, tenantId: 111, forbiddenPreviewCopy: [] },
    },
  },
  {
    id: 'race-date-far-future-roadmap',
    area: 'Roadmap',
    productionStatus: 'production_real',
    inputState: 'Race date is far enough away that the roadmap must extend beyond the current visible block.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'race_date_profile', sourceEntityIds: ['race-2027-04'], verifier: 'roadmap_phase_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['event_based_progression', 'future_roadmap'],
      sessionQuality: { modality: 'running', requiredCopy: ['base', 'build', 'taper'], forbiddenCopy: ['generic end date'] },
      ui: { primaryCopy: ['roadmap', 'race-specific build'], hiddenDebugCopy: ['phase enum'], collapsedDetails: ['profile source'] },
      integrations: { secretary: true, cooking: true, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 112, tenantId: 112, forbiddenPreviewCopy: [] },
    },
  },
  {
    id: 'continuous-no-event-deload',
    area: 'Roadmap',
    productionStatus: 'production_real',
    inputState: 'Continuous plan uses periodic deload without a fake race taper.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'goal_mode_continuous', sourceEntityIds: ['plan-continuous-run'], verifier: 'roadmap_focus_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['rolling_blocks', 'periodic_deload'],
      sessionQuality: { modality: 'running', requiredCopy: ['deload', 'review'], forbiddenCopy: ['race week', 'taper'] },
      ui: { primaryCopy: ['next block', 'review week'], hiddenDebugCopy: ['fake taper'], collapsedDetails: ['roadmap source'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 113, tenantId: 113, forbiddenPreviewCopy: [] },
    },
    // The deload week carries a real reduced-volume session. It previously
    // used `sessions: []` as scaffolding — this fixture exists to prove a
    // continuous plan does NOT trip `no_fake_taper_without_event`, and an
    // empty week was the shortest way to reach that rule. Once
    // `plan_has_active_training` (F3) began enforcing a whole-plan volume
    // floor, the empty week made the fixture assert that a zero-session plan
    // passes the gate — the exact defect F3 closes. A deload is reduced
    // training, not absent training, so the fixture now models one.
    planLintInput: planLintInput({
      isRaceSpecific: false,
      raceDate: null,
      weeks: [{
        weekNumber: 1,
        focus: 'deload',
        sessions: [{
          dayOfWeek: 'tuesday',
          sessionType: 'run',
          title: 'Deload Aerobic Run',
          status: 'scheduled',
          scheduledDate: '2026-05-13T08:00:00.000Z',
        }],
      }],
    }),
  },
  {
    id: 'missed-sessions-reflow',
    area: 'Feedback adaptation',
    productionStatus: 'production_real',
    inputState: 'Missed sessions require a safe reflow instead of chasing all missed volume.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'missed_sessions', sourceEntityIds: ['feedback-week-19'], verifier: 'weekly_plan_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['adherence_repair', 'no_chasing_volume'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['restart', 'short safe session'], forbiddenCopy: ['make up everything'] },
      ui: { primaryCopy: ['restart the week', 'protect recovery'], hiddenDebugCopy: ['0% trailing'], collapsedDetails: ['decision trail'] },
      integrations: { secretary: true, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 114, tenantId: 114, forbiddenPreviewCopy: ['missed reason'] },
    },
  },
  {
    id: 'injury-discomfort-substitution',
    area: 'Substitutions',
    productionStatus: 'production_real',
    inputState: 'Knee discomfort requires compatible substitutions and safe referral language.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'discomfort_feedback', sourceEntityIds: ['feedback-knee-001'], verifier: 'substitution_state' },
    expected: {
      gateStatus: 'needs_user_input',
      planQuality: ['pain_boundary', 'substitution_fit'],
      sessionQuality: { modality: 'strength', requiredCopy: ['alternative', 'stop if pain increases'], forbiddenCopy: ['diagnosis', 'treatment'] },
      ui: { primaryCopy: ['replace exercise', 'choose alternative'], hiddenDebugCopy: ['contraindication enum'], collapsedDetails: ['coach details'] },
      integrations: { secretary: false, cooking: false, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 115, tenantId: 115, forbiddenPreviewCopy: ['knee pain detail'] },
    },
  },
  {
    id: 'user-switch-training-plan-isolation',
    area: 'Privacy',
    productionStatus: 'production_real',
    inputState: 'User switch must clear old Training plan, reasoning, and outcomes.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'tenant_scope_change', sourceEntityIds: ['user-a-plan', 'user-b-plan'], verifier: 'training_repository_user_scope' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['tenant_isolation'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['scoped plan'], forbiddenCopy: ['previous user'] },
      ui: { primaryCopy: ['refreshing training'], hiddenDebugCopy: ['user-a-plan'], collapsedDetails: ['scope source'] },
      integrations: { secretary: true, cooking: true, decisionCenter: true, chatCorrection: false },
      privacy: { userId: 116, tenantId: 116, forbiddenPreviewCopy: ['User A', 'private plan'] },
    },
  },
  {
    id: 'calendar-sync-partial-summary',
    area: 'Calendar sync',
    productionStatus: 'production_real',
    inputState: 'Internal Training state is updated but external calendar sync is partial.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'calendar_sync_partial', sourceEntityIds: ['plan-sync-001'], verifier: 'training_calendar_sync_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['internal_external_sync_separation'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['Nexus updated', 'calendar sync pending'], forbiddenCopy: ['done everywhere'] },
      ui: { primaryCopy: ['waiting on calendar', 'retry sync'], hiddenDebugCopy: ['provider raw error'], collapsedDetails: ['sync detail'] },
      integrations: { secretary: true, cooking: false, decisionCenter: true, chatCorrection: false },
      privacy: { userId: 117, tenantId: 117, forbiddenPreviewCopy: ['provider token'] },
    },
  },
  {
    id: 'duplicate-decision-trail-dedupe',
    area: 'Coach output quality',
    productionStatus: 'production_real',
    inputState: 'Repeated coach reasons should be deduped before the primary UI.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'coach_decision_trail', sourceEntityIds: ['plan-notes-001'], verifier: 'dedupe_decision_lines' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['explanation_quality'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['first useful wording'], forbiddenCopy: ['duplicate duplicate'] },
      ui: { primaryCopy: ['why this session'], hiddenDebugCopy: ['decision_trail', 'mp1'], collapsedDetails: ['sourceTrace'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 118, tenantId: 118, forbiddenPreviewCopy: [] },
    },
  },
  {
    id: 'no-wearable-honest-readiness',
    area: 'Readiness',
    productionStatus: 'production_real',
    inputState: 'No wearable provider is connected; coach must use conservative defaults and label confidence honestly.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'readiness_no_data', sourceEntityIds: ['readiness-fallback'], verifier: 'readiness_confidence_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['honest_degraded_readiness', 'conservative_progression'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['conservative', 'connect wearable'], forbiddenCopy: ['fresh HRV', 'precise recovery'] },
      ui: { primaryCopy: ['neutral read', 'connect provider'], hiddenDebugCopy: ['WEARABLE_INTEGRATION_MISSING'], collapsedDetails: ['readiness confidence'] },
      integrations: { secretary: false, cooking: false, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 119, tenantId: 119, forbiddenPreviewCopy: ['raw provider payload'] },
    },
  },
  {
    id: 'stale-provider-readiness-label',
    area: 'Readiness',
    productionStatus: 'production_real',
    inputState: 'Provider exists but last recovery sync is stale.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'readiness_stale_provider', sourceEntityIds: ['provider-freshness-2026-05-19'], verifier: 'readiness_confidence_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['stale_provider_label', 'no_silent_override'],
      sessionQuality: { modality: 'running', requiredCopy: ['stale', 'avoid aggressive progression'], forbiddenCopy: ['green readiness', 'fresh today'] },
      ui: { primaryCopy: ['stale data', 'check in manually'], hiddenDebugCopy: ['provider timestamp'], collapsedDetails: ['source freshness'] },
      integrations: { secretary: false, cooking: false, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 120, tenantId: 120, forbiddenPreviewCopy: ['provider token'] },
    },
  },
  {
    id: 'week-one-empty-quality-block',
    area: 'Plan quality gate',
    productionStatus: 'production_real',
    inputState: 'Week 1 failed to schedule while later weeks contain active workouts.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'quality_gate_week_one_empty', sourceEntityIds: ['plan-week1-empty'], verifier: 'plan_linter_result' },
    expected: {
      gateStatus: 'needs_repair',
      planQuality: ['week_one_not_empty', 'pre_save_block'],
      sessionQuality: { modality: 'running', requiredCopy: ['choose a Week 1 slot'], forbiddenCopy: ['created successfully'] },
      ui: { primaryCopy: ['Week 1 needs a slot', 'choose another slot'], hiddenDebugCopy: ['week_one_has_active_training'], collapsedDetails: ['quality gate'] },
      integrations: { secretary: true, cooking: false, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 121, tenantId: 121, forbiddenPreviewCopy: ['private meeting title'] },
    },
    planLintInput: planLintInput({
      weeks: [
        {
          weekNumber: 1,
          focus: 'base',
          sessions: [{
            dayOfWeek: 'monday',
            sessionType: 'run',
            title: 'Week 1 Long Run',
            description: 'Could not place safely this week.',
            durationMinutes: 45,
            status: 'unscheduled',
          }],
        },
        {
          weekNumber: 2,
          focus: 'base',
          sessions: [{
            dayOfWeek: 'tuesday',
            sessionType: 'run',
            title: 'Week 2 Easy Run',
            description: '10 min warm-up, 30 min easy, 5 min cooldown.',
            durationMinutes: 45,
            status: 'scheduled',
            scheduledDate: '2026-05-19T07:00:00.000Z',
          }],
        },
      ],
    }),
  },
  {
    id: 'hidden-week-five-move-block',
    area: 'Plan quality gate',
    productionStatus: 'production_real',
    inputState: 'Four-week plan suggests moving a Week 1 workout to a hidden Week 5 slot.',
    sourceTrace: { originatingSkill: 'secretary', originatingSignal: 'move_suggestion_outside_window', sourceEntityIds: ['plan-4-week', 'slot-2026-06-16'], verifier: 'plan_linter_result' },
    expected: {
      gateStatus: 'needs_repair',
      planQuality: ['plan_window_clamp', 'conflict_choice_required'],
      sessionQuality: { modality: 'running', requiredCopy: ['inside this plan window'], forbiddenCopy: ['2026-06-16T00:00:00.000Z'] },
      ui: { primaryCopy: ['Move inside plan window', 'Keep unscheduled'], hiddenDebugCopy: ['no_sessions_outside_plan_window'], collapsedDetails: ['Secretary slot evidence'] },
      integrations: { secretary: true, cooking: false, decisionCenter: true, chatCorrection: true },
      privacy: { userId: 122, tenantId: 122, forbiddenPreviewCopy: ['private calendar title'] },
    },
    planLintInput: planLintInput({
      startDate: '2026-05-19',
      durationWeeks: 4,
      weeks: [
        {
          weekNumber: 1,
          focus: 'base',
          sessions: [{
            dayOfWeek: 'tuesday',
            sessionType: 'run',
            title: 'Week 1 Easy Run',
            description: '10 min warm-up, 30 min easy, 5 min cooldown.',
            durationMinutes: 45,
            status: 'scheduled',
            scheduledDate: '2026-05-19T07:00:00.000Z',
          }],
        },
        {
          weekNumber: 5,
          focus: 'base',
          sessions: [{
            dayOfWeek: 'tuesday',
            sessionType: 'run',
            title: 'Hidden Week 5 Move',
            description: 'Out-of-window move suggestion.',
            durationMinutes: 45,
            status: 'scheduled',
            scheduledDate: '2026-06-16T07:00:00.000Z',
          }],
        },
      ],
    }),
  },
  {
    id: 'plan-cancel-owned-calendar-cleanup',
    area: 'Calendar sync',
    productionStatus: 'production_real',
    inputState: 'Cancel plan must remove every generated calendar event and reconcile ownership state.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'plan_cancel_cleanup', sourceEntityIds: ['plan-owned-events'], verifier: 'calendar_ownership_audit' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['owned_event_cleanup', 'zero_orphans_after_cancel'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['removed generated workouts'], forbiddenCopy: ['manual calendar event deleted'] },
      ui: { primaryCopy: ['Plan cancelled', 'calendar cleaned up'], hiddenDebugCopy: ['provider event id'], collapsedDetails: ['ownership reconciliation'] },
      integrations: { secretary: true, cooking: false, decisionCenter: true, chatCorrection: false },
      privacy: { userId: 123, tenantId: 123, forbiddenPreviewCopy: ['provider raw event'] },
    },
  },
  {
    id: 'duplicate-preview-create-prevention',
    area: 'iOS plan builder',
    productionStatus: 'production_real',
    inputState: 'User taps Preview/Create repeatedly while the request is pending.',
    sourceTrace: { originatingSkill: 'training', originatingSignal: 'idempotent_plan_creation', sourceEntityIds: ['ios-plan-builder'], verifier: 'idempotency_key_and_button_state' },
    expected: {
      gateStatus: 'pass',
      planQuality: ['idempotent_create', 'single_active_request'],
      sessionQuality: { modality: 'hybrid', requiredCopy: ['create plan', 'edit inputs', 'discard'], forbiddenCopy: ['duplicate plan'] },
      ui: { primaryCopy: ['Preview ready', 'Create plan'], hiddenDebugCopy: ['raw idempotency key'], collapsedDetails: ['request fingerprint'] },
      integrations: { secretary: false, cooking: false, decisionCenter: false, chatCorrection: true },
      privacy: { userId: 124, tenantId: 124, forbiddenPreviewCopy: ['idempotencyKey'] },
    },
  },
];
