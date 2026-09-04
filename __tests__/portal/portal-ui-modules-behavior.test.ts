import { describe, expect, it, vi } from 'vitest';
import { createPortalUiHarness, type FakeResponse } from './helpers/portal-ui-module-harness';

const json = (body: unknown, ok = true): FakeResponse => ({ ok, status: ok ? 200 : 500, json: async () => body });

describe('dashboard module', () => {
  const snapshot = { version: '1.2.3', uptime: { human: '1h' }, healthSummary: {}, server: { status: 'online' }, bot: {}, recentEvents: [], integrations: [] };
  const fetch = (url: string) => {
    if (url === '/api/snapshot') return json(snapshot);
    if (url === '/api/usage/summary') return json({ ok: true, today: {}, week: {}, sparkline: [] });
    return json({}, false);
  };

  it('still fans the snapshot out to other sections when its own paint throws, and logs the failure', async () => {
    // app-version is the first element renderSnapshot touches; a missing node
    // must not starve skills / jobs / AI of the payload.
    const harness = createPortalUiHarness({ missingIds: ['app-version'], fetch });
    harness.load('dashboard.js');
    const received = vi.fn();
    harness.bridge.on('snapshot', received);

    harness.bridge.sections.dashboard.onShow();
    await harness.settle();

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(snapshot);
    // The error comes from the vm realm, so match on shape rather than instanceof.
    expect(harness.console.warn).toHaveBeenCalledWith('[portal] dashboard snapshot poll failed', expect.objectContaining({ message: expect.stringContaining('textContent') }));
  });

  it('installs its timers and visibility listener once even when app:start fires twice', () => {
    const harness = createPortalUiHarness({ fetch });
    harness.load('dashboard.js');

    harness.bridge.emit('app:start');
    harness.bridge.emit('app:start');

    const intervals = harness.timers.intervals.map((t) => t.ms).sort((a, b) => a - b);
    expect(intervals).toEqual([15000, 60000]);
    expect(harness.document.listeners.visibilitychange).toHaveLength(1);
  });
});

describe('content module scope status', () => {
  it('shows the accent colour through utility classes when a scope is active', () => {
    const harness = createPortalUiHarness({ contentScope: { userId: '7', tenantId: '' } });
    harness.el('content-scope-status').classList.add('u-c-text-tertiary');
    harness.load('content.js');

    harness.bridge.sections.content.onShow();

    const status = harness.el('content-scope-status');
    expect(status.textContent).toContain('user=7');
    expect(status.classList.contains('u-c-accent')).toBe(true);
    expect(status.classList.contains('u-c-text-tertiary')).toBe(false);
    expect(status.style.color).toBeUndefined();
  });

  it('returns to the tertiary colour when the scope is cleared', () => {
    const harness = createPortalUiHarness({ contentScope: { userId: '', tenantId: '' } });
    harness.el('content-scope-status').classList.add('u-c-accent');
    harness.load('content.js');

    harness.bridge.sections.content.onShow();

    const status = harness.el('content-scope-status');
    expect(status.classList.contains('u-c-text-tertiary')).toBe(true);
    expect(status.classList.contains('u-c-accent')).toBe(false);
  });
});

describe('waitlist access ticket', () => {
  function loadWaitlist(onTicket: (opts: Record<string, unknown>) => FakeResponse | Promise<FakeResponse>) {
    const entry = { id: 5, email: 'someone@example.com', status: 'pending', intent: 'founder', source: 'landing', created_at: '2026-09-01T00:00:00Z', use_case: 'testing' };
    const harness = createPortalUiHarness({
      fetch: (url, opts) => {
        if (url.startsWith('/api/waitlist')) return json({ ok: true, entries: [entry], counters: { founder: { filled: 1, max: 100 }, totals: {} } });
        if (url === '/api/support/tickets') return onTicket(opts ?? {});
        return json({}, false);
      },
    });
    harness.load('waitlist.js');
    const root = harness.el('waitlist-root');
    harness.bridge.sections.waitlist.mount(root);
    return { harness, root };
  }

  const clickTicket = (harness: ReturnType<typeof createPortalUiHarness>, root: any, button: Record<string, unknown>) => {
    harness.trigger(root, 'click', { target: { closest: () => button } });
  };

  it('titles the ticket on the waitlist id (email is redacted server-side) and keeps the external ref', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { harness, root } = loadWaitlist((opts) => {
      bodies.push(JSON.parse(String(opts.body)));
      return json({ ok: true, ticket: { id: 42, ref: 'NH-T-0042' } });
    });
    await harness.bridge.sections.waitlist.onShow();
    await harness.settle();

    clickTicket(harness, root, { dataset: { op: 'ticket', id: '5' }, disabled: false });
    await harness.settle();

    expect(bodies).toHaveLength(1);
    expect(bodies[0].title).toBe('Access request: waitlist #5');
    expect(bodies[0].title).not.toContain('example.com');
    expect(bodies[0]).toMatchObject({ kind: 'access_request', source: 'waitlist', externalRef: 'waitlist:5', priority: 'p1' });
    expect(harness.bridge.navigateTo).toHaveBeenCalledWith('support');
  });

  it('disables the button while the request is in flight and ignores a second click', async () => {
    let resolveTicket: (value: FakeResponse) => void = () => {};
    let posts = 0;
    const { harness, root } = loadWaitlist(() => {
      posts += 1;
      return new Promise<FakeResponse>((resolve) => { resolveTicket = resolve; });
    });
    await harness.bridge.sections.waitlist.onShow();
    await harness.settle();

    const button = { dataset: { op: 'ticket', id: '5' }, disabled: false };
    clickTicket(harness, root, button);
    clickTicket(harness, root, button);
    await harness.settle();

    expect(posts).toBe(1);
    expect(button.disabled).toBe(true);

    resolveTicket(json({ ok: true, ticket: { id: 42, ref: 'NH-T-0042' } }));
    await harness.settle();
    expect(button.disabled).toBe(false);
  });
});

describe('skills module user selector', () => {
  it('re-fetches the user list every time the section is shown', async () => {
    const harness = createPortalUiHarness({
      fetch: (url) => (url === '/api/users' ? json({ users: [{ id: 1, first_name: 'Ada' }] }) : json({}, false)),
    });
    harness.load('skills.js');

    harness.bridge.sections.skills.onShow();
    await harness.settle();
    harness.bridge.sections.skills.onShow();
    await harness.settle();

    expect(harness.calls.filter((c) => c.url === '/api/users')).toHaveLength(2);
  });
});
