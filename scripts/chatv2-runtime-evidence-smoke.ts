#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Drives ordinary natural-language chat turns through the real local API so
 * ChatV2 runtime evidence is produced by the server-side recorder. This script
 * does not insert readiness rows directly. If evidence flags are not enabled in
 * the running backend, the run will succeed but readiness rows will remain at 0.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import dotenv from 'dotenv';

type RuntimePrompt = {
  text: string;
  language: 'en' | 'pt-BR' | 'pt-PT' | 'mixed';
};

const root = path.resolve(__dirname, '..');
const baseUrl = trimTrailingSlash(readArg('--base-url') ?? process.env.CHATV2_RUNTIME_BASE_URL ?? 'http://127.0.0.1:8200');
const tokenFile = path.resolve(readArg('--token-file') ?? process.env.CHATV2_RUNTIME_TOKEN_FILE ?? path.join(root, '.local/full-nexus/local-ios-auth.json'));
const inviteCode = readArg('--invite-code') ?? process.env.IOS_INVITE_CODE ?? 'LOCAL-DEV-INVITE';
const rows = parsePositiveInt(readArg('--rows')) ?? 64;
const writeRows = parsePositiveInt(readArg('--write-rows')) ?? 0;
const dbPath = readArg('--db') ?? process.env.CHATV2_RUNTIME_DB ?? path.join(root, 'data/local.db');
const failOnBlocked = hasFlag('--fail-on-blocked');
const skipReadiness = hasFlag('--skip-readiness');
const reviewOutPath = readArg('--review-out');
const allowRawReviewArtifact = hasFlag('--allow-raw-review-artifact');
const isolatePrompts = hasFlag('--isolate-prompts');
const confirmWritePreviews = hasFlag('--confirm-write-previews');
const promptsFile = readArg('--prompts-file');
const writePromptsFile = readArg('--write-prompts-file');
const unsupportedClaimProbe = hasFlag('--unsupported-claim-probe');

dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

type RuntimeAuth = {
  token: string;
  userId: number;
  tenantId: number;
};

type RuntimeReviewRow = {
  schemaVersion: 'chat_v2_answer_canary_label_row.v1' | 'chat_v2_answer_canary_review_row.v1';
  evidenceSource: 'runtime_route';
  messageHmac: string;
  requestId: string;
  language: RuntimePrompt['language'];
  promptText?: string;
  responseText?: string;
  domain?: unknown;
  routeMethod?: unknown;
  status: number;
  answerAccepted: null;
  reviewerNotes: '';
};

