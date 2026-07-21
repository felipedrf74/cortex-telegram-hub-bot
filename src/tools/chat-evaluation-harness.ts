// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  formatChatEvaluationResultsMarkdown,
  runChatEvaluationSuite,
  type ChatEvalMode,
} from '../services/chat-evaluation-harness';

function parseMode(raw: string | undefined): ChatEvalMode {
  if (raw === 'local_engine' || raw === 'real_provider' || raw === 'fixture') return raw;
  return 'fixture';
}

async function main(): Promise<void> {
  const mode = parseMode(process.env.CHAT_EVAL_MODE);
  const result = await runChatEvaluationSuite({ mode });
  console.log(formatChatEvaluationResultsMarkdown(result));

  if (!result.passed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
