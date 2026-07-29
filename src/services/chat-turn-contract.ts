// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import type {
  NexusChatExpectedResponseShape,
  NexusChatGroundingRequirement,
  NexusChatLanguage,
  NexusChatOwnerSkill,
  NexusChatRiskLevel,
  NexusChatRouteKind,
} from './chat-answer-contract';
import { expectedShapeForRoute, getSkillResponsePolicy, type SkillResponsePolicy } from './skill-response-policy';
import { isChatSkillResponsePolicyEnabled } from './runtime-flags';
import { getCapabilityChatRoutingOwnerMap } from './capability-manifest';

export interface ChatTurnContract {
  skill: NexusChatOwnerSkill;
  routeKind: NexusChatRouteKind;
  riskClass: NexusChatRiskLevel | 'destructive';
  groundingRequired: NexusChatGroundingRequirement;
  expectedResponseShape: NexusChatExpectedResponseShape;
  language: NexusChatLanguage;
  confidence: number;
  ambiguityReasons: string[];
  telemetryLabel: string;
  internetEligible: boolean;
}

export interface ChatTurnContractInput {
  message: string;
  routedDomain?: DomainName | null;
  activeContextDomain?: DomainName | null;
  involvedSkills?: string[];
}

const DOMAIN_SKILL = getCapabilityChatRoutingOwnerMap() as Partial<Record<DomainName, NexusChatOwnerSkill>>;

export function inferChatTurnContract(input: ChatTurnContractInput): ChatTurnContract {
  const folded = fold(input.message);
  const language = inferLanguage(input.message);
  const skill = inferSkill(folded, input);
  const policyEnabled = isChatSkillResponsePolicyEnabled();
  const policy = policyEnabled ? getSkillResponsePolicy(skill) : null;
  const riskClass = inferRiskClass(folded, skill);
  const routeKind = inferRouteKind(folded, skill, riskClass);
  const groundingRequired = inferGroundingRequirement(folded, skill, routeKind, riskClass, policy);
  const expectedResponseShape = inferExpectedShape(folded, skill, routeKind, policy);
  const internetEligible = groundingRequired === 'web' || groundingRequired === 'local_and_web';
  const ambiguityReasons = inferAmbiguityReasons(folded, skill, routeKind);
  return {
    skill,
    routeKind,
    riskClass,
    groundingRequired,
    expectedResponseShape,
    language,
    confidence: ambiguityReasons.length > 0 ? 0.72 : 0.9,
    ambiguityReasons,
    telemetryLabel: policy?.telemetryLabel ?? `chat.skill.${skill}`,
    internetEligible,
  };
}

// ─── M17: fail-safe grounding uncertainty signal ─────────────────────
//
// Derives an HONEST uncertainty verdict from signals the contract already
// computes — no new heuristics, no contract mutation (the stamped
// chatTurnContract metadata stays byte-identical for every turn):
//   * ambiguity_signals_present — inferAmbiguityReasons found conflicts
//     (deictic reference, provider-label vs calendar semantics, destructive
//     verb inside a literal title span, repair without an active skill);
//   * low_contract_confidence  — the calibrated confidence the contract
//     itself assigns when ambiguity reasons exist (< 0.8);
//   * clarification_route      — the contract concluded the turn needs a
//     clarifying question, which by construction means the request could
//     not be resolved confidently from the message alone.
//
// Consumers (domain-handler scoped-context gating) use this to include
// scoped local state for uncertain turns instead of answering blind, while
// HIGH-certainty groundingRequired='none' turns keep today's exclusion.
export interface ChatTurnGroundingCertainty {
  uncertain: boolean;
  reasons: string[];
}

export function assessChatTurnGroundingCertainty(contract: ChatTurnContract): ChatTurnGroundingCertainty {
  const reasons: string[] = [];
  if (contract.ambiguityReasons.length > 0) reasons.push('ambiguity_signals_present');
  // NOTE (M17 review): 'low_contract_confidence' is currently redundant BY
  // CONSTRUCTION — the contract assigns confidence 0.72 iff ambiguityReasons
  // is non-empty and 0.9 otherwise (see inferChatTurnContract above), so
  // this branch fires exactly when 'ambiguity_signals_present' fires. The
  // reason is kept deliberately as future-proofing: if the confidence
  // computation ever diversifies (calibration, per-skill priors, model
  // scores), low confidence becomes an independent uncertainty signal and
  // consumers keying on this reason string keep working unchanged.
  if (contract.confidence < 0.8) reasons.push('low_contract_confidence');
  if (contract.routeKind === 'clarification') reasons.push('clarification_route');
  return { uncertain: reasons.length > 0, reasons };
}

