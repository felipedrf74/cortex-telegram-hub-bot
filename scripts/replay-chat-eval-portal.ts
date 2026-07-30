// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  replayChatEvalPortalRetryPayload,
} from '../src/services/chat-eval-portal-retry';

const DEFAULT_PORTAL_TOKEN_ENV = 'CHAT_EVAL_PORTAL_TOKEN';

interface ReplayOptions {
  payloadPath: string;
  portalUrl: string;
  portalTokenEnv: string;
}

export function parseReplayArgs(args: string[]): ReplayOptions {
  let payloadPath = '';
  let portalUrl = '';
  let portalTokenEnv = DEFAULT_PORTAL_TOKEN_ENV;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--payload') {
      payloadPath = requireValue(arg, value);
      index += 1;
    } else if (arg === '--portal-url') {
      portalUrl = requireValue(arg, value);
      index += 1;
    } else if (arg === '--portal-token-env') {
      portalTokenEnv = requireValue(arg, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  if (!payloadPath || !portalUrl) {
    throw new Error('Portal replay requires --payload <private-json> and --portal-url <url>');
  }
  return { payloadPath, portalUrl, portalTokenEnv };
}

async function main(): Promise<void> {
  const options = parseReplayArgs(process.argv.slice(2));
  const portalToken = process.env[options.portalTokenEnv];
  if (!portalToken) {
    throw new Error(`Portal replay requires a token in env ${options.portalTokenEnv}`);
  }
  const evidence = await replayChatEvalPortalRetryPayload({
    payloadPath: options.payloadPath,
    portalUrl: options.portalUrl,
    portalToken,
  });
  console.log(
    `[chat-eval-live] portal replay PASS runId=${evidence.runId} `
    + `payload=${evidence.payloadPath} sha256=${evidence.sha256}`,
  );
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
