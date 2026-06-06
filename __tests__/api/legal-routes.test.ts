import { describe, expect, it } from 'vitest';
import type { Request } from 'express';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  redirect(codeOrUrl: number | string, maybeUrl?: string): MockRes;
}

function mockRes(onDone?: () => void): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; onDone?.(); return res; },
    redirect(codeOrUrl: number | string, maybeUrl?: string) {
      if (typeof codeOrUrl === 'number') {
        res.statusCode = codeOrUrl;
        res.headers.location = maybeUrl ?? '';
      } else {
        res.statusCode = 302;
        res.headers.location = codeOrUrl;
      }
      onDone?.();
      return res;
    },
  };
  return res;
}

async function dispatchLegal(path: string): Promise<MockRes> {
  const { legalRoutes } = await import('../../src/api/routes/legal');
  const router = legalRoutes();
  const req = {
    method: 'GET',
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
  } as Request;

  let res!: MockRes;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res = mockRes(finish);
    (router as any).handle(req, res, (err: any) => {
      if (err) {
        reject(err);
        return;
      }
      finish();
    });
    setTimeout(finish, 1000);
  });
  return res;
}

describe('legal routes', () => {
  it('returns current legal document metadata and support contact', async () => {
    const res = await dispatchLegal('/current');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.supportEmail).toBe('support@nexushub.me');
    expect(res.body.data.documents.terms.version).toBe('2026-06-04');
    expect(res.body.data.documents.privacy.version).toBe('2026-06-04');
    expect(res.body.data.documents.terms.lawyerReviewRequired).toBe(true);
    expect(res.body.data.documents.privacy.lawyerReviewRequired).toBe(true);
  });

  it('redirects stable legal slugs to the public site documents', async () => {
    const terms = await dispatchLegal('/terms');
    const privacy = await dispatchLegal('/privacy');

    expect(terms.statusCode).toBe(302);
    expect(terms.headers.location).toBe('https://nexushub.me/terms');
    expect(privacy.statusCode).toBe(302);
    expect(privacy.headers.location).toBe('https://nexushub.me/privacy');
  });
});
