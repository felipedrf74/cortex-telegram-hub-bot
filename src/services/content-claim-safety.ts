// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type DeterministicContentClaimRisk = 'standard' | 'sensitive' | 'regulated';

const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  'а': 'a',
  'е': 'e',
  'і': 'i',
  'ј': 'j',
  'к': 'k',
  'м': 'm',
  'о': 'o',
  'р': 'p',
  'с': 'c',
  'х': 'x',
  'у': 'y',
  'т': 't',
  'α': 'a',
  'ε': 'e',
  'ι': 'i',
  'κ': 'k',
  'μ': 'm',
  'ν': 'v',
  'ο': 'o',
  'ρ': 'p',
  'τ': 't',
  'χ': 'x',
});

const MEDICAL_DOMAIN_PATTERNS = [
  /\b(?:medic\w*|doctor\w*|physician\w*|clinician\w*|health\w*|hospital\w*|symptom\w*|disease\w*|illness\w*|diagnos\w*|treat\w*|therap\w*|cure\w*|remed\w*|dosage\w*|dose\w*|pill\w*|capsule\w*|supplement\w*|medicat\w*|prescription\w*|vaccine\w*|insulin\w*|diabet\w*|cancer\w*|pregnan\w*|injur\w*)\b/u,
  /\b(?:salud\w*|enfermed\w*|sintom\w*|diagnost\w*|tratam\w*|terapi\w*|cura\w*|remedi\w*|dosis\w*|pastill\w*|capsul\w*|suplement\w*|medicament\w*|farmac\w*|receta\w*|vacun\w*|embaraz\w*)\b/u,
  /\b(?:saude\w*|doenc\w*|sintom\w*|diagnost\w*|tratam\w*|terapi\w*|cura\w*|remedi\w*|dose\w*|comprimid\w*|capsul\w*|suplement\w*|medicament\w*|farmac\w*|receita\w*|vacin\w*|gravid\w*|lesa\w*)\b/u,
  /\b(?:blood sugar|blood pressure|mental health|azucar (?:en|de la) sangre|presion arterial|saude mental|acucar (?:no|do) sangue|pressao arterial)\b/u,
] as const;

const LEGAL_DOMAIN_PATTERNS = [
  /\b(?:legal\w*|lawful\w*|lawyer\w*|attorney\w*|court\w*|judge\w*|lawsuit\w*|contract\w*|enforce\w*|liabilit\w*|compliance\w*|eviction\w*|custody\w*)\b/u,
  /\b(?:subpoena\w*|warrant\w*|summons\w*|fine\w*|penalt\w*)\b/u,
  /\b(?:abogad\w*|tribunal\w*|citacion\w*|demand\w*|contrat\w*|ejecutab\w*|responsabil\w*|reglament\w*|desaloj\w*|custodi\w*)\b/u,
  /\b(?:advogad\w*|tribunal\w*|intimac\w*|citac\w*|processo judicial\w*|contrat\w*|exigivel\w*|responsabil\w*|regulament\w*|despej\w*|guarda legal\w*)\b/u,
] as const;

const FINANCE_DOMAIN_PATTERNS = [
  /\b(?:financ\w*|invest\w*|return on investment\w*|profit\w*|yield\w*|portfolio\w*|stock\w*|crypto\w*|money\w*|saving\w*|wealth\w*|asset\w*|loan\w*|debt\w*|credit\w*|mortgage\w*|tax\w*|income\w*|deduct\w*|irs)\b/u,
  /\b(?:inversion\w*|retorno\w*|gananci\w*|rentabil\w*|cartera\w*|accion\w*|cripto\w*|dinero\w*|ahorro\w*|patrimonio\w*|activo financiero\w*|prestam\w*|deuda\w*|credito\w*|hipoteca\w*|impuesto\w*|hacienda\w*|ingreso\w*|deduc\w*)\b/u,
  /\b(?:investiment\w*|retorno\w*|lucro\w*|rendimento\w*|carteira\w*|acoes\w*|cripto\w*|dinheiro\w*|poupanca\w*|patrimonio\w*|ativo financeiro\w*|emprestim\w*|divida\w*|credito\w*|hipoteca\w*|juro\w*|imposto\w*|receita federal\w*|renda\w*|deduz\w*)\b/u,
] as const;