async function main(): Promise<void> {
  if (writeRows > 0 && !isolatePrompts) {
    throw new Error('Refusing write evidence smoke without --isolate-prompts. Write samples must use temporary users, not the operator token.');
  }
  const sharedAuth = isolatePrompts ? null : await resolveAuth();
  const prompts = promptsFile ? readPromptsFile(promptsFile).slice(0, rows) : buildRuntimePrompts(rows);
  const results: Array<{ index: number; language: RuntimePrompt['language']; status: number; ok: boolean; domain?: unknown; routeMethod?: unknown }> = [];
  const writeResults: Array<{ index: number; status: number; ok: boolean; confirmedStatus?: number; confirmedOk?: boolean; routeMethod?: unknown }> = [];
  const reviewRows: RuntimeReviewRow[] = [];

  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index]!;
    const auth = sharedAuth ?? await registerAuth();
    const requestId = `chatv2-runtime-evidence-${Date.now()}-${index}`;
    const response = await fetch(`${baseUrl}/api/v1/chat/message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Language': prompt.language,
        'User-Agent': 'NexusHubChatV2RuntimeEvidenceSmoke/1',
        'X-Client-Message-Id': requestId,
        'X-Chat-V2-First-Progress-Ms': '250',
        ...(unsupportedClaimProbe ? { 'X-Chat-V2-Evidence-Probe': 'unsupported_claim' } : {}),
      },
      body: JSON.stringify({ text: prompt.text, clientMessageId: requestId }),
    });
    const body = await safeJson(response);
    results.push({
      index: index + 1,
      language: prompt.language,
      status: response.status,
      ok: response.ok,
      domain: body?.domain,
      routeMethod: body?.routeMethod,
    });
    if (reviewOutPath) {
      const messageHmac = hmacToken('message', `${auth.tenantId}:${auth.userId}:${prompt.text.trim()}`);
      reviewRows.push({
        schemaVersion: allowRawReviewArtifact
          ? 'chat_v2_answer_canary_review_row.v1'
          : 'chat_v2_answer_canary_label_row.v1',
        evidenceSource: 'runtime_route',
        messageHmac,
        requestId,
        language: prompt.language,
        ...(allowRawReviewArtifact ? {
          promptText: prompt.text,
          responseText: extractResponseText(body),
        } : {}),
        domain: body?.domain,
        routeMethod: body?.routeMethod,
        status: response.status,
        answerAccepted: null,
        reviewerNotes: '',
      });
    }
    if (!response.ok) {
      console.error(JSON.stringify({
        schemaVersion: 'chat_v2_runtime_evidence_smoke_error.v1',
        index: index + 1,
        language: prompt.language,
        status: response.status,
        code: body?.error?.code,
        message: body?.error?.message,
      }));
      process.exitCode = 1;
      break;
    }
  }

  if (process.exitCode == null && writeRows > 0) {
    const writePrompts = writePromptsFile ? readPromptsFile(writePromptsFile).slice(0, writeRows) : buildRuntimeWritePrompts(writeRows);
    for (let index = 0; index < writePrompts.length; index += 1) {
      const prompt = writePrompts[index]!;
      const auth = await registerAuth();
      const requestId = `chatv2-runtime-write-evidence-${Date.now()}-${index}`;
      const response = await fetch(`${baseUrl}/api/v1/chat/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Language': prompt.language,
          'User-Agent': 'NexusHubChatV2RuntimeEvidenceSmoke/1',
          'X-Client-Message-Id': requestId,
          'X-Chat-V2-First-Progress-Ms': '250',
        },
        body: JSON.stringify({ text: prompt.text, clientMessageId: requestId }),
      });
      const body = await safeJson(response);
      let confirmedStatus: number | undefined;
      let confirmedOk: boolean | undefined;
      const token = body?.metadata?.pendingConfirmation?.confirmation_token
        ?? body?.metadata?.pendingConfirmation?.confirmationToken
        ?? body?.metadata?.actionConfirmation?.confirmationToken;
      const intentClass = body?.metadata?.pendingConfirmation?.intent_class
        ?? body?.metadata?.pendingConfirmation?.intentClass
        ?? body?.metadata?.actionConfirmation?.intentClass;
      if (confirmWritePreviews && response.status === 202 && typeof token === 'string') {
        const confirmed = await fetch(`${baseUrl}/api/v1/chat/confirm-action`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'NexusHubChatV2RuntimeEvidenceSmoke/1',
          },
          body: JSON.stringify({
            confirmation_token: token,
            intent_class: typeof intentClass === 'string' ? intentClass : undefined,
            idempotencyKey: `${requestId}:confirm`,
          }),
        });
        confirmedStatus = confirmed.status;
        confirmedOk = confirmed.ok;
      }
      writeResults.push({
        index: index + 1,
        status: response.status,
        ok: response.ok,
        confirmedStatus,
        confirmedOk,
        routeMethod: body?.routeMethod,
      });
      if (!response.ok || confirmedOk === false) {
        console.error(JSON.stringify({
          schemaVersion: 'chat_v2_runtime_write_evidence_smoke_error.v1',
          index: index + 1,
          status: response.status,
          confirmedStatus,
          code: body?.error?.code,
          message: body?.error?.message,
        }));
        process.exitCode = 1;
        break;
      }
    }
  }

  const okCount = results.filter((result) => result.ok).length;
  const summary = {
    schemaVersion: 'chat_v2_runtime_evidence_smoke_result.v1',
    baseUrl,
    requestedRows: rows,
    sentRows: results.length,
    okRows: okCount,
    requestedWriteRows: writeRows,
    sentWriteRows: writeResults.length,
    okWriteRows: writeResults.filter((result) => result.ok && result.confirmedOk !== false).length,
    dbPath,
    isolatePrompts,
    confirmWritePreviews,
    warning: 'Rows are valid runtime evidence only if the running backend had CHAT_V2_* evidence flags enabled before this script ran.',
  };
  console.log(JSON.stringify(summary, null, 2));
  if (reviewOutPath) {
    writeReviewRows(reviewOutPath, reviewRows);
    console.log(JSON.stringify({
      schemaVersion: 'chat_v2_answer_canary_review_export.v1',
      path: path.resolve(reviewOutPath),
      rows: reviewRows.length,
      rawTextIncluded: allowRawReviewArtifact,
      note: allowRawReviewArtifact
        ? 'Raw review artifact requested explicitly. Do not import or store raw text in evidence tables.'
        : 'HMAC-only label skeleton. Fill answerAccepted booleans before importing labels; no raw prompt/response text is stored.',
    }, null, 2));
  }

  if (!skipReadiness && okCount > 0) {
    const readiness = spawnSync(
      'npx',
      ['tsx', 'scripts/chatv2-completion-readiness.ts', '--db', dbPath, '--limit', String(Math.max(rows, 64)), ...(failOnBlocked ? ['--fail-on-blocked'] : [])],
      { cwd: root, stdio: 'inherit', env: process.env },
    );
    if (readiness.status && readiness.status !== 0) {
      process.exitCode = readiness.status;
    }
  }
}

