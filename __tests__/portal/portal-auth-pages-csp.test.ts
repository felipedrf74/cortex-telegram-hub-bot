import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The user sign-in, forgot-password, and password-reset pages ship their
 * script and stylesheet from /portal/ui/*.js|css instead of inline blocks, so
 * each page handler can serve script-src 'self' and style-src 'self'. The
 * landing preview is deliberately excluded: it mirrors the marketing site's
 * inline bundle and keeps its own permissive policy.
 */

const portalDir = path.resolve(__dirname, '../../src/portal');
const staticRoutes = fs.readFileSync(path.join(portalDir, 'static-routes.ts'), 'utf8');

const PAGES: Array<{ file: string; asset: string; handler: string }> = [
  { file: 'user-login.html', asset: 'user-login', handler: 'createUserLoginHandler' },
  { file: 'auth/forgot-password.html', asset: 'auth-forgot-password', handler: 'createForgotPasswordPageHandler' },
  { file: 'auth/password-reset.html', asset: 'auth-password-reset', handler: 'createPasswordResetPageHandler' },
];

function handlerCsp(handler: string): string {
  const start = staticRoutes.indexOf(`export function ${handler}`);
  expect(start).toBeGreaterThan(-1);
  const body = staticRoutes.slice(start, staticRoutes.indexOf('\nexport function', start + 1));
  const pieces = body.match(/'Content-Security-Policy',\s*((?:"[^"]*"\s*\+?\s*)+)/)?.[1] ?? '';
  return pieces.replace(/"\s*\+\s*"/g, '').replace(/"/g, '');
}

describe('auth and sign-in pages under a strict CSP', () => {
  for (const page of PAGES) {
    it(`${page.file} carries no inline script, style block, or style attribute`, () => {
      const html = fs.readFileSync(path.join(portalDir, page.file), 'utf8');
      expect(html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? []).toEqual([]);
      expect(html).not.toMatch(/<style[\s>]/);
      expect(html.match(/\sstyle=["']/g) ?? []).toEqual([]);
      expect(html.match(/\son[a-z]+=["']/g) ?? []).toEqual([]);
      expect(html).toContain(`<link rel="stylesheet" href="/portal/ui/${page.asset}.css">`);
      expect(html).toContain(`<script src="/portal/ui/${page.asset}.js"></script>`);
      for (const ext of ['css', 'js']) {
        expect(fs.existsSync(path.join(portalDir, 'ui', `${page.asset}.${ext}`))).toBe(true);
      }
    });

    it(`${page.handler} serves script-src and style-src without 'unsafe-inline'`, () => {
      const csp = handlerCsp(page.handler);
      const directive = (name: string) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name)) ?? '';
      expect(directive('script-src')).toBe("script-src 'self'");
      expect(directive('style-src')).toBe("style-src 'self'");
      expect(directive('default-src')).toBe("default-src 'self'");
    });
  }
});
