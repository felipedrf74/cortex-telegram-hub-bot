import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPortalUiModuleHandler } from '../../src/portal/static-routes';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ui-'));
  fs.mkdirSync(path.join(dir, 'ui'));
  fs.writeFileSync(path.join(dir, 'ui', 'logs.js'), 'export const ok = 1;');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function invoke(file: string) {
  const handler = createPortalUiModuleHandler(dir);
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    set: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = v; return res; }),
    status: vi.fn((code: number) => { res.statusCode = code; return res; }),
    type: vi.fn((t: string) => { headers['content-type'] = t; return res; }),
    send: vi.fn((body: unknown) => { res.body = body; return res; }),
  };
  handler({ params: { file } } as any, res);
  return { res, headers };
}

describe('portal UI module handler', () => {
  it('serves allowlisted module files as JavaScript without caching', () => {
    const { res, headers } = invoke('logs.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('export const ok = 1;');
    expect(headers['content-type']).toContain('text/javascript');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects traversal, non-js names and missing files', () => {
    expect(invoke('../secret.txt').res.statusCode).toBe(404);
    expect(invoke('secret.txt').res.statusCode).toBe(404);
    expect(invoke('Logs.JS').res.statusCode).toBe(404);
    expect(invoke('missing.js').res.statusCode).toBe(404);
  });

  it('ships the modules the SPA imports', () => {
    const uiDir = path.resolve(__dirname, '../../src/portal/ui');
    const app = fs.readFileSync(path.join(uiDir, 'app.js'), 'utf8');
    const imports = Array.from(app.matchAll(/from '\.\/([a-z0-9-]+\.js)'|import '\.\/([a-z0-9-]+\.js)'/g)).map((m) => m[1] || m[2]);
    expect(imports.length).toBeGreaterThan(0);
    for (const file of imports) expect(fs.existsSync(path.join(uiDir, file))).toBe(true);
    const html = fs.readFileSync(path.resolve(__dirname, '../../src/portal/portal.html'), 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="/portal/ui/portal.css">');
    expect(fs.existsSync(path.join(uiDir, 'portal.css'))).toBe(true);
    expect(html).not.toContain('<style>');
    expect(html).toContain('<script src="/portal/ui/legacy.js"></script>');
    expect(html).toContain('<script type="module" src="/portal/ui/app.js"></script>');
    expect(fs.readFileSync(path.join(uiDir, 'legacy.js'), 'utf8')).toContain('window.NexusPortal = {');
  });
});
