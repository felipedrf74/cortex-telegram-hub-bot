// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DefaultDomainName, ClassificationResult } from '../domains/types';
import { classifyMessage } from '../services/anthropic';
import { getClassificationHints } from '../skills/skill-config';
import { logger } from '../utils/logger';

export interface ConversationContext {
  domain: DomainName;
  lastAssistantMessage: string;
}

// ─── Pattern-based quick matching (no API call) ─────────────────────

const DOMAIN_PATTERNS: Record<DefaultDomainName, RegExp[]> = {
  secretary: [
    /^\/(sec|agenda|schedule|todo|todos|done|undone|remind|email|week|day|plan|review|move|cancel)\b/i,
    /^\/(lists|tasks|newtask|newlist|deletelist|deletetask|due|priority|search|todosummary|digest|digesttime)\b/i,
    /^\/(overdue|duetoday|dueweek|movetask|alltasks|completed|edittask|notetask|addstep|steps)\b/i,
  ],
  triathlon: [
    /^\/(train|gym|run|bike|checkin|meal|macros|deload|pain|running|cycling|plan|workout|session|logworkout)\b/i,
  ],
  content: [
    /^\/(content|video|reel|script|caption|thumbnail|trend|ideas|discover|deepsearch|sources|hotnews)\b/i,
    /^\/(trending|reaction|hooks|genscript|titles|genthumbnail|gencaption)\b/i,
    /^\/(competitor|gaps|seo|repurpose|feedback|report)\b/i,
  ],
  finance: [
    /^\/(finance|budget|expense|tax|darf|receipt|invoice)\b/i,
  ],
  cooking: [
    /^\/(cook|recipe|recipes|meal|mealplan|shopping|shoppinglist|menu)\b/i,
  ],
  connections: [
    /^\/(connections?|integrations?|sync|reconnect|providers?)\b/i,
  ],
  notifications: [
    /^\/(notif(?:ication)?s?|alerts?|push|quiet)\b/i,
  ],
  decision_center: [
    /^\/(decis(?:ion)?s?|choices?|snooze|dismiss(?:ed)?|followup)\b/i,
  ],
};

export function patternMatch(message: string): DomainName | null {
  const trimmed = message.trim();
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        return domain as DomainName;
      }
    }
  }
  return null;
}

// ─── Natural language keyword matching (no API call) ────────────────

const NL_KEYWORD_ROUTES: { domain: DomainName; pattern: RegExp }[] = [
  // Domain-specific unique keywords — EN + PT-BR (checked first for specificity)
  { domain: 'triathlon', pattern: /\b(workout|gym(?:\s+session)?|running\s+plan|cycling\s+plan|sets?\s*[x×]\s*\d|training(?:\s+plan)?|deload|squat|deadlift|bench\s+press|heart\s+rate|RPE|RIR|tempo\s+run|intervals?|FTP|soreness|recovery(?:\s+day)?|readiness|body\s+battery|muscle|hypertrophy|endurance|coach\s*(?:report|briefing|rec)|lower\s+body|upper\s+body|periodization|mesocycle|microcycle|training\s+week|log\s+(?:workout|session)|workout\s+plan|auto.?adjust|session\s+complete|my\s+plan|adherence|treino|corrida|pedal(?:ada)?|muscula[çc][aã]o|agachamento|supino|levantamento\s+terra|frequ[eê]ncia\s+card[ií]aca|dor\s+muscular|recupera[çc][aã]o|prontid[aã]o|bateria\s+corporal|s[eé]ries?\s*[x×]\s*\d|academia|plano\s+de\s+treino|plano\s+da\s+semana|semana\s+de\s+treino|treino\s+de\s+(?:hoje|amanh[ãa]))\b/i },
  { domain: 'content', pattern: /\b(youtube|instagram|reels?|thumbnail|video\s+(?:idea|script)|content\s+(?:strategy|calendar|idea)|caption|hashtag|subscribers?|audience|viral|hook|CTA|engagement|script|title\s+ideas?|v[ií]deo|roteiro|legenda|inscritos|miniatura|conte[uú]do|id[eé]ia\s+de\s+(?:v[ií]deo|conte[uú]do)|calend[aá]rio\s+(?:de\s+)?conte[uú]do|engajamento|t[ií]tulos?)\b/i },
  { domain: 'finance', pattern: /\b(despesas?|gastos?|or[çc]amento|imposto|carn[eê]-le[aã]o|DARF|receita\s+federal|nota\s+fiscal|budget|expenses?|spending|tax(?:es)?|income\s+tax|financial|freelancer?\s+tax|dedu[çc][aã]o|faturamento|receipt|receipts|invoice|invoices|merchant|bill|bills|accountant|contador|contabilista|NF(?:-?e)?)\b/i },
  { domain: 'cooking', pattern: /\b(recipe|recipes|meal\s+plan|meal\s+prep|shopping\s+list|cook(?:ing)?|ingredient|groceries|what\s+(?:to|should\s+I)\s+(?:cook|eat|make)|dinner\s+ideas?|breakfast\s+ideas?|lunch\s+ideas?|receita|cardápio|lista\s+de\s+compras|cozinhar|refeição|jantar|almoço|café\s+da\s+manhã)\b/i },
  // Secretary catch-all — EN + PT-BR (common task/scheduling language)
  { domain: 'secretary', pattern: /\b(tasks?|to-?dos?|remind(?:ers?)?|(?:my\s+)?calendar|schedule|meetings?|appointments?|(?:my\s+)?emails?|inbox|overdue|due\s+(?:today|tomorrow|this\s+week)|planning|digest|unread|mark\s+(?:as\s+)?(?:done|complete)|pending|priority|deadline|tarefas?|lembretes?|agend(?:a|ar)|reuni[oõ]es?|compromissos?|e-?mails?|caixa\s+de\s+entrada|atrasad[ao]s?|pra\s+hoje|pendentes?|prioridade|prazo)\b/i },
];

