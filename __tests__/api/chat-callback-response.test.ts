import { describe, expect, it } from 'vitest';

import { labelsForLanguage } from '../../src/api/routes/chat-inline-buttons';
import {
  buildCallbackDataRequiredError,
  buildCallbackExpiredError,
  buildCallbackInternalErrorMessage,
  buildCoachApplyPayload,
  buildDeleteConfirmationPayload,
  buildTaskCompletedPayload,
  buildTodoListSelectionPayload,
  buildUnsupportedCallbackError,
} from '../../src/api/routes/chat-callback-response';

describe('chat-callback-response', () => {
  it('localizes callback validation and internal errors for Portuguese users', () => {
    expect(buildCallbackDataRequiredError('pt-PT')).toEqual({
      code: 'BAD_REQUEST',
      message: 'callbackData é obrigatório',
    });
    expect(buildCallbackExpiredError('pt-PT')).toEqual({
      code: 'CALLBACK_EXPIRED',
      message: 'Esta ação expirou. Volta a executar o comando.',
    });
    expect(buildCallbackInternalErrorMessage('pt-PT')).toBe('Falha ao processar a ação.');
  });

  it('builds coach apply payloads with truncated summaries and suffixes', () => {
    const payload = buildCoachApplyPayload('en', 5, [
      { summary: 'Move recovery run to Thursday' },
      { summary: 'Protect Saturday long run' },
      { summary: 'Shorten strength session' },
      { summary: 'Add hydration reminder' },
      { summary: 'Trim evening load' },
    ]);

    expect(payload.editOriginal).toBe(true);
    expect(payload.newButtons).toBeNull();
    expect(payload.text).toContain('Applied 5 recommendation(s)');
    expect(payload.text).toContain('• Move recovery run to Thursday');
    expect(payload.text).toContain('• … + 1 more changes');
    expect(payload.text).not.toContain('• Trim evening load');
  });

  it('builds todo list payloads with follow-up buttons', () => {
    const labels = labelsForLanguage('en');
    const payload = buildTodoListSelectionPayload([
      {
        id: 'task-1',
        listId: 'list-1',
        listName: 'Ops',
        title: 'Review invoices',
        status: 'notStarted',
        importance: 'high',
        createdDateTime: '2026-04-23T09:00:00.000Z',
        lastModifiedDateTime: '2026-04-23T09:00:00.000Z',
      } as any,
    ], 'Ops', 'en', labels);

    expect(payload.editOriginal).toBe(true);
    expect(payload.text).toContain('Ops');
    expect(payload.newButtons).not.toBeNull();
    expect(payload.newButtons?.[0]?.[0]?.callbackData).toMatch(/^td:tc:/);
    expect(payload.newButtons?.[0]?.[1]?.callbackData).toMatch(/^td:tx:/);
  });

  it('builds escaped delete confirmation payloads and completion labels', () => {
    const labels = labelsForLanguage('pt-PT');
    const confirmation = buildDeleteConfirmationPayload('pt-PT', {
      type: 'task',
      title: 'Relatório <final>',
    }, 'confirm-ref', labels);

    expect(confirmation.editOriginal).toBe(true);
    expect(confirmation.text).toContain('Apagar');
    expect(confirmation.text).toContain('Relatório &lt;final&gt;');
    expect(confirmation.newButtons).toEqual([
      [
        { text: '🗑 Apagar', callbackData: 'td:dy:confirm-ref' },
        { text: 'Cancelar', callbackData: 'td:dn:confirm-ref' },
      ],
    ]);

    expect(buildTaskCompletedPayload('pt-PT', 'Pagar imposto').text).toBe('✅ Concluída: Pagar imposto');
    expect(buildUnsupportedCallbackError('en', 'td:zz')).toEqual({
      code: 'UNSUPPORTED_CALLBACK',
      message: 'Callback "td:zz" is not supported in iOS chat yet.',
    });
  });
});