export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function inferLanguage(text: string): NexusChatLanguage {
  const foldedText = fold(text);
  const ptKeywords = new Set(foldedText.match(/\b(minha|minhas|meu|meus|para|por|com|sem|que|hoje|amanha|semana|receita|treino|tarefa|tarefas|agenda|calendario|foco|decisao|decisoes|notificacao|notificacoes|ligacao|conexao|qual|quais|quanto|como|porque|significa|devo|deve|tenho|posso|fazer|estou|cria|criar|crie|gera|gerar|barato|mostra|listar|marcar|concluida|clima|tempo|previsao|placar|transito|voo|reuniao|reunioes|evento|eventos|plano|recentes|atual|atuais|esse|essa|este|esta|deste|desta|isso|isto|prova|domingo|preparo|preparar|planeei|planejar|comer|cozinhar|compras|despensa|assa|assar|ajuda|ajude|conectar|ligar|provedor|integracao|falhou|expirou|disponivel|principal|dados|foi|registrado|canal|saudavel|configuracoes|entrega|horas|silenciosas|funcionam|escrever|reescreve|reescrever|critica|qualidade|gancho|roteiro|legenda|titulo|rascunho|conteudo|apague|apaguem|cancele|cancelem|remova|removam|elimine|eliminem|exclua|excluam|excluir)\b/g) ?? []);
  const enKeywords = new Set(foldedText.match(/\b(the|my|mine|what|how|create|show|list|give|tell|mark|done|please|put|find|update|delete|add|workflow|workout|recipe|recipes|task|tasks|training|calendar|decision|notification|connection|title|ideas|week|weather|forecast|score|stock|flight|traffic|current|latest|recent)\b/g) ?? []);
  const esKeywords = new Set(foldedText.match(/\b(mi|mis|quiero|quieres|dime|muestra|cuando|cual|todavia|vista|previa|cambio|cambios|cualquier|hecho|tengo|tienes|puedo|puedes|dame|manana|tarea|tareas|receta|recetas|cocinar|cenar|cena|comida|plato|entrenamiento|entrenar|reunion|recordatorio|borrador|guion|contenido|cancelar|complete|completar|guarde|guardar|busca|buscar|fuente|fuentes|noticia|noticias|reciente|recientes|actual|actuales|precio|precios|bateria|bicicleta|bicicletas|electrica|electricas|urbana|urbanas|panel|paneles|solar|solares|residencial|residenciales|mexico|mexicano|mexicanos|america|latina|inflacion|requisitos|visa|seguridad|adulto|adultos|sano|sanos)\b/g) ?? []);
  const hasPtAccent = /[ãõçáéíóúâêôà]/i.test(text);
  const hasEsSignal = /[¿¡ñ]/i.test(text)
    || /\bqué\b/i.test(text)
    || /\b(?:dime|quiero|quieres|todavia|vista\s+previa|cualquier\s+cambio|fuentes?\s+(?:actuales?|publicas?)|noticias?\s+recientes?|precio\s+de|inflacion\s+en)\b/.test(foldedText);
  const hasPtProviderPhrase = /\b(?:agenda|calendario)\s+(?:do|da|no|na)\s+gmail\b/.test(foldedText);
  const hasPt = hasPtAccent || hasPtProviderPhrase || ptKeywords.size >= 2;
  const hasEn = enKeywords.size > 0;
  const hasEs = hasEsSignal || esKeywords.size >= 2;
  if (hasEs) {
    const ptOnlyHits = [...ptKeywords].filter((word) => ![
      'que',
      'para',
      'com',
      'sem',
      'esta',
      'este',
      'essa',
      'esse',
      'semana',
    ].includes(word));
    // Spanish remains detectable for safety/routing tolerance, but it is no
    // longer a supported response language. Use the English fallback instead
    // of leaking Portuguese or emitting a retired language contract.
    return 'en';
  }
  if (hasPt && hasEn) {
    const nonProviderEnglishHits = [...enKeywords].filter((word) => !['calendar', 'connection', 'notification', 'decision'].includes(word));
    if (ptKeywords.size >= 2 && nonProviderEnglishHits.length === 0) return 'pt';
    return 'mixed';
  }
  return hasPt ? 'pt' : 'en';
}