const CONTENT_INTENT_PATTERNS: RegExp[] = [
  /\b(write|create|generate|make|draft|outline|rewrite|improve|give|suggest|organi[sz]e|prioriti[sz]e)\b[\s\S]{0,80}\b(script|caption|hook|hooks|title|titles|thumbnail|thumbnails|reel|reels|video|videos|post|posts|content)\b/i,
  /\b(escrev(?:e|a)|cria|crie|gera|gerar|faz|faça|rascunha|reescreve|melhora)\b[\s\S]{0,80}\b(roteiro|legenda|gancho|ganchos|t[íi]tulo|t[íi]tulos|miniatura|miniaturas|reel|reels|v[ií]deo|v[ií]deos|post|posts|conte[uú]do)\b/i,
  /\b(help\s+me\s+script|write|draft|outline)\b[\s\S]{0,40}\b(intro|opening|outro|hook)\b/i,
  /\b(me\s+ajuda\s+a\s+escrever|escrev(?:e|a)|cria|gera)\b[\s\S]{0,40}\b(intro|abertura|gancho|encerramento)\b/i,
  /\b(id[eé]ias?\s+de\s+conte[uú]do|id[eé]ias?\s+para\s+um?\s+v[ií]deo|hooks?\s+para\s+um?\s+v[ií]deo|t[íi]tulos?\s+melhores?\s+para\s+um?\s+v[ií]deo|[âa]ngulos?\s+de\s+thumbnail|feedback\s+neste?\s+roteiro|planej(?:ar|a)\s+uma\s+grava[çc][aã]o|formatos?\s+de\s+conte[uú]do)\b/i,
  /\b(content\s+ideas?|ideas?\s+for\s+(?:a\s+)?video|better\s+titles?\s+for\s+(?:a\s+)?video|organi[sz]e\s+my\s+content\s+ideas|what\s+(?:content\s+is\s+already\s+ready|is\s+already)\s+on\s+my\s+desk(?:\s+for\s+content)?|what\s+performed\s+best|what\s+are\s+we\s+learning(?:\s+this\s+week)?|what\s+hook(?:s)?\s+are\s+working|what\s+format\s+is\s+(?:winning|working)|filming\s+day|schedule\s+filming\s+around\s+my\s+week|plan\s+filming\s+around\s+my\s+week|what\s+should\s+i\s+publish\s+next|what\s+should\s+i\s+work\s+on\s+next\s+for\s+content)\b/i,
];

