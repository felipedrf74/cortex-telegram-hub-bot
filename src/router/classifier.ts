// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DefaultDomainName, ClassificationResult } from '../domains/types';
import { classifyMessage } from '../services/anthropic';
import { getActiveProvider } from '../services/provider-registry';
import { getClassificationHints } from '../skills/skill-config';
import { logger } from '../utils/logger';
import { config } from '../config';
import { runOllamaShadowClassification } from '../services/classify-shadow';
import { rethrowAiUsageFailClosedError } from '../services/api-usage-fallback';
import { getActiveChatDomain } from '../services/chat-conversation-state';
import { getCurrentContext } from '../utils/request-context';
import { isManifestRoutingEnabled } from '../services/intent-resolution/manifest-routing-flags';
import { resolveIntent } from '../services/intent-resolution/intent-resolver';
import {
  getClassifierLowConfidenceFloor,
  getClassifierPinnedConfidenceMin,
} from '../services/intent-resolution/confidence';
import {
  buildClassifierCandidateShortlist,
  isManifestClassifierPromptEnabled,
  resolveManifestSkillForDomain,
} from './classifier-prompt-builder';
import { isCurrentChatLiveEvalLocalEngine } from '../services/chat-live-evaluation-context';
import {
  isSkillInferenceAccountDeletionError,
  runWithSkillInferenceAccountAdmission,
} from '../services/skill-inference-service';

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
  { domain: 'triathlon', pattern: /\b(workout|gym\s+(?:session|workout|training|day)|(?:biceps?\s+)?curls?\s+(?:at|in)\s+(?:the\s+)?gym|running\s+plan|cycling\s+plan|sets?\s*[x×]\s*\d|training(?:\s+plan)?|deload|squat|deadlift|bench\s+press|heart\s+rate|RPE|RIR|tempo\s+run|intervals?|FTP|soreness|recovery(?:\s+day)?|readiness|body\s+battery|muscle|hypertrophy|endurance|coach\s*(?:report|briefing|rec)|lower\s+body|upper\s+body|periodization|mesocycle|microcycle|training\s+week|log\s+(?:workout|session)|workout\s+plan|auto.?adjust|session\s+complete|my\s+plan|adherence|treino|corrida|pedal(?:ada)?|muscula[çc][aã]o|agachamento|supino|levantamento\s+terra|frequ[eê]ncia\s+card[ií]aca|dor\s+muscular|recupera[çc][aã]o|prontid[aã]o|bateria\s+corporal|s[eé]ries?\s*[x×]\s*\d|dia\s+de\s+academia|plano\s+de\s+treino|plano\s+da\s+semana|semana\s+de\s+treino|treino\s+de\s+(?:hoje|amanh[ãa]))\b/i },
  { domain: 'content', pattern: /\b(youtube|instagram|reels?|thumbnail|video\s+(?:idea|script)|content\s+(?:strategy|calendar|idea)|caption|hashtag|subscribers?|audience|viral|hook|CTA|engagement|script|title\s+ideas?|v[ií]deo|roteiro|legenda|inscritos|miniatura|conte[uú]do|id[eé]ia\s+de\s+(?:v[ií]deo|conte[uú]do)|calend[aá]rio\s+(?:de\s+)?conte[uú]do|engajamento|t[ií]tulos?)\b/i },
  { domain: 'finance', pattern: /\b(despesas?|gastos?|or[çc]amento|imposto|carn[eê]-le[aã]o|DARF|receita\s+federal|nota\s+fiscal|budget|expenses?|spending|tax(?:es)?|income\s+tax|financial|freelancer?\s+tax|dedu[çc][aã]o|faturamento|receipt|receipts|invoice|invoices|merchant|bill|bills|accountant|contador|contabilista|NF(?:-?e)?)\b/i },
  { domain: 'cooking', pattern: /\b(recipe|recipes|meal\s+plan|meal\s+prep|shopping\s+list|cook(?:ing)?|ingredient|groceries|fueling\s+issue|fueling\s+warning|what\s+(?:to|should\s+I)\s+(?:cook|eat|make)|dinner\s+ideas?|breakfast\s+ideas?|lunch\s+ideas?|receita|cardápio|lista\s+de\s+compras|cozinhar|refeição|jantar|almoço|café\s+da\s+manhã)\b/i },
  // Secretary catch-all — EN + PT-BR (common task/scheduling language)
  { domain: 'secretary', pattern: /\b(tasks?|to-?dos?|remind(?:ers?)?|(?:my\s+)?calendar|schedule|meetings?|appointments?|(?:my\s+)?emails?|inbox|overdue|due\s+(?:today|tomorrow|this\s+week)|planning|digest|unread|mark\s+(?:as\s+)?(?:done|complete)|pending|priority|deadline|tarefas?|lembretes?|agend(?:a|ar)|reuni[oõ]es?|compromissos?|e-?mails?|caixa\s+de\s+entrada|atrasad[ao]s?|pra\s+hoje|pendentes?|prioridade|prazo)\b/i },
];