const MEDICAL_ASSERTION_PATTERNS = [
  /\b(?:cure(?:s|d)?|treat(?:s|ed)?|heal(?:s|ed|ing)?|reverse(?:s|d)?|prevent(?:s|ed)?|diagnos(?:e|es|ed)|remove(?:s|d|ing)?|eliminat(?:e|es|ed)|reliev(?:e|es|ed)|lower(?:s|ed)?|raise(?:s|d)?|replace(?:s|d)?|skip(?:s|ped)?|ignor(?:e|es|ed)|stop taking|without medical|without a doctor|makes? you lose|lose\s+\d[\d,.]*\s*(?:pounds?|lbs?|kg|kilos?))\b/u,
  /\b(?:cura\w*|trata\w*|sana\w*|revierte\w*|previene\w*|diagnost\w*|elimina\w*|alivia\w*|reduce\w*|aumenta\w*|reemplaza\w*|omite\w*|ignora\w*|sin (?:un |una )?medic\w*)\b/u,
  /\b(?:cura\w*|trata\w*|sara\w*|reverte\w*|previne\w*|diagnost\w*|elimina\w*|alivia\w*|reduz\w*|aumenta\w*|substitui\w*|ignore\w*|sem (?:um |uma )?medic\w*)\b/u,
] as const;

const LEGAL_ASSERTION_PATTERNS = [
  /\b(?:ignore\w*|throw away|discard\w*|evade\w*|avoid\w*|cannot enforce\w*|not enforceable|no (?:legal )?(?:consequence\w*|effect)|nothing will happen|do not (?:respond|comply)|don t (?:respond|comply)|without (?:a )?(?:lawyer|attorney))\b/u,
  /\b(?:ignora\w*|evita\w*|no (?:es )?ejecutab\w*|sin consecuencias? legal\w*|sin (?:un |una )?abogad\w*)\b/u,
  /\b(?:ignore\w*|evite\w*|nao (?:e )?exigivel\w*|sem consequencias? lega\w*|sem (?:um |uma )?advogad\w*)\b/u,
] as const;

const FINANCE_ASSERTION_PATTERNS = [
  /\b(?:risk free|no risk|zero risk|cannot lose|double\w*|triple\w*|multiply\w*|turn\s+\$?\d[\d,.]*\s+into\s+\$?\d[\d,.]*|(?:earn|return|yield)\w*\s+\d[\d,.]*\s*%\s+(?:(?:every|per)\s+(?:day|week|month|year)|daily|weekly|monthly|yearly)|overnight|do not (?:declare|report|pay)|don t (?:declare|report|pay)|avoid\w* tax|evade\w* tax)\b/u,
  /\b(?:sin riesgo|riesgo cero|no (?:puedes?|puede) perder|duplica\w*|triplica\w*|no (?:debes?|necesitas?) declarar|evita\w* impuesto\w*)\b/u,
  /\b(?:sem risco|risco zero|nao (?:pode|vai) perder|duplica\w*|triplica\w*|nao (?:precisa|deve) declarar|evita\w* imposto\w*)\b/u,
] as const;

