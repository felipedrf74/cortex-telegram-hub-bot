import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  scriptJobEncryptionKey: 'content-script-job-test-key-that-is-longer-than-32-bytes',
  scriptJobPreviousEncryptionKeys: [] as string[],
}));

vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: configMock,
}));

import {
  ContentScriptJobEncryptionError,
  decryptContentScriptJobJson,
  encryptContentScriptJobJson,
} from '../../src/services/content-script-job-encryption';
import { encryptValue } from '../../src/utils/encryption';

describe('content script job encryption', () => {
  it('stores valid JSON envelopes without retaining private plaintext', () => {
    const stored = encryptContentScriptJobJson({ topic: 'private launch', script: 'private draft' }, 42);
    expect(JSON.parse(stored)).toMatchObject({
      schema: 'nexus.content-script-job-encrypted.v3',
      keyVersion: expect.stringMatching(/^[0-9a-f]{16}$/u),
    });
    expect(() => JSON.parse(stored)).not.toThrow();
    expect(stored).not.toContain('private launch');
    expect(stored).not.toContain('private draft');
    expect(decryptContentScriptJobJson(stored, 42)).toEqual({
      topic: 'private launch',
      script: 'private draft',
    });
  });

  it('binds ciphertext to the owning user', () => {
    const stored = encryptContentScriptJobJson({ topic: 'tenant-bound' }, 42);
    expect(() => decryptContentScriptJobJson(stored, 77)).toThrow();
  });

  it('authenticates schema and key-version metadata instead of treating mutation as retirement', () => {
    const envelope = JSON.parse(encryptContentScriptJobJson({ topic: 'metadata-bound' }, 42)) as {
      keyVersion: string;
    };
    envelope.keyVersion = envelope.keyVersion === '0000000000000000'
      ? '1111111111111111'
      : '0000000000000000';

    expect(() => decryptContentScriptJobJson(JSON.stringify(envelope), 42)).toThrow(
      expect.objectContaining({ code: 'CONTENT_SCRIPT_JOB_ENVELOPE_AUTHENTICATION_FAILED' }),
    );
  });

  it('hard-fails a schema mutation instead of degrading it as key retirement', () => {
    const envelope = JSON.parse(encryptContentScriptJobJson({ topic: 'schema-bound' }, 42)) as {
      schema: string;
    };
    envelope.schema = 'nexus.content-script-job-encrypted.v2';

    expect(() => decryptContentScriptJobJson(JSON.stringify(envelope), 42)).toThrow(
      expect.objectContaining({ code: 'CONTENT_SCRIPT_JOB_DECRYPTION_FAILED' }),
    );
  });

  it('normalizes current and previous key whitespace to the same derived identity', () => {
    const current = configMock.scriptJobEncryptionKey;
    try {
      configMock.scriptJobEncryptionKey = `  ${current}  `;
      const stored = encryptContentScriptJobJson({ topic: 'normalized-key' }, 42);
      configMock.scriptJobEncryptionKey = 'replacement-content-script-job-key-that-is-longer-than-32-bytes';
      configMock.scriptJobPreviousEncryptionKeys = [` ${current} `];
      expect(decryptContentScriptJobJson(stored, 42)).toEqual({ topic: 'normalized-key' });
    } finally {
      configMock.scriptJobEncryptionKey = current;
      configMock.scriptJobPreviousEncryptionKeys = [];
    }
  });

  it('decrypts prior key versions while new writes use only the current key', () => {
    const oldKey = configMock.scriptJobEncryptionKey;
    const stored = encryptContentScriptJobJson({ topic: 'rotation-safe' }, 42);
    configMock.scriptJobEncryptionKey = 'replacement-content-script-job-key-that-is-longer-than-32-bytes';
    configMock.scriptJobPreviousEncryptionKeys = [oldKey];
    try {
      expect(decryptContentScriptJobJson(stored, 42)).toEqual({ topic: 'rotation-safe' });
      const newStored = encryptContentScriptJobJson({ topic: 'new-key' }, 42);
      expect(newStored).not.toEqual(stored);
      expect(decryptContentScriptJobJson(newStored, 42)).toEqual({ topic: 'new-key' });
    } finally {
      configMock.scriptJobEncryptionKey = oldKey;
      configMock.scriptJobPreviousEncryptionKeys = [];
    }
  });

  it('uses a configured previous key for export reads when the current key is absent', () => {
    const oldKey = configMock.scriptJobEncryptionKey;
    const stored = encryptContentScriptJobJson({ topic: 'previous-key-only' }, 42);
    configMock.scriptJobEncryptionKey = '';
    configMock.scriptJobPreviousEncryptionKeys = [oldKey];
    try {
      expect(decryptContentScriptJobJson(stored, 42)).toEqual({ topic: 'previous-key-only' });
    } finally {
      configMock.scriptJobEncryptionKey = oldKey;
      configMock.scriptJobPreviousEncryptionKeys = [];
    }
  });

  it('keeps predecessor v1 envelopes readable during key and payload migration', () => {
    const secret = configMock.scriptJobEncryptionKey;
    const legacyEnvelope = JSON.stringify({
      schema: 'nexus.content-script-job-encrypted.v1',
      keyVersion: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16),
      ciphertext: encryptValue(JSON.stringify({ topic: 'legacy-job' }), secret, 42),
    });

    expect(decryptContentScriptJobJson(legacyEnvelope, 42)).toEqual({ topic: 'legacy-job' });
  });

  it('hard-fails a predecessor schema mutation that reuses a configured legacy key identity', () => {
    const secret = configMock.scriptJobEncryptionKey;
    const envelope = {
      schema: 'nexus.content-script-job-encrypted.v2',
      keyVersion: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16),
      ciphertext: encryptValue(JSON.stringify({ topic: 'legacy-schema-mutation' }), secret, 42),
    };

    expect(() => decryptContentScriptJobJson(JSON.stringify(envelope), 42)).toThrow(
      expect.objectContaining({ code: 'CONTENT_SCRIPT_JOB_ENVELOPE_AUTHENTICATION_FAILED' }),
    );
  });

  it('returns a typed failure when retention outlives every configured key version', () => {
    const stored = encryptContentScriptJobJson({ topic: 'unavailable-key' }, 42);
    const current = configMock.scriptJobEncryptionKey;
    configMock.scriptJobEncryptionKey = 'unrelated-content-script-job-key-that-is-longer-than-32-bytes';
    try {
      try {
        decryptContentScriptJobJson(stored, 42);
        throw new Error('expected unavailable key failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ContentScriptJobEncryptionError);
        expect(error).toMatchObject({
          code: 'CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE',
          status: 503,
        });
      }
    } finally {
      configMock.scriptJobEncryptionKey = current;
    }
  });
});
