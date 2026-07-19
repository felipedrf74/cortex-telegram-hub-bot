// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

const RECEIPT_TTL_MS = 10 * 60 * 1000;
const MAX_CONTENT_LENGTH = 20_000;
const MAX_CAPTURE_COMMAND_LENGTH = 256;

const CAPTURE_DELIMITERS = new Set([':', '-', '–', '—']);
const ENGLISH_CAPTURE_VERBS = new Set(['save', 'capture', 'record', 'keep']);
const PORTUGUESE_CAPTURE_VERBS = new Set([
  'salva', 'salve', 'guarda', 'guarde', 'regista', 'registe',
  'registra', 'registre', 'captura', 'capture',
]);
const PORTUGUESE_NOTE_VERBS = new Set([
  'guarda', 'guarde', 'regista', 'registe', 'registra', 'registre', 'captura', 'capture',
]);
const SPANISH_CAPTURE_VERBS = new Set([
  'guarda', 'guardar', 'captura', 'capturar', 'registra', 'registrar',
]);

export interface ContentIdeaCaptureConsentReceipt {
  v: 1;
  source: 'explicit_current_turn';
  tenantId: number;
  userId: number;
  sourceMessageId: string;
  content: string;
  title: string;
  issuedAtMs: number;
  argumentsHash: string;
}

export type ContentIdeaCaptureConsentValidation =
  | { ok: true; receipt: ContentIdeaCaptureConsentReceipt }
  | {
    ok: false;
    code: 'missing_receipt' | 'expired_receipt' | 'wrong_scope' | 'argument_mismatch' | 'invalid_receipt';
  };

export function issueContentIdeaCaptureConsent(input: {
  tenantId: number;
  userId: number;
  sourceMessageId: string;
  message: string;
  now?: Date;
}): ContentIdeaCaptureConsentReceipt | null {
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId <= 0
    || !Number.isSafeInteger(input.userId) || input.userId <= 0) {
    return null;
  }
  if (typeof input.sourceMessageId !== 'string' || typeof input.message !== 'string') return null;
  const sourceMessageId = input.sourceMessageId.trim();
  if (!sourceMessageId) return null;
  if (input.message.length > MAX_CONTENT_LENGTH + MAX_CAPTURE_COMMAND_LENGTH + 1) return null;
  const content = parseExplicitCaptureContent(input.message);
  if (!content || content.length > MAX_CONTENT_LENGTH) return null;
  const issuedAtMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAtMs)) return null;
  const receipt = {
    v: 1 as const,
    source: 'explicit_current_turn' as const,
    tenantId: input.tenantId,
    userId: input.userId,
    sourceMessageId,
    content,
    title: deriveCapturedIdeaTitle(content),
    issuedAtMs,
  };
  return {
    ...receipt,
    argumentsHash: hashReceiptArguments(receipt),
  };
}

function parseExplicitCaptureContent(rawMessage: string): string | null {
  const message = rawMessage.trim();
  let delimiterIndex = -1;
  for (let index = 0; index < message.length; index += 1) {
    if (CAPTURE_DELIMITERS.has(message[index])) {
      delimiterIndex = index;
      break;
    }
  }
  if (delimiterIndex <= 0) return null;

  const command = message.slice(0, delimiterIndex).trim();
  if (!command || command.length > MAX_CAPTURE_COMMAND_LENGTH) return null;
  const content = message.slice(delimiterIndex + 1).trim();
  if (!content) return null;

  const tokens = command.toLowerCase().split(/\s+/u);
  return matchesEnglishCaptureCommand(tokens)
    || matchesPortugueseCaptureCommand(tokens)
    || matchesSpanishCaptureCommand(tokens)
    ? content
    : null;
}

function withoutPolitePrefix(tokens: string[], language: 'en' | 'romance'): string[] {
  if (language === 'en' && tokens[0] === 'please') return tokens.slice(1);
  if (language === 'romance' && tokens[0] === 'por' && tokens[1] === 'favor') return tokens.slice(2);
  return tokens;
}

function matchesEnglishCaptureCommand(rawTokens: string[]): boolean {
  const tokens = withoutPolitePrefix(rawTokens, 'en');
  if (!ENGLISH_CAPTURE_VERBS.has(tokens[0])) return false;
  let cursor = 1;
  if (tokens[cursor] === 'this') cursor += 1;

  if (tokens[cursor] === 'thought' || tokens[cursor] === 'note') {
    cursor += 1;
    if (tokens[cursor] !== 'as') return false;
    cursor += 1;
    if (tokens[cursor] === 'a') cursor += 1;
    if (tokens[cursor] === 'content') cursor += 1;
    return tokens[cursor] === 'idea' && cursor + 1 === tokens.length;
  }

  if (tokens[cursor] === 'as') {
    cursor += 1;
    if (tokens[cursor] !== 'a' && tokens[cursor] !== 'an') return false;
    cursor += 1;
  }
  if (tokens[cursor] === 'content') cursor += 1;
  return tokens[cursor] === 'idea' && cursor + 1 === tokens.length;
}

