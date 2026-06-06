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
      message: 'me indique uma receita de legumes assados para 3 pessoas',
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

  it('keeps generic cooking idea questions as direct answers, not forced recipe structures', () => {
    const english = inferChatTurnContract({
      message: 'What should I cook for dinner?',
      routedDomain: 'cooking',
    });
    const portuguese = inferChatTurnContract({
      message: 'O que devo cozinhar para jantar?',
      routedDomain: 'cooking',
    });
    const portugueseRecipeIdea = inferChatTurnContract({
      message: 'Me dê uma ideia simples de receita para duas pessoas',
      routedDomain: 'cooking',
    });
    const spanishRecipeIdea = inferChatTurnContract({
      message: 'Dame una idea simple de receta para dos personas',
      routedDomain: 'cooking',
    });
    const mixedRecipeIdea = inferChatTurnContract({
      message: 'What recipe posso fazer hoje?',
      routedDomain: 'cooking',
    });
    const mixedSimpleRecipeIdea = inferChatTurnContract({
      message: 'Give me uma receita simples para duas pessoas',
      routedDomain: 'cooking',
    });

    expect(english).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'en',
    });
    expect(portuguese).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'pt',
    });
    expect(portugueseRecipeIdea).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'pt',
    });
    expect(spanishRecipeIdea).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'es',
    });
    expect(mixedRecipeIdea).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'mixed',
    });
    expect(mixedSimpleRecipeIdea).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'mixed',
    });
  });

  it('recognizes common Spanish read and cooking prompts as Spanish', () => {
    expect(inferChatTurnContract({ message: 'Tengo tareas para completar hoy?' })).toMatchObject({
      skill: 'tasks',
      routeKind: 'local_read',
      language: 'es',
    });
    expect(inferChatTurnContract({ message: 'Qué puedo cocinar para cenar?' })).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      expectedResponseShape: 'direct_answer',
      language: 'es',
    });
  });

  it('keeps Spanish research prompts in Spanish even when the command word is English', () => {
    const currentEvents = inferChatTurnContract({
      message: 'Search noticias recientes sobre inflación en América Latina esta semana.',
    });
    const productComparison = inferChatTurnContract({
      message: 'Search fuentes actuales sobre precio de paneles solares residenciales en México.',
    });

    for (const contract of [currentEvents, productComparison]) {
      expect(contract).toMatchObject({
        routeKind: 'internet_research',
        groundingRequired: 'web',
        language: 'es',
      });
    }
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

  it('keeps generic advice follow-ups out of scoped Secretary reads even with a routed domain hint', () => {
    const contract = inferChatTurnContract({
      message: 'Agora me dá um próximo passo pequeno para hoje.',
      routedDomain: 'secretary',
    });

    expect(contract).toMatchObject({
      skill: 'chat',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'pt',
    });
  });

  it('still uses scoped reads when next-step wording explicitly asks about local state', () => {
    const contract = inferChatTurnContract({
      message: 'Qual é o próximo passo na minha agenda hoje?',
      routedDomain: 'secretary',
    });

    expect(contract).toMatchObject({
      skill: 'secretary',
      routeKind: 'local_read',
      groundingRequired: 'local',
    });
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
