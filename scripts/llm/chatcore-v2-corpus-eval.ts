#!/usr/bin/env npx tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Simulator eval harness for the ChatCoreV2 synthetic corpus.
 *
 * Runs each corpus message through a RUNNING sandbox (`/api/v1/chat/message`)
 * with app-like headers, then scores the response with the pure `corpus-eval`
 * checks (route/intent match, no unverified success claim, locale preserved).
 * Read-only: it only sends chat messages and reads responses.
 *
 * Usage:
 *   TOKEN=<jwt> npx tsx scripts/llm/chatcore-v2-corpus-eval.ts \
 *     --base-url=http://127.0.0.1:8200 --limit=33
 *
 * Mint a sandbox dev JWT via the cockpit (http://127.0.0.1:8210) and pass it as
 * TOKEN. This harness never mints credentials itself.
 */

import { CHAT_CORE_V2_SYNTHETIC_CORPUS } from '../../src/services/chat-core-v2/golden-corpus-synthetic';
import {
  evaluateCorpusItem,
  summarizeCorpusEval,
  type CorpusItemEvalResult,
  type RuntimeChatResponse,
} from '../../src/services/chat-core-v2/corpus-eval';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value] as const;
  }),
);

const baseUrl = args.get('base-url') || process.env.CORPUS_EVAL_BASE_URL || 'http://127.0.0.1:8200';
const token = (args.get('token') || process.env.TOKEN || process.env.NEXUS_AUTH_TOKEN || '').trim();
const limit = Number.parseInt(args.get('limit') ?? '', 10);
const timeoutMs = Number.parseInt(args.get('timeout-ms') ?? '', 10) || 60_000;

async function main(): Promise<void> {
  if (!token) {
    console.error('Missing TOKEN. Mint a sandbox dev JWT (cockpit at http://127.0.0.1:8210) and pass TOKEN=<jwt>.');
    process.exitCode = 2;
    return;
  }

  const all = CHAT_CORE_V2_SYNTHETIC_CORPUS.items;
  const items = Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all;
  const results: CorpusItemEvalResult[] = [];

  for (const item of items) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/chat/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-Language': item.language,
          'User-Agent': 'NexusHubiOS/1 CFNetwork Darwin',
        },
        body: JSON.stringify({ text: item.message }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const metadata = (json.metadata ?? {}) as Record<string, unknown>;
      const response: RuntimeChatResponse = {
        text: String(json.text ?? ''),
        routeMethod: typeof json.routeMethod === 'string' ? json.routeMethod : undefined,
        domain: typeof json.domain === 'string' ? json.domain : undefined,
        metadataType: typeof metadata.type === 'string' ? (metadata.type as string) : undefined,
        verificationStatus: json.verificationStatus as RuntimeChatResponse['verificationStatus'],
      };
      const result = evaluateCorpusItem(item, response);
      results.push(result);
      console.log(
        `${result.pass ? '✅' : '❌'} ${item.id} [${item.language}] want=${item.expectedIntent} `
          + `route=${response.routeMethod ?? '?'} ${result.failedChecks.join(',')}`,
      );
    } catch (err) {
      results.push({
        id: item.id,
        language: item.language,
        expectedIntent: item.expectedIntent,
        routeOk: false,
        noUnverifiedSuccessClaim: true,
        localePreserved: true,
        pass: false,
        failedChecks: ['request_error'],
      });
      console.log(`❌ ${item.id} request_error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(JSON.stringify({ summary: summarizeCorpusEval(results) }, null, 2));
}

void main();
