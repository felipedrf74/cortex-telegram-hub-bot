/**
 * Tests for training-plans sub-skill in skill-config.ts
 *
 * Verifies the triathlon skill definition includes training-plans
 * sub-skill with all expected tool mappings and cron jobs.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SKILLS, getSkillDefinition, getCronJobOwner } from '../../src/skills/skill-config';

describe('Training Plans Sub-Skill Config', () => {
  it('triathlon skill includes training-plans sub-skill', () => {
    const triathlon = getSkillDefinition('triathlon');
    const trainingPlans = triathlon.subSkills.find(s => s.name === 'training-plans');
    expect(trainingPlans).toBeDefined();
    expect(trainingPlans!.enabledByDefault).toBe(true);
  });

  it('training-plans sub-skill contains all training tools', () => {
    const triathlon = getSkillDefinition('triathlon');
    const tp = triathlon.subSkills.find(s => s.name === 'training-plans')!;
    expect(tp.tools).toContain('create_training_plan');
    expect(tp.tools).toContain('add_training_week');
    expect(tp.tools).toContain('add_training_session');
    expect(tp.tools).toContain('get_training_plan');
    expect(tp.tools).toContain('log_training_completion');
    expect(tp.tools).toContain('update_training_session');
    expect(tp.tools).toContain('link_session_calendar');
    expect(tp.tools).toHaveLength(7);
  });

  it('training_plan_adjust cron job is mapped to triathlon/training-plans', () => {
    const owner = getCronJobOwner('training_plan_adjust');
    expect(owner).not.toBeNull();
    expect(owner!.domain).toBe('triathlon');
    expect(owner!.subSkill).toBe('training-plans');
  });

  it('triathlon skill version is 2.0.0 after training plans addition', () => {
    const triathlon = DEFAULT_SKILLS['triathlon'];
    expect(triathlon.version).toBe('2.0.0');
  });

  it('triathlon skill still has calendar, reminders, notes, shared-memory sub-skills', () => {
    const triathlon = getSkillDefinition('triathlon');
    const names = triathlon.subSkills.map(s => s.name);
    expect(names).toContain('training-plans');
    expect(names).toContain('calendar');
    expect(names).toContain('reminders');
    expect(names).toContain('notes');
    expect(names).toContain('shared-memory');
    expect(names).toHaveLength(5);
  });
});
