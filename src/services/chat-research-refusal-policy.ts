// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

const SHORT_REFUSAL_MAX_CHARS = 420;

export function isResearchProviderRefusal(text: string): boolean {
  const normalized = normalizeResearchRefusalText(text);
  if (!normalized) return true;
  if (!isMostlyRefusalLength(normalized)) return false;
  const adviceOnlyRefusal = isAdviceOnlyRefusal(normalized);
  return /\bi could not produce a safe answer for that request\.?\b/i.test(normalized)
    || /\bi (?:can(?:not|'t)|could(?: not|n't)) (?:produce|provide|generate|give) (?:a )?(?:safe )?answer\b/i.test(normalized)
    || /\bi (?:can(?:not|'t)|could(?: not|n't)) (?:assist|help) with (?:that|this)(?: request)?\b/i.test(normalized)
    || adviceOnlyRefusal
    || /\bas an ai(?: language model)?[, ]+i (?:can(?:not|'t)|could(?: not|n't))\b/i.test(normalized)
    || /\bno puedo (?:producir|dar|ofrecer|proporcionar) una respuesta segura\b/i.test(normalized)
    || /\bno puedo (?:ayudar|asistir) con (?:eso|esto|esa solicitud)\b/i.test(normalized)
    || /\bno puedo proporcionar asesoramiento (?:legal|m[eé]dico|financiero|migratorio)\b/i.test(normalized)
    || /\bn[aã]o (?:posso|consigo) (?:produzir|dar|oferecer|fornecer) uma resposta segura\b/i.test(normalized)
    || /\bn[aã]o (?:posso|consigo) (?:ajudar|auxiliar) com (?:isso|isto|esse pedido|esta solicita[cç][aã]o)\b/i.test(normalized)
    || /\bn[aã]o (?:posso|consigo) (?:fornecer|dar) aconselhamento (?:jur[ií]dico|m[eé]dico|financeiro|migrat[oó]rio)\b/i.test(normalized);
}

function normalizeResearchRefusalText(text: string): string {
  return text
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMostlyRefusalLength(text: string): boolean {
  return text.length <= SHORT_REFUSAL_MAX_CHARS;
}

function isAdviceOnlyRefusal(text: string): boolean {
  const adviceRefusal = /\bi (?:can(?:not|'t)|could(?: not|n't)) provide (?:legal|immigration|medical|financial) advice\b/i.test(text)
    || /\bno puedo proporcionar asesoramiento (?:legal|m[eé]dico|financiero|migratorio)\b/i.test(text)
    || /\bn[aã]o (?:posso|consigo) (?:fornecer|dar) aconselhamento (?:jur[ií]dico|m[eé]dico|financeiro|migrat[oó]rio)\b/i.test(text);
  if (!adviceRefusal) return false;
  return !/\b(?:but|however|here(?:'s| is)|general information|public information|public sources|official sources|official guidance|official public|puedo resumir|informaci[oó]n general|fuentes oficiales|posso resumir|informa[cç][aã]o geral|fontes oficiais)\b/i.test(text);
}
