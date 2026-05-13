// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import type { NexusChatActionability, NexusChatOwnerSkill, NexusChatRiskLevel } from './chat-answer-contract';

export interface ChatSkillCapability {
  skill: NexusChatOwnerSkill;
  displayName: string;
  readableFacts: string[];
  executableActions: string[];
  requiredFields: string[];
  confirmationPolicy: 'never' | 'high_risk' | 'external_write' | 'always';
  verifier: 'none' | 'read_back' | 'provider_read_back' | 'decision_outcome';
  fallbackPolicy: 'deterministic_summary' | 'clarify' | 'decision_center' | 'provider_degraded' | 'blocked';
  privacyPolicy: 'safe_preview' | 'private_detail' | 'sensitive_redacted' | 'owner_admin_only';
  responseCardType: string;
  latencyBudgetMs: number;
}

export interface ChatSkillCapabilityResolution {
  ownerSkill: NexusChatOwnerSkill;
  intent: string;
  actionability: NexusChatActionability;
  riskLevel: NexusChatRiskLevel;
  capability: ChatSkillCapability;
  involvedSkills: NexusChatOwnerSkill[];
}

const CAPABILITIES: ChatSkillCapability[] = [
  {
    skill: 'secretary',
    displayName: 'Secretary',
    readableFacts: ['calendar.events', 'agenda.items', 'availability.windows', 'schedule.conflicts'],
    executableActions: ['schedule_event', 'move_event', 'retry_calendar_sync', 'create_agenda_item'],
    requiredFields: ['title', 'startAt'],
    confirmationPolicy: 'external_write',
    verifier: 'provider_read_back',
    fallbackPolicy: 'provider_degraded',
    privacyPolicy: 'private_detail',
    responseCardType: 'calendar_action',
    latencyBudgetMs: 2500,
  },
  {
    skill: 'tasks',
    displayName: 'Tasks',
    readableFacts: ['task.lists', 'task.items', 'task.provider_sync'],
    executableActions: ['create_task', 'update_task', 'complete_task', 'create_recurring_task'],
    requiredFields: ['title'],
    confirmationPolicy: 'high_risk',
    verifier: 'read_back',
    fallbackPolicy: 'provider_degraded',
    privacyPolicy: 'private_detail',
    responseCardType: 'task_action',
    latencyBudgetMs: 1800,
  },
  {
    skill: 'training',
    displayName: 'Training',
    readableFacts: ['training.today', 'training.week', 'training.plan', 'training.readiness'],
    executableActions: ['explain_session', 'move_workout', 'replace_exercise', 'request_coach_analysis'],
    requiredFields: ['sessionOrPlanReference'],
    confirmationPolicy: 'external_write',
    verifier: 'read_back',
    fallbackPolicy: 'decision_center',
    privacyPolicy: 'private_detail',
    responseCardType: 'training_action',
    latencyBudgetMs: 2200,
  },
  {
    skill: 'cooking',
    displayName: 'Cooking',
    readableFacts: ['meal.plan', 'grocery.list', 'fueling.support'],
    executableActions: ['add_meal_support', 'skip_meal_support', 'create_grocery_list'],
    requiredFields: ['mealOrSessionReference'],
    confirmationPolicy: 'high_risk',
    verifier: 'read_back',
    fallbackPolicy: 'clarify',
    privacyPolicy: 'private_detail',
    responseCardType: 'cooking_action',
    latencyBudgetMs: 2000,
  },
  {
    skill: 'finance',
    displayName: 'Finance',
    readableFacts: ['receipt.status', 'budget.summary', 'payment.reminders'],
    executableActions: ['categorize_receipt', 'create_payment_reminder', 'mark_paid'],
    requiredFields: ['financeEntityReference'],
    confirmationPolicy: 'always',
    verifier: 'read_back',
    fallbackPolicy: 'clarify',
    privacyPolicy: 'sensitive_redacted',
    responseCardType: 'finance_action',
    latencyBudgetMs: 2200,
  },
  {
    skill: 'content',
    displayName: 'Content',
    readableFacts: ['script.status', 'idea.status', 'publish.window'],
    executableActions: ['approve_script', 'request_rewrite', 'schedule_content_work'],
    requiredFields: ['contentEntityReference'],
    confirmationPolicy: 'high_risk',
    verifier: 'read_back',
    fallbackPolicy: 'deterministic_summary',
    privacyPolicy: 'private_detail',
    responseCardType: 'content_action',
    latencyBudgetMs: 2400,
  },
  {
    skill: 'decision_center',
    displayName: 'Decision Center',
    readableFacts: ['decision.item', 'decision.outcome', 'decision.alternatives'],
    executableActions: ['choose_option', 'dismiss_decision', 'snooze_decision'],
    requiredFields: ['decisionId'],
    confirmationPolicy: 'high_risk',
    verifier: 'decision_outcome',
    fallbackPolicy: 'clarify',
    privacyPolicy: 'safe_preview',
    responseCardType: 'decision_action',
    latencyBudgetMs: 1800,
  },
  {
    skill: 'connections',
    displayName: 'Connections',
    readableFacts: ['provider.status', 'oauth.state', 'sync.health'],
    executableActions: ['retry_sync', 'open_connection'],
    requiredFields: ['provider'],
    confirmationPolicy: 'never',
    verifier: 'provider_read_back',
    fallbackPolicy: 'provider_degraded',
    privacyPolicy: 'safe_preview',
    responseCardType: 'provider_status',
    latencyBudgetMs: 1500,
  },
  {
    skill: 'notifications',
    displayName: 'Notifications',
    readableFacts: ['notification.intent', 'apns.status', 'preference.state'],
    executableActions: ['explain_notification', 'update_preference'],
    requiredFields: ['notificationReference'],
    confirmationPolicy: 'high_risk',
    verifier: 'read_back',
    fallbackPolicy: 'blocked',
    privacyPolicy: 'safe_preview',
    responseCardType: 'notification_action',
    latencyBudgetMs: 1400,
  },
  {
    skill: 'owner_admin',
    displayName: 'Owner/Admin',
    readableFacts: ['release.health', 'provider.ops', 'model.routing'],
    executableActions: ['acknowledge_ops_decision'],
    requiredFields: ['opsDecisionId'],
    confirmationPolicy: 'always',
    verifier: 'decision_outcome',
    fallbackPolicy: 'blocked',
    privacyPolicy: 'owner_admin_only',
    responseCardType: 'owner_admin_action',
    latencyBudgetMs: 2000,
  },
];

