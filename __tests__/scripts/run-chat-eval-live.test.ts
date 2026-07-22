import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTH_TOKEN_ENV,
  attestEvidenceCheckout,
  buildRunPlan,
  parseArgs,
  type EvidenceGitReader,
} from '../../scripts/run-chat-eval-live';

const FULL_SHA = 'a'.repeat(40);

function evidenceGitReader(input: {
  status?: string;
  commit?: string;
  branch?: string;
  mergeHead?: boolean;
} = {}): EvidenceGitReader {
  return {
    read(args) {
      const command = args.join(' ');
      if (command === 'rev-parse --is-inside-work-tree') return 'true';
      if (command === 'status --porcelain=v1 --untracked-files=all') return input.status ?? '';
      if (command === 'rev-parse HEAD') return input.commit ?? FULL_SHA;
      if (command === 'branch --show-current') return input.branch ?? 'main';
      throw new Error(`unexpected git command: ${command}`);
    },
    hasRef(ref) {
      if (ref !== 'MERGE_HEAD') throw new Error(`unexpected git ref: ${ref}`);
      return input.mergeHead ?? false;
    },
  };
}

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
      expect(parseArgs(['--mode', 'real_provider', '--budget-usd', '0.50'], { CHAT_EVAL_MODE: 'fixture' }).mode).toBe('real_provider');
    });

    it('still refuses real_provider without a positive budget', () => {
      expect(() => parseArgs(['--mode', 'real_provider'], {})).toThrow(/EVAL_MAX_USD_PER_RUN|--budget-usd/);
    });

    it('refuses any real-provider ceiling other than the approved exact $0.50 run cap', () => {
      expect(() => parseArgs(['--mode', 'real_provider', '--budget-usd', '0.49'], {})).toThrow(/exactly.*0\.50/i);
      expect(() => parseArgs(['--mode', 'real_provider', '--budget-usd', '1'], {})).toThrow(/exactly.*0\.50/i);
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
        parseArgs(['--mode', 'real_provider', '--budget-usd', '0.50'], {}),
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
        parseArgs(['--mode', 'real_provider', '--base-url', 'http://127.0.0.1:8201', '--budget-usd', '0.50'], {}),
        { [DEFAULT_AUTH_TOKEN_ENV]: 'jwt' },
      );
      expect(plan.executor?.mode).toBe('real_provider');
      expect(plan.judgeOptions).toEqual({ maxUsd: 0.05 });
    });
  });

  describe('evidence checkout attestation', () => {
    it('allows an unpersisted fixture run without treating it as release evidence', () => {
      const options = parseArgs(['--no-json', '--no-markdown'], {});
      expect(attestEvidenceCheckout(options, evidenceGitReader({ status: '?? scratch.txt' }))).toBeUndefined();
    });

    it('requires a clean checkout for every live mode and returns the full 40-character SHA', () => {
      const local = parseArgs([
        '--mode', 'local_engine',
        '--base-url', 'http://127.0.0.1:8201',
      ], {});
      const attested = attestEvidenceCheckout(local, evidenceGitReader());

      expect(attested).toEqual({ gitBranch: 'main', gitCommit: FULL_SHA });
      expect(attested?.gitCommit).toHaveLength(40);
      expect(() => attestEvidenceCheckout(
        local,
        evidenceGitReader({ status: ' M src/services/chat.ts' }),
      )).toThrow(/clean checkout/i);
      expect(() => attestEvidenceCheckout(
        local,
        evidenceGitReader({ status: '?? untracked-evidence-input.json' }),
      )).toThrow(/clean checkout/i);
    });

    it('refuses merge state even when the porcelain status is empty', () => {
      const local = parseArgs([
        '--mode', 'local_engine',
        '--base-url', 'http://127.0.0.1:8201',
      ], {});
      expect(() => attestEvidenceCheckout(
        local,
        evidenceGitReader({ mergeHead: true }),
      )).toThrow(/merge/i);
    });

    it('requires a clean checkout for fixture runs persisted to history', () => {
      const fixtureEvidence = parseArgs(['--persist-db', '/tmp/chat-eval.sqlite'], {});
      expect(() => attestEvidenceCheckout(
        fixtureEvidence,
        evidenceGitReader({ status: ' M package.json' }),
      )).toThrow(/clean checkout/i);
    });

    it('refuses missing or abbreviated commit identities', () => {
      const local = parseArgs([
        '--mode', 'local_engine',
        '--base-url', 'http://127.0.0.1:8201',
      ], {});
      expect(() => attestEvidenceCheckout(
        local,
        evidenceGitReader({ commit: '' }),
      )).toThrow(/full 40-character/i);
      expect(() => attestEvidenceCheckout(
        local,
        evidenceGitReader({ commit: FULL_SHA.slice(0, 12) }),
      )).toThrow(/full 40-character/i);
    });
  });
});