function inferSkill(folded: string, input: ChatTurnContractInput): NexusChatOwnerSkill {
  const explicit = skillFromText(folded);
  if (explicit) return explicit;
  if (isGenericAdviceRequest(folded)) return 'chat';
  const routed = input.routedDomain ? DOMAIN_SKILL[input.routedDomain] : null;
  if (routed) return routed;
  const active = input.activeContextDomain ? DOMAIN_SKILL[input.activeContextDomain] : null;
  if (active && isRepairOrFollowUp(folded)) return active;
  return 'chat';
}

function skillFromText(text: string): NexusChatOwnerSkill | null {
  if (/\b(tasks?|tarefas?)\b/.test(text) && /\b(calendar|calendario|agenda|meeting|meetings|reuniao|reunioes)\b/.test(text)) return 'secretary';
  if (/\b(bill|fatura|invoice|payment|pagamento|pagar)\b/.test(text)) return 'finance';
  if (/\b(tasks?|todo|to-dos?|to-do|tarefas?|tareas?|subtasks?|checklist|lembrete|recordatorio)\b/.test(text)) return 'tasks';
  if (/\b(eat|eating|food|fueling|comer|refeicao)\b/.test(text) && /\b(training|workout|run|gym|treino|treinar|corrida|musculacao)\b/.test(text)) return 'cooking';
  if (/\b(research|pesquisa|fontes?|sources?)\b/.test(text) && /\b(topic|tema|script|roteiro|content|conteudo)\b/.test(text)) return 'content';
  if (/\b(content|script|post|video|caption|title|thumbnail|draft|hook|hooks|roteiro|conteudo|legenda|titulo|gancho|rascunho)\b/.test(text)) return 'content';
  if (/\b(training|train|workout|run|race|gym|strength|coach|readiness|recovery|recovered|treino|treinar|corrida|prova|musculacao|maratona|forca|prontidao|recuperado|recuperacao|\d+\s?km|km\s+(?:a|per|por)\s+(?:week|semana))\b/.test(text)) return 'training';
  if (/\b(help|ajuda|ajude|como)\b/.test(text) && /\b(connect|conectar|ligar)\b/.test(text) && /\b(gmail|outlook|google\s+calendar|apple\s+health|garmin|provider|integration|provedor|integracao)\b/.test(text)) return 'connections';
  if (/\b(gmail|outlook|google\s+calendar)\b/.test(text) && /\b(write|writes|escrever|escreve|should|deve)\b/.test(text) && /\b(calendar|calendario|agenda)\b/.test(text)) return 'connections';
  if (/\b(apns|push)\b/.test(text) && /\b(token|registered|registrado|canal|channel)\b/.test(text)) return 'notifications';
  if (/\b(notification|notificacao|notificacoes)\b/.test(text)) return 'notifications';
  if (/\b(calendar|calendario|agenda|event|events|evento|eventos|meeting|meetings|reuniao|reunioes|day|dia|free\s+(?:time|window)|janela\s+livre|focus\s+time|tempo\s+de\s+foco|overloaded|sobrecarregado|what\s+should\s+i\s+do|o\s+que\s+devo\s+fazer|what\s+changed|o\s+que\s+mudou|next\s+best|a\s+seguir|public\s+holiday|holiday|feriado)\b/.test(text)
    || isGmailAgendaSemantics(text)) return 'secretary';
  if (/\b(show|mostra|list|listar)\b.*\b(week|semana|day|dia|plan|plano)\b/.test(text)) return 'secretary';
  if (/\b(finance|budget|spend|spending|spent|expense|receipt|invoice|bill|tax|payment|investment|currency|exchange|savings|transaction|charge|recurring|financa|financeiro|financeira|orcamento|despesa|gasto|gastei|gastar|poupar|recibo|fatura|imposto|pagamento|investimento|cambio|transacao|cobranca|recorrente)\b/.test(text) || /\bsave\s+more\b/.test(text)) return 'finance';
  if (/\b(recipe|recipes|cook|cooking|bake|baking|oven|meal|meals|food|eat|eating|grocery|pantry|fueling|chicken|leftovers|food\s+safety|receita|receitas|cozinha|assar|assa|forno|refeicao|jantar|almoco|comer|compras|despensa|frango|sobras|seguranca\s+alimentar|receta|recetas|cocinar|cenar|cena|comida|plato)\b/.test(text)) return 'cooking';
  if (/\b(connection|provider|integration|sync|oauth|token|gmail|outlook|google\s+calendar|apple\s+health|garmin|conexao|provedor|integracao|sincronizacao)\b/.test(text)) return 'connections';
  if (/\b(notification|notifications|push|alert|alerts|apns|quiet\s+hours|horas\s+silenciosas|notificacao|notificacoes|alerta|alertas)\b/.test(text)) return 'notifications';
  if (/\b(decision|decisions|decide|choice|option|streak|history|all\s+clear|decisao|decisoes|historico|escolha|opcao|sequencia)\b/.test(text)) return 'decision_center';
  return null;
}

