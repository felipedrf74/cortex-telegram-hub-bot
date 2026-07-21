/**
 * Focused registry pins for chat-skill-capability-registry text inference,
 * including a LABELED characterization pin for the known plural-'tasks' gap
 * so the owning milestone has a marked test to flip.
 */

import { describe, expect, it } from 'vitest';

import { resolveChatSkillCapability } from '../../src/services/chat-skill-capability-registry';

describe('resolveChatSkillCapability text inference', () => {
  it('infers the tasks skill from singular task nouns', () => {
    expect(resolveChatSkillCapability({ message: 'complete my task' }).ownerSkill).toBe('tasks');
    expect(resolveChatSkillCapability({ message: 'add a todo' }).ownerSkill).toBe('tasks');
    // Portuguese plural IS covered by the pattern.
    expect(resolveChatSkillCapability({ message: 'conclui as tarefas' }).ownerSkill).toBe('tasks');
  });

  it("CURRENT LIMITATION (pre-existing bug, owner M15): inferSkillFromText misses plural English 'tasks'", () => {
    // The word list contains 'task' and the Portuguese plural 'tarefas' but
    // not the English plural 'tasks', so a plural-English turn falls through
    // to the 'chat' owner skill. This pin documents today's behavior; M15
    // (full-skill classification via manifest-generated prompt) owns flipping
    // it to 'tasks'.
    expect(resolveChatSkillCapability({ message: 'complete my tasks' }).ownerSkill).toBe('chat');
    expect(resolveChatSkillCapability({ message: 'show me all my tasks' }).ownerSkill).toBe('chat');
  });
});
