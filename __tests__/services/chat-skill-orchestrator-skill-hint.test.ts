/**
 * M15 — orchestrator consumption of the classifier's manifest skill hint.
 *
 * The hint is ADDITIVE ownership metadata: absent → byte-identical decisions
 * (pre-M15 behavior); present → the mapped skill joins involvedSkills and a
 * reason code records the hint. Unmapped platform skills (connections,
 * notifications, decision_center) are ignored by design — the orchestrator
 * reasons in NexusSkillId space, which has no counterpart for them.
 */

import { describe, it, expect } from 'vitest';
import { analyzeChatSkillOrchestration } from '../../src/services/chat-skill-orchestrator';

describe('analyzeChatSkillOrchestration — M15 classifier skill hint', () => {
  it('is byte-identical when the hint is absent vs explicitly null/undefined', () => {
    const message = 'Can you help me plan things for later?';
    const base = analyzeChatSkillOrchestration({ message });
    const withNull = analyzeChatSkillOrchestration({ message, classifierSkillHint: null });
    const withUndefined = analyzeChatSkillOrchestration({ message, classifierSkillHint: undefined });
    expect(withNull).toEqual(base);
    expect(withUndefined).toEqual(base);
  });

  it('adds the mapped orchestrator skill to involvedSkills with a reason code', () => {
    const message = 'Can you sort that thing from before?'; // no skill vocabulary on purpose
    const base = analyzeChatSkillOrchestration({ message });
    expect(base.involvedSkills).not.toContain('finance');
    expect(base.reasonCodes).not.toContain('classifier_skill_ownership_hint');

    const hinted = analyzeChatSkillOrchestration({ message, classifierSkillHint: 'finance' });
    expect(hinted.involvedSkills).toContain('finance');
    expect(hinted.reasonCodes).toContain('classifier_skill_ownership_hint');
  });

  it('maps secretary-family action skills (tasks, mail, calendar, reminders) to the secretary skill', () => {
    for (const hint of ['tasks', 'mail', 'secretary_calendar', 'secretary_reminders']) {
      const decision = analyzeChatSkillOrchestration({
        message: 'Can you sort that thing from before?',
        classifierSkillHint: hint,
      });
      expect(decision.involvedSkills, hint).toContain('secretary');
      expect(decision.reasonCodes, hint).toContain('classifier_skill_ownership_hint');
    }
  });

  it('does not duplicate a skill that pattern evidence already involved', () => {
    const message = 'update my training plan for tomorrow';
    const decision = analyzeChatSkillOrchestration({ message, classifierSkillHint: 'training' });
    expect(decision.involvedSkills.filter((skill) => skill === 'training')).toHaveLength(1);
  });

  it('ignores unmapped platform skills (connections, notifications, decision_center) and unknown values', () => {
    const message = 'Can you sort that thing from before?';
    const base = analyzeChatSkillOrchestration({ message });
    for (const hint of ['connections', 'notifications', 'decision_center', 'not_a_skill']) {
      const decision = analyzeChatSkillOrchestration({ message, classifierSkillHint: hint });
      expect(decision, hint).toEqual(base);
    }
  });
});
