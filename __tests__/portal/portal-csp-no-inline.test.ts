import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The admin dashboard ships no inline script: the SPA lives in
 * `src/portal/ui/legacy.js` plus the ES modules, and markup uses
 * `data-act` delegation instead of inline `on*` handlers. That is what lets
 * the dashboard CSP drop `'unsafe-inline'` from `script-src`. This test keeps
 * both halves honest so a stray inline handler cannot silently break the
 * portal under the stricter policy.
 */

const portalDir = path.resolve(__dirname, '../../src/portal');
const html = fs.readFileSync(path.join(portalDir, 'portal.html'), 'utf8');
const legacy = fs.readFileSync(path.join(portalDir, 'ui', 'legacy.js'), 'utf8');

function directiveOf(csp: string, name: string): string {
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(name));
  return directive ?? '';
}

function scriptSrcDirective(csp: string): string {
  return directiveOf(csp, 'script-src');
}

function uiModuleSources(): Array<[string, string]> {
  const uiDir = path.join(portalDir, 'ui');
  return fs.readdirSync(uiDir).filter((file) => file.endsWith('.js')).map((file) => [file, fs.readFileSync(path.join(uiDir, file), 'utf8')]);
}

describe('portal dashboard CSP without inline scripts', () => {
  it('portal.html carries no inline <script> blocks or inline event handlers', () => {
    const inlineScripts = html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? [];
    expect(inlineScripts).toEqual([]);
    const inlineHandlers = html.match(/\son[a-z]+="/g) ?? [];
    expect(inlineHandlers).toEqual([]);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<script src="/portal/ui/legacy.js"></script>');
    expect(html).toContain('<script type="module" src="/portal/ui/app.js"></script>');
  });

  it('generated markup in the SPA script uses delegated data-act handlers, never on* attributes', () => {
    const inlineHandlers = legacy.match(/\son(click|change|input|submit|keydown|keyup)="/g) ?? [];
    expect(inlineHandlers).toEqual([]);
    expect(legacy).toContain('function dispatchPortalAction(event, kind)');
    expect(legacy).toContain("document.addEventListener('click', (event) => dispatchPortalAction(event, 'click'))");
    expect(legacy).toContain("document.addEventListener('change', (event) => dispatchPortalAction(event, 'change'))");
  });

  it('every data-act name in markup resolves to a function the SPA exposes', () => {
    const names = new Set<string>();
    for (const source of [html, legacy]) {
      for (const match of source.matchAll(/data-act="([A-Za-z_$][\w$]*)"/g)) names.add(match[1]);
    }
    expect(names.size).toBeGreaterThan(0);
    const missing = [...names].filter((name) => {
      const declared = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=|window\\.${name}\\s*=)`).test(legacy);
      return !declared;
    });
    expect(missing).toEqual([]);
  });

  it('the dashboard CSP allows only same-origin scripts', () => {
    const staticRoutes = fs.readFileSync(path.join(portalDir, 'static-routes.ts'), 'utf8');
    const server = fs.readFileSync(path.join(portalDir, 'server.ts'), 'utf8');
    const dashboardCsp = staticRoutes.match(/applyPortalDashboardSecurityHeaders[\s\S]*?'Content-Security-Policy',\s*"([^"]+)"/)?.[1] ?? '';
    const globalCsp = server.match(/createPortalSecurityHeadersMiddleware[\s\S]*?'Content-Security-Policy',\s*((?:"[^"]*"\s*\+?\s*)+)/)?.[1] ?? '';
    for (const csp of [dashboardCsp, globalCsp.replace(/"\s*\+\s*"/g, '').replace(/"/g, '')]) {
      const scriptSrc = scriptSrcDirective(csp);
      expect(scriptSrc).toContain("'self'");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      const styleSrc = directiveOf(csp, 'style-src');
      expect(styleSrc).toContain("'self'");
      expect(styleSrc).not.toContain("'unsafe-inline'");
    }
  });

  it('dashboard markup and UI modules carry no inline style attributes or style blocks', () => {
    // style-src has no 'unsafe-inline' either: static styling lives in
    // ui/portal.css utilities, dynamic per-row values ride on data-w /
    // data-color / data-bg / data-opacity and are applied through CSSOM.
    const sources: Array<[string, string]> = [['portal.html', html], ...uiModuleSources()];
    const offenders = sources.flatMap(([name, source]) => (source.match(/\sstyle=["']/g) ?? []).map(() => name));
    expect(offenders).toEqual([]);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(sources.some(([, source]) => source.includes("createElement('style')"))).toBe(false);
    expect(legacy).toContain('function applyDynamicStyles(root)');
    expect(legacy).toContain('new MutationObserver(');
  });
});