async function resolveAuth(): Promise<RuntimeAuth> {
  const existing = readTokenFile(tokenFile);
  if (existing) return existing;
  return registerAuth(tokenFile);
}

async function registerAuth(writePath?: string): Promise<RuntimeAuth> {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: `chatv2-runtime-evidence-${Date.now()}`,
      deviceName: 'ChatV2 Runtime Evidence Smoke',
      inviteCode,
    }),
  });
  const body = await safeJson(response);
  const payload = body?.data ?? body;
  if (!response.ok || typeof payload?.accessToken !== 'string') {
    throw new Error(`Unable to register local auth token: HTTP ${response.status} ${JSON.stringify(body?.error ?? body)}`);
  }
  if (writePath) {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, JSON.stringify({
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresIn: payload.expiresIn,
      user: payload.user,
    }, null, 2));
  }
  return authFromPayload(payload.accessToken, payload.user);
}

function readTokenFile(filePath: string): RuntimeAuth | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.accessToken === 'string' && parsed.accessToken.trim()) return authFromPayload(parsed.accessToken.trim(), parsed.user);
    if (typeof parsed.token === 'string' && parsed.token.trim()) return authFromPayload(parsed.token.trim(), parsed.user);
    if (typeof parsed.jwt === 'string' && parsed.jwt.trim()) return authFromPayload(parsed.jwt.trim(), parsed.user);
  } catch {
    return authFromPayload(raw, null);
  }
  return null;
}

function authFromPayload(token: string, user: unknown): RuntimeAuth {
  const record = user && typeof user === 'object' ? user as Record<string, unknown> : null;
  const userId = numberFromUnknown(record?.id ?? record?.userId ?? process.env.CHATV2_RUNTIME_USER_ID);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Unable to resolve user id for runtime evidence HMAC export. Set CHATV2_RUNTIME_USER_ID or regenerate the token file.');
  }
  const tenantId = numberFromUnknown(record?.tenantId ?? record?.tenant_id ?? process.env.CHATV2_RUNTIME_TENANT_ID) ?? userId;
  return { token, userId, tenantId };
}

async function safeJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 240) };
  }
}

