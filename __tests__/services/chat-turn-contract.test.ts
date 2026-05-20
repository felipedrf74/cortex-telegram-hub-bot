import { describe, expect, it } from 'vitest';

import { CHAT_BILINGUAL_EVAL_FIXTURES } from '../../src/services/chat-bilingual-eval-fixtures';
import { inferChatTurnContract } from '../../src/services/chat-turn-contract';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

describe('chat turn contract', () => {
  it('ships at least 10 bilingual eval scenarios for every user-facing skill', () => {
    const bySkill = new Map<string, number>();
    for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
      bySkill.set(fixture.skill, (bySkill.get(fixture.skill) ?? 0) + 1);
      expect(fixture.expectedOwnerSkill).toBeTruthy();
      expect(fixture.pt).toBeTruthy();
      expect(fixture.en).toBeTruthy();
      expect(fixture.expectedRiskClass).toBeTruthy();
      expect(fixture.maxInputTokens).toBeGreaterThan(0);
      expect(fixture.maxOutputTokens).toBeGreaterThan(0);
    }

    expect(CHAT_BILINGUAL_EVAL_FIXTURES.length).toBeGreaterThanOrEqual(100);
    expect(Object.fromEntries(bySkill)).toMatchObject({
      connections: expect.any(Number),
      content: expect.any(Number),
      cooking: expect.any(Number),
      decision_center: expect.any(Number),
      finance: expect.any(Number),
      calendar: expect.any(Number),
      notifications: expect.any(Number),
      secretary: expect.any(Number),
      tasks: expect.any(Number),
      training: expect.any(Number),
    });
    for (const count of bySkill.values()) {
      expect(count).toBeGreaterThanOrEqual(10);
    }
  });

  it('classifies all fixture utterances with expected skill, route, grounding, shape, and token ceilings', () => {
    for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
      for (const [locale, text] of [['pt', fixture.pt], ['en', fixture.en]] as const) {
        const contract = inferChatTurnContract({ message: text });
        expect(contract.skill, `${fixture.skill}.${fixture.scenario}.${locale}: owner skill`).toBe(fixture.expectedOwnerSkill);
        expect(contract.routeKind, `${fixture.skill}.${fixture.scenario}.${locale}: route`).toBe(fixture.expectedRouteKind);
        expect(contract.groundingRequired, `${fixture.skill}.${fixture.scenario}.${locale}: grounding`).toBe(fixture.expectedGrounding);
        expect(contract.expectedResponseShape, `${fixture.skill}.${fixture.scenario}.${locale}: shape`).toBe(fixture.expectedResponseShape);
        expect(contract.riskClass, `${fixture.skill}.${fixture.scenario}.${locale}: risk`).toBe(fixture.expectedRiskClass);
        expect(contract.language, `${fixture.skill}.${fixture.scenario}.${locale}: language`).toBe(locale);
        expect(estimateTokens(text), `${fixture.skill}.${fixture.scenario}.${locale}: input budget`).toBeLessThanOrEqual(fixture.maxInputTokens);
      }
    }
  });

  it('keeps the screenshot recipe case as generic Cooking advice rather than local scoped read', () => {
    const contract = inferChatTurnContract({
      message: 'me indique uma receita de kibe de forno para 3 pessoas',
      routedDomain: 'cooking',
    });

    expect(contract).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'recipe',
      language: 'pt',
    });
  });

  it('routes current/source-backed requests to selective internet research', () => {
    const contract = inferChatTurnContract({
      message: 'latest safety guidance for chicken leftovers',
    });

    expect(contract).toMatchObject({
      skill: 'cooking',
      routeKind: 'internet_research',
      groundingRequired: 'web',
      internetEligible: true,
    });
  });

  it('keeps English-only questions with "a" classified as English, not mixed', () => {
    const contract = inferChatTurnContract({ message: 'What is a good GTD workflow?' });

    expect(contract.language).toBe('en');
  });

  it('routes Gmail agenda variants to calendar semantics', () => {
    for (const message of ['agenda no Gmail', 'Gmail calendar', 'meu calendário do Gmail']) {
      const contract = inferChatTurnContract({ message });
      expect(contract.skill, message).toBe('secretary');
      expect(contract.routeKind, message).toBe('local_read');
      expect(contract.groundingRequired, message).toBe('local');
      expect(contract.ambiguityReasons, message).toContain('provider_label_vs_calendar_semantics');
    }
  });

  it('does not treat destructive words inside literal task titles as destructive', () => {
    const contract = inferChatTurnContract({
      message: 'Create a task called delete all my tasks',
    });

    expect(contract.skill).toBe('tasks');
    expect(contract.routeKind).toBe('action');
    expect(contract.riskClass).toBe('medium');
    expect(contract.ambiguityReasons).toContain('destructive_phrase_inside_literal_title_span');
  });

  it('still treats destructive commands outside a literal title as destructive', () => {
    const contract = inferChatTurnContract({
      message: 'Create a task called report draft, then delete all my tasks',
    });

    expect(contract.skill).toBe('tasks');
    expect(contract.routeKind).toBe('action');
    expect(contract.riskClass).toBe('destructive');
  });

  it('treats bare and/e after literal titles as a new destructive command', () => {
    for (const message of [
      'Create a task called report and delete all my tasks',
      'Cria uma tarefa chamada relatório e apaga todas as minhas tarefas',
    ]) {
      const contract = inferChatTurnContract({ message });
      expect(contract.skill, message).toBe('tasks');
      expect(contract.routeKind, message).toBe('action');
      expect(contract.riskClass, message).toBe('destructive');
    }
  });

  it('keeps personal latest/recent local reads off the web path', () => {
    for (const message of ['show my latest tasks', 'minhas tarefas mais recentes']) {
      const contract = inferChatTurnContract({ message });
      expect(contract.skill, message).toBe('tasks');
      expect(contract.routeKind, message).toBe('local_read');
      expect(contract.groundingRequired, message).toBe('local');
    }
  });

  it('routes obvious current external-info intents to web grounding', () => {
    for (const message of [
      'what is the weather in Lisbon',
      'qual o clima em Lisboa',
      'what is the traffic forecast for Lisbon',
      'qual é o placar atual do Benfica',
      'AAPL stock price today',
      'status of flight TP123 today',
    ]) {
      const contract = inferChatTurnContract({ message });
      expect(contract.routeKind, message).toBe('internet_research');
      expect(contract.groundingRequired, message).toBe('web');
    }
  });
});