function inferRouteKind(
  text: string,
  skill: NexusChatOwnerSkill,
  riskClass: NexusChatRiskLevel | 'destructive',
): NexusChatRouteKind {
  if (isRepairOrFollowUp(text)) return 'repair';
  if (skill === 'training' && /\b\d+\s?km\b/.test(text) && /\b(week|semana)\b/.test(text)) return 'repair';
  if (riskClass === 'high' && needsSafetyResearch(text)) return 'internet_research';
  if (skill === 'connections' && /\b(help|ajuda|ajude|como)\b/.test(text) && /\b(connect|conectar|ligar)\b/.test(text)) return 'generic_skill_answer';
  if (skill === 'decision_center' && /\b(do|faz|fazer)\b/.test(text) && /\b(decision|decisao)\b/.test(text)) return 'action';
  if (riskClass === 'destructive' || hasActionIntent(text, skill)) return 'action';
  const localRead = needsLocalRead(text, skill);
  const internet = needsInternet(text);
  if (localRead && internet) {
    return hasExplicitExternalCurrentInfo(text) ? 'internet_research' : 'local_read';
  }
  if (localRead) return 'local_read';
  if (internet) return 'internet_research';
  if (/\b(which|qual|what\s+one|which\s+one|ambiguous|nao\s+sei|not\s+sure)\b/.test(text)) return 'clarification';
  return 'generic_skill_answer';
}

function inferGroundingRequirement(
  text: string,
  skill: NexusChatOwnerSkill,
  routeKind: NexusChatRouteKind,
  riskClass: NexusChatRiskLevel | 'destructive',
  policy: SkillResponsePolicy | null,
): NexusChatGroundingRequirement {
  if (routeKind === 'internet_research') return needsLocalRead(text, skill) ? 'local_and_web' : 'web';
  if (routeKind === 'local_read' || routeKind === 'repair') return 'local';
  if (routeKind === 'action') return riskClass === 'destructive' ? 'local' : (needsInternet(text) ? 'local_and_web' : 'local');
  return policy?.defaultGrounding ?? 'none';
}

function inferExpectedShape(
  text: string,
  skill: NexusChatOwnerSkill,
  routeKind: NexusChatRouteKind,
  policy: SkillResponsePolicy | null,
): NexusChatExpectedResponseShape {
  if (skill === 'cooking' && isCookingIdeaRequest(text)) return 'direct_answer';
  if (skill === 'cooking' && /\b(recipe|receita|bake|baking|oven|assar|assa|forno)\b/.test(text) && !needsLocalRead(text, skill)) return 'recipe';
  if (skill === 'cooking' && /\b(eat|eating|bake|baking|oven|food\s+safety|safety\s+guidance|fueling|leftovers|chicken|store|storage|fridge|comer|assar|assa|forno|seguranca\s+alimentar|sobras|frango|conservar|conservo|conserva|guardar|geladeira|frigorifico)\b/.test(text)) return 'direct_answer';
  if (policy) {
    if (routeKind === 'local_read' || routeKind === 'action' || routeKind === 'repair') {
      return policy.defaultLocalShape;
    }
    return policy.defaultGenericShape;
  }
  return expectedShapeForRoute(skill, routeKind);
}

