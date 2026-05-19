import { describe, expect, it } from 'vitest';

import {
  buildChatResearchContext,
  compileChatContext,
} from '../../src/services/chat-context-compiler';

describe('chat context compiler', () => {
  it('keeps cacheable sections stable and dynamic user text last', () => {
    const first = buildChatResearchContext({
      message: 'latest safety guidance for chicken leftovers',
      language: 'en',
      skill: 'cooking',
      expectedResponseShape: 'direct_answer',
    });
    const second = buildChatResearchContext({
      message: 'latest safety guidance for chicken leftovers',
      language: 'en',
      skill: 'cooking',
      expectedResponseShape: 'direct_answer',
    });

    expect(first.cacheablePrefixHash).toBe(second.cacheablePrefixHash);
    expect(first.systemPrompt).toContain('<stable_system_policy>');
    expect(first.systemPrompt).toContain('<skill_response_policy>');
    expect(first.systemPrompt).toContain('<response_contract>');
    expect(first.userPrompt.trim().endsWith('</user_message>')).toBe(true);
    expect(first.userPrompt).toContain('latest safety guidance for chicken leftovers');
  });

  it('truncates oversized dynamic sections and reports token estimates', () => {
    const compiled = compileChatContext({
      sections: [
        {
          name: 'stable_system_policy',
          content: 'Stable policy',
          source: 'test',
          cacheable: true,
          required: true,
        },
        {
          name: 'web_source_package',
          content: 'x'.repeat(100),
          source: 'test.web',
          maxChars: 12,
        },
      ],
    });

    const webSection = compiled.sections.find((section) => section.name === 'web_source_package');
    expect(webSection?.truncated).toBe(true);
    expect(webSection?.content).toHaveLength(12);
    expect(compiled.tokenEstimate).toBeGreaterThan(0);
  });

  it('adds scoped local facts when research requires local-and-web grounding', () => {
    const compiled = buildChatResearchContext({
      message: 'show my latest tasks and the weather',
      language: 'en',
      skill: 'secretary',
      expectedResponseShape: 'agenda_summary',
      groundingRequired: 'local_and_web',
      localContext: 'Tasks: Finish proposal\nCalendar: 15:00 review',
    });

    expect(compiled.userPrompt).toContain('<local_facts>');
    expect(compiled.userPrompt).toContain('Tasks: Finish proposal');
    expect(compiled.systemPrompt).toContain('combine them with current web sources');
  });
});
