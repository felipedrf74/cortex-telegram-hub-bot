import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPortalUiModuleHandler, createPortalUiModuleRateLimiter } from '../../src/portal/static-routes';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ui-'));
  fs.mkdirSync(path.join(dir, 'ui'));
  fs.writeFileSync(path.join(dir, 'ui', 'logs.js'), 'export const ok = 1;');
  fs.writeFileSync(path.join(dir, 'ui', 'portal.css'), ':root{--space-1:4px}');
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
  it('serves the allowlisted stylesheet as CSS', () => {
    const { res, headers } = invoke('portal.css');
    expect(res.statusCode).toBe(200);
    expect(headers['content-type']).toBe('text/css; charset=utf-8');
    expect(res.body).toBe(':root{--space-1:4px}');
  });

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

describe('portal UI module rate limiter', () => {
  it('caps asset reads per client IP using PORTAL_API_RATE_LIMIT', async () => {
    const previousLimit = process.env.PORTAL_API_RATE_LIMIT;
    process.env.PORTAL_API_RATE_LIMIT = '2';
    try {
      const limiter = createPortalUiModuleRateLimiter();
      const buildResponse = () => ({
        statusCode: 200,
        body: undefined as unknown,
        headers: {} as Record<string, string | number>,
        setHeader(name: string, value: string | number) { this.headers[name] = value; return this; },
        status(code: number) { this.statusCode = code; return this; },
        type(value: string) { this.headers['Content-Type'] = value; return this; },
        send(body: unknown) { this.body = body; return this; },
      });
      const request = { headers: {}, ip: '198.51.100.42', socket: { remoteAddress: '198.51.100.42' } };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const next = vi.fn();
        await limiter(request as any, buildResponse() as any, next);
        expect(next).toHaveBeenCalledOnce();
      }
      const blocked = buildResponse();
      const blockedNext = vi.fn();
      await limiter(request as any, blocked as any, blockedNext);
      expect(blockedNext).not.toHaveBeenCalled();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['Retry-After']).toBe(60);
      expect(blocked.headers['Content-Type']).toBe('text/plain');
      expect(String(blocked.body)).toContain('Too many portal asset requests');
    } finally {
      if (previousLimit === undefined) delete process.env.PORTAL_API_RATE_LIMIT;
      else process.env.PORTAL_API_RATE_LIMIT = previousLimit;
    }
  });

  it('falls back to the built-in ceiling when PORTAL_API_RATE_LIMIT is unset', async () => {
    const previousLimit = process.env.PORTAL_API_RATE_LIMIT;
    delete process.env.PORTAL_API_RATE_LIMIT;
    try {
      const limiter = createPortalUiModuleRateLimiter();
      const next = vi.fn();
      const res: any = { setHeader: vi.fn(), status: vi.fn(), type: vi.fn(), send: vi.fn() };
      await limiter({ headers: {}, ip: '198.51.100.43', socket: { remoteAddress: '198.51.100.43' } } as any, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    } finally {
      if (previousLimit !== undefined) process.env.PORTAL_API_RATE_LIMIT = previousLimit;
    }
  });
});