function isCookingIdeaRequest(text: string): boolean {
  const recipeTerm = /\b(recipe|recipes|receita|receitas|receta|recetas|ingredientes?|ingredients?|modo de preparo|instrucoes|instructions|servings?|porcoes|porcao)\b/.test(text);
  const ideaTerm = /\b(what should i|what can i|what could i|what recipe|which recipe|simple recipe|receita simples|receta simple|should i|could i|idea|ideas|ideia|ideias|sugestao|sugest[aã]o|option|opcao|opcoes|op(?:c|ç)(?:ao|oes)|quick meal|meal idea|que devo|o que devo|que posso|o que posso|qual receita|que receita|que receta|que puedo|me de|me da|da-me|dame)\b/.test(text);
  const softSuggest = /\b(suggest|suggestion|suger)\b/.test(text);
  const asksForIdea = ideaTerm || (softSuggest && !recipeTerm);
  if (!asksForIdea && recipeTerm) {
    return false;
  }
  const cookingContext = /\b(recipe|recipes|receita|receitas|receta|recetas|cook|cooking|dinner|lunch|meal|food|dish|cozinhar|jantar|almoco|comer|refeicao|prato|plato|cocinar|cena|comida)\b/.test(text);
  return asksForIdea && cookingContext;
}

function inferRiskClass(text: string, skill: NexusChatOwnerSkill): NexusChatRiskLevel | 'destructive' {
  if (/\ball\s+clear\b/.test(text)) return 'low';
  if (hasDestructiveVerbOutsideLiteralTitle(text)) return 'destructive';
  if (skill === 'finance' && hasActionIntent(text, skill)) return 'high';
  if (/\b(injury|pain|medical|legal|tax\s+advice|investment|dose|dosage|depression|anxiety|lesao|dor|medico|juridico|investimento|dosagem|depressao|ansiedade)\b/.test(text)) return 'high';
  if (skill === 'decision_center' && /\b(do|faz|fazer)\b/.test(text) && /\b(decision|decisao)\b/.test(text)) return 'medium';
  if (hasActionIntent(text, skill)) return 'medium';
  return 'low';
}

function hasActionIntent(text: string, skill: NexusChatOwnerSkill): boolean {
  if (skill === 'cooking' && /\b(recipe|receita|store|conservar)\b/.test(text) && !/\b(plan|plano|cardapio|lista|grocery|compras|add|adiciona|create\s+a\s+grocery)\b/.test(text)) {
    return false;
  }
  return /\b(create|add|schedule|book|move|reschedule|adjust|change|complete|mark|send|draft|generate|publish|choose|dismiss|snooze|retry|connect|disconnect|activate|apply|protect|cancel|delete|remove|eliminate|rewrite|repurpose|transform|turn\s+on|turn\s+off|cria|criar|crie|adiciona|agendar|marca|marcar|move|mover|muda|mudar|remarca|ajusta|alterar|concluir|conclui|envia|gera|gerar|aplica|aplicar|reescreve|reescrever|transforma|transformar|publicar|escolhe|adiar|ligar|desligar|conectar|ativa|ativar|reconectar|protege|proteger|cancela|cancelar|cancele|cancelem|apaga|apagar|apague|apaguem|remove|remover|remova|removam|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam)\b/.test(text)
    || /\bagenda\s+(?:reuniao|reuni[aã]o|evento|consulta|bloco|foco)\b/.test(text);
}

