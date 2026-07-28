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
    expect(split.overflowCount).toBe(0);
  });

  it('does not treat a negated safety boundary as a second action', () => {
    const split = splitChatMultiStepRequest(
      'Delete only the task NEXUS_CHAT_EVAL_M2_TARGET. Do not delete any other task.',
    );
    expect(split.classification).toBe('single');
    expect(split.segments).toHaveLength(1);
    expect(split.segments[0].text).toContain('NEXUS_CHAT_EVAL_M2_TARGET');
  });

  // M16: segments beyond the cap are counted, never silently dropped — the
  // response layer discloses the overflow to the user.
  it('caps at 5 segments and reports the overflow count', () => {
    const split = splitChatMultiStepRequest(
      'Create task one, create task two, create task three, create task four, create task five, create task six, create task seven',
    );
    expect(split.segments).toHaveLength(5);
    expect(split.overflowCount).toBe(2);
    expect(split.classification === 'multi' || split.classification === 'low_confidence_multi').toBe(true);
  });

  it('reports zero overflow for in-cap multi-step requests', () => {
    const split = splitChatMultiStepRequest('Create task Buy milk and then schedule dentist tomorrow at 9am');
    expect(split.overflowCount).toBe(0);
  });

  // ── M16 adversarial fixes ────────────────────────────────────────

  it("splits on '&' as live relaxed connective vocabulary", () => {
    const split = splitChatMultiStepRequest('Create task Buy milk & schedule dentist tomorrow at 9am');
    expect(split.classification === 'multi' || split.classification === 'low_confidence_multi').toBe(true);
    expect(split.segments.map((segment) => segment.text)).toEqual([
      'Create task Buy milk',
      'schedule dentist tomorrow at 9am',
    ]);
    expect(split.segments[1].connective).toBe('&');
  });

  it("extracts PT contracted anaphora ('nela') so relaxed 'e' segments stay linked", () => {
    const split = splitChatMultiStepRequest('Cria a lista mercado e adiciona leite nela');
    expect(split.segments).toHaveLength(2);
    expect(split.segments[1].text).toBe('adiciona leite nela');
    expect(split.segments[1].pronounMentions).toContain('nela');
  });

  it("extracts EN definite anaphora phrases ('the list')", () => {
    const split = splitChatMultiStepRequest('Create a grocery list and add milk to the list');
    expect(split.segments).toHaveLength(2);
    expect(split.segments[1].pronounMentions).toContain('the list');
  });

  it('extracts ES clitic anaphora — standalone and verb+clitic suffix forms', () => {
    const suffix = splitChatMultiStepRequest('Crea una lista de compras y añade la tarea comprar leche, agrégale una nota');
    expect(suffix.segments.length).toBeGreaterThanOrEqual(2);
    const suffixMentions = suffix.segments.flatMap((segment) => segment.pronounMentions);
    expect(suffixMentions).toContain('agrégale');

    const standalone = splitChatMultiStepRequest('Crea una tarea comprar leche y luego la marca como hecha');
    expect(standalone.segments).toHaveLength(2);
    expect(standalone.segments[1].pronounMentions).toContain('la');
  });
});
