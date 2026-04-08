// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Sport Classifier — Phase 2 Slice A
 *
 * Pure keyword-based classifier that decides which SPORT a triathlon
 * message is about. Used by the prompt loader to pick the right coach
 * persona file:
 *
 *   triathlon/gym.md      ← strength coach
 *   triathlon/running.md  ← endurance running coach
 *   triathlon/cycling.md  ← cycling coach
 *   triathlon/swim.md     ← swim coach
 *
 * Design notes
 * ------------
 *
 * 1. TOKEN-ZERO BY DESIGN: This classifier does NOT make an LLM call.
 *    It runs on every triathlon message to decide which persona file
 *    to load, which means it has to be fast, deterministic, and free.
 *    Pure keyword matching with word boundaries — that's it.
 *
 * 2. PORTUGUESE + ENGLISH: Felipe switches languages mid-sentence, so
 *    each sport's keyword list mixes both languages. Keywords are
 *    chosen for HIGH PRECISION — we'd rather return null (fall back
 *    to the generic triathlon prompt) than misclassify a general
 *    fitness question as "running".
 *
 * 3. SHARED VOCABULARY IS EXCLUDED: Words like "workout", "training",
 *    "session", "plan", "week", "today" appear in every sport and
 *    would produce 4-way ties. They're deliberately absent from all
 *    keyword lists.
 *
 * 4. TIE HANDLING: If two sports score identically, we return null
 *    (generic prompt). The alternative — picking one arbitrarily —
 *    would be wrong half the time. Generic-triathlon is the safe
 *    fallback because it can ask "which sport?".
 */

export type Sport = 'gym' | 'running' | 'cycling' | 'swim';

export interface SportMatch {
  /** The winning sport, or null if no clear winner. */
  sport: Sport | null;
  /** Confidence score 0-1. 0 = no match, 1.0 = only one sport matched. */
  confidence: number;
  /** Keywords that contributed to the winning score — for debugging. */
  matched: string[];
  /** Full per-sport scores — useful for tests and observability. */
  scores: Record<Sport, number>;
}

// ─── Keyword lists ───────────────────────────────────────────────────
//
// Order matters only for readability — the matcher is case-insensitive
// and applies each keyword with a word-boundary regex.

const GYM_KEYWORDS: readonly string[] = [
  // English — lifts (with common morphological variants: past tense,
  // present participle, plural). We enumerate rather than stem because
  // stemming is language-dependent and the keyword list is small enough
  // to list variants explicitly.
  'squat', 'squats', 'squatted', 'squatting',
  'deadlift', 'deadlifts', 'deadlifted', 'deadlifting',
  'bench press', 'bench', 'benched', 'benching',
  'overhead press', 'ohp', 'military press', 'shoulder press',
  'row', 'rows', 'rowed', 'pull-up', 'pullup', 'pull up',
  'chin up', 'chinup', 'chinups',
  'dip', 'dips', 'lunge', 'lunges', 'lunged',
  'leg press', 'leg curl', 'leg extension',
  'rdl', 'romanian deadlift', 'hip thrust', 'split squat', 'bulgarian',
  'front squat', 'back squat', 'sumo', 'hack squat',
  'lifted',
  // English — generic gym vocabulary
  'rpe', 'rir', '1rm', 'pr', 'one rep max', 'personal record',
  'hypertrophy', 'strength', 'powerlifting', 'bodybuilding',
  'push day', 'pull day', 'leg day', 'upper body', 'lower body',
  'biceps', 'triceps', 'chest', 'back day', 'legs day', 'glutes',
  'hamstrings', 'quads', 'quadriceps', 'lats', 'delts', 'shoulders',
  'gym session', 'lifting', 'lift', 'barbell', 'dumbbell', 'dumbbells',
  'plate', 'plates', 'reps', 'sets', 'sets x', 'sets of',
  'muscular', 'muscle',
  // Portuguese
  'agachamento', 'levantamento terra', 'supino', 'desenvolvimento',
  'musculação', 'musculacao', 'academia', 'série', 'serie', 'séries', 'series',
  'repetições', 'repeticoes', 'peso', 'carga', 'halter', 'haltere',
  'barra', 'peito', 'costas', 'perna', 'pernas', 'biceps', 'bíceps',
  'triceps', 'tríceps', 'glúteo', 'gluteos', 'posterior',
  'treino de força', 'treino de forca', 'hipertrofia', 'forca',
];