function needsLocalRead(text: string, skill: NexusChatOwnerSkill): boolean {
  if (isGenericAdviceRequest(text)) return false;
  if (skill === 'cooking' && /\b(meal\s+plan|grocery\s+list|shopping\s+list|pantry|plano\s+de\s+refeicao|cardapio|lista\s+de\s+compras|despensa)\b/.test(text)) return true;
  if (skill === 'cooking' && isCookingIdeaRequest(text)) return false;
  if (skill === 'finance' && /\b(explain|explica)\b/.test(text) && /\b(category|categoria|deductible|dedutivel)\b/.test(text)) return false;
  if (skill === 'finance' && /\b(latest|current|atual|investment|investimento|recommendation|recomendacao|currency|exchange|cambio)\b/.test(text) && !/\b(my|meu|minha|minhas|meus)\b/.test(text)) return false;
  if (hasExplicitExternalCurrentInfo(text) && !hasPersonalLocalSignal(text)) return false;
  if (skill === 'decision_center') return true;
  if (/\b(my|mine|meu|minha|minhas|meus|i\s+have|do\s+i\s+have|tenho|tengo|tienes|today|hoje|hoy|tomorrow|amanha|manana|this\s+week|esta\s+semana|next\s+up|what\s+do\s+i\s+have|what\s+should\s+i\s+do|show|list|mostra|listar|muestra|lista|status|estado|connected|conectado|unavailable|indisponivel)\b/.test(text)) return true;
  if (skill === 'secretary' && (/\b(agenda|calendar|calendario)\b/.test(text) || isGmailAgendaSemantics(text))) return true;
  if (skill === 'content' && /\b(draft|drafts|pipeline|voice\s+card|voice|voz|meus\s+rascunhos|pipeline)\b/.test(text)) return true;
  if (skill === 'content' && /\b(critique|quality|critica|qualidade)\b/.test(text) && /\b(this|este|esta|script|roteiro|draft|rascunho)\b/.test(text)) return true;
  if (skill === 'connections' && /\b(failed|fail|falhou|expirou|expired|available|disponivel|connected|conectado|status|estado|principal|primary)\b/.test(text)) return true;
  if (skill === 'notifications' && /\b(unread|settings|missed|delivery|health|healthy|token|registered|nao\s+lidos|configuracoes|perdi|entrega|saudavel|registrado|esta|this)\b/.test(text)) return true;
  if (skill === 'finance' && /\b(spending|spent|expense|charge|bill|transaction|budget|account|gastei|gasto|despesa|cobranca|fatura|transacao|orcamento|conta|mes|month)\b/.test(text)) return true;
  if (skill === 'training' && /\b(plan|session|readiness|recovery|agenda|plano|sessao|prontidao|recuperacao)\b/.test(text) && /\b(my|meu|minha|hoje|today|this\s+week|esta\s+semana)\b/.test(text)) return true;
  return false;
}

