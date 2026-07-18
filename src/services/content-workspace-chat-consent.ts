// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

const RECEIPT_TTL_MS = 10 * 60 * 1000;
const MAX_CONTENT_LENGTH = 20_000;

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

const EXPLICIT_CAPTURE_PATTERNS = [
  /^(?:please\s+)?(?:save|capture|record|keep)\s+(?:this\s+)?(?:as\s+(?:a|an)\s+)?(?:content\s+)?idea\s*[:\-–—]\s*([\s\S]+)$/iu,
  /^(?:please\s+)?(?:save|capture|record|keep)\s+(?:this\s+)?(?:thought|note)\s+as\s+(?:a\s+)?(?:content\s+)?idea\s*[:\-–—]\s*([\s\S]+)$/iu,
  /^(?:por\s+favor\s+)?(?:salva|salve|guarda|guarde|regista|registe|registra|registre|captura|capture)\s+(?:esta|essa|isto|isso)?\s*(?:como\s+)?(?:uma\s+)?ideia(?:\s+de\s+conte[uú]do)?\s*[:\-–—]\s*([\s\S]+)$/iu,
  /^(?:por\s+favor\s+)?(?:guarda|guarde|regista|registe|registra|registre|captura|capture)\s+(?:esta|essa)\s+(?:nota|reflex[aã]o)\s+como\s+(?:uma\s+)?ideia(?:\s+de\s+conte[uú]do)?\s*[:\-–—]\s*([\s\S]+)$/iu,
  /^(?:por\s+favor\s+)?(?:guarda|guardar|captura|capturar|registra|registrar)\s+(?:esta\s+)?(?:como\s+)?(?:una\s+)?idea(?:\s+de\s+contenido)?\s*[:\-–—]\s*([\s\S]+)$/iu,
];

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
  const sourceMessageId = input.sourceMessageId.trim();
  if (!sourceMessageId) return null;
  const message = input.message.trim();
  let content: string | null = null;
  for (const pattern of EXPLICIT_CAPTURE_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.[1]) {
      content = match[1].trim();
      break;
    }
  }
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