function matchesPortugueseCaptureCommand(rawTokens: string[]): boolean {
  const tokens = withoutPolitePrefix(rawTokens, 'romance');
  if (!PORTUGUESE_CAPTURE_VERBS.has(tokens[0])) return false;

  if (PORTUGUESE_NOTE_VERBS.has(tokens[0])
    && (tokens[1] === 'esta' || tokens[1] === 'essa')
    && (tokens[2] === 'nota' || tokens[2] === 'reflexão' || tokens[2] === 'reflexao')) {
    let noteCursor = 3;
    if (tokens[noteCursor] !== 'como') return false;
    noteCursor += 1;
    if (tokens[noteCursor] === 'uma') noteCursor += 1;
    if (tokens[noteCursor] !== 'ideia') return false;
    noteCursor += 1;
    if (tokens[noteCursor] === 'de'
      && (tokens[noteCursor + 1] === 'conteúdo' || tokens[noteCursor + 1] === 'conteudo')) {
      noteCursor += 2;
    }
    return noteCursor === tokens.length;
  }

  let cursor = 1;
  if (tokens[cursor] === 'esta' || tokens[cursor] === 'essa'
    || tokens[cursor] === 'isto' || tokens[cursor] === 'isso') cursor += 1;
  if (tokens[cursor] === 'como') cursor += 1;
  if (tokens[cursor] === 'uma') cursor += 1;
  if (tokens[cursor] !== 'ideia') return false;
  cursor += 1;
  if (tokens[cursor] === 'de'
    && (tokens[cursor + 1] === 'conteúdo' || tokens[cursor + 1] === 'conteudo')) {
    cursor += 2;
  }
  return cursor === tokens.length;
}

function matchesSpanishCaptureCommand(rawTokens: string[]): boolean {
  const tokens = withoutPolitePrefix(rawTokens, 'romance');
  if (!SPANISH_CAPTURE_VERBS.has(tokens[0])) return false;
  let cursor = 1;
  if (tokens[cursor] === 'esta') cursor += 1;
  if (tokens[cursor] === 'como') cursor += 1;
  if (tokens[cursor] === 'una') cursor += 1;
  if (tokens[cursor] !== 'idea') return false;
  cursor += 1;
  if (tokens[cursor] === 'de' && tokens[cursor + 1] === 'contenido') cursor += 2;
  return cursor === tokens.length;
}

export function validateContentIdeaCaptureConsent(
  receipt: ContentIdeaCaptureConsentReceipt | null | undefined,
  expected: {
    tenantId: number;
    userId: number;
    content: unknown;
    title?: unknown;
    now?: Date;
  },
): ContentIdeaCaptureConsentValidation {
  if (!receipt) return { ok: false, code: 'missing_receipt' };
  if (receipt.v !== 1 || receipt.source !== 'explicit_current_turn'
    || !receipt.sourceMessageId || !Number.isFinite(receipt.issuedAtMs)) {
    return { ok: false, code: 'invalid_receipt' };
  }
  if (receipt.tenantId !== expected.tenantId || receipt.userId !== expected.userId) {
    return { ok: false, code: 'wrong_scope' };
  }
  const nowMs = (expected.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs) || receipt.issuedAtMs > nowMs + 5_000
    || nowMs - receipt.issuedAtMs > RECEIPT_TTL_MS) {
    return { ok: false, code: 'expired_receipt' };
  }
  const content = typeof expected.content === 'string' ? expected.content.trim() : '';
  const suppliedTitle = expected.title == null
    ? receipt.title
    : typeof expected.title === 'string'
      ? expected.title.trim()
      : '';
  if (!content || content !== receipt.content || suppliedTitle !== receipt.title) {
    return { ok: false, code: 'argument_mismatch' };
  }
  if (receipt.argumentsHash !== hashReceiptArguments({
    v: receipt.v,
    source: receipt.source,
    tenantId: receipt.tenantId,
    userId: receipt.userId,
    sourceMessageId: receipt.sourceMessageId,
    content: receipt.content,
    title: receipt.title,
    issuedAtMs: receipt.issuedAtMs,
  })) {
    return { ok: false, code: 'invalid_receipt' };
  }
  return { ok: true, receipt };
}

export function deriveCapturedIdeaTitle(content: string): string {
  const firstLine = content.split(/\r?\n/u)[0]?.trim() || content;
  const firstSentence = firstLine.split(/(?<=[.!?])\s/u)[0]?.trim() || firstLine;
  if (firstSentence.length <= 240) return firstSentence;
  return `${firstSentence.slice(0, 237).trimEnd()}…`;
}

function hashReceiptArguments(input: Omit<ContentIdeaCaptureConsentReceipt, 'argumentsHash'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
