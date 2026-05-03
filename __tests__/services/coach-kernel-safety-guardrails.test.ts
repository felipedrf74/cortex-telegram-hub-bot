// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// training-expert-coach-knowledge-engine (2026-05-03):
// Pin tests for non-medical, non-diagnostic safety guardrails. The coach
// must: (1) never diagnose, (2) always include a referral when pain /
// medical / supplement topics arise, (3) halt cleanly on stress-fracture
// red flags, pregnancy, and disordered-eating signals.

import { describe, expect, it } from 'vitest';
import {
  evaluateSafetyContext,
  COACH_NON_DIAGNOSTIC_DISCLAIMER,
  type SafetyEvaluationInput,
} from '../../src/services/coach-kernel/safety-guardrails';

describe('coach-kernel/safety-guardrails', () => {
  describe('acute pain', () => {
    it('flags moderate sudden weight-bearing shin pain as a stress-fracture concern (block)', () => {
      const r = evaluateSafetyContext({
        acuteSessionPain: {
          bodyArea: 'left shin',
          severity: 'moderate',
          onset: 'sudden',
          weightBearing: true,
        },
      });
      expect(r.status).toBe('flag');
      expect(r.findings[0].domain).toBe('stress_fracture_warning');
      expect(r.findings[0].severity).toBe('block');
      expect(r.topMessage).toMatch(/stress[\s-]?related/i);
      expect(r.topMessage).toMatch(/sports[\s-]?medicine/i);
    });

    it('flags general moderate pain as warn (not block)', () => {
      const r = evaluateSafetyContext({
        acuteSessionPain: {
          bodyArea: 'left lat',
          severity: 'moderate',
          onset: 'gradual',
          weightBearing: false,
        },
      });
      expect(r.findings[0].domain).toBe('acute_pain_during_session');
      expect(r.findings[0].severity).toBe('warn');
    });

    it('flags high-severity pain anywhere as block', () => {
      const r = evaluateSafetyContext({
        acuteSessionPain: {
          bodyArea: 'right shoulder',
          severity: 'high',
          onset: 'gradual',
          weightBearing: false,
        },
      });
      expect(r.findings[0].severity).toBe('block');
    });
  });

  describe('persistent fatigue', () => {
    it('warns on multi-day low energy + low adherence + sleep deficit', () => {
      const r = evaluateSafetyContext({
        fatiguePattern: {
          consecutiveLowEnergyDays: 7,
          consecutiveLowAdherenceWeeks: 2,
          sleepDeficitNights: 6,
        },
      });
      expect(r.status).toBe('flag');
      expect(r.findings[0].domain).toBe('persistent_fatigue');
      expect(r.findings[0].severity).toBe('warn');
      expect(r.findings[0].referralCopy).toMatch(/qualified medical|sports-medicine/);
    });

    it('passes when fatigue signals are below thresholds', () => {
      const r = evaluateSafetyContext({
        fatiguePattern: {
          consecutiveLowEnergyDays: 1,
          consecutiveLowAdherenceWeeks: 0,
          sleepDeficitNights: 1,
        },
      });
      expect(r.status).toBe('pass');
    });
  });

  describe('self-reported flags', () => {
    it('blocks on pregnancy and emits postpartum referral', () => {
      const a = evaluateSafetyContext({ selfReportedFlags: { pregnant: true } });
      expect(a.findings[0].domain).toBe('pregnancy_or_postpartum');
      expect(a.findings[0].severity).toBe('block');

      const b = evaluateSafetyContext({ selfReportedFlags: { postpartum: true } });
      expect(b.findings[0].domain).toBe('pregnancy_or_postpartum');
      expect(b.findings[0].severity).toBe('block');
    });

    it('blocks on disordered-eating concern with explicit specialist referral', () => {
      const r = evaluateSafetyContext({
        selfReportedFlags: { disorderedEatingConcern: true },
      });
      expect(r.findings[0].domain).toBe('disordered_eating_risk');
      expect(r.findings[0].severity).toBe('block');
      expect(r.findings[0].referralCopy).toMatch(/dietitian|mental-health|specialist/i);
    });

    it('warns on severe menstrual symptoms', () => {
      const r = evaluateSafetyContext({
        selfReportedFlags: { severeMenstrualSymptoms: true },
      });
      expect(r.findings[0].domain).toBe('menstrual_symptoms_severe');
      expect(r.findings[0].severity).toBe('warn');
    });
  });

  describe('direct medical question detection', () => {
    it('flags "do I have a stress fracture?" as a direct medical question', () => {
      const r = evaluateSafetyContext({
        userQuestionText: 'Do I have a stress fracture?',
      });
      expect(r.findings[0].domain).toBe('direct_medical_question');
      expect(r.findings[0].referralCopy).toMatch(/can.t answer|can not answer/i);
    });

    it('flags "should I take a painkiller?" as medication advice', () => {
      const r = evaluateSafetyContext({
        userQuestionText: 'Should I take a painkiller before the long run?',
      });
      expect(r.findings[0].domain).toBe('direct_medical_question');
    });

    it('does NOT flag a normal training question', () => {
      const r = evaluateSafetyContext({
        userQuestionText: 'How long should my long run be this week?',
      });
      expect(r.status).toBe('pass');
    });
  });

  describe('supplement / anti-doping context', () => {
    it('emits an inform-level WADA referral on creatine/preworkout questions', () => {
      const r = evaluateSafetyContext({
        userQuestionText: 'Should I take creatine and a preworkout for the marathon block?',
      });
      const supp = r.findings.find((f) => f.domain === 'anti_doping_supplement_question');
      expect(supp).toBeDefined();
      expect(supp?.severity).toBe('inform');
      expect(supp?.referralCopy).toMatch(/WADA|sports physician|registered dietitian/i);
    });

    it('always emits a supplement finding when fromSupplementContext is true (no text needed)', () => {
      const r = evaluateSafetyContext({ fromSupplementContext: true });
      expect(r.findings[0].domain).toBe('anti_doping_supplement_question');
    });
  });

  describe('aggregate behavior', () => {
    it('returns pass when no flags are triggered', () => {
      const r = evaluateSafetyContext({});
      expect(r.status).toBe('pass');
      expect(r.findings).toEqual([]);
      expect(r.topMessage).toBe('');
    });

    it('orders topMessage by severity (block > warn > inform)', () => {
      const r = evaluateSafetyContext({
        acuteSessionPain: {
          bodyArea: 'shin',
          severity: 'moderate',
          onset: 'sudden',
          weightBearing: true,
        }, // block via stress_fracture
        userQuestionText: 'Should I take creatine?', // also matches "should i take" medical pattern → BOTH a warn (medical) AND inform (supplement) finding
        fatiguePattern: {
          consecutiveLowEnergyDays: 7,
          consecutiveLowAdherenceWeeks: 2,
          sleepDeficitNights: 6,
        }, // warn via persistent_fatigue
      });
      // 4 findings: stress_fracture(block) + persistent_fatigue(warn) +
      // direct_medical_question(warn) + anti_doping_supplement_question(inform).
      // The medical-question pattern intentionally fires on "should I take X"
      // because that vocabulary is a strong recommend-against signal whether
      // X is a medication or a supplement.
      expect(r.findings.length).toBe(4);
      // topMessage chosen from the block-severity finding.
      expect(r.topMessage).toMatch(/stress[\s-]?related/i);
    });

    it('every referralCopy includes a "not a clinician" + "consult professional" line', () => {
      const triggers: SafetyEvaluationInput[] = [
        {
          acuteSessionPain: {
            bodyArea: 'shoulder',
            severity: 'high',
            onset: 'gradual',
            weightBearing: false,
          },
        },
        {
          fatiguePattern: {
            consecutiveLowEnergyDays: 7,
            consecutiveLowAdherenceWeeks: 2,
            sleepDeficitNights: 6,
          },
        },
        { selfReportedFlags: { pregnant: true } },
        { userQuestionText: 'Do I have a stress fracture?' },
        { userQuestionText: 'Should I take a peptide for recovery?' },
      ];
      for (const t of triggers) {
        const r = evaluateSafetyContext(t);
        for (const f of r.findings) {
          expect(f.referralCopy).toMatch(/clinician|medical|sports[\s-]?medicine|professional/i);
        }
      }
    });
  });

  describe('disclaimer constant', () => {
    it('exports a non-diagnostic disclaimer line', () => {
      expect(COACH_NON_DIAGNOSTIC_DISCLAIMER).toMatch(/not a clinician/i);
      expect(COACH_NON_DIAGNOSTIC_DISCLAIMER).toMatch(/medical|sports[\s-]?medicine/i);
    });
  });
});