const DIRECT_HIGH_RISK_PATTERNS = [
  /\b(?:makes? you lose|lose)\s+\d[\d,.]*\s*(?:pounds?|lbs?|kg|kilos?)\s+in\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?)\b/u,
  /\b(?:supplement\w*|capsule\w*|pill\w*|tea|herb\w*)?\s*(?:melt\w*|burn\w*|remove\w*|eliminat\w*)\s+(?:belly\s+|body\s+)?fat\s+in\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?)\b/u,
  /\b(?:remove\w*|eliminat\w*|reverse\w*|cure\w*)\s+(?:diabet\w*|cancer\w*|disease\w*|symptom\w*)\s+(?:permanent\w*|forever|in\s+\d+\s+(?:days?|weeks?))\b/u,
  /\bstop\s+(?:taking\s+)?(?:insulin\w*|medicat\w*|medicine\w*|prescription\w*)\b/u,
  /\bturn\s+\$?\d[\d,.]*\s+into\s+\$?\d[\d,.]*\s+(?:overnight|in\s+(?:\d+|one|two|three|four|five|six|seven)\s+days?)\b/u,
  /\bignore\s+(?:a\s+)?(?:subpoena|warrant|summons)\b/u,
  /\b(?:te\s+hace\s+|hace\s+|ayuda\s+a\s+)?perder\s+\d[\d,.]*\s*(?:kilos?|kg|libras?)\s+en\s+(?:una?\s+|\d+\s+)?(?:semana|semanas|dias?)\b/u,
  /\b(?:faz\s+|ajuda\s+a\s+)?perder\s+\d[\d,.]*\s*(?:quilos?|kg|libras?)\s+em\s+(?:uma?\s+|\d+\s+)?(?:semana|semanas|dias?)\b/u,
  /\b(?:puedes?\s+)?ignorar\s+(?:una?\s+)?citacion(?:\s+judicial)?\b/u,
  /\b(?:podes?\s+)?ignorar\s+(?:uma?\s+)?(?:citacao|intimacao)(?:\s+judicial)?\b/u,
  /\b(?:treatment\w*|supplement\w*|capsule\w*|pill\w*|remedy\w*)\s+guarantee\w*\s+(?:a\s+)?(?:cure\w*|recovery|weight loss|symptom relief)\b/u,
  /\b(?:legal service\w*|lawyer\w*|attorney\w*)\s+guarantee\w*\s+(?:that\s+)?(?:you\s+will\s+)?(?:win\w*|avoid\w*|succeed\w*)\b/u,
  /\bguarantee\w*\s+(?:a\s+)?legal\s+(?:win\w*|victory|outcome)\b/u,
  /\b(?:guarantee\w*\s+(?:a\s+)?(?:return|profit|yield|income)|(?:investment\s+)?(?:return|profit|yield|income)\s+(?:is\s+)?guarantee\w*)\b/u,
  /\b(?:tratamiento\w*|suplement\w*|capsul\w*|remedi\w*)\s+garantiz\w*\s+(?:una?\s+)?(?:cura\w*|recuperacion|perdida de peso)\b/u,
  /\b(?:tratamento\w*|suplement\w*|capsul\w*|remedi\w*)\s+garant\w*\s+(?:uma?\s+)?(?:cura\w*|recuperacao|perda de peso)\b/u,
  /\b(?:garantiz\w*\s+(?:un\s+)?(?:retorno|ganancia|rentabilidad)|(?:retorno|ganancia|rentabilidad)\s+(?:esta\s+)?garantiz\w*)\b/u,
  /\b(?:garant\w*\s+(?:um\s+)?(?:retorno|lucro|rendimento)|(?:retorno|lucro|rendimento)\s+(?:e\s+)?garant\w*)\b/u,
] as const;

const COMPACT_DOMAIN_FRAGMENTS = [
  'medical', 'medic', 'doctor', 'physician', 'diagnos', 'treatment', 'therapy',
  'cure', 'remedy', 'dosage', 'pill', 'capsule', 'supplement', 'medication', 'prescription', 'vaccine', 'diabet',
  'cancer', 'bloodsugar', 'bloodpressure', 'mentalhealth',
  'salud', 'enfermed', 'sintom', 'tratam', 'remedi', 'pastill', 'capsul', 'suplement', 'medicament', 'farmac',
  'azucarensangre', 'presionarterial', 'embaraz',
  'saude', 'doenc', 'comprimid', 'acucarnosangue', 'pressaoarterial', 'gravid',
  'legal', 'lawful', 'lawyer', 'attorney', 'court', 'judge', 'lawsuit', 'contract',
  'enforce', 'liabilit', 'compliance', 'eviction', 'custody',
  'abogad', 'tribunal', 'demand', 'ejecutab', 'responsabil', 'desaloj', 'custodi',
  'advogad', 'processojudicial', 'exigivel', 'regulament', 'despej', 'guardalegal',
  'financial', 'finance', 'invest', 'returnoninvestment', 'profit', 'portfolio',
  'stock', 'crypto', 'money', 'saving', 'wealth', 'asset', 'loan', 'debt', 'credit', 'mortgage', 'tax',
  'income', 'deduct', 'inversion', 'gananci', 'rentabil', 'cartera', 'accion',
  'dinero', 'ahorro', 'patrimonio', 'activofinanciero', 'prestam', 'deuda', 'impuesto', 'hacienda', 'ingreso',
  'investiment', 'lucro', 'rendimento', 'carteira', 'acoes', 'dinheiro',
  'poupanca', 'patrimonio', 'ativofinanceiro', 'emprestim', 'divida', 'hipoteca', 'juros', 'imposto', 'receitafederal', 'renda',
] as const;

