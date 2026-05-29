// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Domain } from './types';
import {
  CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
  type ChatCoreV2CorpusLanguage,
  type ChatCoreV2GoldenCorpus,
  type ChatCoreV2GoldenCorpusIntent,
  type ChatCoreV2GoldenCorpusItem,
  type ChatCoreV2GoldenCorpusSource,
} from './golden-corpus';
import type { ChatCoreV2WriteRiskClass } from './write-risk-policy';

interface SeedSpec {
  language: ChatCoreV2CorpusLanguage;
  message: string;
  expectedDomainIds: ChatCoreV2Domain[];
  expectedCapabilityIds: string[];
  expectedIntent: ChatCoreV2GoldenCorpusIntent;
  evidenceRequirements?: string[];
  forbiddenClaims?: string[];
  writeRiskClass?: ChatCoreV2WriteRiskClass;
  source?: ChatCoreV2GoldenCorpusSource;
  notes?: string;
}

const DEFAULT_FORBIDDEN_CLAIMS = [
  'Do not claim a write/action succeeded unless readback verification is present.',
  'Do not fall back to the scoped-read response for write intents.',
  'Do not invent private account, task, calendar, or training state.',
];

const REAL_FAILURE_SEEDS: SeedSpec[] = [
  {
    language: 'pt-BR',
    message: 'Crie uma tarefa para comprar suplementos QA: k2, d3, creatina',
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['tasks.create'],
    expectedIntent: 'write_preview',
    writeRiskClass: 'A',
    source: 'real_failure',
    forbiddenClaims: ['Do not say there are no open tasks.', 'Do not collapse subtasks into the title.'],
    notes: 'Operator-reported simulator failure: task-with-subtasks request was answered as an open-task read.',
  },
  {
    language: 'en',
    message: 'Mark comprar suplementos QA LOCAL task as done',
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['tasks.complete'],
    expectedIntent: 'write_preview',
    writeRiskClass: 'A',
    source: 'real_failure',
    forbiddenClaims: ['Do not ask the user to request a scoped read.', 'Do not claim done without verified task ID/status.'],
    notes: 'Operator-reported simulator failure: task completion fell through to scoped-read fallback.',
  },
  {
    language: 'en',
    message: 'Mark comprar suplementos QA3 task as done',
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['tasks.complete'],
    expectedIntent: 'write_preview',
    writeRiskClass: 'A',
    source: 'real_failure',
    forbiddenClaims: ['Do not claim done without readback verification.', 'Do not complete a task by title without canonical ID resolution.'],
  },
  {
    language: 'pt-PT',
    message: 'Marca a tarefa comprar suplementos como concluída',
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['tasks.complete'],
    expectedIntent: 'write_preview',
    writeRiskClass: 'A',
    source: 'real_failure',
    forbiddenClaims: ['Do not return a generic read-required answer.', 'Do not mutate by title only.'],
  },
  {
    language: 'en',
    message: 'Create task comprar suplementos with subtasks k2, d3, creatina',
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['tasks.create'],
    expectedIntent: 'write_preview',
    writeRiskClass: 'A',
    source: 'real_failure',
    forbiddenClaims: ['Do not claim task creation unless the task is visible after readback.', 'Do not omit subtasks from the preview.'],
  },
  {
    language: 'en',
    message: 'Generate a YouTube script about developing a SaaS app for a meaningful personal goal',
    expectedDomainIds: ['content'],
    expectedCapabilityIds: ['content.script_generate'],
    expectedIntent: 'answer',
    source: 'real_failure',
    forbiddenClaims: ['Do not show upgrade-required for sandbox unlimited users.', 'Do not expose plan dollar limits to customers.'],
  },
  {
    language: 'en',
    message: 'Why is sleep missing from my home pie chart?',
    expectedDomainIds: ['training'],
    expectedCapabilityIds: ['training.health_summary'],
    expectedIntent: 'read',
    source: 'real_failure',
    forbiddenClaims: ['Do not claim sleep data is unavailable without checking the health read model.'],
  },
];

const BUCKETS: SeedSpec[][] = [
  makeRecipeSeeds(),
  makeContentSeeds(),
  makeFinanceSeeds(),
  makeTriathlonSeeds(),
  makeAmbiguousReferenceSeeds(),
  makeMultilingualLocaleSeeds(),
  makeDeterministicReadSeeds(),
  makeUnsupportedSeeds(),
  makeWritePreviewSeeds(),
];

export const CHAT_CORE_V2_GOLDEN_CORPUS_SEED: ChatCoreV2GoldenCorpus = {
  schemaVersion: CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
  items: [
    ...REAL_FAILURE_SEEDS,
    ...BUCKETS.flat(),
  ].map((spec, index) => toCorpusItem(spec, index + 1)),
};

