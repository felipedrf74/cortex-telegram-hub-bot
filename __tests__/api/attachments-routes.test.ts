import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExtractPhotoAttachment = vi.fn();
const mockEnforceCostGuardrails = vi.fn();
const mockGetUserLanguageById = vi.fn();

vi.mock('../../src/services/photo-extraction', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/photo-extraction')>('../../src/services/photo-extraction');
  return {
    ...actual,
    extractPhotoAttachment: (...args: unknown[]) => mockExtractPhotoAttachment(...args),
  };
});

vi.mock('../../src/services/cost-guardrail', () => ({
  enforceCostGuardrails: (...args: unknown[]) => mockEnforceCostGuardrails(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguageById(...args),
}));

import { attachmentRoutes } from '../../src/api/routes/attachments';

function allowQuota() {
  mockEnforceCostGuardrails.mockReturnValue({
    block: false,
  });
}

function blockQuota() {
  mockEnforceCostGuardrails.mockReturnValue({
    block: true,
    reason: 'DAILY_LIMIT',
    message: 'Daily limit reached.',
    status: 429,
    details: { retryable: true },
    quota: {
      spentUsd: 1,
      capUsd: 1,
    },
    global: {
      totalUsd: 1,
      limitUsd: 10,
    },
  });
}

async function requestApp(
  body: unknown,
  headers: Record<string, string> = {},
  userId: number | undefined = 44,
  tenantId: number | undefined = 44,
): Promise<{ statusCode: number; body: any }> {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use((req, _res, next) => {
    (req as any).userId = userId;
    (req as any).tenantId = tenantId;
    next();
  });
  app.use('/attachments', attachmentRoutes());

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to start test server'));
        return;
      }

      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/attachments/extract',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload).toString(),
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            server.close();
            resolve({
              statusCode: res.statusCode ?? 0,
              body: data ? JSON.parse(data) : null,
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      req.write(payload);
      req.end();
    });
  });
}

describe('attachment extraction routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockExtractPhotoAttachment.mockReset();
    mockEnforceCostGuardrails.mockReset();
    mockGetUserLanguageById.mockReset();
    allowQuota();
    mockGetUserLanguageById.mockReturnValue('en-US');
  });

  it('returns a scoped photo extraction preview without echoing image bytes', async () => {
    const imageBase64 = 'c3VwZXItc2VjcmV0LWltYWdlLWJ5dGVz';
    mockExtractPhotoAttachment.mockResolvedValue({
      userText: 'Analyze this image.',
      conversationDomain: 'finance',
      degraded: false,
      degradedReason: null,
      preview: {
        text: 'I analyzed the image as a receipt/invoice.',
        domain: 'finance',
        confidence: 0.92,
        metadata: {
          type: 'invoice_preview',
          invoiceVendor: 'Pingo Doce',
          invoiceAmount: '18,20 EUR',
        },
      },
    });

    const res = await requestApp({
      attachment: {
        base64: imageBase64,
        mimeType: 'IMAGE/JPG',
      },
      caption: ' ',
    }, { 'x-language': 'en-US' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({
      type: 'photo_extraction_preview',
      routeMethod: 'attachment',
      domain: 'finance',
      text: 'I analyzed the image as a receipt/invoice.',
      confidence: 0.92,
      metadata: {
        type: 'invoice_preview',
        invoiceVendor: 'Pingo Doce',
        invoiceAmount: '18,20 EUR',
      },
      degraded: false,
      degradedReason: null,
      userText: 'Analyze this image.',
    });
    expect(JSON.stringify(res.body)).not.toContain(imageBase64);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-image-bytes');
    expect(mockExtractPhotoAttachment).toHaveBeenCalledWith({
      attachment: {
        base64: imageBase64,
        mimeType: 'image/jpeg',
      },
      caption: '',
      userId: 44,
      tenantId: 44,
      language: 'en-US',
    });
  });

  it('rejects unsupported attachment payloads before invoking the classifier', async () => {
    const res = await requestApp({
      attachment: {
        base64: 'abc123',
        mimeType: 'application/pdf',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockExtractPhotoAttachment).not.toHaveBeenCalled();
  });

  it('rejects oversized image payloads before invoking the classifier', async () => {
    vi.stubEnv('PHOTO_EXTRACTION_MAX_BASE64_CHARS', '8');
    const res = await requestApp({
      attachment: {
        base64: 'a'.repeat(9),
        mimeType: 'image/png',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockExtractPhotoAttachment).not.toHaveBeenCalled();
  });

  it('fails closed when tenant scope is missing', async () => {
    const res = await requestApp({
      attachment: {
        base64: 'abc123',
        mimeType: 'image/png',
      },
    }, {}, 44, 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockExtractPhotoAttachment).not.toHaveBeenCalled();
  });

  it('returns rate-limit errors before invoking vision extraction', async () => {
    blockQuota();

    const res = await requestApp({
      attachment: {
        base64: 'abc123',
        mimeType: 'image/png',
      },
    });

    expect(res.statusCode).toBe(429);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('DAILY_LIMIT');
    expect(mockExtractPhotoAttachment).not.toHaveBeenCalled();
  });
});
