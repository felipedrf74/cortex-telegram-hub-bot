import { describe, expect, it } from 'vitest';
import { createPortalUiHarness, type FakeResponse } from './helpers/portal-ui-module-harness';

/**
 * The shell (ui/legacy.js) offers two ways into the same cookie session: a
 * username + password form when the deployment advertises it, and the session
 * token field otherwise. These run the real shell script in the vm harness.
 */

const json = (body: unknown, ok = true, status = ok ? 200 : 401): FakeResponse => ({ ok, status, json: async () => body });

function bootShell(options: { passwordConfigured: boolean; onPassword?: (body: Record<string, unknown>) => FakeResponse }) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const harness = createPortalUiHarness({
    fetch: (url, opts) => {
      const method = String((opts as Record<string, unknown> | undefined)?.method || 'GET').toUpperCase();
      if (url === '/api/auth/session' && method === 'GET') return json({ ok: false }, false, 401);
      if (url === '/api/auth/session/methods') return json({ ok: true, token: true, password: options.passwordConfigured });
      if (url === '/api/auth/session/password' && method === 'POST') {
        const body = JSON.parse(String((opts as Record<string, unknown>).body));
        posts.push({ url, body });
        return options.onPassword ? options.onPassword(body) : json({ ok: true, scope: 'admin', actor: 'operator', csrf: 'proof' });
      }
      return json({}, false, 404);
    },
  });
  harness.el('login-overlay').hidden = true;
  harness.el('login-password-form').hidden = true;
  harness.el('login-switch').hidden = true;
  harness.load('legacy.js');
  return { harness, posts };
}

describe('portal shell sign-in overlay', () => {
  it('shows the username and password form when the deployment advertises it', async () => {
    const { harness } = bootShell({ passwordConfigured: true });
    await harness.settle();
    expect(harness.el('login-overlay').hidden).toBe(false);
    expect(harness.el('login-password-form').hidden).toBe(false);
    expect(harness.el('login-token-form').hidden).toBe(true);
    expect(harness.el('login-switch').hidden).toBe(false);
    expect(harness.el('login-sub').textContent).toContain('operator account');
  });

  it('keeps the token field when password sign-in is not configured', async () => {
    const { harness } = bootShell({ passwordConfigured: false });
    await harness.settle();
    expect(harness.el('login-token-form').hidden).toBe(false);
    expect(harness.el('login-password-form').hidden).toBe(true);
    expect(harness.el('login-switch').hidden).toBe(true);
  });

  it('submits the form to the password route, stores the session, and hides the overlay', async () => {
    const { harness, posts } = bootShell({ passwordConfigured: true });
    await harness.settle();
    harness.el('login-username').value = ' operator@example.test ';
    harness.el('login-password').value = 'correct horse battery staple';

    harness.trigger(harness.el('login-password-form'), 'submit');
    await harness.settle();

    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ username: 'operator@example.test', password: 'correct horse battery staple' });
    expect(harness.el('login-overlay').hidden).toBe(true);
    expect(harness.el('login-password').value).toBe('');
    expect(harness.bridge.getSession?.()?.csrf ?? harness.context.NexusPortal.getSession().csrf).toBe('proof');
  });

  it('reports a rejected password and re-enables the button', async () => {
    const { harness } = bootShell({ passwordConfigured: true, onPassword: () => json({ ok: false, message: 'Invalid username or password' }, false, 401) });
    await harness.settle();
    harness.el('login-username').value = 'operator@example.test';
    harness.el('login-password').value = 'wrong';

    harness.trigger(harness.el('login-password-form'), 'submit');
    await harness.settle();

    expect(harness.el('login-overlay').hidden).toBe(false);
    expect(harness.el('login-error').textContent).toBe('Invalid username or password');
    expect(harness.el('login-password-btn').disabled).toBe(false);
  });

  it('lets the operator switch back to the session token field', async () => {
    const { harness } = bootShell({ passwordConfigured: true });
    await harness.settle();
    harness.trigger(harness.el('login-switch'), 'click');
    expect(harness.el('login-token-form').hidden).toBe(false);
    expect(harness.el('login-password-form').hidden).toBe(true);
    expect(harness.el('login-switch').textContent).toContain('username and password');
  });
});
