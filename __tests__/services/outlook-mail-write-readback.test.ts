// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graph = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock('../../src/services/microsoft-auth', async () => ({
  ...(await vi.importActual('../../src/services/microsoft-auth')),
  getGraphClient: vi.fn(() => ({ api: graph.api })),
  getGraphClientForUser: vi.fn(() => ({ api: graph.api })),
  getOutlookRefreshTokenForUser: vi.fn(() => 'refresh-token'),
  isMicrosoftConfigured: vi.fn(() => true),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: vi.fn() })),
  })),
}));

vi.mock('../../src/portal/telemetry', async () => ({
  ...(await vi.importActual('../../src/portal/telemetry')),
  pushEvent: vi.fn(),
}));

import {
  createOutlookDraftForUser,
  sendOutlookEmailWithReadBackForUser,
} from '../../src/services/outlook-mail';

const WRITE = {
  to: 'ana@example.test',
  subject: 'Release update',
  body: 'All checks are green.',
  source: 'chat_action_planner',
};

function graphMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'immutable-message-1',
    internetMessageId: '<nexus-1@example.test>',
    subject: WRITE.subject,
    toRecipients: [{ emailAddress: { address: WRITE.to } }],
    body: { contentType: 'text', content: WRITE.body },
    isDraft: true,
    sentDateTime: null,
    ...overrides,
  };
}

function request(input: { get?: () => unknown; post?: (body: unknown) => unknown }) {
  const chain: Record<string, unknown> = {
    header: vi.fn(() => chain),
    option: vi.fn(() => chain),
    select: vi.fn(() => chain),
    get: vi.fn(async () => input.get?.()),
    post: vi.fn(async (body: unknown) => input.post?.(body)),
  };
  return chain;
}

describe('Outlook mail provider write read-back', () => {
  beforeEach(() => {
    graph.api.mockReset();
  });

  it('creates a draft and verifies the exact provider object before reporting success', async () => {
    graph.api.mockImplementation((path: string) => {
      if (path === '/me/messages') return request({ post: () => ({ id: 'immutable-message-1' }) });
      if (path === '/me/messages/immutable-message-1') return request({ get: () => graphMessage() });
      throw new Error(`unexpected path ${path}`);
    });

    const receipt = await createOutlookDraftForUser(77, WRITE);

    expect(receipt).toMatchObject({
      provider: 'outlook_mail',
      messageId: 'immutable-message-1',
      state: 'draft',
      verified: true,
    });
  });

  it('sends the verified draft and reads the immutable id back from Sent Items state', async () => {
    let messageReads = 0;
    graph.api.mockImplementation((path: string) => {
      if (path === '/me/messages') return request({ post: () => ({ id: 'immutable-message-1' }) });
      if (path === '/me/messages/immutable-message-1/send') return request({ post: () => undefined });
      if (path === '/me/messages/immutable-message-1') {
        return request({
          get: () => {
            messageReads += 1;
            return messageReads === 1
              ? graphMessage()
              : graphMessage({ isDraft: false, sentDateTime: '2026-07-22T12:00:00Z' });
          },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });

    const receipt = await sendOutlookEmailWithReadBackForUser(77, WRITE);

    expect(receipt).toMatchObject({
      provider: 'outlook_mail',
      messageId: 'immutable-message-1',
      state: 'sent',
      verified: true,
    });
    expect(graph.api).toHaveBeenCalledWith('/me/messages/immutable-message-1/send');
  });

  it('never reports verified when the post-send provider state does not match', async () => {
    let messageReads = 0;
    graph.api.mockImplementation((path: string) => {
      if (path === '/me/messages') return request({ post: () => ({ id: 'immutable-message-1' }) });
      if (path === '/me/messages/immutable-message-1/send') return request({ post: () => undefined });
      if (path === '/me/messages/immutable-message-1') {
        return request({
          get: () => {
            messageReads += 1;
            return messageReads === 1
              ? graphMessage()
              : graphMessage({
                subject: 'Different subject',
                isDraft: false,
                sentDateTime: '2026-07-22T12:00:00Z',
              });
          },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });

    const receipt = await sendOutlookEmailWithReadBackForUser(77, WRITE);

    expect(receipt).toMatchObject({
      state: 'sent',
      verified: false,
      verificationError: 'sent_read_back_mismatch',
    });
  });

  it('never verifies a read-back carrying a different immutable provider id', async () => {
    graph.api.mockImplementation((path: string) => {
      if (path === '/me/messages') return request({ post: () => ({ id: 'immutable-message-1' }) });
      if (path === '/me/messages/immutable-message-1') {
        return request({ get: () => graphMessage({ id: 'different-message' }) });
      }
      throw new Error(`unexpected path ${path}`);
    });

    const receipt = await createOutlookDraftForUser(77, WRITE);

    expect(receipt).toMatchObject({
      messageId: 'immutable-message-1',
      state: 'draft',
      verified: false,
      verificationError: 'draft_read_back_mismatch',
    });
  });
});