function needsInternet(text: string): boolean {
  if (/\btempo\s+de\s+foco\b/.test(text)) return false;
  return /\b(latest|current|today'?s\s+news|news|source|sources|search|internet|web|price|pricing|law|legal|medical|research|recent|weather|forecast|score|stock|flight|traffic|atual|atuais|ultim[ao]s?|noticias|fontes?|pesquisa|internet|preco|lei|juridico|medico|recente|clima|previsao|placar|cotacao|acao|acoes|voo|transito)\b/.test(text)
    || /\btime\s+in\s+[a-z][a-z\s-]{2,}\b/.test(text)
    || /\bhora(?:rio)?\s+(?:em|de)\s+[a-z][a-z\s-]{2,}\b/.test(text)
    || /\btempo\s+(?:em|de|para)\s+[a-z][a-z\s-]{2,}\b/.test(text)
    || /\b(?:qual\s+(?:e|eh|é)\s+o|como\s+esta\s+o)\s+tempo\b/.test(text);
}

function hasExplicitExternalCurrentInfo(text: string): boolean {
  if (/\btempo\s+de\s+foco\b/.test(text)) return false;
  return /\b(today'?s\s+news|news|source|sources|search|internet|web|price|pricing|law|legal|medical|research|weather|forecast|score|stock|flight|traffic|noticias|fontes?|pesquisa|internet|preco|lei|juridico|medico|clima|previsao|placar|cotacao|acao|acoes|voo|transito|public\s+holiday|holiday|feriado)\b/.test(text)
    || /\btime\s+in\s+[a-z][a-z\s-]{2,}\b/.test(text)
    || /\bhora(?:rio)?\s+(?:em|de)\s+[a-z][a-z\s-]{2,}\b/.test(text)
    || /\btempo\s+(?:em|de|para)\s+[a-z][a-z\s-]{2,}\b/.test(text)
    || /\b(?:qual\s+(?:e|eh|é)\s+o|como\s+esta\s+o)\s+tempo\b/.test(text);
}

function hasPersonalLocalSignal(text: string): boolean {
  return /\b(my|mine|meu|minha|minhas|meus|i\s+have|do\s+i\s+have|tenho|what\s+do\s+i\s+have|what\s+should\s+i\s+do|show\s+my|list\s+my|mostra\s+(?:o\s+)?meu|minhas?\s+|meus\s+)\b/.test(text);
}

function isGenericAdviceRequest(text: string): boolean {
  const asksForAdvice = /\b(next\s+step|small\s+step|tiny\s+step|one\s+step|advice|tip|strategy|strategies|suggestion|proximo\s+passo|pr[oó]ximo\s+passo|passo\s+pequeno|um\s+passo|conselho|dica|estrategia|estrategias|sugestao|sugest[aã]o)\b/.test(text);
  if (!asksForAdvice) return false;
  const asksForLocalState = /\b(my|mine|meu|minha|minhas|meus|i\s+have|tenho|tengo|tienes|agenda|calendar|calendario|task|tasks|tarefa|tarefas|tarea|tareas|treino|training|entrenamiento|plano|plan|budget|orcamento|conta|account|pipeline|draft|rascunho)\b/.test(text);
  return !asksForLocalState;
}

function needsSafetyResearch(text: string): boolean {
  return /\b(injury|pain|medical|dose|dosage|depression|anxiety|lesao|dor|medico|dosagem|depressao|ansiedade)\b/.test(text);
}

function isRepairOrFollowUp(text: string): boolean {
  return /\b(scope\s+is|escopo\s+e|scope\s*=|i\s+asked|i\s+meant|eu\s+pedi|queria\s+dizer|isso\s+e|this\s+is)\b/.test(text)
    || /(^|\s)(nao|no)[,!]/.test(text);
}

function inferAmbiguityReasons(
  text: string,
  skill: NexusChatOwnerSkill,
  routeKind: NexusChatRouteKind,
): string[] {
  const reasons: string[] = [];
  if (routeKind === 'repair' && skill === 'chat') reasons.push('repair_without_active_skill');
  if (/\b(this|that|it|isso|essa|este|aquela)\b/.test(text) && routeKind === 'action') reasons.push('deictic_reference');
  if (skill === 'secretary' && isGmailAgendaSemantics(text)) reasons.push('provider_label_vs_calendar_semantics');
  if (hasDestructiveVerb(text) && hasLiteralTitleSpan(text)) reasons.push('destructive_phrase_inside_literal_title_span');
  return reasons;
}

function hasDestructiveVerb(text: string): boolean {
  return /\b(delete|remove|cancel|clear|eliminate|apaga|apagar|apague|apaguem|remove|remover|remova|removam|cancela|cancelar|cancele|cancelem|limpa|limpar|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam)\b/.test(text);
}

function hasDestructiveVerbOutsideLiteralTitle(text: string): boolean {
  if (!hasDestructiveVerb(text)) return false;
  if (!hasLiteralTitleSpan(text)) return true;
  return hasSecondDestructiveCommandAfterLiteralTitle(text);
}

function hasLiteralTitleSpan(text: string): boolean {
  const createObject = /\b(create|add|new|cria|criar|crie|adiciona|adicionar|nova|novo)\b.{0,80}\b(task|todo|tarefa|note|nota)\b/.test(text);
  const titleMarker = /\b(called|titled|named|chamada|chamado|intitulada|intitulado|titulo|com\s+(?:o\s+)?nome)\b/.test(text);
  return createObject && titleMarker;
}

function hasSecondDestructiveCommandAfterLiteralTitle(text: string): boolean {
  const titleMarker = /\b(called|titled|named|chamada|chamado|intitulada|intitulado|titulo|com\s+(?:o\s+)?nome)\b/;
  const marker = titleMarker.exec(text);
  if (!marker) return true;
  const afterTitleMarker = text.slice(marker.index + marker[0].length);
  return /\b(?:and\s+then|and|then|after\s+that|also|e\s+depois|e|depois|tambem|tambem\s+)\s+(?:delete|remove|cancel|clear|eliminate|apaga|apagar|apague|apaguem|remove|remover|remova|removam|cancela|cancelar|cancele|cancelem|limpa|limpar|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam)\b/.test(afterTitleMarker)
    || /[,;]\s*(?:delete|remove|cancel|clear|eliminate|apaga|apagar|apague|apaguem|remove|remover|remova|removam|cancela|cancelar|cancele|cancelem|limpa|limpar|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam)\b/.test(afterTitleMarker);
}

function isGmailAgendaSemantics(text: string): boolean {
  return /(?:agenda|calendario|calendar).{0,18}(?:gmail|google\s+calendar)/.test(text)
    || /(?:gmail|google\s+calendar).{0,18}(?:agenda|calendario|calendar)/.test(text);
}
