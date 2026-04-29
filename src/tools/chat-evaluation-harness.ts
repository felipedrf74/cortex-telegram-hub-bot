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

const mode = parseMode(process.env.CHAT_EVAL_MODE);
const result = runChatEvaluationSuite({ mode });
console.log(formatChatEvaluationResultsMarkdown(result));

if (!result.passed) {
  process.exitCode = 1;
}