const SKILL_BY_DOMAIN: Partial<Record<DomainName, NexusChatOwnerSkill>> = {
  secretary: 'secretary',
  triathlon: 'training',
  cooking: 'cooking',
  finance: 'finance',
  content: 'content',
};

export function getChatSkillCapabilityRegistry(): ChatSkillCapability[] {
  return CAPABILITIES.map((capability) => ({ ...capability }));
}

export function getChatSkillCapability(skill: NexusChatOwnerSkill): ChatSkillCapability {
  return CAPABILITIES.find((capability) => capability.skill === skill) ?? fallbackCapability(skill);
}

export function resolveChatSkillCapability(input: {
  message: string;
  routedDomain?: DomainName;
  involvedSkills?: string[];
}): ChatSkillCapabilityResolution {
  const normalized = input.message.toLowerCase();
  const involved = new Set<NexusChatOwnerSkill>();
  for (const skill of input.involvedSkills ?? []) {
    const normalizedSkill = normalizeSkill(skill);
    if (normalizedSkill) involved.add(normalizedSkill);
  }
  const domainOwner = input.routedDomain ? SKILL_BY_DOMAIN[input.routedDomain] : undefined;
  if (domainOwner) involved.add(domainOwner);

  const direct = inferSkillFromText(normalized);
  if (direct) involved.add(direct);

  const ownerSkill = direct ?? domainOwner ?? [...involved][0] ?? 'chat';
  const intent = inferIntent(normalized, ownerSkill);
  const actionability = inferActionability(normalized, intent);
  const riskLevel = inferRiskLevel(normalized, ownerSkill, actionability);
  const capability = getChatSkillCapability(ownerSkill);
  return {
    ownerSkill,
    intent,
    actionability,
    riskLevel,
    capability,
    involvedSkills: [...new Set([ownerSkill, ...involved])],
  };
}

