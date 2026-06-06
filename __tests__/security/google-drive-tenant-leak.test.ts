import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

const buildGoogleOAuth2ClientForUser = vi.fn((userId: number) => ({ userId }));
const isGoogleConfigured = vi.fn((userId?: number) => userId === 101 || userId === 202);
const filesList = vi.fn(async () => ({ data: { files: [{ id: 'folder_existing' }] } }));
const filesCreate = vi.fn(async () => ({ data: { id: 'file_created', webViewLink: 'https://drive.example/file_created' } }));

vi.mock('../../src/services/google-auth', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/google-auth')>(
    '../../src/services/google-auth',
  );
  return {
    ...actual,
    buildGoogleOAuth2ClientForUser,
    isGoogleConfigured,
    registerGoogleClientReset: vi.fn(),
  };
});

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  );
  return {
    ...actual,
    getOwnerBootstrapUserRefs: () => [101],
  };
});

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(() => ({
      files: {
        list: filesList,
        create: filesCreate,
      },
    })),
  },
}));

vi.mock('../../src/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/config')>('../../src/config');
  return {
    ...actual,
    config: {
      ...actual.config,
      googleDrive: { enabled: true, rootFolderId: 'root_folder' },
      google: { ...actual.config.google, clientId: 'google-client', clientSecret: 'google-secret' },
    },
  };
});

vi.mock('../../src/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger');
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe('Google Drive tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, 'createReadStream').mockImplementation(() => Readable.from(['fixture']) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the non-owner user OAuth client for uploads', async () => {
    const { uploadToDrive } = await import('../../src/services/google-drive');
    const tmpFile = path.join(os.tmpdir(), `nexus-drive-tenant-${Date.now()}.docx`);
    fs.writeFileSync(tmpFile, 'fixture');
    try {
      const url = await uploadToDrive(202, tmpFile, 'fixture.docx', 'REPORTS');

      expect(url).toBe('https://drive.example/file_created');
      expect(buildGoogleOAuth2ClientForUser).toHaveBeenCalledWith(202);
      expect(buildGoogleOAuth2ClientForUser).not.toHaveBeenCalledWith(101);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('does not fall back to owner OAuth when a non-owner user has no Google token', async () => {
    const { isGoogleDriveEnabled, uploadToDrive } = await import('../../src/services/google-drive');
    const tmpFile = path.join(os.tmpdir(), `nexus-drive-no-token-${Date.now()}.docx`);
    fs.writeFileSync(tmpFile, 'fixture');
    try {
      expect(isGoogleDriveEnabled(303)).toBe(false);
      await expect(uploadToDrive(303, tmpFile, 'fixture.docx', 'REPORTS')).resolves.toBeNull();
      expect(buildGoogleOAuth2ClientForUser).not.toHaveBeenCalledWith(303);
      expect(buildGoogleOAuth2ClientForUser).not.toHaveBeenCalledWith(101);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('preserves owner bootstrap behavior for explicit owner/system calls', async () => {
    const { ensureDriveFolders } = await import('../../src/services/google-drive');

    await ensureDriveFolders();

    expect(isGoogleConfigured).toHaveBeenCalledWith(101);
    expect(buildGoogleOAuth2ClientForUser).toHaveBeenCalledWith(101);
  });
});