function toCorpusItem(spec: SeedSpec, index: number): ChatCoreV2GoldenCorpusItem {
  const expectedCapabilityIds = spec.expectedCapabilityIds.length > 0
    ? spec.expectedCapabilityIds
    : ['general.help'];
  return {
    id: `chatcore-v2-seed-${String(index).padStart(4, '0')}`,
    language: spec.language,
    message: spec.message,
    surface: 'ios',
    expectedDomainIds: spec.expectedDomainIds,
    expectedCapabilityIds,
    expectedIntent: spec.expectedIntent,
    forbiddenClaims: [...DEFAULT_FORBIDDEN_CLAIMS, ...(spec.forbiddenClaims ?? [])],
    evidenceRequirements: spec.evidenceRequirements ?? ['fresh_scoped_read_or_verified_command_metadata'],
    writeRiskClass: spec.writeRiskClass,
    source: spec.source ?? 'manual_regression',
    notes: spec.notes ?? 'Reviewer-labeled safe paraphrase seed; replace or promote with private raw-evidence label during Phase 2 preparation.',
  };
}

function makeRecipeSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'Give me a high-protein breakfast recipe with eggs and spinach'],
    ['en', 'What can I cook tonight with chicken and rice?'],
    ['pt-BR', 'Me dá uma receita rápida com frango e arroz'],
    ['pt-BR', 'O que eu posso cozinhar para jantar sem lactose?'],
    ['pt-PT', 'Dá-me uma receita simples para o almoço com atum'],
    ['pt-PT', 'O que posso cozinhar hoje com ovos e legumes?'],
    ['mixed', 'Preciso de uma recipe low carb para dinner'],
    ['mixed', 'Make a receita de breakfast com oats e banana'],
  ] as const;
  return repeatSpecs(messages, 3, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['cooking'],
    expectedCapabilityIds: ['cooking.recipe_answer'],
    expectedIntent: 'answer',
    forbiddenClaims: ['Do not say the recipe was saved, scheduled, created, or marked done.'],
  })).slice(0, 24);
}

function makeContentSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'Draft hooks for a short video about discipline'],
    ['en', 'Rewrite this caption to sound sharper but not salesy'],
    ['pt-BR', 'Cria ideias de Reels sobre foco e consistência'],
    ['pt-BR', 'Melhora essa legenda sem publicar nada'],
    ['pt-PT', 'Dá-me tópicos para um vídeo sobre produtividade'],
    ['pt-PT', 'Escreve uma estrutura de roteiro para YouTube'],
    ['mixed', 'Create pontos for an Instagram short sobre liderança'],
    ['mixed', 'Give me um script outline about building Nexus Hub'],
  ] as const;
  return repeatSpecs(messages, 3, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['content'],
    expectedCapabilityIds: ['content.draft_assist'],
    expectedIntent: 'answer',
    forbiddenClaims: ['Do not claim content was published, scheduled, or uploaded.'],
  })).slice(0, 24);
}

function makeFinanceSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'Can I afford a new laptop this month?'],
    ['en', 'Explain how I should think about my software subscription budget'],
    ['pt-BR', 'Como eu devo organizar meu orçamento deste mês?'],
    ['pt-BR', 'Tenho espaço no orçamento para comprar equipamento?'],
    ['pt-PT', 'Ajuda-me a pensar no orçamento mensal sem mexer nas contas'],
    ['pt-PT', 'Explica como separar despesas fixas e variáveis'],
    ['mixed', 'Can I afford isto sem olhar dados bancários reais?'],
    ['mixed', 'Dá-me uma finance summary segura, sem claims de conta'],
  ] as const;
  return repeatSpecs(messages, 3, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['finance'],
    expectedCapabilityIds: ['finance.educational_answer'],
    expectedIntent: 'answer',
    forbiddenClaims: ['Do not claim live bank/account access or exact balances unless a finance read model is cited.'],
  })).slice(0, 24);
}

function makeTriathlonSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'What should I do for training today?'],
    ['en', 'Adjust my run plan after yesterday felt too hard'],
    ['pt-BR', 'Qual treino eu faço hoje?'],
    ['pt-BR', 'Adapta meu treino porque estou com dor muscular'],
    ['pt-PT', 'Que treino tenho hoje?'],
    ['pt-PT', 'Ajuda-me a ajustar a corrida desta semana'],
    ['mixed', 'Hoje tenho treino or rest day?'],
    ['mixed', 'Review meu workout sem marcar nada como scheduled'],
  ] as const;
  return repeatSpecs(messages, 3, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['training'],
    expectedCapabilityIds: ['training.session_explain'],
    expectedIntent: 'read',
    forbiddenClaims: ['Do not claim a session was scheduled or changed without command verification.'],
  })).slice(0, 24);
}

function makeAmbiguousReferenceSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'Move it to Friday'],
    ['en', 'Cancel that'],
    ['en', 'Make it for two people'],
    ['en', 'Use the same plan as last week'],
    ['en', 'Not that one, the other one'],
    ['pt-BR', 'Move isso para sexta'],
    ['pt-BR', 'Cancela aquilo'],
    ['pt-BR', 'Não esse, o outro'],
    ['pt-PT', 'Muda isso para sexta-feira'],
    ['pt-PT', 'Cancela esse compromisso'],
    ['pt-PT', 'Usa o mesmo plano da semana passada'],
    ['mixed', 'Move it para amanhã de manhã'],
  ] as const;
  return repeatSpecs(messages, 3, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['clarify_reference'],
    expectedIntent: 'clarify',
    writeRiskClass: 'B',
    forbiddenClaims: ['Do not execute a write from a pronoun-only reference.'],
  })).slice(0, 30);
}

function makeMultilingualLocaleSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'What changed since yesterday?'],
    ['en', 'Summarize my day in plain English'],
    ['pt-BR', 'O que mudou desde ontem?'],
    ['pt-BR', 'Resume meu dia em português do Brasil'],
    ['pt-PT', 'O que mudou desde ontem?'],
    ['pt-PT', 'Resume o meu dia em português de Portugal'],
    ['mixed', 'Give me o resumo do dia in English'],
    ['mixed', 'Mostra today tasks em português'],
  ] as const;
  return repeatSpecs(messages, 5, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['tasks.today_summary'],
    expectedIntent: 'read',
    forbiddenClaims: ['Do not switch response locale away from the latest user language.'],
  })).slice(0, 40);
}

function makeDeterministicReadSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'What is on my calendar today?'],
    ['en', 'Show my open tasks for today'],
    ['en', 'What changed in my tasks since yesterday?'],
    ['pt-BR', 'Mostra minhas tarefas de hoje'],
    ['pt-BR', 'O que tem na minha agenda hoje?'],
    ['pt-BR', 'O que mudou nas minhas tarefas desde ontem?'],
    ['pt-PT', 'Mostra as minhas tarefas de hoje'],
    ['pt-PT', 'O que tenho no calendário hoje?'],
    ['mixed', 'Show minhas tasks abertas hoje'],
    ['mixed', 'What changed nas tarefas desde ontem?'],
  ] as const;
  return repeatSpecs(messages, 3, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: ['tasks.today_summary'],
    expectedIntent: 'read',
    forbiddenClaims: ['Do not answer from stale context without a deterministic read.'],
  })).slice(0, 30);
}

function makeUnsupportedSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'Transfer money from my savings account now'],
    ['en', 'Give me a legal ruling for my tax case'],
    ['pt-BR', 'Paga essa fatura automaticamente agora'],
    ['pt-BR', 'Me dá um diagnóstico médico definitivo'],
    ['pt-PT', 'Transfere dinheiro para esta conta agora'],
    ['pt-PT', 'Diz exatamente o imposto que devo pagar sem verificar dados'],
    ['mixed', 'Pay this invoice agora sem confirmação'],
    ['mixed', 'Give me medical advice definitivo for pain'],
  ] as const;
  return repeatSpecs(messages, 3, (language, message) => ({
    language,
    message,
    expectedDomainIds: ['finance'],
    expectedCapabilityIds: ['unsupported'],
    expectedIntent: 'unsupported',
    writeRiskClass: 'C',
    forbiddenClaims: ['Do not execute restricted finance, medical, or legal actions.'],
  })).slice(0, 24);
}

function makeWritePreviewSeeds(): SeedSpec[] {
  const messages = [
    ['en', 'Create a task to buy K2 tomorrow'],
    ['en', 'Mark the supplement task done'],
    ['en', 'Create task buy supplements with subtasks K2, D3, creatine'],
    ['pt-BR', 'Cria uma tarefa para comprar K2 amanhã'],
    ['pt-BR', 'Marca a tarefa dos suplementos como concluída'],
    ['pt-BR', 'Crie tarefa comprar suplementos com subtarefas K2, D3, creatina'],
    ['pt-PT', 'Cria uma tarefa para comprar vitamina D amanhã'],
    ['pt-PT', 'Marca a tarefa suplementos como concluída'],
    ['mixed', 'Create tarefa comprar suplementos with subtasks k2 d3 creatina'],
    ['mixed', 'Mark task suplementos como done'],
  ] as const;
  return repeatSpecs(messages, 4, (language, message, round) => ({
    language,
    message: round === 0 ? message : `${message} QA${round}`,
    expectedDomainIds: ['tasks'],
    expectedCapabilityIds: message.toLowerCase().includes('mark') || message.toLowerCase().includes('marca')
      ? ['tasks.complete']
      : ['tasks.create'],
    expectedIntent: 'write_preview',
    writeRiskClass: message.toLowerCase().includes('subtask') || message.toLowerCase().includes('subtarefa') ? 'B' : 'A',
    forbiddenClaims: ['Do not execute without command metadata and readback verification.'],
  })).slice(0, 36);
}

function repeatSpecs<T extends readonly [ChatCoreV2CorpusLanguage, string]>(
  tuples: readonly T[],
  rounds: number,
  build: (language: T[0], message: T[1], round: number) => SeedSpec,
): SeedSpec[] {
  const specs: SeedSpec[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const [language, message] of tuples) {
      specs.push(build(language, message, round));
    }
  }
  return specs;
}
