// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

type AnyPlan = Record<string, any>;
type AnyWeek = Record<string, any>;
type AnySession = Record<string, any>;

export interface TrainingLearningPathContext {
  objective: string;
  goalMode?: string | null;
  trainingPriority?: string | null;
  durationWeeks: number;
}

export interface TrainingLearningPathWeek {
  weekNumber: number;
  title: string;
  phaseGoal: string;
  weeklyLearningFocus: string;
  whyThisMatters: string;
  techniqueCards: string[];
  benchmarkSessionTitles: string[];
  assessmentPrompt: string;
}

export interface TrainingLearningPath {
  schemaVersion: 1;
  objective: string;
  planGoal: string;
  measurableOutcomes: string[];
  weeklyPath: TrainingLearningPathWeek[];
}

/**
 * Deterministic educational overlay for generated Training plans.
 *
 * The planner should teach the athlete what the block is doing, not only
 * produce a calendar. Keep this metadata provider-neutral and bounded so iOS,
 * Progress, and QA tools can render or score it without parsing prompt prose.
 */
export function attachTrainingLearningPathToPlan<T extends AnyPlan>(
  plan: T,
  context: TrainingLearningPathContext,
): T & { trainingLearningPath: TrainingLearningPath; weeks?: AnyWeek[] } {
  const learningPath = buildTrainingLearningPath(plan, context);
  const weeks = Array.isArray(plan.weeks)
    ? plan.weeks.map((week: AnyWeek) => {
        const learning = learningPath.weeklyPath.find((item) => item.weekNumber === normalizeWeekNumber(week.weekNumber));
        return learning
          ? {
              ...week,
              learningFocus: {
                title: learning.title,
                phaseGoal: learning.phaseGoal,
                weeklyLearningFocus: learning.weeklyLearningFocus,
                whyThisMatters: learning.whyThisMatters,
                techniqueCards: learning.techniqueCards,
                benchmarkSessionTitles: learning.benchmarkSessionTitles,
                assessmentPrompt: learning.assessmentPrompt,
              },
            }
          : week;
      })
    : plan.weeks;

  return {
    ...plan,
    weeks,
    trainingLearningPath: learningPath,
  };
}

export function buildTrainingLearningPath(
  plan: AnyPlan,
  context: TrainingLearningPathContext,
): TrainingLearningPath {
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : [];
  const weeklyPath = weeks.map((week: AnyWeek, index: number): TrainingLearningPathWeek => {
    const weekNumber = normalizeWeekNumber(week.weekNumber, index + 1);
    const sessions = Array.isArray(week.sessions) ? week.sessions : [];
    const sports = new Set(sessions.map(inferSessionSport).filter((sport): sport is string => Boolean(sport)));
    const benchmarkSessionTitles = sessions
      .filter(isBenchmarkSession)
      .map((session) => cleanText(session.title) ?? cleanText(session.sessionType) ?? 'Benchmark session')
      .slice(0, 3);
    const phaseGoal = phaseGoalForWeek(week, weekNumber, context);
    return {
      weekNumber,
      title: `Week ${weekNumber}: ${phaseGoal}`,
      phaseGoal,
      weeklyLearningFocus: weeklyLearningFocusFor(sports, week, context),
      whyThisMatters: whyThisMattersFor(sports, week, context),
      techniqueCards: techniqueCardsFor(sports).slice(0, 4),
      benchmarkSessionTitles,
      assessmentPrompt: assessmentPromptFor(sports, benchmarkSessionTitles.length > 0),
    };
  });

  return {
    schemaVersion: 1,
    objective: context.objective,
    planGoal: planGoalFor(context),
    measurableOutcomes: measurableOutcomesFor(weeks, context),
    weeklyPath,
  };
}