const FINANCE_REFINEMENT_PATTERNS = [
  /\b(categori[sz]e|reclassif(?:y|ies)|tag|mark|split|rename|attach|file|reconcile|deductible|business\s+expense|personal\s+expense|software|travel|meals?)\b/i,
  /\b(categoriza|reclassifica|marca|separa|divide|renomeia|anexa|lan[çc]a|reconcilia|dedut[ií]vel|despesa\s+(?:da\s+empresa|pessoal)|software|viagem|refei[çc][aã]o|almo[cç]o|jantar)\b/i,
];

const FINANCE_INTENT_PATTERNS: RegExp[] = [
  /\b(create|add|log|record|categori[sz]e|analy[sz]e)\b[\s\S]{0,80}\b(expense|expenses|receipt|receipts|invoice|invoices|bill|bills|subscription|subscriptions|budget|tax(?:es)?)\b/i,
  /\b(cria|crie|adiciona|adicione|registra|registre|lan[çc]a|lan[cç]ar|cadastra|categoriza|categorize|analisa)\b[\s\S]{0,80}\b(despesa|despesas|gasto|gastos|recibo|recibos|fatura|faturas|nota\s+fiscal|assinatura|assinaturas|or[çc]amento|imposto|impostos)\b/i,
  /\b(despesa\s+manual|gasto\s+manual|resumo\s+financeiro|or[çc]amento\s+restante|conta\s+fiscal|contas\s+fiscais|assinaturas?\s+para\s+renovar|recibos?\s+ou\s+faturas?\s+ainda\s+faltam|o\s+que\s+devo\s+enviar\s+ao\s+meu\s+contabilista|o\s+que\s+devo\s+mandar\s+ao\s+meu\s+contador|quanto\s+gastei\s+este\s+mes|que\s+faturas\s+registei\s+este\s+mes|what\s+subscriptions?\s+renew\s+soon|which\s+subscriptions?\s+renew\s+soon|what\s+bills?\s+are\s+still\s+missing\s+this\s+month|what\s+should\s+i\s+send\s+to\s+my\s+accountant|how\s+much\s+did\s+i\s+spend\s+this\s+month|what\s+invoices?\s+did\s+i\s+file\s+this\s+month)\b/i,
];

const SECRETARY_INTENT_PATTERNS: RegExp[] = [
  /\b(create|add|schedule|move|reschedule|delete|remove|cancel|summari[sz]e|review|list|show)\b[\s\S]{0,80}\b(task|tasks|to-?do|to-?dos|calendar|meeting|meetings|appointment|appointments|event|events|focus\s+block|reminder|reminders|agenda|email|emails|inbox)\b/i,
  /\b(cria|crie|adiciona|adicione|marca|agenda|move|muda|remarca|reagenda|apaga|remove|cancela|resume|revisa|lista|mostra)\b[\s\S]{0,80}\b(tarefa|tarefas|agenda|calend[aá]rio|reuni[aã]o|reuni[oõ]es|compromisso|compromissos|evento|eventos|bloco\s+de\s+foco|lembrete|lembretes|e-?mail|e-?mails|caixa\s+de\s+entrada)\b/i,
];

