// Milestone 4 — deterministic manifest intent resolver.
//
// The manifest is iterated GENERICALLY: no capability id is named in the
// example-utterance assertions, which proves the resolver carries no
// hardcoded per-capability behavior.

import { beforeEach, describe, expect, it } from 'vitest';

import { loadCapabilityManifest } from '../../../src/services/capability-manifest';
import {
  resolveIntent,
  resolveIntentAgainst,
} from '../../../src/services/intent-resolution/intent-resolver';
import {
  compileIntentVocabulary,
  getCompiledIntentVocabulary,
  resetIntentVocabularyForTests,
  type IntentVocabularySourceEntry,
} from '../../../src/services/intent-resolution/vocabulary';

describe('manifest intent resolver', () => {
  beforeEach(() => {
    resetIntentVocabularyForTests();
  });

  it('resolves every seeded example utterance to its own capability (generic manifest iteration)', () => {
    const manifest = loadCapabilityManifest();
    const seeded = manifest.capabilities.filter(
      (entry) => (entry.routingVocabulary?.exampleUtterances?.length ?? 0) > 0,
    );
    expect(seeded.length).toBe(manifest.capabilities.length); // every capability is seeded

    for (const entry of seeded) {
      for (const utterance of entry.routingVocabulary!.exampleUtterances!) {
        const candidates = resolveIntent(utterance);
        expect(candidates.length, `${entry.id} :: ${utterance}`).toBeGreaterThan(0);
        expect(candidates[0].capabilityId, `${entry.id} :: ${utterance}`).toBe(entry.id);
        expect(candidates[0].domain).toBe(entry.runtimeRouting.domain);
        expect(candidates[0].rawScore).toBeGreaterThan(0);
        expect(candidates[0].matchedEvidence.length).toBeGreaterThan(0);
      }
    }
  });

  it.each([
    ['secretary', 'secretary', 'Outline a weekly planning block at 3 p.m.; the date is still open.'],
    ['secretary', 'secretary', 'Preview a schedule that fits meal prep around tomorrow\'s commitments; save nothing.'],
    ['secretary', 'secretary', 'Explain recipient checks before a bulk message; send nothing.'],
    ['secretary', 'secretary', 'Ajuda-me a preparar um bloco de concentração às 15h; falta escolher o dia.'],
    ['secretary', 'secretary', 'Esboce como encaixar o treino nos horários livres de amanhã; não altere a agenda.'],
    ['secretary', 'secretary', 'Describe how you would prioritize an overloaded day by urgency; save nothing.'],
    ['secretary', 'secretary', 'Outline safeguards before a message goes to multiple recipients; keep it unsent.'],
    ['secretary', 'secretary', 'Mostre os próximos eventos do calendário por ordem de horário.'],
    ['secretary', 'secretary', 'Explique como excluir uma série de eventos do calendário; não exclua nada.'],
    ['secretary', 'secretary', 'Faça uma minuta de pedido para mudar o horário da reunião; não envie.'],
    ['secretary', 'secretary', 'Escreve um rascunho a pedir outra hora para a reunião; não o guardes.'],
    ['secretary', 'secretary', 'Esboça uma sessão de foco de cinquenta minutos às duas; deixa a data em aberto.'],
    ['secretary', 'secretary', 'Prepara uma hora de planeamento na quinta-feira; deixa o início por escolher.'],
    ['triathlon', 'training', 'Prepare a one-hour easy ride for Thursday; the start time remains open.'],
    ['triathlon', 'training', 'Sketch an easy 1500-metre swim for Tuesday; the pool length is missing.'],
    ['triathlon', 'training', 'Preview a long-ride workout with a fueling outline; save nothing.'],
    ['triathlon', 'training', 'Draft an easier version of Saturday\'s long run; do not apply the change.'],
    ['triathlon', 'training', 'Prepare uma sessão fácil de 1.200 metros para terça cedo, deixando apenas o comprimento da piscina indefinido.'],
    ['triathlon', 'training', 'Explain the confirmation needed before clearing a week of workouts from the plan.'],
    ['triathlon', 'training', 'Mostre os treinos guardados no planeamento da semana.'],
    ['triathlon', 'training', 'Mostre as corridas previstas no plano dos próximos dias.'],
    ['triathlon', 'training', 'Preview a bike session with a snack outline; do not update workouts or groceries.'],
    ['triathlon', 'training', 'Esboça uma sessão de bicicleta com abastecimento; não alteres treino nem despensa.'],
    ['content', 'content', 'List the editorial briefs saved in my workspace with their due dates.'],
    ['content', 'content', 'Show the research notes filed under sustainable packaging.'],
    ['content', 'content', 'Quais pautas estão salvas no espaço editorial?'],
    ['content', 'content', 'Mostre os títulos e os status das pautas existentes sobre consumo consciente.'],
    ['content', 'content', 'Rascunhe uma pauta sobre hábitos sustentáveis para iniciantes, mas não salve nem publique.'],
    ['content', 'content', 'Show source notes filed in the research folder for reusable packaging.'],
    ['content', 'content', 'Explain safeguards before superseding an approved content brief.'],
    ['content', 'content', 'Which saved ideas in the editorial backlog share the beginner theme?'],
    ['content', 'content', 'Mostre uma prévia de briefing para um guia de sustentabilidade; não registe.'],
    ['content', 'content', 'Revise o processo para substituir um artigo aprovado; não troque o texto.'],
    ['content', 'content', 'O que deve ser revisado antes de substituir um artigo já aprovado? Não troque o texto.'],
    ['content', 'content', 'Esboça um artigo introdutório em três secções; deixa a extensão em aberto.'],
    ['content', 'content', 'Prepara a estrutura de um guia prático em três partes; não o guardes.'],
    ['cooking', 'cooking', 'Which pantry items need restocking this week?'],
    ['cooking', 'cooking', 'Sketch a lentil soup for Sunday; leave the portion count open.'],
    ['cooking', 'cooking', 'Que itens da despensa precisam de reposição?'],
    ['cooking', 'cooking', 'Explain the checks before placing a large grocery order.'],
    ['cooking', 'cooking', 'Which meals are planned from Monday through Friday next week?'],
    ['cooking', 'cooking', 'Suggest possible swaps for the pasta ingredients; change nothing.'],
    ['cooking', 'cooking', 'Mostre uma prévia de compras para refeições rápidas; não atualize a lista.'],
    ['cooking', 'cooking', 'Propõe, só em rascunho, os ingredientes para refeições rápidas desta semana; não guardes a sugestão nem alteres a lista.'],
    ['cooking', 'cooking', 'Explique como substituir ervas frescas por secas neste prato.'],
    ['cooking', 'cooking', 'Que verificações vêm antes de encomendar uma compra grande de mercearia?'],
    ['cooking', 'cooking', 'Confirme os cuidados para uma encomenda avultada de alimentos; não compre.'],
    ['finance', 'finance', 'Quais faturas pendentes vencem neste mês?'],
    ['finance', 'finance', 'Que pagamentos a fornecedores continuam pendentes?'],
    ['finance', 'finance', 'Show supplier payments still pending processing.'],
    ['finance', 'finance', 'Liste as faturas não pagas com datas de vencimento e valores.'],
    ['finance', 'finance', 'Liste os lançamentos que aguardam recibo.'],
    ['finance', 'finance', 'Esboce um registo fictício de material de escritório; falta a forma de pagamento.'],
    ['finance', 'finance', 'Esboça um recibo fictício em euros; deixa a categoria fiscal em aberto.'],
  ] as const)('routes product-owned state language to %s/%s: %s', (domain, skill, message) => {
    expect(resolveIntent(message)[0]).toMatchObject({ domain, skill });
  });

  it('does not treat generic missing-detail language as finance evidence', () => {
    const candidates = resolveIntent('The only missing detail is the date.');
    expect(candidates.some((candidate) => candidate.domain === 'finance')).toBe(false);

    const portuguese = resolveIntent('Falta apenas escolher o dia.');
    expect(portuguese.some((candidate) => candidate.domain === 'finance')).toBe(false);
  });

  it('does not route generic scheduling or order timing nouns without a domain object', () => {
    expect(resolveIntent('We need a short session tomorrow.').some(
      (candidate) => candidate.domain === 'triathlon',
    )).toBe(false);
    expect(resolveIntent('The order is due this month.').some(
      (candidate) => candidate.domain === 'finance',
    )).toBe(false);
  });

  it('does not treat generic deadline, pending, or light-weight adjectives as domain evidence', () => {
    expect(resolveIntent('The only pending detail is the deadline.').some(
      (candidate) => candidate.domain === 'secretary',
    )).toBe(false);
    expect(resolveIntent('Um produto fictício leve continua sem público definido.').some(
      (candidate) => candidate.domain === 'triathlon',
    )).toBe(false);
  });

  it('keeps editorial and restock vocabulary bounded to product-owned objects', () => {
    for (const meetingAgenda of [
      'Quais são as pautas da reunião de amanhã?',
      'Mostre os títulos das pautas da reunião de amanhã.',
      'Rascunhe uma pauta para a reunião de sexta.',
      'Qual é o status das pautas da reunião?',
      'Rascunhe para a reunião uma pauta de sexta.',
      'Mostre os títulos da reunião nas pautas.',
    ]) {
      expect(resolveIntent(meetingAgenda)[0]?.domain).toBe('secretary');
    }
    expect(resolveIntent('Restock printer paper in the office supplies cabinet.').some(
      (candidate) => candidate.domain === 'cooking',
    )).toBe(false);
    expect(resolveIntent('Repor papel na impressora do escritório.').some(
      (candidate) => candidate.domain === 'cooking',
    )).toBe(false);
    expect(resolveIntent('Show the legal briefs for tomorrow\'s meeting.').some(
      (candidate) => candidate.domain === 'content',
    )).toBe(false);
    expect(resolveIntent('Review the editorial decision from legal.').some(
      (candidate) => candidate.domain === 'content',
    )).toBe(false);
    expect(resolveIntent('Check our vendor integration status.').some(
      (candidate) => candidate.domain === 'finance',
    )).toBe(false);
    expect(resolveIntent('A piscina precisa de manutenção.').some(
      (candidate) => candidate.domain === 'triathlon',
    )).toBe(false);
    expect(resolveIntent('A academia publicou novas regras.').some(
      (candidate) => candidate.domain === 'triathlon',
    )).toBe(false);
    for (const connectionOrFinanceStatus of [
      'Check the gym integration status.',
      'Is my gym connection working?',
      'Mostre o status da integração de pagamentos.',
      'Verifique o status da integração do ginásio.',
      'Mostre o status da integração de recibos.',
    ]) {
      expect(resolveIntent(connectionOrFinanceStatus)[0]?.domain).toBe('connections');
    }
    expect(resolveIntent('Show my gym subscription renewal.')[0]?.domain).toBe('finance');
    expect(resolveIntent('Mostre a renovação da assinatura do ginásio.')[0]?.domain).toBe('finance');
    expect(resolveIntent('Esboce um registro fictício de personagem com detalhes reais.').some(
      (candidate) => candidate.domain === 'finance',
    )).toBe(false);
    for (const nonTrainingSwim of [
      'The swimming pool needs maintenance.',
      'Swimming lessons for the kids start Monday.',
      'As aulas de natação das crianças começam segunda.',
    ]) {
      expect(resolveIntent(nonTrainingSwim).some(
        (candidate) => candidate.domain === 'triathlon',
      )).toBe(false);
    }
  });

  it('counts an identical locale matcher once within one capability', () => {
    const duplicateLocaleVocabulary = compileIntentVocabulary([{
      id: 'finance',
      runtimeRouting: { domain: 'finance', chatOwnerSkill: 'finance' },
      chatOwnerSkills: ['finance'],
      routingVocabulary: {
        locales: {
          pt: ['falta'],
          es: ['falta'],
        },
      },
    }]);

    expect(resolveIntentAgainst(duplicateLocaleVocabulary, 'Falta escolher o dia.')).toEqual([
      expect.objectContaining({
        domain: 'finance',
        rawScore: 1,
        matchedEvidence: ['locale:pt:falta'],
      }),
    ]);
  });

  it('counts one lexical hit once when overlapping matcher shapes match the same text', () => {
    const overlappingVocabulary = compileIntentVocabulary([{
      id: 'secretary',
      runtimeRouting: { domain: 'secretary', chatOwnerSkill: 'secretary' },
      chatOwnerSkills: ['secretary'],
      routingVocabulary: {
        locales: { en: ['schedule'] },
        regexFragments: [
          '\\b(schedule|calendar)\\b',
          '\\b(schedule|agenda|meeting)\\b',
        ],
      },
    }]);

    expect(resolveIntentAgainst(overlappingVocabulary, 'Keep the schedule unchanged.')).toEqual([
      expect.objectContaining({
        domain: 'secretary',
        rawScore: 1,
        matchedEvidence: ['locale:en:schedule'],
      }),
    ]);
  });

  it('is deterministic and ranked by descending score', () => {
    const manifest = loadCapabilityManifest();
    for (const entry of manifest.capabilities) {
      for (const utterance of entry.routingVocabulary?.exampleUtterances ?? []) {
        const first = resolveIntent(utterance);
        const second = resolveIntent(utterance);
        expect(second).toEqual(first);
        for (let i = 1; i < first.length; i++) {
          expect(first[i - 1].rawScore).toBeGreaterThanOrEqual(first[i].rawScore);
        }
      }
    }
  });

  it('makes a synthetic manifest entry resolvable without any code change', () => {
    const synthetic: IntentVocabularySourceEntry = {
      id: 'stargazing',
      runtimeRouting: { domain: 'stargazing', chatOwnerSkill: 'stargazing' },
      chatOwnerSkills: ['stargazing'],
      routingVocabulary: {
        locales: { en: ['telescopes?', 'constellations?', 'meteor\\s+shower'] },
        regexFragments: ['\\b(point|aim)\\b[\\s\\S]{0,40}\\b(telescope|lens)\\b'],
        exampleUtterances: ['where should I point my telescope tonight'],
      },
    };
    const vocabulary = compileIntentVocabulary([
      ...getCompiledIntentVocabularySource(),
      synthetic,
    ]);

    const candidates = resolveIntentAgainst(vocabulary, 'where should I point my telescope tonight');
    expect(candidates[0].capabilityId).toBe('stargazing');
    expect(candidates[0].skill).toBe('stargazing');

    const keywordOnly = resolveIntentAgainst(vocabulary, 'is there a meteor shower this weekend?');
    expect(keywordOnly.some((candidate) => candidate.capabilityId === 'stargazing')).toBe(true);
  });

  it('applies the optional context nudge only as a deterministic tie-break aid', () => {
    const text = 'what should I do next?';
    const without = resolveIntent(text);
    const withContext = resolveIntent(text, { activeDomain: 'cooking' });
    // The nudge never invents candidates.
    expect(withContext.map((c) => c.capabilityId).sort()).toEqual(
      without.map((c) => c.capabilityId).sort(),
    );
  });

  it('compiles the vocabulary once (lazy singleton) and supports explicit reset', () => {
    const first = getCompiledIntentVocabulary();
    expect(getCompiledIntentVocabulary()).toBe(first);
    resetIntentVocabularyForTests();
    const second = getCompiledIntentVocabulary();
    expect(second).not.toBe(first);
    expect(second.map((entry) => entry.capabilityId)).toEqual(first.map((entry) => entry.capabilityId));
  });
});

function getCompiledIntentVocabularySource(): IntentVocabularySourceEntry[] {
  return loadCapabilityManifest().capabilities.map((entry) => ({
    id: entry.id,
    runtimeRouting: entry.runtimeRouting,
    chatOwnerSkills: entry.chatOwnerSkills,
    routingVocabulary: entry.routingVocabulary,
  }));
}