function normalizeSkill(skill: string): NexusChatOwnerSkill | null {
  const value = skill.toLowerCase().replace(/[-\s]/g, '_');
  if (value === 'calendar') return 'secretary';
  if (value === 'task') return 'tasks';
  if (value === 'decision' || value === 'decision_center') return 'decision_center';
  if (value === 'provider' || value === 'integration') return 'connections';
  return CAPABILITIES.some((capability) => capability.skill === value) ? value as NexusChatOwnerSkill : null;
}

function inferSkillFromText(text: string): NexusChatOwnerSkill | null {
  if (/\b(calendar|agenda|event|meeting|schedule|outlook|google|calend[aá]rio|evento|reuni[aã]o|agendar)\b/.test(text)) return 'secretary';
  if (/\b(task|todo|to-do|tarefa|tarefas|subtask|checklist)\b/.test(text)) return 'tasks';
  if (/\b(training|workout|run|gym|coach|race|marathon|treino|corrida|muscula[cç][aã]o|maratona)\b/.test(text)) return 'training';
  if (/\b(meal|food|recipe|grocery|fuel|fueling|comida|receita|mercado|refei[cç][aã]o)\b/.test(text)) return 'cooking';
  if (/\b(invoice|receipt|payment|budget|finance|fatura|recibo|pagamento|or[cç]amento)\b/.test(text)) return 'finance';
  if (/\b(script|content|post|video|publish|roteiro|conte[uú]do|publicar)\b/.test(text)) return 'content';
  if (/\b(decision|decide|option|choice|decis[aã]o|escolha|op[cç][aã]o)\b/.test(text)) return 'decision_center';
  if (/\b(connection|provider|sync|oauth|garmin|strava|health|conex[aã]o|sincroniza)\b/.test(text)) return 'connections';
  if (/\b(notification|push|apns|alert|notifica[cç][aã]o|alerta)\b/.test(text)) return 'notifications';
  if (/\b(release|deploy|model scan|provider outage|ops|admin|production|staging)\b/.test(text)) return 'owner_admin';
  return null;
}

function inferIntent(text: string, ownerSkill: NexusChatOwnerSkill): string {
  if (/\b(why|explain|porque|por que|explica)\b/.test(text)) return `${ownerSkill}.explain`;
  if (/\b(create|add|schedule|book|cria|criar|adiciona|agendar|marcar|colocar|coloca)\b/.test(text)) return `${ownerSkill}.create`;
  if (/\b(move|reschedule|adjust|change|mover|remarcar|ajustar|alterar)\b/.test(text)) return `${ownerSkill}.adjust`;
  if (/\b(cancel|delete|remove|apagar|cancelar|remover)\b/.test(text)) return `${ownerSkill}.destructive`;
  if (/\b(show|list|open|what|mostra|listar|abrir|quais)\b/.test(text)) return `${ownerSkill}.read`;
  return `${ownerSkill}.answer`;
}

function inferActionability(text: string, intent: string): NexusChatActionability {
  if (/\b(cancel|delete|remove|apagar|cancelar|remover)\b/.test(text)) return 'preview';
  if (/\b(create|add|schedule|book|move|reschedule|adjust|change|cria|criar|adiciona|agendar|marcar|colocar|coloca|mover|remarcar|ajustar|alterar)\b/.test(text)) return 'execute';
  if (intent.endsWith('.read') || intent.endsWith('.explain')) return 'answer_only';
  if (/\b(decide|choose|escolher|decidir)\b/.test(text)) return 'decision_center';
  return 'answer_only';
}

function inferRiskLevel(text: string, ownerSkill: NexusChatOwnerSkill, actionability: NexusChatActionability): NexusChatRiskLevel {
  if (/\b(cancel|delete|remove|clear|apagar|cancelar|remover|limpar)\b/.test(text)) return 'high';
  if (ownerSkill === 'finance' && actionability !== 'answer_only') return 'high';
  if (actionability === 'execute' || actionability === 'preview') return 'medium';
  return 'low';
}

function fallbackCapability(skill: NexusChatOwnerSkill): ChatSkillCapability {
  return {
    skill,
    displayName: skill,
    readableFacts: [],
    executableActions: [],
    requiredFields: [],
    confirmationPolicy: 'high_risk',
    verifier: 'none',
    fallbackPolicy: 'clarify',
    privacyPolicy: 'safe_preview',
    responseCardType: 'answer',
    latencyBudgetMs: 3000,
  };
}