const RUNNING_KEYWORDS: readonly string[] = [
  // English — race distances
  '5k', '10k', 'half marathon', 'marathon', '5 km', '10 km',
  'half-marathon', 'hm', 'full marathon', 'ultramarathon', 'ultra',
  // English — running workouts. NOTE: we intentionally don't use bare
  // "intervals" / "interval" here — the word is too generic and also
  // applies to swim / cycle interval sets, which would cause ties on
  // phrases like "sweet spot intervals" (cycling). More specific
  // phrases like "cruise intervals" / "interval repeats" are fine.
  'easy run', 'long run', 'tempo run', 'tempo', 'track workout',
  'track session', 'speed work', 'fartlek', 'strides', 'vo2max run',
  'threshold run', 'cruise intervals', 'interval repeats',
  'repeats at', 'run repeats',
  'run', 'runs', 'running', 'jog', 'jogging',
  // English — running metrics
  'mileage', 'cadence', 'foot strike', 'spm',
  'pace', 'pacing', 'km pace', 'mile pace', 'min/km', 'min/mi',
  'zone 2 run', 'z2 run', 'lthr run',
  // Portuguese
  'corrida', 'corridas', 'correr', 'corrida longa', 'tiro',
  'intervalado', 'ritmo', 'meia maratona',
  'maratona', 'treino de corrida', 'pace de corrida',
];

const CYCLING_KEYWORDS: readonly string[] = [
  // English — core
  'bike', 'biking', 'cycle', 'cycling', 'bicycle', 'road bike',
  'ride', 'rides', 'riding', 'cyclist', 'roadie',
  // English — metrics and intensity
  'ftp', 'ftp test', 'watts', 'wattage', 'normalized power', 'np',
  'tss', 'ctl', 'atl', 'tsb', 'variability index', 'vi',
  'sweet spot', 'ss intervals', 'sweet-spot', 'threshold ride',
  'z2 ride', 'zone 2 ride', 'endurance ride',
  // English — equipment/terrain
  'gravel', 'gravel ride', 'road ride', 'crit', 'criterium',
  'time trial', 'tt bike', 'trainer', 'indoor cycling', 'indoor ride',
  'zwift', 'trainerroad', 'rouvy', 'sufferfest',
  'gran fondo', 'granfondo', 'climbing ride', 'hills',
  // English — bike parts (strong signals)
  'cassette', 'chainring', 'derailleur', 'saddle', 'cleats', 'bibs',
  // Portuguese
  'pedal', 'pedalada', 'pedaladas', 'pedalar', 'bicicleta',
  'ciclismo', 'rolo', 'estrada', 'ciclovia', 'ciclo',
];

const SWIM_KEYWORDS: readonly string[] = [
  // English — core
  'swim', 'swims', 'swimming', 'swimmer',
  // English — pool vocabulary
  'pool', 'laps', 'lanes', 'lane', 'meters', 'yards',
  '100m', '200m', '400m', '800m', '1500m',
  'flip turn', 'flip turns', 'push-off', 'streamline',
  // English — strokes. "fly" is omitted — it collides with common
  // English usage ("fly to the gym") even though it's a valid stroke.
  'freestyle', 'backstroke', 'breaststroke', 'butterfly',
  'stroke', 'strokes', 'catch', 'pull phase', 'kick',
  // English — drills and gear
  'catch-up drill', 'fingertip drag', '3/3/3 breathing', 'fist drill',
  'scull', 'pull buoy', 'paddles', 'fins', 'snorkel', 'kickboard',
  'tempo trainer', 'kickboard set',
  // English — training vocabulary
  'css', 'critical swim speed', 'threshold swim', 'interval swim',
  'aerobic swim', 'open water', 'ow swim', 'wetsuit', 'sighting',
  // Portuguese
  'natação', 'natacao', 'nadar', 'nado', 'piscina', 'braçada',
  'bracada', 'crawl', 'aberto',
];