const SECRETARY_STRONG_OPERATIONAL_PATTERNS: RegExp[] = [
  /\b(remind\s+me\s+to|set\s+(?:me\s+)?a\s+reminder\s+to|create\s+(?:me\s+)?a\s+reminder\s+to|create\s+(?:a\s+)?task\s+to|add\s+(?:a\s+)?task\s+to|add\s+this\s+to\s+my\s+to-?do(?:\s+list)?|schedule\s+time\s+to)\b/i,
  /\b(me\s+lembra\s+de|cria\s+(?:um\s+)?lembrete\s+para|define\s+(?:um\s+)?lembrete\s+para|cria\s+(?:uma\s+)?tarefa\s+para|adiciona\s+(?:uma\s+)?tarefa\s+para|adiciona\s+isso\s+na\s+minha\s+lista|agenda\s+tempo\s+para)\b/i,
  /\b(schedule|book|move|reschedule|reserve|set\s+aside|find)\b[\s\S]{0,80}\b(filming|recording|editing|publish(?:ing)?|shoot|video|reel)\b[\s\S]{0,40}\b(block|time|slot|window|session)\b/i,
  /\b(schedule|book|move|reschedule|reserve|set\s+aside|find)\b[\s\S]{0,80}\b(block|time|slot|window|session)\b[\s\S]{0,40}\b(filming|recording|editing|publish(?:ing)?|shoot|video|reel)\b/i,
  /\b(agenda|marca|move|muda|remarca|reagenda|reserva|separa)\b[\s\S]{0,80}\b(grava[çc][aã]o|filmagem|edi[çc][aã]o|publica(?:r|[çc][aã]o)|v[ií]deo|reel)\b[\s\S]{0,40}\b(bloco|hor[aá]rio|janela|sess[aã]o|tempo)\b/i,
  /\b(agenda|marca|move|muda|remarca|reagenda|reserva|separa)\b[\s\S]{0,80}\b(bloco|hor[aá]rio|janela|sess[aã]o|tempo)\b[\s\S]{0,40}\b(grava[çc][aã]o|filmagem|edi[çc][aã]o|publica(?:r|[çc][aã]o)|v[ií]deo|reel)\b/i,
  /\b(schedule|book|move|reschedule|reserve|set\s+aside|find|protect)\b[\s\S]{0,80}\b(sponsor(?:ed)?\s+post|sponsor\s+deliverable|publish(?:ing)?|post|upload|recording|filming|editing|video|reel)\b[\s\S]{0,80}\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|next\s+month|morning|afternoon|evening|at\s+\d)\b/i,
  /\b(agenda|marca|move|muda|remarca|reagenda|reserva|separa|protege)\b[\s\S]{0,80}\b(publica(?:r|[çc][aã]o)|post\s+patrocinado|entrega\s+de\s+patroc[ií]nio|upload|grava[çc][aã]o|filmagem|edi[çc][aã]o|v[ií]deo|reel)\b[\s\S]{0,80}\b(hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|pr[oó]xima\s+semana|pr[oó]ximo\s+m[eê]s|manh[ãa]|tarde|noite|[àa]s?\s*\d)\b/i,
  /\b(schedule|book|move|reschedule|reserve|set\s+aside|find|protect)\b[\s\S]{0,80}\b(invoice|receipt|receipts|bill|bills|tax|taxes|darf|subscription|subscriptions|accountant)\b[\s\S]{0,80}\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|next\s+month|morning|afternoon|evening|at\s+\d)\b/i,
  /\b(agenda|marca|move|muda|remarca|reagenda|reserva|separa|protege)\b[\s\S]{0,80}\b(fatura|faturas|recibo|recibos|conta|contas|imposto|darf|assinatura|assinaturas|contador|contabilista)\b[\s\S]{0,80}\b(hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|pr[oó]xima\s+semana|pr[oó]ximo\s+m[eê]s|manh[ãa]|tarde|noite|[àa]s?\s*\d)\b/i,
  /\b(send|pay|file|review|renew|cancel|follow\s+up\s+on|follow\s+up\s+with)\b[\s\S]{0,80}\b(invoice|receipt|receipts|bill|bills|tax|darf|subscription|subscriptions|accountant)\b[\s\S]{0,80}\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|next\s+month|morning|afternoon|evening|at\s+\d)\b/i,
  /\b(envia|paga|lan[çc]a|rev[eê]|renova|cancela|faz\s+follow-?up(?:\s+com)?|cobra)\b[\s\S]{0,80}\b(fatura|faturas|recibo|recibos|conta|contas|imposto|darf|assinatura|assinaturas|contador|contabilista)\b[\s\S]{0,80}\b(hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|pr[oó]xima\s+semana|pr[oó]ximo\s+m[eê]s|manh[ãa]|tarde|noite|[àa]s?\s*\d)\b/i,
];