const COMPACT_ASSERTION_FRAGMENTS = [
  'cure', 'treat', 'heal', 'reverse', 'prevent', 'diagnos', 'eliminat',
  'skipdoctor', 'withoutdoctor', 'ignore', 'cannotenforce', 'nothingwillhappen',
  'guarantee', 'riskfree', 'norisk', 'cannotlose', 'double', 'triple',
  'nodeclare', 'dontdeclare', 'naoprecisadeclarar', 'nonecesitasdeclarar',
] as const;

const HIGH_RISK_QUALIFIER_PATTERNS = [
  /\b(?:risk free|no risk|zero risk|cannot fail|without (?:a )?(?:doctor|lawyer|professional)|skip (?:the )?(?:doctor|lawyer))\b/u,
  /\b(?:sin riesgo|riesgo cero|no puede fallar|sin (?:un |una )?(?:medico|abogado|profesional)|sustituye (?:al|a la) (?:medico|abogado))\b/u,
  /\b(?:sem risco|risco zero|nao pode falhar|sem (?:um |uma )?(?:medico|advogado|profissional)|substitui (?:o|a) (?:medico|advogado))\b/u,
  /\b100\s*%/u,
] as const;

const FACTUAL_CLAIM_SIGNAL_PATTERNS = [
  /\b(?:according to|research|study|studies|data|survey|report|analysis|statistics|evidence|clinical trial)\b/u,
  /\b(?:segun|investigacion|estudio|estudios|datos|encuesta|informe|analisis|estadisticas|evidencia|ensayo clinico)\b/u,
  /\b(?:segundo|pesquisa|estudo|estudos|dados|levantamento|relatorio|analise|estatisticas|evidencia|ensaio clinico)\b/u,
  /\b\d[\d,.]*\s*(?:%|(?:percent|percentage|people|users|customers|clients|days|weeks|months|years|times|fold|x)\b)/u,
  /\b(?:in|since|by)\s+(?:19|20)\d{2}\b/u,
] as const;

/**
 * Derive claim risk on the server. Provider/client risk labels are hints only:
 * callers must take the maximum of this result and any trusted policy label.
 * The normalizer removes accents, common homoglyphs, zero-width characters,
 * punctuation, and common leetspeak so separator tricks cannot downgrade risk.
 */
export function classifyContentClaimRisk(text: string): DeterministicContentClaimRisk {
  const atoms = sentenceAtomsForRisk(text);
  if (atoms.length > 1) {
    let risk: DeterministicContentClaimRisk = 'standard';
    for (const atom of atoms) risk = strongestDeterministicRisk(risk, classifySingleContentClaimRisk(atom));
    for (const windowSize of [2, 3]) {
      for (let index = 0; index + windowSize <= atoms.length; index += 1) {
        const continuation = atoms.slice(index + 1, index + windowSize).join(' ');
        if (!hasClaimContinuation(continuation)) continue;
        risk = strongestDeterministicRisk(
          risk,
          classifySingleContentClaimRisk(atoms.slice(index, index + windowSize).join(' ')),
        );
      }
    }
    return risk;
  }
  return classifySingleContentClaimRisk(text);
}

function classifySingleContentClaimRisk(text: string): DeterministicContentClaimRisk {
  const obfuscation = classifyClaimObfuscation(text);
  const normalized = normalizeForClaimSafety(text);
  if (!normalized) return 'standard';
  const obfuscatedCompacts = extractObfuscatedCompacts(text);
  const hasMedicalDomain = MEDICAL_DOMAIN_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasLegalDomain = LEGAL_DOMAIN_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasFinanceDomain = FINANCE_DOMAIN_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasObfuscatedDomain = obfuscatedCompacts.some((compact) => COMPACT_DOMAIN_FRAGMENTS.some((fragment) => (
      fragment.length >= 5 ? compact.includes(fragment) : compact === fragment
    )));
  const hasObfuscatedAssertion = obfuscatedCompacts.some((compact) => (
    COMPACT_ASSERTION_FRAGMENTS.some((fragment) => compact.includes(fragment))
  ));
  const highRiskQualifier = HIGH_RISK_QUALIFIER_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasAnyRegulatedAssertion = [
    ...MEDICAL_ASSERTION_PATTERNS,
    ...LEGAL_ASSERTION_PATTERNS,
    ...FINANCE_ASSERTION_PATTERNS,
  ].some((pattern) => pattern.test(normalized));
  if (DIRECT_HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized))
    || (hasMedicalDomain && MEDICAL_ASSERTION_PATTERNS.some((pattern) => pattern.test(normalized)))
    || (hasLegalDomain && LEGAL_ASSERTION_PATTERNS.some((pattern) => pattern.test(normalized)))
    || (hasFinanceDomain && FINANCE_ASSERTION_PATTERNS.some((pattern) => pattern.test(normalized)))
    || ((hasMedicalDomain || hasLegalDomain || hasFinanceDomain)
      && (highRiskQualifier || hasObfuscatedAssertion))
    || (hasObfuscatedDomain && (hasAnyRegulatedAssertion || highRiskQualifier || hasObfuscatedAssertion))) {
    return 'regulated';
  }
  if (obfuscation === 'opaque') return 'sensitive';
  return highRiskQualifier ? 'sensitive' : 'standard';
}

