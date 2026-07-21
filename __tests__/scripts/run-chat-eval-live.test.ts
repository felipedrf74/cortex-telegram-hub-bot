import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTH_TOKEN_ENV,
  buildRunPlan,
  parseArgs,
} from '../../scripts/run-chat-eval-live';

describe('run-chat-eval-live CLI safety guards', () => {
  describe('parseArgs', () => {
    it('defaults to zero-cost fixture mode on bare invocation', () => {
      expect(parseArgs([], {}).mode).toBe('fixture');
    });

    it('does NOT arm real_provider just because EVAL_MAX_USD_PER_RUN is set', () => {
      const options = parseArgs([], { EVAL_MAX_USD_PER_RUN: '2' });
      expect(options.mode).toBe('fixture');
      expect(options.budgetUsd).toBe(2);
    });

    it('honors CHAT_EVAL_MODE and --mode overrides (flag wins)', () => {
      expect(parseArgs([], { CHAT_EVAL_MODE: 'local_engine' }).mode).toBe('local_engine');
      expect(parseArgs(['--mode', 'real_provider', '--budget-usd', '1'], { CHAT_EVAL_MODE: 'fixture' }).mode).toBe('real_provider');
    });

    it('still refuses real_provider without a positive budget', () => {
      expect(() => parseArgs(['--mode', 'real_provider'], {})).toThrow(/EVAL_MAX_USD_PER_RUN|--budget-usd/);
    });

    it('parses --base-url and --auth-token-env; a raw token flag is rejected as unknown', () => {
      const options = parseArgs(
        ['--mode', 'local_engine', '--base-url', 'http://127.0.0.1:8201', '--auth-token-env', 'MY_EVAL_JWT'],
        {},
      );
      expect(options.baseUrl).toBe('http://127.0.0.1:8201');
      expect(options.authTokenEnv).toBe('MY_EVAL_JWT');
      // Tokens must never travel through argv: there is no such flag.
      expect(() => parseArgs(['--auth-token', 'secret'], {})).toThrow(/Unknown argument/);
    });
  });

  describe('buildRunPlan', () => {
    it('builds no executor and no judge options in fixture mode', () => {
      const plan = buildRunPlan(parseArgs([], {}), {});
      expect(plan.executor).toBeUndefined();
      expect(plan.judgeOptions).toBeUndefined();
    });

    it('refuses local_engine and real_provider without --base-url so the judge can never score fixtures', () => {
      expect(() => buildRunPlan(
        parseArgs(['--mode', 'local_engine'], {}),
        { [DEFAULT_AUTH_TOKEN_ENV]: 'jwt' },
      )).toThrow(/--base-url/);
      expect(() => buildRunPlan(
        parseArgs(['--mode', 'real_provider', '--budget-usd', '1'], {}),
        { [DEFAULT_AUTH_TOKEN_ENV]: 'jwt' },
      )).toThrow(/--base-url/);
    });

    it('refuses live modes when the named auth-token env var is empty', () => {
      expect(() => buildRunPlan(
        parseArgs(['--mode', 'local_engine', '--base-url', 'http://127.0.0.1:8201'], {}),
        {},
      )).toThrow(new RegExp(DEFAULT_AUTH_TOKEN_ENV));
      expect(() => buildRunPlan(
        parseArgs(['--mode', 'local_engine', '--base-url', 'http://127.0.0.1:8201', '--auth-token-env', 'MY_EVAL_JWT'], {}),
        {},
      )).toThrow(/MY_EVAL_JWT/);
    });

    it('builds a live HttpExecutor for local_engine WITHOUT judge options', () => {
      const plan = buildRunPlan(
        parseArgs(['--mode', 'local_engine', '--base-url', 'http://127.0.0.1:8201'], {}),
        { [DEFAULT_AUTH_TOKEN_ENV]: 'jwt' },
      );
      expect(plan.executor?.mode).toBe('local_engine');
      expect(plan.judgeOptions).toBeUndefined();
    });

    it('arms the judge ONLY for real_provider with a live executor and budget', () => {
      const plan = buildRunPlan(
        parseArgs(['--mode', 'real_provider', '--base-url', 'http://127.0.0.1:8201', '--budget-usd', '1.5'], {}),
        { [DEFAULT_AUTH_TOKEN_ENV]: 'jwt' },
      );
      expect(plan.executor?.mode).toBe('real_provider');
      expect(plan.judgeOptions).toEqual({ maxUsd: 1.5 });
    });
  });
});