const COOKING_INTENT_PATTERNS: RegExp[] = [
  /\b(recipe|recipes|meal\s+plan|meal\s+prep|shopping\s+list|batch\s+cook(?:ing)?|dinner|breakfast|lunch|snack|menu|grocer(?:y|ies)|what\s+(?:to|should\s+I)\s+(?:cook|eat|make)|jantar|almo[cç]o|caf[eé]\s+da\s+manh[aã]|lanche|refei[çc][aã]o|lista\s+de\s+compras|receita)\b/i,
  /caf[eé]\s+da\s+manh[aã]|almo[cç]o|jantar|lanche|refei[çc][aã]o|lista\s+de\s+compras|receita/i,
  /\b(?:me\s+)?(sugere?|passa|adapta|monta|cria)\b[\s\S]{0,80}\b(jantar|almo[cç]o|caf[eé]\s+da\s+manh[aã]|refei[çc][aã]o|lanche|snack|menu|lista\s+de\s+compras|receita)\b/i,
  /\b(o\s+que\s+eu\s+devo\s+comer|ideia\s+de\s+almo[cç]o|batch\s+cooking|lista\s+de\s+compras|sugere?\s+uma\s+receita|snack\s+para\s+recupera[çc][aã]o)\b/i,
  /\b(what\s+should\s+i\s+eat\s+before|high\s+protein\s+breakfast|weekly\s+menu|monday\s+to\s+sunday\s+menu|menu\s+focused\s+on\s+performance|grocery\s+list\s+by\s+aisle|meal\s+ideas?|protein-?rich\s+(?:breakfast|lunch|dinner|snack)|meal\s+prep\s+ideas?)\b/i,
  /\b(carnivore\s+breakfast|breakfast\s+ideas?|fuel\s+after|refuel\s+after|fuel\s+on\s+travel\s+days?|travel\s+day\s+fuel|post-?workout\s+meal|pre-?workout\s+meal|pre-?workout\s+snacks?|post-?workout\s+snacks?|snacks?\s+(?:for|before|after)\s+(?:a|the|my)?\s*(?:hard\s+)?(?:workout|training|ride)|adapt\s+my\s+meals?|lighter\s+recovery\s+day|recovery\s+day\s+meal|batch-?cook\s+plan|prep\s+my\s+meals)\b/i,
  /\b(caf[eé]\s+da\s+manh[aã]\s+carn[ií]voro|alimenta[çc][aã]o\s+p[oó]s-?treino|alimenta[çc][aã]o\s+em\s+dias?\s+de\s+viagem|snacks?\s+para\s+antes\s+do\s+treino|lanche(?:s)?\s+pr[eé]-?treino|o\s+que\s+comer\s+antes|o\s+que\s+comer\s+depois|adapta\s+minhas\s+refei[çc][aã]es|dia\s+de\s+recupera[çc][aã]o|plano\s+de\s+batch\s+cook|preparar\s+refei[çc][aã]es|plano\s+alimentar|ideias?\s+de\s+refei[çc][aã]es?|jantar\s+rico\s+em\s+prote[ií]na)\b/i,
  /\b(store|preserve|keep|refrigerat(?:e|ed|ing)|freeze|thaw|fridge|freezer|shelf\s+life|last(?:ing)?|conserv(?:e|es|ed|ing|ar|o|a)|guard(?:ar|o|a)|armazen(?:ar|o|a)|refriger(?:ar|o|a)|congel(?:ar|o|a)|geladeira|frigor[ií]fico|frigorifico|durar|estraga(?:r)?)\b[\s\S]{0,60}\b(food|meal|ingredient|ingredients|vegetable|vegetables|fruit|fruits|leftovers?|comida|ingrediente|ingredientes|legume|legumes|vegetal|vegetais|fruta|frutas|sobras|cenoura|carrot|banana|alface|frango|arroz|queijo|ovo|ovos)\b/i,
  /\b(ralar|ralada|grate|grated)\b[\s\S]{0,30}\b(cenoura|carrot)\b[\s\S]{0,60}\b(guard(?:ar|o|a)|conserv(?:ar|o|a)|armazen(?:ar|o|a)|geladeira|fridge|refrigerator|refriger(?:ar|o|a)|durar|last)\b/i,
];