// Explicit Nexus product-area anchors outrank generic workflow nouns such as
// "task", "schedule", or "summary". Keep these phrases narrow: they close
// observed gaps where a standalone request names its owning product directly,
// without turning ordinary uses of those generic nouns into domain signals.
const EXPLICIT_PRODUCT_AREA_ROUTES: { domain: DomainName; pattern: RegExp }[] = [
  { domain: 'content', pattern: /\b(?:content\s+(?:area|request|workspace|draft|preview)|request\s+(?:a\s+)?(?:safe\s+)?content|specific\s+content|publishing\s+plans?|channel\s+performance|performance\s+(?:of\s+)?(?:the\s+)?channel)\b|[aá]rea\s+de\s+conte[uú]do\b|performance[\s\S]{0,20}\bcanal\b/i },
  { domain: 'finance', pattern: /\b(?:finance|finan[çc]as?|financeir[oa]|finance\s+(?:area|request|workspace)|specific\s+finance|an[aá]lise\s+detalhada\s+d(?:e|as?)\s+contas?)\b|[aá]rea\s+(?:de\s+)?finan[çc]as?\b|[aá]rea\s+financeir[ao]\b/i },
  { domain: 'cooking', pattern: /\b(?:cooking[-\s]+related\s+(?:task|request)|cooking\s+(?:area|request|workspace)|cozinha|cozedura|meal\s+preparation\s+plan|planejamento\s+de\s+refei[cç][oõ]es|regras?\s+de\s+substitui[cç][aã]o\s+de\s+ingredientes|plano\s+de\s+(?:cozedura|refei[cç][oõ]es)|se[cç][aã]o\s+de\s+cozinhar)\b|[aá]rea\s+(?:de\s+)?cozinha\b/i },
  { domain: 'triathlon', pattern: /\b(?:triathlon|triatl(?:o|on)|treinamento)\b|[aá]rea\s+(?:de\s+)?triatl(?:o|on)\b/i },
  { domain: 'secretary', pattern: /\b(?:secretary\s+(?:area|request|workspace)|area\s+within\s+secretary|secret[aá]ria|secret[aá]ria\s+nexus|daily\s+planner|calend[aá]rio\s+pessoal|agendamento)\b|[aá]rea\s+(?:d[ae]\s+)?secret[aá]ria\b/i },
];

// Product-profile nouns exposed by the governed staging QA are deliberately
// narrower than generic verbs such as "show", "preview", or "create".  These
// pairs let the free classifier recognize stable Nexus-owned artifacts while
// preserving the existing LLM fallback for genuinely ambiguous requests.
// Keep the order aligned with primary ownership when a request mentions a
// secondary skill (for example a marketing email, a travel budget, or an email
// to a coach).
const CONTENT_PRODUCT_PROFILE_PATTERNS: RegExp[] = [
  /\b(?:blog|article|social|documentary|newsletter|marketing)\b[\s\S]{0,70}\b(?:drafts?|posts?|videos?|opening|campaign|email\s+series|editorial\s+review)\b/i,
  /\b(?:approved|latest)\s+tagline\b[\s\S]{0,60}\b(?:product\s+)?launch\b/i,
  /\b(?:publish|delete|preview)\b[\s\S]{0,80}\b(?:approved\s+article|article|content\s+drafts?|campaign)\b/i,
  /\b(?:slogan|artigo|texto|publica[cç][aã]o)\b[\s\S]{0,80}\b(?:aprovad[oa]|marca|rascunho\s+editorial|campanha|confirmar)\b/i,
  /\b(?:aprovad[oa]|marca|rascunho\s+editorial|campanha|confirmar)\b[\s\S]{0,80}\b(?:slogan|artigo|texto|publica[cç][aã]o)\b/i,
  /\b(?:repurpose|repurposed)\b[\s\S]{0,70}\b(?:webinar|short-form\s+content)\b/i,
  /\bpublica[cç][oõ]es\b[\s\S]{0,80}\b(?:programadas?|campanha\s+de\s+lan[cç]amento)\b/i,
  /\bartigos?\b[\s\S]{0,80}\bcampanha\b[\s\S]{0,60}\b(?:aguardar|aguardam|revis[aã]o)\b/i,
  /\bescreve\b[\s\S]{0,50}\bpublica[cç][aã]o\b[\s\S]{0,50}\blan[cç]amento\b/i,
];

const FINANCE_PRIMARY_CROSS_SKILL_PATTERNS: RegExp[] = [
  /\b(?:travel|conference)\s+budget\b[\s\S]{0,100}\b(?:calendar|event)\b[\s\S]{0,80}\b(?:unchanged|without\s+changing|not\s+change)\b/i,
  /\b(?:income|spending)\b[\s\S]{0,50}\b(?:income|spending|calendar\s+month)\b/i,
];

const FINANCE_PRODUCT_PROFILE_PATTERNS: RegExp[] = [
  /\b(?:checking|savings|bank)\b[\s\S]{0,60}\b(?:accounts?|balances?|transfer)\b|\b(?:accounts?|balances?|transfer)\b[\s\S]{0,60}\b(?:checking|savings|bank)\b/i,
  /\b(?:card\s+charges?|card\s+purchases?|recategori[sz](?:e|ing)|emergency\s+fund|savings\s+target)\b/i,
  /\b(?:travel|conference)\s+budget\b|\bbudget\b[\s\S]{0,50}\b(?:travel|conference)\b/i,
  /\bsubscriptions?\b[\s\S]{0,50}\b(?:due\s+to\s+renew|renew\s+before|cancel)\b/i,
  /\bcancel\b[\s\S]{0,50}\bsubscriptions?\b/i,
  /\b(?:categori[sz]e|recategori[sz]e)\b[\s\S]{0,50}\b(?:transaction|card\s+charge)\b/i,
  ...FINANCE_PRIMARY_CROSS_SKILL_PATTERNS,
  /\b(?:compras?|movimentos?|lan[cç]amentos?)\b[\s\S]{0,60}\b(?:cart[aã]o|conta\s+[àa]\s+ordem)\b|\bcart[aã]o\b[\s\S]{0,60}\b(?:compras?|movimentos?|lan[cç]amentos?)\b/i,
  /\b(?:meta|reserva)\b[\s\S]{0,50}\b(?:poupan[cç]as?|emerg[eê]ncia)\b|\b(?:poupan[cç]as?|emerg[eê]ncia)\b[\s\S]{0,50}\b(?:meta|reserva)\b/i,
  /\b(?:transfere?|transfira|transferir)\b[\s\S]{0,80}\b(?:conta\s+corrente|conta\s+[àa]\s+ordem|poupan[cç]a)\b/i,
  /\bor[cç]amento\b[\s\S]{0,60}\b(?:alimenta[cç][aã]o|viagem|confer[eê]ncia)\b/i,
  /\b(?:quanto\s+(?:ainda\s+)?posso\s+gastar|categoria\s+lazer|assinaturas?\s+ser[aã]o\s+renovadas?)\b/i,
  /\b(?:saldos?|movimentos?)\b[\s\S]{0,70}\b(?:conta\s+[àa]\s+ordem|poupan[cç]a|superiores?\s+a)\b/i,
];

