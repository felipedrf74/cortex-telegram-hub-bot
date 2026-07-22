import { describe, expect, it } from 'vitest';

import {
  checkStagingLocaleWritePreview,
  checkResponseLocaleFidelity,
  detectResponseLanguage,
  expectedLanguageForLocale,
} from '../../src/services/chat-language-detector';
import { CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES } from '../../src/services/chat-bilingual-eval-fixtures';

describe('detectResponseLanguage', () => {
  const SPANISH_CORPUS = [
    'Listo, creé la tarea para comprar leche mañana.',
    'Tienes 3 tareas atrasadas: revisión del informe, pagar la factura y llamar al médico.',
    'Agendé la reunión con Ana para el viernes a las 10 de la mañana.',
    'Hecho, marqué la tarea como completada.',
    'Hoy tienes dos reuniones y una ventana libre después del almuerzo.',
    '¿Quieres que agregue un recordatorio para el lunes también?',
    'No encontré ninguna tarea con ese nombre. ¿Puedes darme más detalles?',
    'Tu agenda del viernes está libre después de las 14:00.',
  ];

  const PORTUGUESE_CORPUS = [
    'Pronto, criei a tarefa para comprar leite amanhã.',
    'Você tem 3 tarefas atrasadas: revisão do relatório, pagar a fatura e ligar para o médico.',
    'Agendei a reunião com a Ana para sexta-feira às 10 da manhã.',
    'Feito, marquei a tarefa como concluída.',
    'Hoje você tem duas reuniões e uma janela livre depois do almoço.',
    'Quer que eu adicione um lembrete para segunda-feira também?',
    'Não encontrei nenhuma tarefa com esse nome. Pode dar mais detalhes?',
    'Sua agenda de sexta está livre depois das 14h.',
  ];

  const ENGLISH_CORPUS = [
    'Done, I created the task to buy milk tomorrow.',
    'You have 3 overdue tasks: report review, pay the invoice, and call the doctor.',
    'I scheduled the meeting with Ana for Friday at 10 in the morning.',
    'Your Friday agenda is free after 2pm.',
    'Would you like me to add a reminder for Monday as well?',
  ];

  it('detects Spanish responses including pt-confusable phrasing', () => {
    for (const text of SPANISH_CORPUS) {
      const result = detectResponseLanguage(text);
      expect(result.language, text).toBe('es');
      expect(result.confidence, text).toBeGreaterThan(0.5);
    }
  });

  it('detects Portuguese responses including es-confusable phrasing', () => {
    for (const text of PORTUGUESE_CORPUS) {
      const result = detectResponseLanguage(text);
      expect(result.language, text).toBe('pt');
      expect(result.confidence, text).toBeGreaterThan(0.5);
    }
  });

  it('detects English responses', () => {
    for (const text of ENGLISH_CORPUS) {
      const result = detectResponseLanguage(text);
      expect(result.language, text).toBe('en');
      expect(result.confidence, text).toBeGreaterThan(0.5);
    }
  });

  it('degrades short strings to unknown with low confidence instead of guessing', () => {
    for (const text of ['OK', 'Ok!', 'Sí.', 'Sim', '👍', '10:00', 'Done', '']) {
      const result = detectResponseLanguage(text);
      expect(result.language, text).toBe('unknown');
      expect(result.confidence, text).toBeLessThan(0.5);
    }
  });

  it('degrades balanced mixed-language content to unknown', () => {
    const mixed = 'Criei a tarefa para você. I also added a reminder for tomorrow morning.';
    const result = detectResponseLanguage(mixed);
    expect(result.language).toBe('unknown');
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('pins the known es-419 → Portuguese leak reply shape as Portuguese', () => {
    // Live eval evidence (chat-eval real_provider run): es-419 prompt
    // "Crea una tarea llamada revisión del planificador" answered in pt.
    const leakedReply = 'Criei a tarefa chamada revisão do planificador. Precisa de mais alguma coisa?';
    const result = detectResponseLanguage(leakedReply);
    expect(result.language).toBe('pt');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('is deterministic across repeated calls', () => {
    const first = detectResponseLanguage(SPANISH_CORPUS[0]);
    const second = detectResponseLanguage(SPANISH_CORPUS[0]);
    expect(second).toEqual(first);
  });
});

describe('expectedLanguageForLocale', () => {
  it('maps locales to expected response languages', () => {
    expect(expectedLanguageForLocale('es-419')).toBe('es');
    expect(expectedLanguageForLocale('es-ES')).toBe('es');
    expect(expectedLanguageForLocale('es')).toBe('es');
    expect(expectedLanguageForLocale('pt-BR')).toBe('pt');
    expect(expectedLanguageForLocale('pt-PT')).toBe('pt');
    expect(expectedLanguageForLocale('pt_br')).toBe('pt');
    expect(expectedLanguageForLocale('en-US')).toBe('en');
    expect(expectedLanguageForLocale('en')).toBe('en');
    expect(expectedLanguageForLocale('fr-FR')).toBe('unknown');
    expect(expectedLanguageForLocale('')).toBe('unknown');
    expect(expectedLanguageForLocale(undefined)).toBe('unknown');
  });
});

describe('checkResponseLocaleFidelity', () => {
  it('flags the known es-419 → Portuguese leak', () => {
    const result = checkResponseLocaleFidelity(
      'es-419',
      'Criei a tarefa chamada revisão do planificador. Precisa de mais alguma coisa?',
    );
    expect(result.ok).toBe(false);
    expect(result.expected).toBe('es');
    expect(result.detected).toBe('pt');
  });

  it('passes on-locale Spanish responses to es-419 prompts', () => {
    const result = checkResponseLocaleFidelity('es-419', 'Listo, creé la tarea llamada revisión del planificador.');
    expect(result.ok).toBe(true);
    expect(result.expected).toBe('es');
    expect(result.detected).toBe('es');
  });

  it('fails-open (ok:true) when detection is unknown, e.g. one-word answers', () => {
    for (const text of ['OK', 'Sí.', '👍', '10:00']) {
      const result = checkResponseLocaleFidelity('es-419', text);
      expect(result.ok, text).toBe(true);
      expect(result.detected, text).toBe('unknown');
      expect(result.confidence, text).toBeLessThan(0.5);
    }
  });

  it('fails-open when the locale itself is unmapped', () => {
    const result = checkResponseLocaleFidelity('fr-FR', 'Pronto, criei a tarefa para comprar leite amanhã.');
    expect(result.ok).toBe(true);
    expect(result.expected).toBe('unknown');
  });

  it('flags pt-BR prompts answered in Spanish (reverse leak)', () => {
    const result = checkResponseLocaleFidelity('pt-BR', 'Listo, creé la tarea para comprar leche mañana.');
    expect(result.ok).toBe(false);
    expect(result.expected).toBe('pt');
    expect(result.detected).toBe('es');
  });
});

describe('checkStagingLocaleWritePreview', () => {
  const spanishPreview = {
    text: 'Listo, preparé la tarea para comprar leche mañana. Confirma para crearla.',
    metadata: { actionStatus: 'needs_confirmation' },
  };

  it.each([200, 202])('accepts intended HTTP %i write previews with an explicit confirmation status', (httpStatus) => {
    const result = checkStagingLocaleWritePreview('es-419', httpStatus, spanishPreview);

    expect(result.ok).toBe(true);
    expect(result.httpStatusAccepted).toBe(true);
    expect(result.actionStatus).toBe('needs_confirmation');
    expect(result.actionStatusAccepted).toBe(true);
  });

  it('fails closed when actionStatus is absent or claims the write already succeeded', () => {
    const missing = checkStagingLocaleWritePreview('es-419', 202, {
      text: spanishPreview.text,
      metadata: {},
    });
    const mutated = checkStagingLocaleWritePreview('es-419', 200, {
      text: spanishPreview.text,
      metadata: { actionStatus: 'verified_success' },
    });

    expect(missing.ok).toBe(false);
    expect(missing.actionStatusAccepted).toBe(false);
    expect(mutated.ok).toBe(false);
    expect(mutated.actionStatusAccepted).toBe(false);
  });

  it('rejects non-200/202 responses and cross-locale leakage', () => {
    const wrongStatus = checkStagingLocaleWritePreview('es-419', 201, spanishPreview);
    const leaked = checkStagingLocaleWritePreview('es-419', 202, {
      text: 'Pronto, preparei a tarefa para comprar leite amanhã. Confirme para criar.',
      metadata: { actionStatus: 'needs_confirmation' },
    });

    expect(wrongStatus.ok).toBe(false);
    expect(wrongStatus.httpStatusAccepted).toBe(false);
    expect(leaked.ok).toBe(false);
    expect(leaked.localeFidelity.detected).toBe('pt');
  });
});

describe('confusable fixture corpus', () => {
  it('has at least 10 es-419/pt-BR confusable prompt-response pairs', () => {
    expect(CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES.length).toBeGreaterThanOrEqual(10);
    const locales = new Set(CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES.map((fixture) => fixture.promptLocale));
    expect(locales.has('es-419')).toBe(true);
    expect(locales.has('pt-BR')).toBe(true);
  });

  it('accepts every on-locale response and rejects every cross-locale leak response', () => {
    for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
      const onLocale = checkResponseLocaleFidelity(fixture.promptLocale, fixture.onLocaleResponse);
      expect(onLocale.ok, `${fixture.scenario} on-locale`).toBe(true);

      const leaked = checkResponseLocaleFidelity(fixture.promptLocale, fixture.crossLocaleLeakResponse);
      expect(leaked.ok, `${fixture.scenario} leak`).toBe(false);
      expect(leaked.detected, `${fixture.scenario} leak detected`).toBe(
        fixture.promptLocale === 'es-419' ? 'pt' : 'es',
      );
    }
  });

  it('keeps expectedResponseLanguage consistent with the locale mapping', () => {
    for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
      expect(expectedLanguageForLocale(fixture.promptLocale)).toBe(fixture.expectedResponseLanguage);
    }
  });
});
