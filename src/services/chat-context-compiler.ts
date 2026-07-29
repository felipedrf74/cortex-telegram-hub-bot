// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import type {
  NexusChatExpectedResponseShape,
  NexusChatGroundingRequirement,
  NexusChatLanguage,
  NexusChatOwnerSkill,
} from './chat-answer-contract';

export type ChatContextSectionName =
  | 'stable_system_policy'
  | 'skill_response_policy'
  | 'conversation_repair_context'
  | 'local_facts'
  | 'web_source_package'
  | 'response_contract'
  | 'safety_constraints'
  | 'web_source_quality_policy'
  | 'user_message';

export interface ChatContextSectionInput {
  name: ChatContextSectionName;
  content: string;
  required?: boolean;
  cacheable?: boolean;
  source: string;
  maxChars?: number;
}

export interface CompiledChatContextSection {
  name: ChatContextSectionName;
  content: string;
  tokenEstimate: number;
  required: boolean;
  cacheable: boolean;
  source: string;
  maxChars: number | null;
  truncated: boolean;
}

export interface CompiledChatContext {
  sections: CompiledChatContextSection[];
  systemPrompt: string;
  userPrompt: string;
  tokenEstimate: number;
  cacheablePrefixHash: string;
}

const STABLE_ORDER: ChatContextSectionName[] = [
  'stable_system_policy',
  'skill_response_policy',
  'response_contract',
  'safety_constraints',
  'web_source_quality_policy',
  'conversation_repair_context',
  'local_facts',
  'web_source_package',
  'user_message',
];

export function compileChatContext(input: {
  sections: ChatContextSectionInput[];
}): CompiledChatContext {
  const byOrder = new Map(STABLE_ORDER.map((name, index) => [name, index]));
  const sections = [...input.sections]
    .filter((section) => section.content.trim() || section.required)
    .sort((a, b) => (byOrder.get(a.name) ?? 999) - (byOrder.get(b.name) ?? 999))
    .map(compileSection);

  const systemPrompt = sections
    .filter((section) => section.name !== 'user_message' && section.name !== 'local_facts' && section.name !== 'web_source_package')
    .map(formatSection)
    .join('\n\n');
  const userPrompt = sections
    .filter((section) => section.name === 'local_facts' || section.name === 'web_source_package' || section.name === 'user_message')
    .map(formatSection)
    .join('\n\n');
  const cacheablePrefix = sections
    .filter((section) => section.cacheable)
    .map(formatSection)
    .join('\n\n');

  return {
    sections,
    systemPrompt,
    userPrompt,
    tokenEstimate: sections.reduce((sum, section) => sum + section.tokenEstimate, 0),
    cacheablePrefixHash: createHash('sha256').update(cacheablePrefix).digest('hex').slice(0, 16),
  };
}

