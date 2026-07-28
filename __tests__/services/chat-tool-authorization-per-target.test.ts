import { describe, expect, it } from 'vitest';
import {
  authorizeChatToolCall,
  CONFIRMED_TARGET_FIELDS,
  getChatToolRisk,
  runWithChatToolAuthorization,
  type ChatConfirmedDestructiveTarget,
} from '../../src/services/chat-tool-authorization';
import { DISPATCHABLE_TOOL_NAMES } from '../../src/services/tool-executor';

// ADV-3 (chat safety hardening, milestone 1): one user confirmation must not
// authorize more than the destructive work that was actually confirmed. A
// confirmation is a bounded, single-use grant — per target when the confirming
// surface knows the target, per call otherwise — never a turn-wide blank check.

const baseContext = {
  userId: 4242,
  tenantId: 4242,
  confirmedDestructiveAction: true,
  confirmationSource: 'pending_confirmation' as const,
  requireConfirmationForWrites: true,
};

function authorize(toolName: string, input: Record<string, unknown> = {}) {
  return authorizeChatToolCall(
    toolName,
    { userId: 4242, tenantId: 4242, ...input },
    4242,
    4242,
  );
}

describe('per-target destructive confirmation (ADV-3)', () => {
  it('a single untyped confirmation authorizes exactly one destructive call', async () => {
    await runWithChatToolAuthorization({ ...baseContext }, async () => {
      const first = authorize('delete_calendar_event', { event_id: 'evt-1' });
      expect(first.allowed).toBe(true);

      const second = authorize('delete_calendar_event', { event_id: 'evt-2' });
      expect(second).toMatchObject({
        allowed: false,
        code: 'CONFIRMATION_REQUIRED',
        confirmationRequired: true,
        toolRisk: 'destructive',
      });
    });
  });

  it('a single untyped confirmation does not extend to a second destructive tool', async () => {
    await runWithChatToolAuthorization({ ...baseContext }, async () => {
      expect(authorize('delete_calendar_event', { event_id: 'evt-1' }).allowed).toBe(true);
      const crossTool = authorize('ms_todo_delete_task', { task_id: 'task-9', list_id: 'l1' });
      expect(crossTool).toMatchObject({
        allowed: false,
        code: 'CONFIRMATION_REQUIRED',
        toolRisk: 'destructive',
      });
    });
  });

  it('typed target grants authorize only the confirmed tool + target, once', async () => {
    const targets: ChatConfirmedDestructiveTarget[] = [
      { tool: 'delete_calendar_event', targetId: 'evt-1' },
    ];
    await runWithChatToolAuthorization(
      { ...baseContext, confirmedDestructiveTargets: targets },
      async () => {
        const wrongTarget = authorize('delete_calendar_event', { event_id: 'evt-2' });
        expect(wrongTarget).toMatchObject({ allowed: false, code: 'CONFIRMATION_REQUIRED' });

        const wrongTool = authorize('ms_todo_delete_task', { task_id: 'evt-1', list_id: 'l1' });
        expect(wrongTool).toMatchObject({ allowed: false, code: 'CONFIRMATION_REQUIRED' });

        const match = authorize('delete_calendar_event', { event_id: 'evt-1' });
        expect(match.allowed).toBe(true);

        const replay = authorize('delete_calendar_event', { event_id: 'evt-1' });
        expect(replay).toMatchObject({ allowed: false, code: 'CONFIRMATION_REQUIRED' });
      },
    );
  });

  it('a decoy id field carrying the confirmed target never satisfies a targeted grant', async () => {
    // Adversarial: the model points the REAL target field at a different
    // object and smuggles the confirmed id into an unrelated field. Matching
    // is schema-exact (CONFIRMED_TARGET_FIELDS), so the decoy is inert.
    const targets: ChatConfirmedDestructiveTarget[] = [
      { tool: 'delete_calendar_event', targetId: 'evt-1' },
    ];
    await runWithChatToolAuthorization(
      { ...baseContext, confirmedDestructiveTargets: targets },
      async () => {
        const decoy = authorize('delete_calendar_event', {
          event_id: 'evt-OTHER',
          original_id: 'evt-1',
          eventId: 'evt-1',
        });
        expect(decoy).toMatchObject({ allowed: false, code: 'CONFIRMATION_REQUIRED' });
      },
    );
  });

  it('a tool-scoped grant without target id authorizes one call of that tool only', async () => {
    const targets: ChatConfirmedDestructiveTarget[] = [{ tool: 'delete_calendar_event' }];
    await runWithChatToolAuthorization(
      { ...baseContext, confirmedDestructiveTargets: targets },
      async () => {
        expect(authorize('ms_todo_delete_list', { list_id: 'l1' }).allowed).toBe(false);
        expect(authorize('delete_calendar_event', { event_id: 'evt-7' }).allowed).toBe(true);
        expect(authorize('delete_calendar_event', { event_id: 'evt-8' }).allowed).toBe(false);
      },
    );
  });

  it('a targeted grant never matches a call whose input carries no identifiable target', async () => {
    const targets: ChatConfirmedDestructiveTarget[] = [
      { tool: 'delete_calendar_event', targetId: 'evt-1' },
    ];
    await runWithChatToolAuthorization(
      { ...baseContext, confirmedDestructiveTargets: targets },
      async () => {
        const result = authorize('delete_calendar_event', { title: 'standup' });
        expect(result).toMatchObject({ allowed: false, code: 'CONFIRMATION_REQUIRED' });
      },
    );
  });

  it('multiple grants authorize exactly that many destructive calls', async () => {
    const targets: ChatConfirmedDestructiveTarget[] = [{}, {}];
    await runWithChatToolAuthorization(
      { ...baseContext, confirmedDestructiveTargets: targets },
      async () => {
        expect(authorize('delete_calendar_event', { event_id: 'a' }).allowed).toBe(true);
        expect(authorize('ms_todo_delete_task', { task_id: 'b', list_id: 'l1' }).allowed).toBe(true);
        expect(authorize('finance_delete_transaction', { transaction_id: 'c' }).allowed).toBe(false);
      },
    );
  });

  it('an empty grant list blocks all destructive calls even when the boolean is confirmed', async () => {
    await runWithChatToolAuthorization(
      { ...baseContext, confirmedDestructiveTargets: [] },
      async () => {
        const result = authorize('delete_calendar_event', { event_id: 'evt-1' });
        expect(result).toMatchObject({ allowed: false, code: 'CONFIRMATION_REQUIRED' });
      },
    );
  });

  it('every dispatchable destructive/external-send tool declares a target field mapping', () => {
    // Fail-closed invariant: a future destructive tool shipped without a
    // CONFIRMED_TARGET_FIELDS row would make targeted grants silently
    // unmatchable for it. Surface that at test time, not in production.
    for (const toolName of DISPATCHABLE_TOOL_NAMES) {
      const risk = getChatToolRisk(toolName);
      if (risk !== 'destructive' && risk !== 'external_send') continue;
      expect(
        CONFIRMED_TARGET_FIELDS[toolName],
        `${toolName} is ${risk} but has no CONFIRMED_TARGET_FIELDS mapping`,
      ).toBeDefined();
    }
  });

  it('external-send tools consume grants like destructive tools', async () => {
    await runWithChatToolAuthorization({ ...baseContext }, async () => {
      expect(authorize('send_outlook_email', { to: 'a@b.c' }).allowed).toBe(true);
      expect(authorize('send_outlook_email', { to: 'd@e.f' }).allowed).toBe(false);
    });
  });

  it('confirmed writes are not rationed by destructive grants', async () => {
    await runWithChatToolAuthorization({ ...baseContext }, async () => {
      expect(authorize('create_calendar_event', { title: 'a' }).allowed).toBe(true);
      expect(authorize('set_reminder', { title: 'b' }).allowed).toBe(true);
      expect(authorize('ms_todo_create_task', { title: 'c' }).allowed).toBe(true);
      // The destructive grant is still available after any number of writes.
      expect(authorize('delete_calendar_event', { eventId: 'evt-1' }).allowed).toBe(true);
    });
  });

  it('grants are irrelevant while the confirmation boolean is false', async () => {
    await runWithChatToolAuthorization(
      {
        ...baseContext,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
        confirmedDestructiveTargets: [{ tool: 'delete_calendar_event', targetId: 'evt-1' }],
      },
      async () => {
        const result = authorize('delete_calendar_event', { eventId: 'evt-1' });
        expect(result).toMatchObject({ allowed: false, code: 'CONFIRMATION_REQUIRED' });
      },
    );
  });

  it('consumption state is scoped to one authorization context, not shared across turns', async () => {
    await runWithChatToolAuthorization({ ...baseContext }, async () => {
      expect(authorize('delete_calendar_event', { eventId: 'evt-1' }).allowed).toBe(true);
    });
    // A new turn (new context) starts with its own single-use grant.
    await runWithChatToolAuthorization({ ...baseContext }, async () => {
      expect(authorize('delete_calendar_event', { eventId: 'evt-2' }).allowed).toBe(true);
    });
  });

  it('matches snake_case and nested-free id fields when checking targeted grants', async () => {
    const targets: ChatConfirmedDestructiveTarget[] = [
      { tool: 'ms_todo_delete_task', targetId: 'task-11' },
      { tool: 'shared_memory_remove', targetId: 'pref.timezone' },
    ];
    await runWithChatToolAuthorization(
      { ...baseContext, confirmedDestructiveTargets: targets },
      async () => {
        expect(authorize('ms_todo_delete_task', { task_id: 'task-11' }).allowed).toBe(true);
        expect(authorize('shared_memory_remove', { key: 'pref.timezone' }).allowed).toBe(true);
      },
    );
  });
});