const TRAINING_INTENT_PATTERNS: RegExp[] = [
  /\b(how\s+much|how\s+many|set|adjust|calculate|dial\s+in|review|optimi[sz]e|what\s+should\s+my|what\s+are\s+my|help\s+me\s+hit)\b[\s\S]{0,80}\b(protein(?:\s+(?:intake|target))?|macros?|calories?|carbs?|fat|electrolytes?|creatine|supplements?)\b/i,
  /\b(carnivore\s+diet|cutting\s+macros?|bulking\s+macros?|maintenance\s+calories?|sports?\s+nutrition|performance\s+nutrition)\b/i,
  /\b(quanto|quanta|quantos|quantas|define|ajusta|calcula|alinha|revisa|otimiza|qual\s+(?:deve\s+ser|é)\s+(?:a\s+)?minha|me\s+ajuda\s+a\s+bater)\b[\s\S]{0,80}\b(prote[ií]na(?:\s+(?:di[aá]ria|alvo))?|macros?|calorias?|carbo(?:idratos)?|gordura|eletr[oó]litos?|creatina|suplementos?)\b/i,
  /\b(dieta\s+carn[ií]vora|macros?\s+para\s+(?:cut|bulk|ganhar\s+massa|secar)|calorias?\s+de\s+manuten[çc][aã]o|nutri[çc][aã]o\s+esportiva|nutri[çc][aã]o\s+de\s+performance)\b/i,
];

export function keywordMatch(message: string): DomainName | null {
  // Explicit "make content" asks should beat subject-matter vocabulary
  // from other domains, e.g. "Write a script about recovery intervals".
  if (CONTENT_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'content';
  }
  // Explicit secretary actions should beat training/topic nouns such as
  // "training" when the user is clearly asking to create, move, delete,
  // or summarize a task/calendar item.
  if (SECRETARY_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'secretary';
  }
  if (SECRETARY_STRONG_OPERATIONAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'secretary';
  }
  // Explicit bookkeeping and fiscal actions should beat meal nouns such as
  // "almoço" when the user is clearly creating or categorizing an expense.
  if (FINANCE_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'finance';
  }
  // Explicit food/meal asks should beat training-topic vocabulary such as
  // "treino", "recuperação", or "leg day" when the user is clearly asking
  // for meals, recipes, menus, or shopping.
  if (COOKING_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'cooking';
  }
  // Training should own coaching logic, target-setting, and physiology-aware
  // nutrition decisions, but not meal execution. Put these after cooking so
  // meal-plan / recipe / menu prompts still land in cooking.
  if (TRAINING_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'triathlon';
  }

  // Check domain-specific keywords first (non-secretary for specificity)
  for (const { domain, pattern } of NL_KEYWORD_ROUTES) {
    if (domain !== 'secretary' && pattern.test(message)) {
      return domain;
    }
  }
  // Secretary last (broader match)
  for (const { domain, pattern } of NL_KEYWORD_ROUTES) {
    if (domain === 'secretary' && pattern.test(message)) {
      return domain;
    }
  }
  return null;
}

export function hasStrongSecretaryIntent(message: string): boolean {
  return SECRETARY_INTENT_PATTERNS.some((pattern) => pattern.test(message))
    || SECRETARY_STRONG_OPERATIONAL_PATTERNS.some((pattern) => pattern.test(message));
}

// ─── Dynamic classifier prompt builder ──────────────────────────────

/**
 * Build the classifier hints text from registered skill classification hints.
 */
export function buildClassifierHints(): string {
  const hints = getClassificationHints();
  if (hints.length === 0) return '';
  return hints.map(h =>
    `- "${h.label}" — ${h.description}`
  ).join('\n');
}

// ─── Claude-based classification ────────────────────────────────────

/**
 * Route a user message through Claude classification.
 *
 * April 9 2026: added optional `userId` so the downstream
 * `trackedCreate` / `completeOneShotWithFallback` calls attribute
 * the classification cost row to the real user. Callers that don't
 * have a user in scope (tests, scheduled jobs) can omit it and the
 * row falls back to `user_id = 0` as before.
 */
export async function classifyWithClaude(
  message: string,
  activeContext?: ConversationContext | null,
  userId?: number,
  tenantId?: number,
): Promise<ClassificationResult> {
  const result = await classifyMessage(message, activeContext ?? undefined, userId, tenantId);
  if (activeContext && result.confidence < 0.6) {
    logger.warn(
      { requested: result.domain, confidence: result.confidence, fallbackDomain: activeContext.domain },
      'Low-confidence classifier result — preserving active conversation domain',
    );
    return { domain: activeContext.domain, confidence: Math.max(result.confidence, 0.51) };
  }
  logger.debug({ result }, 'Claude classification result');
  return result;
}