const SECRETARY_PRODUCT_PROFILE_PATTERNS: RegExp[] = [
  /\b(?:subject\s+lines?|messages?)\b[\s\S]{0,60}\b(?:arrived|received|inbox)\b/i,
  /\b(?:draft|prepare|preview|write)\b[\s\S]{0,60}\b(?:reply|out-of-office|email)\b/i,
  /\b(?:reply|out-of-office|email)\b[\s\S]{0,80}\b(?:unsent|do\s+not\s+send|don'?t\s+send|leave\s+it\s+unsent|change\s+no\s+workouts?)\b/i,
  /\b(?:events?|appointments?)\b[\s\S]{0,60}\b(?:overlap|start|room|notes?)\b/i,
  /\b(?:focus\s+time|one-on-one|client\s+check-in)\b/i,
  /\b(?:marque|reserve|mude|passa)\b[\s\S]{0,60}\b(?:conversa|per[ií]odo\s+de\s+concentra[cç][aã]o|reuni[aã]o|consulta)\b/i,
  /\b(?:consulta|reuni[aã]o)\b[\s\S]{0,60}\b(?:marcada|sala|outra\s+hora|hor[aá]rio\s+diferente)\b/i,
  /\b(?:sala|marcada)\b[\s\S]{0,60}\breuni[aã]o\b/i,
  /\b(?:pr[eé]via|pr[eé]-visualiza[cç][aã]o)\b[\s\S]{0,50}\be-?mail\b[\s\S]{0,100}\bn[aã]o\s+envi(?:e|es)\b/i,
  /\blembra-me\b[\s\S]{0,50}\b(?:levantar|buscar|recolher)\b/i,
  /\bapaga\b[\s\S]{0,50}\bmarca[cç][aã]o\b/i,
];

const TRAINING_PRODUCT_PROFILE_PATTERNS: RegExp[] = [
  /\b(?:split\s+times?|splits?)\b[\s\S]{0,60}\b(?:pool|swim|metres?|meters?|yards?)\b/i,
  /\b(?:log|record|adjust|schedule)\b[\s\S]{0,60}\b(?:swim\s+(?:workout|session)|cycling\s+load|brick\s+(?:workout|session))\b/i,
  /\b(?:sprint[-\s]?triathlon|triathlon)\s+plan\b|\b(?:preview|sketch)\b[\s\S]{0,70}\b(?:triathlon|training)\s+plan\b/i,
  /\b(?:metros?\s+nadei|bloco\s+de\s+treino|carga\s+dos?\s+meus?\s+pr[oó]ximos?\s+treinos?\s+de\s+bicicleta)\b/i,
  /\b(?:esboce?|estrutura|prepare)\b[\s\S]{0,70}\b(?:semana\s+de\s+treinos?|plano\s+de\s+treino|triatlo\s+sprint)\b/i,
  /\b(?:longest\s+duration|longest)\b[\s\S]{0,50}\brun\b|\brun\b[\s\S]{0,50}\blongest\s+duration\b/i,
  /\b(?:apresenta|mostra)\b[\s\S]{0,60}\bpr[eé]-visualiza[cç][aã]o\b[\s\S]{0,70}\btriatlo\s+sprint\b/i,
];

const COOKING_PRODUCT_PROFILE_PATTERNS: RegExp[] = [
  /\b(?:main\s+course|food\s+allerg(?:y|ies)|sourdough|cold-proof|bread\s+recipe)\b/i,
  /\b(?:confirm|approve)\b[\s\S]{0,70}\bgrocery\s+order\b/i,
  /\b(?:confirma|aprova)\b[\s\S]{0,70}\bencomenda\s+de\s+mercearia\b/i,
  /\b(?:dinner|meal-prep)\s+plan\b[\s\S]{0,70}\b(?:food\s+budget|without\s+saving|do\s+not\s+save)\b/i,
  /\b(?:planeje|prepara)\b[\s\S]{0,60}\b(?:comida|refei[cç][oõ]es)\b[\s\S]{0,70}\b(?:restri[cç][oõ]es\s+alimentares|sem\s+guardar)\b/i,
  /\b(?:planeje|prepara)\b[\s\S]{0,160}(?:restri[cç][oõ]es\s+alimentares|sem\s+guardar|n[aã]o\s+guardes?)/i,
];

const CONTENT_INTENT_PATTERNS: RegExp[] = [
  /\b(write|create|generate|make|draft|outline|rewrite|improve|give|suggest|organi[sz]e|prioriti[sz]e)\b[\s\S]{0,80}\b(script|caption|hook|hooks|title|titles|thumbnail|thumbnails|reel|reels|video|videos|post|posts|content)\b/i,
  /\b(escrev(?:e|a)|cria|crie|gera|gerar|faz|faça|rascunha|reescreve|melhora)\b[\s\S]{0,80}\b(roteiro|legenda|gancho|ganchos|t[íi]tulo|t[íi]tulos|miniatura|miniaturas|reel|reels|v[ií]deo|v[ií]deos|post|posts|conte[uú]do)\b/i,
  /\b(write|create|draft|prepare)\b[\s\S]{0,80}\b(?:blog\s+article|article|newsletter|marketing\s+post)\b/i,
  /\b(?:escreve|redige|cria|prepare|prepara)\b[\s\S]{0,80}\b(?:artigo|newsletter|publica[cç][aã]o\s+de\s+marketing)\b/i,
  /\b(help\s+me\s+script|write|draft|outline)\b[\s\S]{0,40}\b(intro|opening|outro|hook)\b/i,
  /\b(me\s+ajuda\s+a\s+escrever|escrev(?:e|a)|cria|gera)\b[\s\S]{0,40}\b(intro|abertura|gancho|encerramento)\b/i,
  /\b(id[eé]ias?\s+de\s+conte[uú]do|id[eé]ias?\s+para\s+um?\s+v[ií]deo|hooks?\s+para\s+um?\s+v[ií]deo|t[íi]tulos?\s+melhores?\s+para\s+um?\s+v[ií]deo|[âa]ngulos?\s+de\s+thumbnail|feedback\s+neste?\s+roteiro|planej(?:ar|a)\s+uma\s+grava[çc][aã]o|formatos?\s+de\s+conte[uú]do)\b/i,
  /\b(content\s+ideas?|ideas?\s+for\s+(?:a\s+)?video|better\s+titles?\s+for\s+(?:a\s+)?video|organi[sz]e\s+my\s+content\s+ideas|what\s+(?:content\s+is\s+already\s+ready|is\s+already)\s+on\s+my\s+desk(?:\s+for\s+content)?|what\s+performed\s+best|what\s+are\s+we\s+learning(?:\s+this\s+week)?|what\s+hook(?:s)?\s+are\s+working|what\s+format\s+is\s+(?:winning|working)|filming\s+day|schedule\s+filming\s+around\s+my\s+week|plan\s+filming\s+around\s+my\s+week|what\s+should\s+i\s+publish\s+next|what\s+should\s+i\s+work\s+on\s+next\s+for\s+content)\b/i,
];

// Product-owned artifacts that are stable routing signals even when the user
// is reading, previewing, or clarifying them rather than invoking a verb from
// the older creation-oriented patterns. Keep these bounded to Nexus nouns so
// generic words such as "workspace", "notes", or "draft" do not become
// catch-all content routes.
const CONTENT_WORKSPACE_PATTERNS: RegExp[] = [
  /\b(editorial\s+(?:briefs?|workspace|backlog)|content\s+briefs?|research\s+notes?|article\s+drafts?)\b/i,
  /\bpautas?\b[\s\S]{0,70}\b(?:espa[cç]o|fila)\s+editorial\b|\b(?:espa[cç]o|fila)\s+editorial\b[\s\S]{0,70}\bpautas?\b|\b(briefings?\s+editoriais|espa[cç]o\s+editorial|fila\s+editorial|notas?\s+de\s+pesquisa|rascunhos?\s+de\s+artigo)\b/i,
  /\bsource[- ]notes?\b[\s\S]{0,70}\b(?:research|folder|titles?)\b|\b(?:research|folder|titles?)\b[\s\S]{0,70}\bsource[- ]notes?\b/i,
  /\b(?:approved|current)\s+(?:content\s+)?briefs?\b[\s\S]{0,80}\b(?:supersed(?:e|ed|ing)|replace|replacing|safeguards?|review)\b|\b(?:supersed(?:e|ed|ing)|replace|replacing|safeguards?|review)\b[\s\S]{0,80}\b(?:approved|current)\s+(?:content\s+)?briefs?\b/i,
  /\b(?:saved\s+ideas?|ideas?)\b[\s\S]{0,70}\b(?:editorial\s+)?backlog\b[\s\S]{0,50}\btheme\b|\btheme\b[\s\S]{0,50}\b(?:editorial\s+)?backlog\b[\s\S]{0,70}\b(?:saved\s+ideas?|ideas?)\b/i,
  /\b(?:pr[eé]via|esbo[cç]o)\b[\s\S]{0,60}\bbriefing\b[\s\S]{0,60}\bguia\b/i,
  /\b(?:t[ií]tulos?|status)\b[\s\S]{0,60}\bpautas?\b(?![\s\S]{0,60}\breuni(?:[aã]o|[oõ]es)\b)|\bpautas?\b(?![\s\S]{0,60}\breuni(?:[aã]o|[oõ]es)\b)[\s\S]{0,60}\b(?:t[ií]tulos?|status)\b/i,
  /\brascunh(?:e|a|ar)\b[\s\S]{0,50}\bpautas?\b(?![\s\S]{0,60}\breuni(?:[aã]o|[oõ]es)\b)/i,
  /\b(?:substituir|trocar|rever|revisar|revise|revisado)\b[\s\S]{0,70}\bartigo(?:\s+j[aá])?\s+aprovado\b|\bartigo(?:\s+j[aá])?\s+aprovado\b[\s\S]{0,70}\b(?:substituir|trocar|rever|revisar|revise|revisado)\b/i,
  /\b(?:esbo[cç]a|esboce|prepara|prepare|estrutura|estruture)\b[\s\S]{0,70}\b(?:artigo\s+(?:introdut[oó]rio|pr[aá]tico)|guia\s+pr[aá]tico)\b[\s\S]{0,80}\b(?:sec[cç][oõ]es|partes|extens[aã]o|palavras?)\b/i,
];

const DECISION_CENTER_WORKSPACE_PATTERNS: RegExp[] = [
  /\b(?:show|list|review)\b[\s\S]{0,40}\b(?:pending|waiting)\s+decisions?\b/i,
  /\b(?:pending|waiting)\s+decisions?\b/i,
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

// Scheduling remains secretary-owned when the thing being placed belongs to
// another skill (meal prep, training, filming, etc.). These patterns encode
// the scheduling operation and its time/calendar object together instead of
// treating the foreign-domain noun as the owner.
const SECRETARY_WORKSPACE_PATTERNS: RegExp[] = [
  /\b(?:weekly\s+)?(?:planning|focus|concentration)\s+blocks?\b/i,
  /\bblocos?\s+de\s+(?:planejamento|planeamento|foco|concentra[cç][aã]o)\b/i,
  /\b(?:schedule|preview|outline|arrange|fit|fits|reschedule|move)\b[\s\S]{0,100}\b(?:commitments?|calendar|agenda|free\s+(?:time|slots?)|available\s+(?:time|slots?))\b/i,
  /\b(?:encaixa|encaixar|organiza|organizar|remarca|remarcar|reagenda|reagendar|move|mover)\b[\s\S]{0,100}\b(?:compromissos?|agenda|calend[aá]rio|hor[aá]rios?\s+livres?|tempo\s+livre)\b/i,
  /\b(?:recipient\s+checks?|recipient\s+review|bulk\s+(?:messages?|emails?)|mailing\s+list)\b/i,
  /\b(?:verifica[cç][aã]o\s+de\s+destinat[aá]rios?|mensagens?\s+em\s+massa|e-?mails?\s+em\s+massa|lista\s+de\s+destinat[aá]rios?)\b/i,
  /\b(?:reschedule|move)\b[\s\S]{0,60}\b(?:conversation|call|meeting)\b/i,
  /\b(?:remarca|remarcar|reagenda|reagendar|move|mover)\b[\s\S]{0,60}\b(?:conversa|chamada|reuni[aã]o)\b/i,
  /\bmessages?\b[\s\S]{0,70}\b(?:many|multiple|several)\s+recipients?\b|\b(?:many|multiple|several)\s+recipients?\b[\s\S]{0,70}\bmessages?\b/i,
  /\b(?:arrange|arranging|prioriti[sz]e|prioriti[sz]ing)\b[\s\S]{0,70}\b(?:busy|overloaded)\s+(?:day|week)\b[\s\S]{0,50}\burgency\b/i,
  /\b(?:mostre|liste|listar)\b[\s\S]{0,60}\beventos?\b[\s\S]{0,50}\bcalend[aá]rio\b|\b(?:excluir|exclua|apagar|apague)\b[\s\S]{0,50}\b(?:s[eé]rie\s+de\s+)?eventos?\b[\s\S]{0,50}\bcalend[aá]rio\b/i,
  /\bpautas?\b[\s\S]{0,60}\breuni(?:[aã]o|[oõ]es)\b|\breuni(?:[aã]o|[oõ]es)\b[\s\S]{0,60}\bpautas?\b/i,
  /\b(?:minuta|rascunho|pedido|vers[aã]o\s+provis[oó]ria)\b[\s\S]{0,80}\b(?:mudar|mudan[cç]a\s+de|pedir)\b[\s\S]{0,50}\b(?:hor[aá]rio|outra\s+hora|reuni[aã]o)\b/i,
  /\b(?:sess(?:[aã]o|ao)|hora)\s+de\s+(?:planeamento|planejamento|foco|concentra[cç][aã]o)\b/i,
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

const COOKING_WORKSPACE_PATTERNS: RegExp[] = [
  /\b(pantry|pantry\s+items?|lentil\s+soup|grocery\s+orders?)\b/i,
  /\b(despensa|itens?\s+da\s+despensa|sopa\s+de\s+lentilhas?|pedidos?\s+de\s+(?:mercearia|supermercado|alimentos))\b/i,
  /\bplanned\b[\s\S]{0,50}\bmeals?\b|\bmeals?\b[\s\S]{0,50}\bplanned\b/i,
  /\bswaps?\b[\s\S]{0,60}\bingredients?\b|\bingredients?\b[\s\S]{0,60}\bswaps?\b/i,
  /\b(?:pr[eé]via|esbo[cç]o)\b[\s\S]{0,50}\bcompras?\b[\s\S]{0,50}\brefei[cç][oõ]es\s+r[aá]pidas\b/i,
  /\bsubstituir\b[\s\S]{0,50}\bervas?\b[\s\S]{0,40}\b(?:frescas?|secas?)\b[\s\S]{0,40}\bprato\b/i,
  /\b(?:rascunho|prop[oõ]e|proponha)\b[\s\S]{0,70}\bingredientes?\b[\s\S]{0,60}\brefei[cç][oõ]es\s+r[aá]pidas\b/i,
  /\b(?:encomendar|confirmar|confirme|verifica[cç][oõ]es|cuidados?)\b[\s\S]{0,80}\b(?:compra|encomenda)\b[\s\S]{0,60}\b(?:mercearia|alimentos|supermercado)\b/i,
  /\b(?:mercearia|alimentos|supermercado)\b[\s\S]{0,60}\b(?:compra|encomenda)\b[\s\S]{0,80}\b(?:confirmar|verifica[cç][oõ]es|cuidados?)\b/i,
];

const TRAINING_INTENT_PATTERNS: RegExp[] = [
  /\b(how\s+much|how\s+many|set|adjust|calculate|dial\s+in|review|optimi[sz]e|what\s+should\s+my|what\s+are\s+my|help\s+me\s+hit)\b[\s\S]{0,80}\b(protein(?:\s+(?:intake|target))?|macros?|calories?|carbs?|fat|electrolytes?|creatine|supplements?)\b/i,
  /\b(carnivore\s+diet|cutting\s+macros?|bulking\s+macros?|maintenance\s+calories?|sports?\s+nutrition|performance\s+nutrition)\b/i,
  /\b(quanto|quanta|quantos|quantas|define|ajusta|calcula|alinha|revisa|otimiza|qual\s+(?:deve\s+ser|é)\s+(?:a\s+)?minha|me\s+ajuda\s+a\s+bater)\b[\s\S]{0,80}\b(prote[ií]na(?:\s+(?:di[aá]ria|alvo))?|macros?|calorias?|carbo(?:idratos)?|gordura|eletr[oó]litos?|creatina|suplementos?)\b/i,
  /\b(dieta\s+carn[ií]vora|macros?\s+para\s+(?:cut|bulk|ganhar\s+massa|secar)|calorias?\s+de\s+manuten[çc][aã]o|nutri[çc][aã]o\s+esportiva|nutri[çc][aã]o\s+de\s+performance)\b/i,
];

const TRAINING_WORKSPACE_PATTERNS: RegExp[] = [
  /\b(?:easy|long|recovery|tempo|interval|lighter)\b[\s\S]{0,35}\b(?:runs?|rides?|swims?)\b/i,
  /\b(?:bike|cycling|running|swimming)\s+(?:workouts?|sessions?|plans?)\b/i,
  /\bworkouts?\b/i,
  /\b(?:ciclismo|pedal(?:ada)?|corridas?)\b/i,
  /\b(?:sess(?:[aã]o|ao)|treino)\b[\s\S]{0,50}\bnata[cç][aã]o\b|\bnata[cç][aã]o\b[\s\S]{0,50}\b(?:sess(?:[aã]o|ao)|treino)\b/i,
  /\b\d[\d.,]*\s+metros?\b[\s\S]{0,50}\bnata[cç][aã]o\b|\bnata[cç][aã]o\b[\s\S]{0,50}\b\d[\d.,]*\s+metros?\b/i,
  /\bsess(?:[aã]o|ao)\b[\s\S]{0,80}\b\d[\d.,]*\s+metros?\b[\s\S]{0,100}\b(?:comprimento|tamanho)\s+da\s+piscina\b/i,
  /\btreinos?\b[\s\S]{0,70}\b(?:salvos?|planeamento|planejamento|plano|semana)\b|\b(?:planeamento|planejamento|plano)\b[\s\S]{0,70}\btreinos?\b/i,
  /\bcorridas?\b[\s\S]{0,70}\b(?:previstas?|planeadas?|planejadas?|plano)\b|\bplano\b[\s\S]{0,70}\bcorridas?\b/i,
];

const TRAINING_PRIMARY_CROSS_SKILL_PATTERNS: RegExp[] = [
  /\b(?:preview|sketch|draft|outline|prepare|build)\b[\s\S]{0,120}\b(?:bike\s+sessions?|ride\s+workouts?|workouts?|training\s+plans?)\b[\s\S]{0,120}\b(?:fuel(?:ing)?|snacks?|meals?|grocer(?:y|ies)|pantry)\b/i,
  /\b(?:esbo[cç]a|esboce|pr[eé]via|prepara|prepare|estrutura|estruture)\b[\s\S]{0,120}\b(?:sess(?:[aã]o|ao)\s+de\s+bicicleta|treinos?|plano\s+de\s+treino)\b[\s\S]{0,120}\b(?:abastecimento|snacks?|refei[cç][aã]o|compras?|despensa)\b/i,
];

const FINANCE_WORKSPACE_PATTERNS: RegExp[] = [
  /\b(?:supplier|vendor)\s+(?:payments?|invoices?|bills?)\b/i,
  /\b(?:payments?|invoices?|bills?)\s+(?:to|from)\s+(?:suppliers?|vendors?)\b/i,
  /\b(?:faturas?|facturas?|recibos?|pagamentos?)\b[\s\S]{0,50}\b(?:fornecedores?|venc(?:e|em|ida|idas)|pendentes?)\b/i,
  /\bfornecedores?\b[\s\S]{0,50}\b(?:faturas?|facturas?|recibos?|pagamentos?)\b/i,
  /\bfaturas?\b[\s\S]{0,80}\b(?:n[aã]o\s+pagas?|datas?\s+de\s+vencimento|vencimento|valores?)\b/i,
  /\blan[cç]amentos?\b[\s\S]{0,70}\b(?:aguard(?:am|ando)|pendentes?|sem)\b[\s\S]{0,40}\brecibos?\b/i,
  /\b(?:registro|registo|recibo)\s+fict[ií]cio\b[\s\S]{0,100}\b(?:euros?|forma\s+de\s+pagamento|categoria\s+fiscal)\b/i,
];

// ─── M12 manifest convergence (flag: AI_ROUTING_MANIFEST_CLASSIFIER) ─
//
// MISROUTE-FIX CONVENTION (flag on): fix a misroute with ONE manifest
// vocabulary edit (config/capability-manifest.json routingVocabulary —
// for this surface: an exampleUtterance) plus ONE corpus fixture — never a
// new inline regex.
//
// Flag-on scope (measured, deliberate): the manifest resolver decides the
// domain whenever its evidence is DECISIVE — the message normalizes to a
// seeded example utterance. Below that bar the legacy tiers still decide,
// because M12 parity measurement showed the fragment-union evidence cannot
// reproduce keywordMatch's tier interleaving at weak scores (identical
// resolver scores map to different legacy outcomes, e.g. cooking:2 is a
// legacy cooking hit for "how should i fuel after a long ride?" and the
// explicit dedupe phrase "same fueling issue". Full
// keyword delegation needs per-surface vocabulary tiers in the manifest
// schema — out of M12 scope.
const MANIFEST_KEYWORD_DOMAINS = new Set<string>(['content', 'secretary', 'finance', 'cooking', 'triathlon']);

function keywordMatchViaManifestExample(message: string): DomainName | null {
  const exampleCandidate = resolveIntent(message).find(
    (candidate) => candidate.matchedEvidence.includes('example_utterance'),
  );
  if (exampleCandidate && MANIFEST_KEYWORD_DOMAINS.has(exampleCandidate.domain)) {
    return exampleCandidate.domain as DomainName;
  }
  return null;
}

export function keywordMatch(message: string): DomainName | null {
  if (isManifestRoutingEnabled('classifier')) {
    const manifestDecision = keywordMatchViaManifestExample(message);
    if (manifestDecision) return manifestDecision;
    // Fall through: legacy tiers keep deciding sub-decisive evidence.
  }
  // Explicit "make content" asks should beat subject-matter vocabulary
  // from other domains, e.g. "Write a script about recovery intervals".
  if (CONTENT_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'content';
  }
  for (const { domain, pattern } of EXPLICIT_PRODUCT_AREA_ROUTES) {
    if (pattern.test(message)) return domain;
  }
  if (CONTENT_PRODUCT_PROFILE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'content';
  }
  // A finance preview remains finance-owned when the calendar reference is an
  // explicit no-op boundary, not a scheduling request.
  if (FINANCE_PRIMARY_CROSS_SKILL_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'finance';
  }
  // Meeting agendas remain Secretary-owned even when they use editorial
  // words such as pauta, title, status, or draft.
  if (SECRETARY_WORKSPACE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'secretary';
  }
  if (SECRETARY_PRODUCT_PROFILE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'secretary';
  }
  if (CONTENT_WORKSPACE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'content';
  }
  if (DECISION_CENTER_WORKSPACE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'decision_center';
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
  if (FINANCE_WORKSPACE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'finance';
  }
  if (FINANCE_PRODUCT_PROFILE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'finance';
  }
  // A preview whose primary artifact is a workout remains training-owned
  // when food vocabulary is merely an ancillary fueling suggestion.
  if (TRAINING_PRIMARY_CROSS_SKILL_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'triathlon';
  }
  if (TRAINING_PRODUCT_PROFILE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'triathlon';
  }
  // Explicit food/meal asks should beat training-topic vocabulary such as
  // "treino", "recuperação", or "leg day" when the user is clearly asking
  // for meals, recipes, menus, or shopping.
  if (COOKING_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'cooking';
  }
  if (COOKING_WORKSPACE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'cooking';
  }
  if (COOKING_PRODUCT_PROFILE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'cooking';
  }
  // A concrete workout/ride/swim remains training-owned even if the user also
  // requests an ancillary fueling outline. Explicit meal execution was
  // already handled by the cooking patterns above.
  if (TRAINING_WORKSPACE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'triathlon';
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
export interface ClassifyWithClaudeOptions {
  /** Caller/client lifecycle; exact abort reasons propagate through providers. */
  abortSignal?: AbortSignal;
  /**
   * M13 durable-pin scope decision (adversarial-review follow-up, 2026-07):
   * the low-confidence fallback below may consult the DURABLE per-user
   * active-domain pin (chat_conversation_state) when the caller passed no
   * in-arg activeContext. Surfaces that reach routeMessage today are the
   * iOS chat route (src/api/routes/chat-message-routes.ts) and the iOS
   * websocket chat path (src/api/websocket.ts) — both are the same
   * user-facing chat surface, so the durable pin applies to the shared
   * router fallback. Telegram inbound was removed (Phase 0/Telegram
   * deprecation), so no non-chat surface reaches this today. A future
   * non-chat surface (scheduler, batch classification, admin tooling) can
   * opt out by passing `allowDurableDomainPinFallback: false` so a stale
   * interactive-chat pin never bleeds into non-chat classification.
   * Defaults to true (current chat behavior).
   */
  allowDurableDomainPinFallback?: boolean;
}

export async function classifyWithClaude(
  message: string,
  activeContext?: ConversationContext | null,
  userId?: number,
  tenantId?: number,
  options?: ClassifyWithClaudeOptions,
): Promise<ClassificationResult> {
  const operation = (abortSignal?: AbortSignal) => classifyWithClaudeAdmitted(
    message,
    activeContext,
    userId,
    tenantId,
    options,
    abortSignal,
  );
  if (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0) {
    return runWithSkillInferenceAccountAdmission({
      userId,
      abortSignal: options?.abortSignal,
    }, operation);
  }
  return operation(options?.abortSignal);
}

async function classifyWithClaudeAdmitted(
  message: string,
  activeContext?: ConversationContext | null,
  userId?: number,
  tenantId?: number,
  options?: ClassifyWithClaudeOptions,
  accountAbortSignal?: AbortSignal,
): Promise<ClassificationResult> {
  // Phase K Codex round-11 fix (F-new-4): the legacy
  // services/anthropic.classifyMessage path uses
  // completeOneShotWithFallback (Gemini-first → Anthropic Haiku) and
  // never reaches the TaskRoutingProvider. That meant
  // AI_CLASSIFY_PRIMARY=ollama had no effect on live chat
  // classification, even though the routing config and provider were
  // both initialized correctly.
  //
  // Prefer the active routing provider when available. It honors
  // AI_CLASSIFY_PRIMARY (e.g., 'ollama') with its circuit-breaker +
  // fallback chain (e.g., ollama → gemini → openai), and writes the
  // expected api_usage row with provider='ollama', cost_usd=0,
  // local_request_units=1 when Ollama serves the request.
  //
  // Fall back to the legacy classifyMessage path only when no routing
  // provider is initialized (early boot, tests, scheduled jobs running
  // before provider-registry init).
  let result: ClassificationResult;
  // M15 (flag AI_CLASSIFY_MANIFEST_PROMPT, default OFF): append the
  // deterministic candidate shortlist (resolveIntent top-k with matched
  // evidence) to the LIVE classify input only. Kept small — the approved
  // cost waiver covers the static manifest prompt expansion plus this
  // shortlist. The shadow path below still receives the ORIGINAL message so
  // shadow telemetry stays comparable across flag states.
  let liveMessage = message;
  if (isManifestClassifierPromptEnabled()) {
    const shortlist = buildClassifierCandidateShortlist(
      message,
      { activeDomain: activeContext?.domain ?? null },
    );
    if (shortlist) liveMessage = `${message}\n\n${shortlist}`;
  }
  // Option 3: measure live classify duration so the shadow path can
  // compare it to the small-model Ollama latency. Captured even when
  // shadow is disabled (cheap; harmless).
  const liveStart = Date.now();
  const routingProvider = getActiveProvider();
  if (routingProvider) {
    try {
      const raw = await routingProvider.classify(
        liveMessage,
        activeContext ?? undefined,
        // O3-A19: ordinary user-facing traffic remains explicitly live. Only
        // an authenticated local-engine AsyncLocalStorage scope receives the
        // evaluation role; an environment flag alone cannot grant it.
        {
          userId,
          tenantId,
          source: isCurrentChatLiveEvalLocalEngine() ? 'evaluation' : 'live',
          ...(accountAbortSignal ? { abortSignal: accountAbortSignal } : {}),
        },
      );
      // Defensive guard (Codex Mac sync round-1 fix): routing-provider
      // implementations are typed to always return ClassificationResult
      // or throw, but test stubs / misconfigured environments may return
      // undefined. Treat that as a failure and fall back to the legacy
      // classifier so callers never see `undefined.domain`.
      if (!raw || typeof raw.domain !== 'string' || typeof raw.confidence !== 'number') {
        throw new Error('routing-provider classify returned malformed/empty result');
      }
      result = raw;
    } catch (err) {
      rethrowAiUsageFailClosedError(err);
      if (isSkillInferenceAccountDeletionError(err) || accountAbortSignal?.aborted) {
        throw accountAbortSignal?.reason instanceof Error ? accountAbortSignal.reason : err;
      }
      // Routing-provider classify failures should not block the chat
      // turn — log and fall through to the legacy classifier so the
      // request keeps moving. The routing provider's circuit-breaker
      // will mark the underlying provider as failing and route around
      // it on the next call.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Routing-provider classify failed — falling back to legacy classifyMessage',
      );
      result = accountAbortSignal
        ? await classifyMessage(
          liveMessage,
          activeContext ?? undefined,
          userId,
          tenantId,
          accountAbortSignal,
        )
        : await classifyMessage(liveMessage, activeContext ?? undefined, userId, tenantId);
    }
  } else {
    result = accountAbortSignal
      ? await classifyMessage(
        liveMessage,
        activeContext ?? undefined,
        userId,
        tenantId,
        accountAbortSignal,
      )
      : await classifyMessage(liveMessage, activeContext ?? undefined, userId, tenantId);
  }
  const liveDurationMs = Date.now() - liveStart;

  const manifestPromptEnabled = isManifestClassifierPromptEnabled();
  if (
    manifestPromptEnabled
    && (result.domain === 'clarify' || result.domain === 'none')
  ) {
    const disposition = result.domain as 'clarify' | 'none';
    result = {
      domain: 'chat',
      confidence: result.confidence,
      disposition,
    };
  }

  // M15 output validation: keep the optional skill field ONLY when the
  // manifest prompt flag is on AND the skill is a manifest chatActionSkill of
  // the classified domain. Providers pass the model's skill through raw; this
  // is the single sanitization point. With the flag OFF the skill is stripped
  // unconditionally (the legacy prompt never asks for one, and a stray value
  // must not leak into the orchestrator hint), so flag-off results stay
  // byte-identical to pre-M15 behavior.
  if (result.skill !== undefined) {
    const validSkill = manifestPromptEnabled && typeof result.skill === 'string'
      ? resolveManifestSkillForDomain(result.domain, result.skill)
      : null;
    if (validSkill) {
      result = { ...result, skill: validSkill };
    } else {
      logger.debug(
        { domain: result.domain, rejectedSkill: result.skill },
        'Dropping classifier skill field (flag off or not a manifest chatActionSkill of the domain)',
      );
      const { skill: _invalidSkill, ...rest } = result;
      result = rest;
    }
  }

  // Option 3 (O3-A1): fire-and-forget Ollama shadow classify.
  //
  // Runs on a separate microtask so the live response returns to the
  // caller immediately. The shadow function:
  //   - skips if config.localLLM.classifyShadow is false
  //   - skips if the live path is already Ollama (O3-A19, anti-recursion)
  //   - bounds itself with AbortController timeout (O3-A18)
  //   - never throws to this caller (the .catch swallows + logs)
  //   - preflights paid eligibility, owns a separate shared-system budget
  //     reservation, and writes zero-cost api_usage telemetry
  //
  // The shadow row is correlated to the live chat turn via requestId
  // (pulled from AsyncLocalStorage if available — null otherwise).
  if (config.localLLM?.classifyShadow) {
    const ctx = getCurrentContext();
    const requestId = ctx?.requestId;
    // `geminiModel` reflects the model that the LIVE classify path used.
    // In the current setup (AI_CLASSIFY_PRIMARY=gemini), the routing
    // provider invokes Gemini's classifier model; pass that name so
    // shadow rows have the baseline model recorded for diff/audit. If
    // the live path ever becomes a different provider, this field would
    // need to follow — but for the Option-3 shadow window, Gemini IS
    // the live classifier (O3-A19 prevents shadow from running when
    // Ollama is the live path), so config.gemini.classifierModel is
    // accurate.
    const liveModelName = config.gemini?.classifierModel ?? undefined;
    void runOllamaShadowClassification({
      message,
      activeContext: activeContext ?? undefined,
      userId,
      tenantId,
      requestId,
      geminiResult: result,
      geminiModel: liveModelName,
      geminiDurationMs: liveDurationMs,
    }).catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'classify shadow failed'),
    );
  }

  // Explicit manifest-classifier abstentions are terminal decisions, not
  // weak guesses. Never replace them with a stale active-domain pin.
  if (result.disposition) {
    logger.debug({ result }, 'Routing-provider classification produced a safe terminal disposition');
    return result;
  }

  // M14: the low-confidence floor (legacy 0.6) and the pinned-domain minimum
  // (legacy 0.51) now route through the calibration table; the bootstrap
  // table reproduces both constants exactly.
  if (result.confidence < getClassifierLowConfidenceFloor()) {
    // M13 read-site swap: the low-confidence pin now reads the durable-backed
    // active-domain store. Within the TTL this is identical to the legacy
    // in-arg activeContext (callers derive it from the same store); after a
    // restart the durable row keeps the pin alive even when callers could not
    // rebuild activeContext. The explicit in-arg still wins when provided.
    // Durable fallback is gated on userId presence AND the opt-out flag —
    // see ClassifyWithClaudeOptions.allowDurableDomainPinFallback.
    const allowDurablePin = options?.allowDurableDomainPinFallback ?? true;
    const pinnedDomain = activeContext?.domain
      ?? (allowDurablePin && typeof userId === 'number' ? getActiveChatDomain(userId, Date.now(), tenantId) : null);
    if (pinnedDomain) {
      logger.warn(
        { requested: result.domain, confidence: result.confidence, fallbackDomain: pinnedDomain },
        'Low-confidence classifier result — preserving active conversation domain',
      );
      return { domain: pinnedDomain, confidence: Math.max(result.confidence, getClassifierPinnedConfidenceMin()) };
    }
  }
  logger.debug({ result }, 'Routing-provider classification result');
  return result;
}
