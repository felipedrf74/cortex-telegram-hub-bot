// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RETRY_PAYLOAD_FILENAME = 'portal-retry-payload.json';
const RUN_ID_PATTERN = /^chat-eval-[a-zA-Z0-9._:-]{8,120}$/;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type ChatEvalPortalRetryPayload = Record<string, unknown> & {
  result: Record<string, unknown>;
  runId: string;
  gitCommit: string;
  productionDataUsed: false;
};

export interface ChatEvalPortalRetryEvidence {
  payloadPath: string;
  rawBody: string;
  payload: ChatEvalPortalRetryPayload;
  runId: string;
  sha256: string;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type ChatEvalPortalFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<FetchResponseLike>;

function sha256(rawBody: string): string {
  return crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

function validatePayload(value: unknown): ChatEvalPortalRetryPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chat eval portal retry payload must be an object');
  }
  const payload = value as Record<string, unknown>;
  const result = payload.result;
  if (
    typeof payload.runId !== 'string'
    || !RUN_ID_PATTERN.test(payload.runId)
    || typeof payload.gitCommit !== 'string'
    || !/^[a-f0-9]{40}$/.test(payload.gitCommit)
    || payload.productionDataUsed !== false
    || !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || (result as Record<string, unknown>).mode !== 'real_provider'
  ) {
    throw new Error('Chat eval portal retry payload is missing exact real-provider evidence identity');
  }
  return payload as ChatEvalPortalRetryPayload;
}

function assertPrivateRunDirectory(runDirectory: string): string {
  const resolved = path.resolve(runDirectory);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error('Chat eval portal retry directory must be a non-symlink directory');
  }
  fs.chmodSync(resolved, 0o700);
  return fs.realpathSync(resolved);
}

function assertPrivatePayloadFile(payloadPath: string): string {
  const resolved = path.resolve(payloadPath);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  const stat = fs.lstatSync(resolved);
  const canonicalParent = fs.realpathSync(parent);
  if (
    !parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || (typeof process.getuid === 'function' && parentStat.uid !== process.getuid())
    || (parentStat.mode & 0o777) !== 0o700
    || !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error('Chat eval portal retry payload must be a private owner-only regular file');
  }
  const canonical = fs.realpathSync(resolved);
  if (path.dirname(canonical) !== canonicalParent) {
    throw new Error('Chat eval portal retry payload escaped its private directory');
  }
  return canonical;
}

export function writeChatEvalPortalRetryPayload(
  runDirectory: string,
  payloadValue: Record<string, unknown>,
): ChatEvalPortalRetryEvidence {
  const directory = assertPrivateRunDirectory(runDirectory);
  const payload = validatePayload(payloadValue);
  const rawBody = JSON.stringify(payload);
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('Chat eval portal retry payload exceeds the portal body limit');
  }

  const payloadPath = path.join(directory, RETRY_PAYLOAD_FILENAME);
  const temporaryPath = path.join(
    directory,
    `.${RETRY_PAYLOAD_FILENAME}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(descriptor, rawBody, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, payloadPath);
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }

  assertPrivatePayloadFile(payloadPath);
  return {
    payloadPath,
    rawBody,
    payload,
    runId: payload.runId,
    sha256: sha256(rawBody),
  };
}

export function readChatEvalPortalRetryPayload(
  payloadPath: string,
): ChatEvalPortalRetryEvidence {
  const resolved = assertPrivatePayloadFile(payloadPath);
  const rawBody = fs.readFileSync(resolved, 'utf8');
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('Chat eval portal retry payload exceeds the portal body limit');
  }
  const payload = validatePayload(JSON.parse(rawBody) as unknown);
  return {
    payloadPath: resolved,
    rawBody,
    payload,
    runId: payload.runId,
    sha256: sha256(rawBody),
  };
}

export async function postChatEvalPortalPayload(input: {
  portalUrl: string;
  portalToken: string;
  rawBody: string;
  fetchImpl?: ChatEvalPortalFetch;
}): Promise<void> {
  if (!input.portalToken) {
    throw new Error('Chat eval portal POST requires a token supplied through the approved environment');
  }
  const endpoint = new URL('/api/portal/eval-history', input.portalUrl).toString();
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.portalToken}`,
      'content-type': 'application/json',
    },
    body: input.rawBody,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Portal eval-history POST failed: ${response.status} ${text.slice(0, 200)}`);
  }
}

export async function postChatEvalHistoryWithRecovery(input: {
  runDirectory: string;
  portalUrl: string;
  portalToken: string;
  payload: Record<string, unknown>;
  fetchImpl?: ChatEvalPortalFetch;
}): Promise<ChatEvalPortalRetryEvidence> {
  const evidence = writeChatEvalPortalRetryPayload(input.runDirectory, input.payload);
  try {
    await postChatEvalPortalPayload({
      portalUrl: input.portalUrl,
      portalToken: input.portalToken,
      rawBody: evidence.rawBody,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return evidence;
  } catch (error) {
    throw new Error(
      `Portal eval-history POST failed after paid work; retained exact zero-provider retry payload `
      + `${evidence.payloadPath} sha256=${evidence.sha256}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export async function replayChatEvalPortalRetryPayload(input: {
  payloadPath: string;
  portalUrl: string;
  portalToken: string;
  fetchImpl?: ChatEvalPortalFetch;
}): Promise<ChatEvalPortalRetryEvidence> {
  const evidence = readChatEvalPortalRetryPayload(input.payloadPath);
  await postChatEvalPortalPayload({
    portalUrl: input.portalUrl,
    portalToken: input.portalToken,
    rawBody: evidence.rawBody,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  return evidence;
}
