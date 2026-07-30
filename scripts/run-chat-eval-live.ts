// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

const VERIFIER_RUNTIME_FLAG = 'NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME';

function requestedMode(args: string[], env: NodeJS.ProcessEnv): string | undefined {
  let mode = env.CHAT_EVAL_MODE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--mode') {
      mode = args[index + 1];
      index += 1;
    }
  }
  return mode;
}

/**
 * This file intentionally has no static project imports. For a paid judge
 * run, the verifier flag must exist before config.ts can execute dotenv.
 */
export async function loadChatEvalLiveRunner(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<typeof import('./run-chat-eval-live-runner')> {
  if (requestedMode(args, env) === 'real_provider') {
    env[VERIFIER_RUNTIME_FLAG] = '1';
    process.env[VERIFIER_RUNTIME_FLAG] = '1';
  }
  return import('./run-chat-eval-live-runner');
}

export async function runChatEvalLiveEntrypoint(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runner = await loadChatEvalLiveRunner(args, env);
  await runner.runChatEvalLiveCli(args, env);
}

if (require.main === module) {
  runChatEvalLiveEntrypoint().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
