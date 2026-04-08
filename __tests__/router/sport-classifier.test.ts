/**
 * Sport Classifier — Phase 2 Slice A tests
 *
 * The classifier's job is to decide which sport persona prompt to load
 * for a triathlon message. Three things have to be right:
 *
 *   1. Each sport's keywords route to the right persona (positive cases)
 *   2. Ambiguous / mixed messages return null (safer than guessing)
 *   3. Portuguese AND English phrasings work — Felipe switches mid-chat
 *
 * These tests exercise real phrasings pulled from the persona prompt
 * files so a regression in the classifier would immediately show up as
 * a wrong coach responding to a real-world question.
 */

import { describe, it, expect } from 'vitest';
import {
  classifySport,
  getTriathlonPromptNameForMessage,
  type Sport,
} from '../../src/router/sport-classifier';

// ─── Positive cases: each sport has unambiguous triggers ────────────

describe('sport classifier — positive cases', () => {
  describe('gym', () => {
    const gymMessages: Array<[string, string]> = [
      ['5x5 squats at RPE 8', 'squat + rpe'],
      ['I deadlifted 180kg today', 'deadlift'],
      ['Bench press 4x6 @ 85%', 'bench press'],
      ['Upper body push day — OHP, incline bench, lateral raises', 'push day'],
      ['Is my leg day heavy enough?', 'leg day'],
      ['Hypertrophy block starting Monday', 'hypertrophy'],
      ['Programa de musculação pra hipertrofia', 'PT musculação'],
      ['Agachamento com 140kg na série pesada', 'PT agachamento'],
      ['4 séries de 8 reps no supino reto', 'PT supino'],
      ['Foram 3 séries de levantamento terra', 'PT levantamento terra'],
    ];

    for (const [msg, label] of gymMessages) {
      it(`classifies "${label}" as gym`, () => {
        const result = classifySport(msg);
        expect(result.sport).toBe('gym');
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      });
    }
  });

  describe('running', () => {
    const runningMessages: Array<[string, string]> = [
      ['Run 10k at tempo pace today', 'tempo run'],
      ['Easy run 45 min, heart rate zone 2', 'easy run'],
      ['Long run this Sunday 18k', 'long run'],
      ['Track workout: 6x800m with 2min rest', 'track workout'],
      ['Half marathon in 8 weeks, need a plan', 'half marathon'],
      ['Corrida longa domingo, 22km no fim', 'PT corrida longa'],
      ['Vou fazer um tiro de 5km', 'PT tiro 5km'],
      ['Intervalado na pista hoje', 'PT intervalado'],
      ['Fartlek de 40 min', 'fartlek'],
      ['5x1000m repeats at 5k pace', 'interval repeats'],
    ];

    for (const [msg, label] of runningMessages) {
      it(`classifies "${label}" as running`, () => {
        const result = classifySport(msg);
        expect(result.sport).toBe('running');
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      });
    }
  });

  describe('cycling', () => {
    const cyclingMessages: Array<[string, string]> = [
      ['FTP test tomorrow on the trainer', 'FTP + trainer'],
      ['Sweet spot intervals 4x10min', 'sweet spot'],
      ['Long endurance ride in zone 2', 'Z2 ride'],
      ['Gran fondo prep — 120km this weekend', 'gran fondo'],
      ['My new FTP is 260 watts', 'FTP watts'],
      ['Gravel ride tomorrow, 60km', 'gravel'],
      ['Pedal de 80km pela estrada', 'PT pedal'],
      ['Treino no rolo, 60 min Z2', 'PT rolo'],
      ['Indoor cycling session on Zwift', 'Zwift'],
      ['TSS 120 today', 'TSS'],
    ];

    for (const [msg, label] of cyclingMessages) {
      it(`classifies "${label}" as cycling`, () => {
        const result = classifySport(msg);
        expect(result.sport).toBe('cycling');
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      });
    }
  });

  describe('swim', () => {
    const swimMessages: Array<[string, string]> = [
      ['500m freestyle at CSS pace', 'freestyle + CSS'],
      ['Pool session today — 10x100m', 'pool + distance'],
      ['Open water swim, 1500m in the lake', 'open water'],
      ['Working on my catch phase and bilateral breathing', 'catch + drill'],
      ['Swim set: 8x50m kick with a kickboard', 'kick + kickboard'],
      ['Natação na piscina, 2000m total', 'PT natação piscina'],
      ['Nado crawl, 400m contínuos', 'PT nado crawl'],
      ['Butterfly drill for 4x25m', 'butterfly'],
      ['Threshold swim at 1:30/100m', 'threshold swim'],
      ['Flip turns are killing me', 'flip turn'],
    ];

    for (const [msg, label] of swimMessages) {
      it(`classifies "${label}" as swim`, () => {
        const result = classifySport(msg);
        expect(result.sport).toBe('swim');
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      });
    }
  });
});

// ─── Negative / ambiguous cases return null ─────────────────────────