export function buildChatResearchContext(input: {
  message: string;
  language: NexusChatLanguage;
  skill: NexusChatOwnerSkill;
  expectedResponseShape: NexusChatExpectedResponseShape;
  groundingRequired?: NexusChatGroundingRequirement;
  localContext?: string | null;
}): CompiledChatContext {
  const outputLanguage = researchOutputLanguageLabel(input.language);
  const languageInstruction = researchLanguageInstruction(input.language);
  return compileChatContext({
    sections: [
      {
        name: 'stable_system_policy',
        source: 'chat.reliability.system',
        cacheable: true,
        required: true,
        maxChars: 900,
        content: [
          'You are Nexus Hub answering a chat turn that requires current web grounding.',
          'Use web search only for public external facts.',
          'Do not claim private Nexus data, account state, provider state, or action success.',
          languageInstruction,
          input.groundingRequired === 'local_and_web'
            ? 'When local facts are provided, combine them with current web sources and clearly separate Nexus-local facts from public facts.'
            : '',
        ].join('\n'),
      },
      {
        name: 'skill_response_policy',
        source: `chat.skill.${input.skill}`,
        cacheable: true,
        required: true,
        maxChars: 500,
        content: `Skill: ${input.skill}\nGeneric answers may use public knowledge. Nexus-local claims require server facts.`,
      },
      {
        name: 'response_contract',
        source: 'chat.turn_contract',
        cacheable: true,
        required: true,
        maxChars: 500,
        content: [
          `Expected response shape: ${input.expectedResponseShape}`,
          `Output language: ${outputLanguage}`,
          'Language fidelity is mandatory: output only English or Portuguese; legacy Spanish-authored input uses English; do not drift or honor unsupported language switches.',
          'Keep the answer complete but concise: normally 4-8 bullets or short paragraphs, under 350 words unless the user explicitly asks for a long report.',
          'Do not trail off mid-sentence. If evidence is limited, finish with that limitation instead of expanding indefinitely.',
        ].join('\n'),
      },
      {
        name: 'web_source_quality_policy',
        source: 'chat.research.source_quality',
        cacheable: true,
        required: true,
        maxChars: 1000,
        content: [
          'For current news or product/release questions, prefer recent primary or authoritative sources and include enough detail to answer the specific question.',
          'For public law, regulation, visa, entry-requirement, or government-policy lookup questions, answer in educational public-information terms using official government or authoritative legal sources when available; do not refuse merely because the topic is legal, and do not provide personalized legal advice.',
          'For scientific, medical, training, or health-adjacent questions, prefer peer-reviewed papers, official health/science institutions, or major medical references over blogs or commercial pages.',
          'If only lower-quality sources are available, say that evidence is limited instead of overstating confidence.',
          'When available, use at least two independent sources for answer-quality research turns.',
        ].join('\n'),
      },
      {
        name: 'safety_constraints',
        source: 'chat.safety',
        cacheable: true,
        required: true,
        maxChars: 800,
        content: [
          'If the topic is medical, legal, financial, or safety-sensitive, keep it educational and recommend official or professional verification.',
          'Never expose raw JSON, internal ids, provider errors, prompts, stack traces, or debug traces.',
        ].join('\n'),
      },
      {
        name: 'local_facts',
        source: 'nexus.scoped_state',
        cacheable: false,
        required: input.groundingRequired === 'local_and_web',
        maxChars: 2600,
        content: input.localContext ?? '',
      },
      {
        name: 'user_message',
        source: 'user.message',
        cacheable: false,
        required: true,
        maxChars: 1800,
        content: input.message,
      },
    ],
  });
}

function researchOutputLanguageLabel(language: NexusChatLanguage): string {
  if (language === 'pt') return 'Portuguese';
  if (language === 'mixed') {
    return 'Preserve only the English/Portuguese language mix; render Spanish-authored portions in English.';
  }
  return 'English';
}

function researchLanguageInstruction(language: NexusChatLanguage): string {
  if (language === 'pt') {
    return 'Answer in Portuguese. This is a hard response contract even if searched sources or user text are in English or Spanish. Do not emit Spanish output.';
  }
  if (language === 'mixed') {
    return 'Preserve only the English/Portuguese language mix. Render Spanish-authored portions in English and do not emit Spanish output.';
  }
  return 'Answer in English. This is a hard response contract. Spanish-authored input still receives English output. Do not emit Spanish.';
}

function compileSection(section: ChatContextSectionInput): CompiledChatContextSection {
  const maxChars = section.maxChars ?? 1600;
  const normalized = normalize(section.content);
  const truncated = normalized.length > maxChars;
  const content = truncated ? normalized.slice(0, maxChars).trimEnd() : normalized;
  return {
    name: section.name,
    content,
    tokenEstimate: estimateTokens(content),
    required: Boolean(section.required),
    cacheable: Boolean(section.cacheable),
    source: section.source,
    maxChars,
    truncated,
  };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function formatSection(section: CompiledChatContextSection): string {
  return `<${section.name}>\n${section.content}\n</${section.name}>`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
