/**
 * Tests for training-plans sub-skill in skill-config.ts
 *
 * Verifies the triathlon skill definition includes training-plans
 * sub-skill with all expected tool mappings and cron jobs.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SKILLS,
  buildTrainingPlansSubSkillDefinition,
  getSkillDefinition,
  getCronJobOwner,
} from '../../src/skills/skill-config';

describe('Training Plans Sub-Skill Config', () => {
  it('triathlon skill includes training-plans sub-skill', () => {
    const triathlon = getSkillDefinition('triathlon');
    const trainingPlans = triathlon.subSkills.find(s => s.name === 'training-plans');
    expect(trainingPlans).toBeDefined();
    expect(trainingPlans!.enabledByDefault).toBe(true);
  });

  it('training-plans sub-skill exposes reviewed actions but no raw projection writers', () => {
    const triathlon = getSkillDefinition('triathlon');
    const tp = triathlon.subSkills.find(s => s.name === 'training-plans')!;
    const runtimeContract = buildTrainingPlansSubSkillDefinition();
    expect(runtimeContract).toEqual({
      name: 'training-plans',
      description: 'Reviewed Training plan handoff, readback, completion, and calendar linkage used by all sport sub-skills',
      enabledByDefault: true,
      requiredTier: 'pro',
      tools: [
        'create_training_plan',
        'get_training_plan',
        'log_training_completion',
        'link_session_calendar',
      ],
      cronJobs: ['training_plan_adjust'],
    });
    expect(tp).toEqual(runtimeContract);
    // F13 supersedes the old CRUD exposure: these tools bypassed candidate
    // construction, lint, volume enforcement, and activation review.
    expect(tp.tools).not.toContain('add_training_week');
    expect(tp.tools).not.toContain('add_training_session');
    expect(tp.tools).not.toContain('update_training_session');
    expect(tp.tools).toHaveLength(4);
  });

  it('training_plan_adjust cron job is mapped to triathlon/training-plans', () => {
    const owner = getCronJobOwner('training_plan_adjust');
    expect(owner).not.toBeNull();
    expect(owner!.domain).toBe('triathlon');
    expect(owner!.subSkill).toBe('training-plans');
  });

  it('triathlon skill is at version 3.0.0 after Phase 1 sport sub-skill split', () => {
    const triathlon = DEFAULT_SKILLS['triathlon'];
    expect(triathlon.version).toBe('3.0.0');
  });

  it('triathlon has 4 sport sub-skills (gym/running/cycle/swim) + capability sub-skills', () => {
    const triathlon = getSkillDefinition('triathlon');
    const names = triathlon.subSkills.map(s => s.name);
    // Sport sub-skills — persona shells with per-sport prompts
    expect(names).toContain('gym');
    expect(names).toContain('running');
    expect(names).toContain('cycle');
    expect(names).toContain('swim');
    // Shared capability sub-skills
    expect(names).toContain('training-plans');
    expect(names).toContain('calendar');
    expect(names).toContain('reminders');
    expect(names).toContain('notes');
    expect(names).toContain('shared-memory');
    expect(names).toContain('recovery');
    expect(names).toHaveLength(10);
  });

  it('sport sub-skills declare coach personas + prompt files', () => {
    const triathlon = getSkillDefinition('triathlon');
    // The sub-skill name and prompt filename can differ — Phase 2
    // Slice A renamed the cycle prompt to `cycling.md` so it matches
    // the sport classifier's `cycling` enum value. Map each sub-skill
    // name to the expected prompt filename stem explicitly.
    const sportSkills: Record<'gym' | 'running' | 'cycle' | 'swim', string> = {
      gym: 'gym',
      running: 'running',
      cycle: 'cycling',
      swim: 'swim',
    };
    for (const name of Object.keys(sportSkills) as Array<keyof typeof sportSkills>) {
      const sub = triathlon.subSkills.find(s => s.name === name)!;
      expect(sub, `sport sub-skill ${name} exists`).toBeDefined();
      expect(sub.coachPersona, `${name} has a coach persona`).toBeDefined();
      expect(sub.promptFile, `${name} has a prompt file`).toBe(`triathlon/${sportSkills[name]}.md`);
      // Sport sub-skills are persona shells — they own no tools themselves,
      // they depend on training-plans + calendar + shared-memory
      expect(sub.tools).toHaveLength(0);
      expect(sub.dependencies).toContain('training-plans');
      expect(sub.dependencies).toContain('calendar');
    }
  });
});