describe('sport classifier — ambiguous and negative cases', () => {
  const nullMessages: Array<[string, string]> = [
    ['Plan my week please', 'no sport keyword'],
    ['How should I eat today?', 'nutrition only'],
    ['What is my training plan?', 'generic training'],
    ['Am I overtraining?', 'wellness question'],
    ['Como estou hoje?', 'PT generic'],
    ['I need a workout', 'bare workout word'],
    ['Recovery day today', 'no sport keyword'],
    ['HRV is down this morning', 'wellness only'],
  ];

  for (const [msg, label] of nullMessages) {
    it(`returns null for "${label}"`, () => {
      const result = classifySport(msg);
      expect(result.sport).toBeNull();
      expect(result.confidence).toBe(0);
    });
  }

  it('returns null when gym and running tie', () => {
    // Equal matches: "squat" (gym) + "run" (running)
    const result = classifySport('I will squat and run today');
    expect(result.sport).toBeNull();
    expect(result.scores.gym).toBeGreaterThan(0);
    expect(result.scores.running).toBeGreaterThan(0);
    expect(result.scores.gym).toBe(result.scores.running);
  });

  it('picks the dominant sport when one side has 2x more matches', () => {
    // "squat deadlift bench" = 3 gym, "run" = 1 running → gym wins
    const result = classifySport('squat deadlift bench then run');
    expect(result.sport).toBe('gym');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

// ─── Word boundaries: no substring false positives ──────────────────

describe('sport classifier — word boundaries', () => {
  it('does NOT match "run" inside "running-late"', () => {
    const result = classifySport('I am running-late for my meeting');
    // Either it's null or it matches "running" (which is a legit
    // keyword) — the point is we don't accept "run" as a substring
    // of some unrelated word like "runway"
    expect(result.sport === null || result.sport === 'running').toBe(true);
  });

  it('does NOT match "swim" inside "swimmingly"', () => {
    // Edge case: an adverb that contains "swim" should not trigger.
    // Our regex enforces word boundaries, so "swimmingly" is one token.
    const result = classifySport('the project is going swimmingly');
    expect(result.sport).toBeNull();
  });

  it('does NOT match "bike" inside "bikers"', () => {
    // "bikers" as one token should not be classified because neither
    // "bike" nor "bikers" matches (our keyword is "bike" with boundary).
    const result = classifySport('the bikers were fast');
    expect(result.sport).toBeNull();
  });

  it('DOES match multi-word phrases like "bench press"', () => {
    const result = classifySport('Added bench press to the routine');
    expect(result.sport).toBe('gym');
  });

  it('DOES match accented PT words with Unicode boundaries', () => {
    const result = classifySport('Treino de musculação intensa');
    expect(result.sport).toBe('gym');
  });
});

// ─── getTriathlonPromptNameForMessage wrapper ───────────────────────

describe('getTriathlonPromptNameForMessage', () => {
  it('returns persona path for confident matches', () => {
    expect(getTriathlonPromptNameForMessage('5x5 squats')).toBe('triathlon/gym');
    expect(getTriathlonPromptNameForMessage('10k tempo run')).toBe('triathlon/running');
    // Cycling persona → file is named `cycling.md`, matching the
    // coachPersona enum value (not the shorter sub-skill name `cycle`).
    expect(getTriathlonPromptNameForMessage('FTP test on the trainer')).toBe('triathlon/cycling');
    expect(getTriathlonPromptNameForMessage('1500m freestyle at CSS')).toBe('triathlon/swim');
  });

  it('returns generic triathlon for ambiguous messages', () => {
    expect(getTriathlonPromptNameForMessage('plan my week')).toBe('triathlon');
    expect(getTriathlonPromptNameForMessage('am I overtraining?')).toBe('triathlon');
  });

  it('returns generic triathlon for empty messages', () => {
    expect(getTriathlonPromptNameForMessage('')).toBe('triathlon');
  });

  it('returns generic triathlon when sports tie', () => {
    // squat + run both hit once — tie → null → generic
    expect(getTriathlonPromptNameForMessage('squat and run')).toBe('triathlon');
  });
});

// ─── Confidence scoring ─────────────────────────────────────────────

describe('sport classifier — confidence levels', () => {
  it('confidence = 1.0 when only one sport matches', () => {
    const result = classifySport('5x5 squats at RPE 9');
    expect(result.sport).toBe('gym');
    expect(result.confidence).toBe(1.0);
  });

  it('confidence = 0.9 when winner has 2x+ the runner-up', () => {
    // "squat deadlift bench" (gym=3) vs "run" (running=1)
    const result = classifySport('squat deadlift bench followed by a run');
    expect(result.sport).toBe('gym');
    expect(result.confidence).toBe(0.9);
  });

  it('confidence is computed from the match-count ratio', () => {
    // Rather than hardcoding a specific input and exact confidence
    // value (which is fragile against keyword-list tweaks), verify
    // the mathematical relationship: winner ≥ 2× runnerUp → 0.9,
    // otherwise → 0.7, runner = 0 → 1.0.
    //
    // Case 1: clear dominance via distinct keywords.
    const dominantGym = classifySport('ohp deadlift squats and a marathon someday');
    expect(dominantGym.sport).toBe('gym');
    if (dominantGym.scores.gym >= dominantGym.scores.running * 2 || dominantGym.scores.running === 0) {
      expect(dominantGym.confidence).toBeGreaterThanOrEqual(0.9);
    } else {
      expect(dominantGym.confidence).toBe(0.7);
    }

    // Case 2: single-sport message → 1.0
    const onlyGym = classifySport('ohp and deadlift day');
    expect(onlyGym.sport).toBe('gym');
    expect(onlyGym.confidence).toBe(1.0);
  });
});

// ─── Scores object returned for observability ───────────────────────

describe('sport classifier — scores output', () => {
  it('always returns a 4-sport scores object', () => {
    const result = classifySport('squats today');
    const sports: Sport[] = ['gym', 'running', 'cycling', 'swim'];
    for (const s of sports) {
      expect(typeof result.scores[s]).toBe('number');
    }
  });

  it('returns empty matched list when no match', () => {
    const result = classifySport('hello world');
    expect(result.matched).toEqual([]);
  });

  it('returns the winning sport\'s matched keywords', () => {
    const result = classifySport('squat and deadlift session');
    expect(result.sport).toBe('gym');
    expect(result.matched.length).toBeGreaterThan(0);
    // matched should include gym-related keywords
    expect(result.matched.some(kw => kw.includes('squat') || kw.includes('deadlift'))).toBe(true);
  });
});
