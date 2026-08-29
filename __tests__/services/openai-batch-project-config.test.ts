import { describe, expect, it } from 'vitest';
import { resolveOpenAIBatchProjectCredentials } from '../../src/services/openai-batch-project-config';

describe('OpenAI Batch project configuration', () => {
  it('keeps the isolated project disabled when both values are absent', () => {
    expect(resolveOpenAIBatchProjectCredentials({})).toEqual({ apiKey: '', projectId: '' });
  });

  it.each([
    { OPENAI_API_KEY: 'sk-legacy', OPENAI_BATCH_API_KEY: 'sk-batch' },
    { OPENAI_API_KEY: 'sk-legacy', OPENAI_BATCH_PROJECT_ID: 'proj_batch_12345678' },
  ])('requires the isolated key and project binding together', (environment) => {
    expect(() => resolveOpenAIBatchProjectCredentials(environment))
      .toThrow('must be configured together');
  });

  it('requires the legacy key so retained provider objects remain reachable', () => {
    expect(() => resolveOpenAIBatchProjectCredentials({
      OPENAI_BATCH_API_KEY: 'sk-batch',
      OPENAI_BATCH_PROJECT_ID: 'proj_batch_12345678',
    })).toThrow('OPENAI_API_KEY is required');
  });

  it('requires a distinct isolated key instead of replaying the legacy project key', () => {
    expect(() => resolveOpenAIBatchProjectCredentials({
      OPENAI_API_KEY: 'sk-same-project',
      OPENAI_BATCH_API_KEY: 'sk-same-project',
      OPENAI_BATCH_PROJECT_ID: 'proj_batch_12345678',
    })).toThrow('must be distinct');
  });

  it('rejects surrounding key whitespace without echoing the key', () => {
    const secret = ' sk-private-test-value ';
    let failure: unknown;
    try {
      resolveOpenAIBatchProjectCredentials({
        OPENAI_API_KEY: 'sk-legacy',
        OPENAI_BATCH_API_KEY: secret,
        OPENAI_BATCH_PROJECT_ID: 'proj_batch_12345678',
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain('surrounding whitespace');
    expect(String(failure)).not.toContain(secret);
  });

  it('rejects malformed project binding without echoing secret material', () => {
    const secret = 'sk-private-test-value';
    let failure: unknown;
    try {
      resolveOpenAIBatchProjectCredentials({
        OPENAI_API_KEY: 'sk-legacy',
        OPENAI_BATCH_API_KEY: secret,
        OPENAI_BATCH_PROJECT_ID: 'not-a-project',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('valid OpenAI project identifier');
    expect(String(failure)).not.toContain(secret);
  });

  it('returns the exact valid isolated credential pair', () => {
    expect(resolveOpenAIBatchProjectCredentials({
      OPENAI_API_KEY: 'sk-legacy',
      OPENAI_BATCH_API_KEY: 'sk-batch',
      OPENAI_BATCH_PROJECT_ID: 'proj_batch_12345678',
    })).toEqual({
      apiKey: 'sk-batch',
      projectId: 'proj_batch_12345678',
    });
  });
});