export function extractHighRiskContentClaims(text: string, limit = 100): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const segments = contentClaimSegments(text);
  const claims = new Map<string, string>();
  for (const segment of segments) {
    const claim = segment.trim();
    if (!claim || classifyContentClaimRisk(claim) === 'standard') continue;
    const key = normalizeForClaimSafety(claim);
    if (!isSubsumedClaim(key, claims.keys())) claims.set(key, claim);
    if (claims.size >= Math.min(limit, 100)) break;
  }
  return Array.from(claims.values());
}

/**
 * Extract statements that need an evidence decision even when they are not
 * regulated. This intentionally stays conservative and deterministic: an
 * ordinary unsupported statistic becomes a visible warning, while only the
 * high-risk classifier can make the policy block approval.
 */
export function extractReviewableContentClaims(text: string, limit = 100): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const candidates = contentClaimSegments(text).map((claim, index) => ({
    claim: claim.trim(),
    index,
    risk: classifyContentClaimRisk(claim),
    normalized: normalizeForClaimSafety(claim),
  })).filter(({ claim, risk, normalized }) => Boolean(claim) && (
    risk !== 'standard'
    || FACTUAL_CLAIM_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized))
  ));
  candidates.sort((left, right) => (
    Number(right.risk !== 'standard') - Number(left.risk !== 'standard')
    || left.index - right.index
  ));
  const claims = new Map<string, string>();
  for (const candidate of candidates) {
    if (!isSubsumedClaim(candidate.normalized, claims.keys())) {
      claims.set(candidate.normalized, candidate.claim);
    }
    if (claims.size >= Math.min(limit, 100)) break;
  }
  return Array.from(claims.values());
}

function normalizeForClaimSafety(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, '')
    .replace(/[\u0430\u0435\u0456\u0458\u043a\u043c\u043e\u0440\u0441\u0442\u0445\u0443\u03b1\u03b5\u03b9\u03ba\u03bc\u03bd\u03bf\u03c1\u03c4\u03c7]/gu, (character) => CONFUSABLES[character] ?? character)
    .replace(/(?<=\d)[,.](?=\d)/gu, '')
    .replace(/[^a-z0-9%]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function classifyClaimObfuscation(value: string): 'none' | 'join' | 'opaque' {
  if (/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(value)) return 'opaque';
  const hasLatin = /[A-Za-z]/u.test(value);
  const hasGreekOrCyrillic = /[\u0370-\u03FF\u0400-\u04FF]/u.test(value);
  if (hasLatin && hasGreekOrCyrillic) return 'opaque';
  if (/(?:[A-Za-z][013457](?=[A-Za-z])|[013457](?=[A-Za-z]))/u.test(value)) return 'join';
  if (/\b[A-Za-z]{2,}[._·-][A-Za-z]{2,}\b/u.test(value)) return 'join';
  if (/(?:[A-Za-z]\s*[._·-]\s*){2,}[A-Za-z]/u.test(value)) return 'join';
  return /(?:\b[A-Za-z]\b\s+){3,}\b[A-Za-z]\b/u.test(value) ? 'join' : 'none';
}

function extractObfuscatedCompacts(value: string): string[] {
  const candidates = new Set<string>();
  for (const token of value.split(/\s+/u)) {
    if (
      /(?:[A-Za-z][013457](?=[A-Za-z])|[013457](?=[A-Za-z]))/u.test(token)
      || /[A-Za-z]{2,}[._·-][A-Za-z]{2,}/u.test(token)
      || /(?:[A-Za-z]\s*[._·-]\s*){2,}[A-Za-z]/u.test(token)
      || /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(token)
      || (/[A-Za-z]/u.test(token) && /[\u0370-\u03FF\u0400-\u04FF]/u.test(token))
    ) {
      candidates.add(compactForClaimSafety(normalizeForClaimSafety(token)));
    }
  }
  for (const match of value.matchAll(/(?:[A-Za-z]\s*[._·-]\s*){2,}[A-Za-z]/gu)) {
    candidates.add(compactForClaimSafety(normalizeForClaimSafety(match[0])));
  }
  for (const match of value.matchAll(/(?:\b[A-Za-z]\b\s+){3,}\b[A-Za-z]\b/gu)) {
    candidates.add(compactForClaimSafety(normalizeForClaimSafety(match[0])));
  }
  candidates.delete('');
  return Array.from(candidates);
}

function compactForClaimSafety(normalized: string): string {
  return normalized
    .replace(/[@4]/gu, 'a')
    .replace(/[3]/gu, 'e')
    .replace(/[1!|]/gu, 'i')
    .replace(/[0]/gu, 'o')
    .replace(/[5$]/gu, 's')
    .replace(/[7+]/gu, 't')
    .replace(/[^a-z]+/gu, '');
}

function boundedClaimSegments(value: string, maxChars: number, overlap: number): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  const output: string[] = [];
  const step = maxChars - overlap;
  for (let start = 0; start < trimmed.length; start += step) {
    output.push(trimmed.slice(start, start + maxChars));
    if (start + maxChars >= trimmed.length) break;
  }
  return output;
}

