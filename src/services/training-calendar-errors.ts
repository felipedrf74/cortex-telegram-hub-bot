// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Detects provider responses that mean "this calendar event is already gone".
 *
 * Keep this helper scoped to calendar-event delete/reconcile flows. Generic
 * "not found" errors elsewhere can mean a missing user, task, or permission
 * boundary and should not be treated as a successful no-op.
 */
export function isProviderEventNotFoundError(err: unknown): boolean {
  const anyErr = err as any;
  const status = Number(anyErr?.status ?? anyErr?.statusCode ?? anyErr?.response?.status ?? anyErr?.code);
  if (status === 404 || status === 410) return true;

  const code = String(anyErr?.code ?? anyErr?.error?.code ?? '').toLowerCase();
  if (
    code === 'event_not_found'
    || code === 'not_found'
    || code === 'notfound'
    || code === 'gone'
    || code === 'erroritemnotfound'
  ) return true;

  const reason = String(
    anyErr?.reason
    ?? anyErr?.error?.reason
    ?? anyErr?.errors?.[0]?.reason
    ?? anyErr?.response?.data?.error
    ?? '',
  ).toLowerCase();
  if (reason === 'notfound' || reason === 'not_found' || reason === 'event_not_found' || reason === 'gone') return true;

  const message = String(
    anyErr?.message
    ?? anyErr?.body
    ?? anyErr?.response?.data?.message
    ?? '',
  ).toLowerCase();
  return /\b(404|410|event[_\s-]not[_\s-]found|calendar event not found|event gone|410 gone|object was not found in the store|non-calendar folder)\b/.test(message);
}
