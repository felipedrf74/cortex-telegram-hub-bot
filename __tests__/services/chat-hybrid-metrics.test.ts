import { describe, expect, it } from 'vitest';

import {
  computeHybridActionMetricsFromCorpus,
  type ChatHybridActionMetricCase,
} from '../../src/services/chat-hybrid-metrics';
import { CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES } from '../../src/services/chat-bilingual-eval-fixtures';

function baseCase(overrides: Partial<ChatHybridActionMetricCase>): ChatHybridActionMetricCase {
  return { id: overrides.id ?? 'case', ...overrides };
}

describe('computeHybridActionMetricsFromCorpus portuguese localization leakage', () => {
  it('keeps counting explicit portugueseLocalizationLeakage booleans (legacy path)', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      baseCase({ id: 'legacy-leak', portugueseLocalizationLeakage: true }),
      baseCase({ id: 'legacy-clean', portugueseLocalizationLeakage: false }),
      baseCase({ id: 'unset' }),
    ]);
    expect(metrics.portugueseLocalizationLeakageCount).toBe(1);
  });

  it('derives leakage from promptLocale + actualResponseText via the detector', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      baseCase({
        id: 'es419-leaked-pt',
        promptLocale: 'es-419',
        actualResponseText: 'Criei a tarefa chamada revisão do planificador. Precisa de mais alguma coisa?',
      }),
      baseCase({
        id: 'es419-retired-spanish-output',
        promptLocale: 'es-419',
        actualResponseText: 'Listo, creé la tarea llamada revisión del planificador.',
      }),
      baseCase({
        id: 'en-leaked-pt',
        promptLocale: 'en-US',
        actualResponseText: 'Pronto, criei a tarefa para comprar leite amanhã.',
      }),
      baseCase({
        id: 'ptbr-pt-reply-not-leak',
        promptLocale: 'pt-BR',
        actualResponseText: 'Pronto, criei a tarefa para comprar leite amanhã.',
      }),
    ]);
    expect(metrics.portugueseLocalizationLeakageCount).toBe(2);
  });

  it('fails open on unknown detections and unmapped locales in the derived path', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      baseCase({ id: 'short-ack', promptLocale: 'es-419', actualResponseText: 'OK' }),
      baseCase({ id: 'unmapped-locale', promptLocale: 'fr-FR', actualResponseText: 'Criei a tarefa para você.' }),
      baseCase({ id: 'no-response-text', promptLocale: 'es-419' }),
    ]);
    expect(metrics.portugueseLocalizationLeakageCount).toBe(0);
  });

  it('lets an explicit boolean override the detector-derived verdict', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      baseCase({
        id: 'explicit-false-wins',
        portugueseLocalizationLeakage: false,
        promptLocale: 'es-419',
        actualResponseText: 'Criei a tarefa chamada revisão do planificador.',
      }),
    ]);
    expect(metrics.portugueseLocalizationLeakageCount).toBe(0);
  });

  it('retains the historical es-419 detector corpus for Portuguese-leak monitoring', () => {
    const es419 = CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES.filter((fixture) => fixture.promptLocale === 'es-419');
    expect(es419.length).toBeGreaterThanOrEqual(5);

    const leaked = computeHybridActionMetricsFromCorpus(es419.map((fixture) => baseCase({
      id: `${fixture.scenario}-leak`,
      promptLocale: fixture.promptLocale,
      actualResponseText: fixture.crossLocaleLeakResponse,
    })));
    expect(leaked.portugueseLocalizationLeakageCount).toBe(es419.length);

    const nonPortuguese = computeHybridActionMetricsFromCorpus(es419.map((fixture) => baseCase({
      id: `${fixture.scenario}-historical-spanish`,
      promptLocale: fixture.promptLocale,
      actualResponseText: fixture.onLocaleResponse,
    })));
    expect(nonPortuguese.portugueseLocalizationLeakageCount).toBe(0);
  });
});