function contentClaimSegments(text: string): string[] {
  const normalized = text
    .replace(/\r\n?/gu, '\n')
    // A newline is formatting, not a claim boundary. Treating it as a hard
    // split lets a domain and its promise be placed on adjacent lines to evade
    // classification (for example, "This investment\nwill double it").
    .replace(/\n+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return [];
  const atoms = normalized
    .split(/(?<=[!?])\s+|(?<=\.)\s+/u)
    .flatMap((segment) => boundedClaimSegments(segment, 2_000, 200));
  const candidates = [...atoms];
  // Claims frequently span a setup sentence and its promised outcome. Scan
  // referential adjacent windows as well as individual display sentences so
  // punctuation cannot separate a regulated subject from "it/this/that" in
  // the outcome. Unrelated neighboring sentences must not be combined merely
  // because one mentions a doctor, court, investment, or tax workshop.
  for (const windowSize of [2, 3]) {
    for (let index = 0; index + windowSize <= atoms.length; index += 1) {
      const continuation = atoms.slice(index + 1, index + windowSize).join(' ');
      if (!hasClaimContinuation(continuation)) continue;
      candidates.push(...boundedClaimSegments(
        atoms.slice(index, index + windowSize).join(' '),
        2_000,
        200,
      ));
    }
  }
  return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
}

function hasReferentialContinuation(value: string): boolean {
  const normalized = normalizeForClaimSafety(value);
  return /\b(?:it|this|that|these|those|them|one|esto|eso|este|ese|aquello|ele|ela|isso|isto|aquilo)\b/u
    .test(normalized);
}

function hasClaimContinuation(value: string): boolean {
  if (hasReferentialContinuation(value)) return true;
  const normalized = normalizeForClaimSafety(value);
  return /^(?:(?:claim|promise|result|outcome|benefit|assertion)\s+)?(?:will\s+)?(?:return\w*|earn\w*|double\w*|triple\w*|multiply\w*|guarantee\w*|cure\w*|remove\w*|eliminat\w*|reverse\w*|ignore\w*|duplica\w*|triplica\w*|garant\w*)\b/u
    .test(normalized);
}

function sentenceAtomsForRisk(value: string): string[] {
  const normalized = value.replace(/\r\n?/gu, '\n').replace(/\n+/gu, ' ').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[!?])\s+|(?<=\.)\s+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function strongestDeterministicRisk(
  left: DeterministicContentClaimRisk,
  right: DeterministicContentClaimRisk,
): DeterministicContentClaimRisk {
  const rank: Record<DeterministicContentClaimRisk, number> = {
    standard: 0,
    sensitive: 1,
    regulated: 2,
  };
  return rank[right] > rank[left] ? right : left;
}

function isSubsumedClaim(candidate: string, selected: Iterable<string>): boolean {
  for (const existing of selected) {
    if (existing === candidate || existing.includes(candidate) || candidate.includes(existing)) return true;
  }
  return false;
}
