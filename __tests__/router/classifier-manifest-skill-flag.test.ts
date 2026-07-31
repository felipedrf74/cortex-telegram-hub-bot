/**
 * M15 — classifyWithClaude flag threading:
 *
 *  - flag OFF (default): classify input passed VERBATIM (no shortlist) and
 *    any stray `skill` field is stripped → byte-identical to pre-M15;
 *  - flag ON: the deterministic candidate shortlist is appended to the LIVE
 *    classify input; parsing tolerates BOTH output shapes
 *    ({domain, confidence} and {domain, skill, confidence});
 *  - the model-proposed skill survives ONLY when it is a manifest
 *    chatActionSkill of the classified domain;
 *  - the low-confidence active-context pin drops the (stale) skill;
 *  - master kill (AI_ROUTING_MANIFEST_KILL) restores flag-off behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyWithClaude } from '../../src/router/classifier';
import { routeMessage } from '../../src/router';

vi.mock('../../src/services/anthropic', async () => ({
  ...(await vi.importActual('../../src/services/anthropic')),
  classifyMessage: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

const mockGetActiveChatDomain = vi.hoisted(
  () => vi.fn((_userId: number, _now?: number, _tenantId?: number): string | null => null),
);
vi.mock('../../src/services/chat-conversation-state', async () => ({
  ...(await vi.importActual('../../src/services/chat-conversation-state')),
  getActiveChatDomain: (userId: number, now?: number, tenantId?: number) =>
    mockGetActiveChatDomain(userId, now, tenantId),
}));

import { classifyMessage } from '../../src/services/anthropic';

const mockClassifyMessage = vi.mocked(classifyMessage);

const FLAG = 'AI_CLASSIFY_MANIFEST_PROMPT';
const KILL = 'AI_ROUTING_MANIFEST_KILL';

describe('classifyWithClaude — M15 manifest skill threading', () => {
  let savedFlag: string | undefined;
  let savedKill: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    savedKill = process.env[KILL];
    delete process.env[FLAG];
    delete process.env[KILL];
    mockClassifyMessage.mockReset();
    mockGetActiveChatDomain.mockReset();
    mockGetActiveChatDomain.mockReturnValue(null);
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = savedFlag;
    if (savedKill === undefined) delete process.env[KILL]; else process.env[KILL] = savedKill;
  });

  describe('flag OFF (default) — byte parity', () => {
    it('passes the classify input verbatim (no shortlist appended)', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.9 });
      await classifyWithClaude('Create a task to buy milk tomorrow');
      expect(mockClassifyMessage).toHaveBeenCalledWith(
        'Create a task to buy milk tomorrow', undefined, undefined, undefined,
      );
    });

    it('strips a stray skill field so flag-off results stay shape-identical', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.9, skill: 'tasks' });
      const result = await classifyWithClaude('Create a task to buy milk tomorrow');
      expect(result).toEqual({ domain: 'secretary', confidence: 0.9 });
      expect('skill' in result).toBe(false);
    });
  });

  describe('flag ON', () => {
    beforeEach(() => {
      process.env[FLAG] = 'true';
    });

    it('appends the deterministic candidate shortlist to the live classify input', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.9, skill: 'tasks' });
      await classifyWithClaude('Create a task to buy milk tomorrow');
      const [sentMessage] = mockClassifyMessage.mock.calls[0];
      expect(sentMessage).toContain('Create a task to buy milk tomorrow');
      expect(sentMessage).toContain('[CANDIDATE SHORTLIST]');
      expect(sentMessage).toContain('- secretary (skill:');
    });

    it('sends the message verbatim when the resolver has no candidates', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.4 });
      await classifyWithClaude('zzz qqq xyzzy');
      expect(mockClassifyMessage.mock.calls[0][0]).toBe('zzz qqq xyzzy');
    });

    it('keeps a valid manifest chatActionSkill of the classified domain', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.92, skill: 'mail' });
      const result = await classifyWithClaude('summarize my inbox');
      expect(result).toEqual({ domain: 'secretary', confidence: 0.92, skill: 'mail' });
    });

    it('drops a skill that belongs to a different domain', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.92, skill: 'training' });
      const result = await classifyWithClaude('summarize my inbox');
      expect(result).toEqual({ domain: 'secretary', confidence: 0.92 });
    });

    it('drops an unknown skill', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'cooking', confidence: 0.9, skill: 'sous_vide' });
      const result = await classifyWithClaude('what should I cook tonight');
      expect(result).toEqual({ domain: 'cooking', confidence: 0.9 });
    });

    it('tolerates the legacy {domain, confidence} output shape', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'finance', confidence: 0.88 });
      const result = await classifyWithClaude('what bills are still missing this month');
      expect(result).toEqual({ domain: 'finance', confidence: 0.88 });
    });

    it('classifies platform-domain skills that are newly reachable (decision_center)', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'decision_center', confidence: 0.9, skill: 'decision_center' });
      const result = await classifyWithClaude('show my pending decisions');
      expect(result).toEqual({ domain: 'decision_center', confidence: 0.9, skill: 'decision_center' });
    });

    it.each(['clarify', 'none'] as const)(
      'turns the explicit %s outcome into a safe terminal disposition without a routable fake domain',
      async (disposition) => {
        mockClassifyMessage.mockResolvedValue({
          domain: disposition,
          confidence: 0.93,
          skill: 'tasks',
        });

        const result = await classifyWithClaude('do the ambiguous thing');

        expect(result).toEqual({
          domain: 'chat',
          confidence: 0.93,
          disposition,
        });
        expect('skill' in result).toBe(false);
      },
    );

    it('does not replace a low-confidence explicit terminal outcome with the active-domain pin', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'clarify', confidence: 0.3 });

      const result = await classifyWithClaude(
        'move it',
        { domain: 'finance', lastAssistantMessage: 'Which expense?' },
      );

      expect(result).toEqual({ domain: 'chat', confidence: 0.3, disposition: 'clarify' });
    });

    it('propagates a safe terminal disposition through routeMessage', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'none', confidence: 0.97 });

      const route = await routeMessage('zzz qqq xyzzy');

      expect(route).toMatchObject({
        domain: 'chat',
        method: 'classifier',
        confidence: 0.97,
        disposition: 'none',
      });
    });

    it('low-confidence active-context pin drops the stale skill with the domain', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'cooking', confidence: 0.3, skill: 'cooking' });
      const result = await classifyWithClaude(
        'make it shorter',
        { domain: 'content', lastAssistantMessage: 'Here is your script.' },
      );
      expect(result).toEqual({ domain: 'content', confidence: 0.51 });
      expect('skill' in result).toBe(false);
    });

    it('master kill restores verbatim input + skill stripping even with the flag on', async () => {
      process.env[KILL] = 'true';
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.9, skill: 'tasks' });
      const result = await classifyWithClaude('Create a task to buy milk tomorrow');
      expect(mockClassifyMessage.mock.calls[0][0]).toBe('Create a task to buy milk tomorrow');
      expect(result).toEqual({ domain: 'secretary', confidence: 0.9 });
    });
  });
});