// ─── Matcher ─────────────────────────────────────────────────────────

/**
 * Escape a keyword for use inside a RegExp. Handles the one or two
 * punctuation characters that might appear in our lists (slashes,
 * dashes) so `1/rm` or `3/3/3 breathing` match cleanly.
 */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Check whether `haystack` contains `keyword` as a WHOLE WORD (or a
 * multi-word phrase with its boundaries intact). We don't want "swim"
 * to match "swimming-pool-table" or "run" to match "running shoe store".
 */
function matchesWord(haystack: string, keyword: string): boolean {
  const escaped = escapeForRegex(keyword);
  // Use a lookahead/lookbehind for word boundary on the ends of the
  // keyword. Unicode-friendly so PT-BR accents don't break the match.
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu');
  return re.test(haystack);
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Classify a triathlon message into one of the 4 sports, or null.
 *
 * Returns { sport: null } when:
 *   - No sport keywords matched at all
 *   - Two or more sports tied for the highest match count
 *   - The caller should fall back to the generic triathlon prompt
 *
 * Examples:
 *   classifySport("5x5 squats at RPE 8")     → { sport: 'gym',     confidence: 1 }
 *   classifySport("run 10k at tempo pace")   → { sport: 'running', confidence: 0.9+ }
 *   classifySport("FTP test on the trainer") → { sport: 'cycling', confidence: 1 }
 *   classifySport("500m freestyle CSS set")  → { sport: 'swim',    confidence: 1 }
 *   classifySport("plan my week please")     → { sport: null,      confidence: 0 }
 */
export function classifySport(message: string): SportMatch {
  const lower = message.toLowerCase();

  const matched: Record<Sport, string[]> = {
    gym: [],
    running: [],
    cycling: [],
    swim: [],
  };

  for (const kw of GYM_KEYWORDS) if (matchesWord(lower, kw)) matched.gym.push(kw);
  for (const kw of RUNNING_KEYWORDS) if (matchesWord(lower, kw)) matched.running.push(kw);
  for (const kw of CYCLING_KEYWORDS) if (matchesWord(lower, kw)) matched.cycling.push(kw);
  for (const kw of SWIM_KEYWORDS) if (matchesWord(lower, kw)) matched.swim.push(kw);

  const scores: Record<Sport, number> = {
    gym: matched.gym.length,
    running: matched.running.length,
    cycling: matched.cycling.length,
    swim: matched.swim.length,
  };

  // Rank by score descending.
  const ranked = (Object.keys(scores) as Sport[])
    .map((sport) => ({ sport, count: scores[sport] }))
    .sort((a, b) => b.count - a.count);

  const winner = ranked[0];
  const runnerUp = ranked[1];

  // No matches at all → null
  if (winner.count === 0) {
    return { sport: null, confidence: 0, matched: [], scores };
  }

  // Tie at the top → null (safer than arbitrary pick)
  if (runnerUp.count === winner.count) {
    return { sport: null, confidence: 0, matched: [], scores };
  }

  // Clear winner. Compute confidence based on the gap ratio:
  //   - runner-up is 0  → 1.0   (the only sport matched)
  //   - winner >= 2x    → 0.9   (dominant lead)
  //   - winner > runner → 0.7   (soft lead)
  let confidence: number;
  if (runnerUp.count === 0) {
    confidence = 1.0;
  } else if (winner.count >= runnerUp.count * 2) {
    confidence = 0.9;
  } else {
    confidence = 0.7;
  }

  return {
    sport: winner.sport,
    confidence,
    matched: matched[winner.sport],
    scores,
  };
}

/**
 * Shortcut used by the prompt loader: returns the prompt file name
 * to load for a triathlon message, or `'triathlon'` (the generic
 * fallback) when classification is ambiguous.
 *
 * Naming convention matches the files on disk — the loader will try
 * `prompts/triathlon/${sport}.md` when a sport is returned.
 */
export function getTriathlonPromptNameForMessage(message: string): string {
  const result = classifySport(message);
  if (result.sport && result.confidence >= 0.7) {
    return `triathlon/${result.sport}`;
  }
  return 'triathlon';
}
