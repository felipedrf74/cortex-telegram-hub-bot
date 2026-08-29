// Copyright (c) 2026 Felipe Dominguez. MIT License. See LICENSE.

export function resolveOpenAIBatchProjectCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): { apiKey: string; projectId: string } {
  const apiKey = environment.OPENAI_BATCH_API_KEY || '';
  const projectId = environment.OPENAI_BATCH_PROJECT_ID || '';
  if (Boolean(apiKey) !== Boolean(projectId)) {
    throw new Error(
      'OPENAI_BATCH_API_KEY and OPENAI_BATCH_PROJECT_ID must be configured together',
    );
  }
  if (!apiKey) return { apiKey: '', projectId: '' };
  if (!environment.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is required when the isolated OpenAI Batch project is configured',
    );
  }
  if (apiKey === environment.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_BATCH_API_KEY must be distinct from the legacy OPENAI_API_KEY',
    );
  }
  if (apiKey !== apiKey.trim()) {
    throw new Error('OPENAI_BATCH_API_KEY must not contain surrounding whitespace');
  }
  if (!/^proj_[A-Za-z0-9_-]{8,200}$/u.test(projectId)) {
    throw new Error('OPENAI_BATCH_PROJECT_ID must be a valid OpenAI project identifier');
  }
  return { apiKey, projectId };
}