function extractResponseText(body: any): string {
  const candidates = [
    body?.text,
    body?.message,
    body?.data?.text,
    body?.data?.message,
    body?.response?.text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

function writeReviewRows(filePath: string, rows: RuntimeReviewRow[]): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function hmacToken(kind: string, value: string): string {
  const secret = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (!secret) {
    throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required when exporting answer canary review rows');
  }
  return `hmac:${kind}:${crypto.createHmac('sha256', secret).update(value).digest('hex')}`;
}

function buildRuntimePrompts(count: number): RuntimePrompt[] {
  const seed: RuntimePrompt[] = [
    { language: 'en', text: 'In one sentence, what is a good way to keep focus while building a SaaS?' },
    { language: 'pt-BR', text: 'Em uma frase, qual é uma boa forma de manter foco enquanto crio um SaaS?' },
    { language: 'pt-PT', text: 'Numa frase, qual é uma boa forma de manter o foco enquanto crio um SaaS?' },
    { language: 'mixed', text: 'What is um pequeno hábito de foco, advice only?' },
    { language: 'en', text: 'What are three practical strategies to improve focus during deep work?' },
    { language: 'pt-BR', text: 'Quais são três estratégias práticas para manter foco em trabalho profundo?' },
    { language: 'pt-PT', text: 'Quais são três estratégias práticas para manter o foco em trabalho profundo?' },
    { language: 'mixed', text: 'What are 2 ideias simples para reduzir distrações, advice only?' },
    { language: 'en', text: 'What is an oven-baked vegetable recipe idea for two people?' },
    { language: 'pt-BR', text: 'Qual é uma ideia de receita de legumes assados para duas pessoas?' },
    { language: 'pt-PT', text: 'Qual é uma ideia de receita de legumes assados para duas pessoas?' },
    { language: 'mixed', text: 'What is uma receita simples para jantar, only as text?' },
    { language: 'en', text: 'In plain language, what is a small emergency fund?' },
    { language: 'pt-BR', text: 'De forma simples, o que é uma reserva de emergência pequena?' },
    { language: 'pt-PT', text: 'De forma simples, o que é uma pequena reserva de emergência?' },
    { language: 'mixed', text: 'What is um budget mensal em uma frase, concept only?' },
    { language: 'en', text: 'What is a gentle training recovery idea for a tired day?' },
    { language: 'pt-BR', text: 'Qual é uma ideia leve de recuperação para um dia cansado?' },
    { language: 'pt-PT', text: 'Qual é uma ideia leve de recuperação para um dia cansado?' },
    { language: 'mixed', text: 'What is uma sugestão leve de recovery, advice only?' },
    { language: 'en', text: 'What is a short title idea for a video about focus and startup discipline?' },
    { language: 'pt-BR', text: 'Qual é uma ideia curta de título para um vídeo sobre foco e disciplina?' },
    { language: 'pt-PT', text: 'Qual é uma ideia curta de título para um vídeo sobre foco e disciplina?' },
    { language: 'mixed', text: 'What is um hook curto sobre foco e disciplina, only as text?' },
    { language: 'en', text: 'What is one useful reflection question for the end of the day?' },
    { language: 'pt-BR', text: 'Qual é uma pergunta útil de reflexão para o fim do dia?' },
    { language: 'pt-PT', text: 'Qual é uma pergunta útil de reflexão para o fim do dia?' },
    { language: 'mixed', text: 'What is uma pergunta útil de reflexão pessoal, as advice only?' },
    { language: 'en', text: 'What belongs in a concise checklist for starting a deep work block?' },
    { language: 'pt-BR', text: 'O que deve entrar em um checklist curto para começar um bloco de foco?' },
    { language: 'pt-PT', text: 'O que deve entrar numa checklist curta para começar um bloco de foco?' },
    { language: 'mixed', text: 'What belongs em uma checklist curta para deep work, advice only?' },
  ];
  const prompts: RuntimePrompt[] = [];
  while (prompts.length < count) {
    const base = seed[prompts.length % seed.length]!;
    prompts.push({
      ...base,
      text: `${base.text} (${Math.floor(prompts.length / seed.length) + 1})`,
    });
  }
  return prompts;
}

function buildRuntimeWritePrompts(count: number): RuntimePrompt[] {
  const seed: RuntimePrompt[] = [
    { language: 'en', text: 'Create task ChatV2 runtime evidence task with subtasks alpha beta gamma' },
    { language: 'pt-BR', text: 'Crie uma tarefa ChatV2 runtime evidence Brasil com subtarefas alfa beta gama' },
    { language: 'pt-PT', text: 'Cria uma tarefa ChatV2 runtime evidence Portugal com subtarefas alfa beta gama' },
    { language: 'en', text: 'Create a task called ChatV2 runtime confirmation evidence' },
    { language: 'pt-BR', text: 'Crie uma tarefa chamada ChatV2 runtime confirmação evidência' },
    { language: 'en', text: 'Delete all my tasks' },
    { language: 'pt-BR', text: 'Apague todas as minhas tarefas' },
  ];
  const prompts: RuntimePrompt[] = [];
  while (prompts.length < count) {
    const base = seed[prompts.length % seed.length]!;
    prompts.push({
      ...base,
      text: `${base.text} ${Math.floor(prompts.length / seed.length) + 1}`,
    });
  }
  return prompts;
}

function readPromptsFile(filePath: string): RuntimePrompt[] {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('--prompts-file must be a JSON array');
  return parsed.map((item, index): RuntimePrompt => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Prompt row ${index + 1} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    const language = record.language;
    if (!text) throw new Error(`Prompt row ${index + 1} has empty text`);
    if (language !== 'en' && language !== 'pt-BR' && language !== 'pt-PT' && language !== 'mixed') {
      throw new Error(`Prompt row ${index + 1} has unsupported language`);
    }
    return { text, language };
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
