import { describe, expect, it } from 'vitest';

import { splitChatMultiStepRequest } from '../../src/services/chat-multi-step-splitter';

describe('chat multi-step splitter', () => {
  it('splits sequential EN/PT/ES action requests into bounded actionable segments', () => {
    const en = splitChatMultiStepRequest('Create task Buy milk and then schedule dentist tomorrow at 9am');
    expect(en.classification).toBe('multi');
    expect(en.segments.map((segment) => segment.text)).toEqual([
      'Create task Buy milk',
      'schedule dentist tomorrow at 9am',
    ]);
    expect(en.segments[1].connective).toMatch(/then|and then/i);

    const pt = splitChatMultiStepRequest('Cria tarefa comprar leite e depois agenda dentista amanhã às 9');
    expect(pt.classification).toBe('multi');
    expect(pt.segments).toHaveLength(2);
    expect(pt.segments[0].languageHint).toBe('pt');

    const es = splitChatMultiStepRequest('Crea tarea comprar leche y luego programa dentista mañana a las 9');
    expect(es.classification).toBe('multi');
    expect(es.segments).toHaveLength(2);
    expect(es.segments[1].languageHint).toBe('es');
  });

  it('keeps quoted connective text inside the owning segment', () => {
    const split = splitChatMultiStepRequest('Create task "Review and publish reel" and create task Call mom');
    expect(split.classification).toBe('multi');
    expect(split.segments.map((segment) => segment.text)).toEqual([
      'Create task "Review and publish reel"',
      'create task Call mom',
    ]);
  });

  it('does not split ordinary list items that have no second action verb', () => {
    const split = splitChatMultiStepRequest('Add milk and eggs to the grocery list');
    expect(split.classification).toBe('single');
    expect(split.segments[0].text).toBe('Add milk and eggs to the grocery list');
  });
});