function normalizeWeekNumber(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function inferSessionSport(session: AnySession): string | null {
  const text = [
    session.sport,
    session.sessionType,
    session.title,
    session.description,
    ...(Array.isArray(session.tags) ? session.tags : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(swim|swimming|pool|freestyle|open water|technique_swim)\b/.test(text)) return 'swim';
  if (/\b(cycling|cycle|bike|ride|trainer|ftp|watts|cadence)\b/.test(text)) return 'bike';
  if (/\b(run|running|jog|tempo|threshold run|long run|race pace)\b/.test(text)) return 'run';
  if (/\b(strength|gym|lift|squat|hinge|bench|hypertrophy)\b/.test(text)) return 'strength';
  if (/\b(mobility|recovery|rest)\b/.test(text)) return 'recovery';
  return null;
}

function isBenchmarkSession(session: AnySession): boolean {
  const text = [
    session.sessionType,
    session.title,
    session.description,
    session.sessionRole,
    session.keySessionLabel,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(benchmark|test|time trial|tt|assessment|race pace|threshold|ftp|css|5k|10k)\b/.test(text);
}

function planGoalFor(context: TrainingLearningPathContext): string {
  if (context.goalMode === 'event_based') {
    return 'Build toward the target event with clear phase intent, benchmark checks, and a controlled taper.';
  }
  if (context.trainingPriority === 'hybrid') {
    return 'Build durable fitness while keeping strength and endurance from competing blindly.';
  }
  if (context.trainingPriority === 'strength') {
    return 'Improve strength quality through progressive overload, technique consistency, and recovery feedback.';
  }
  return 'Create a repeatable training rhythm with visible progression and measurable feedback each week.';
}

function phaseGoalForWeek(week: AnyWeek, weekNumber: number, context: TrainingLearningPathContext): string {
  const focus = cleanText(week.focus)?.toLowerCase() ?? '';
  if (/\btaper|race\b/.test(focus)) return 'Sharpen and arrive fresh';
  if (/\bdeload|recovery|reset\b/.test(focus)) return 'Absorb work and restore quality';
  if (/\bbenchmark|test\b/.test(focus)) return 'Measure current capacity';
  if (weekNumber === 1) return 'Establish baseline and rhythm';
  if (weekNumber >= Math.max(1, context.durationWeeks)) return 'Consolidate progress and review signals';
  return 'Progress load while protecting quality';
}

function weeklyLearningFocusFor(
  sports: Set<string>,
  week: AnyWeek,
  context: TrainingLearningPathContext,
): string {
  if (sports.has('bike') && sports.has('run') && sports.has('swim')) {
    return 'Track how swim, bike, run, and transition stress fit together instead of treating them separately.';
  }
  if (sports.has('strength') && sports.has('run')) {
    return 'Notice how lower-body lifting is spaced around key running work.';
  }
  if (sports.has('strength')) return 'Keep reps technically clean and record RPE so progression has a real signal.';
  if (sports.has('run')) return 'Separate easy running from quality work so pace improves without stacking fatigue.';
  if (sports.has('bike')) return 'Use cadence, RPE, and power only when benchmark data supports the prescription.';
  if (sports.has('swim')) return 'Prioritize relaxed technique before chasing pace.';
  if (context.goalMode === 'event_based') return 'Connect this week to the event timeline and adjust only with evidence.';
  return cleanText(week.focus) ?? 'Use this week to learn what dosage is repeatable.';
}

function whyThisMattersFor(sports: Set<string>, week: AnyWeek, context: TrainingLearningPathContext): string {
  if (sports.has('swim') && sports.has('bike') && sports.has('run')) {
    return 'Triathlon fitness improves when discipline stress and transitions are planned as one system.';
  }
  if (sports.has('strength') && (sports.has('run') || sports.has('bike'))) {
    return 'Hybrid progress depends on spacing stress, not simply adding more sessions.';
  }
  if (context.goalMode === 'event_based') {
    return 'Race-specific work should become more precise as the event approaches, while recovery protects execution.';
  }
  return 'Understanding the intent makes feedback useful: easy, hard, sore, or pain signals can change the next step.';
}

function techniqueCardsFor(sports: Set<string>): string[] {
  const cards: string[] = [];
  if (sports.has('strength')) {
    cards.push('Strength: stop sets with clean reps in reserve; do not chase load when form changes.');
  }
  if (sports.has('run')) {
    cards.push('Run: easy days should feel controlled enough to repeat tomorrow.');
  }
  if (sports.has('bike')) {
    cards.push('Bike: keep cadence smooth before forcing more power.');
  }
  if (sports.has('swim')) {
    cards.push('Swim: relaxed breathing and body position come before speed.');
  }
  if (cards.length === 0) {
    cards.push('Recovery: use soreness, sleep, and motivation as training signals, not annoyances to ignore.');
  }
  return cards;
}

function assessmentPromptFor(sports: Set<string>, hasBenchmark: boolean): string {
  if (hasBenchmark) {
    return 'After the benchmark, record effort, soreness, and whether the result changed future targets.';
  }
  if (sports.has('strength')) {
    return 'After lifting, record RPE, reps left in reserve, and any pain signal.';
  }
  if (sports.has('run') || sports.has('bike') || sports.has('swim')) {
    return 'After endurance work, record whether the session felt easy, controlled, or too hard for the intent.';
  }
  return 'At week end, note what felt repeatable and what needs adaptation.';
}

function measurableOutcomesFor(weeks: AnyWeek[], context: TrainingLearningPathContext): string[] {
  const outcomes = [
    'Session completion and skip rate',
    'Post-session RPE, soreness, and pain feedback',
    'Key-session execution quality',
  ];
  const text = JSON.stringify(weeks).toLowerCase();
  if (/\bstrength|gym|squat|bench|deadlift\b/.test(text)) outcomes.push('Strength exercise progression and clean-rep consistency');
  if (/\brun|running|pace|threshold\b/.test(text)) outcomes.push('Running long-session and quality-session response');
  if (/\bbike|cycling|ftp|watts\b/.test(text)) outcomes.push('Cycling benchmark or RPE-zone calibration');
  if (/\bswim|pool|freestyle\b/.test(text)) outcomes.push('Swim technique consistency and access fit');
  if (context.goalMode === 'event_based') outcomes.push('Race-date readiness and taper fit');
  return outcomes;
}
