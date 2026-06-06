// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Google Drive Service — uploads content DOCX files to a shared Drive folder.
 *
 * Folder structure in Drive mirrors the local IDEAS structure:
 *   Nexus Hub IDEAS/
 *     ├── RESEARCH/
 *     ├── IDEAS/
 *     ├── SCRIPTS/
 *     ├── VISUALS/
 *     └── REPORTS/
 *
 * Uses `drive.file` scope — can only access files created by this app.
 *
 * Set GOOGLE_DRIVE_ENABLED=true (defaults to true when Google credentials exist)
 * Optionally set GOOGLE_DRIVE_ROOT_FOLDER_ID to skip the initial root-folder lookup.
 */

import fs from 'fs';
import { google, drive_v3 } from 'googleapis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';
import {
  buildGoogleOAuth2ClientForUser,
  isGoogleConfigured,
  registerGoogleClientReset,
} from './google-auth';
import { getOwnerBootstrapUserRefs } from './user-service';

// Drive operations are bounded to 30s — higher than Calendar because
// file uploads (backups, DOCX) can legitimately take longer than metadata
// queries. Folder lookups and list operations complete in <2s normally.
// Audit Month 2 #4.
const DRIVE_API_TIMEOUT_MS = 30_000;

const ROOT_FOLDER_NAME = 'Nexus Hub IDEAS';
const SUBFOLDERS = ['RESEARCH', 'IDEAS', 'SCRIPTS', 'VISUALS', 'REPORTS'] as const;

const driveClientsByUser = new Map<number, drive_v3.Drive>();

/** Cache: "userId/parentId/name" → Google Drive folder ID */
const folderIdCache = new Map<string, string>();

// Reset the cached Drive client when /connect google writes a fresh token.
// The folder ID cache is also dropped because folders are owned per-account
// — switching tokens without invalidating would point at the wrong folders.
registerGoogleClientReset(() => {
  driveClientsByUser.clear();
  folderIdCache.clear();
});

// ── Auth ────────────────────────────────────────────────────────────

function getOwnerDriveUserId(): number | null {
  return getOwnerBootstrapUserRefs()[0] ?? null;
}

function getDrive(userId: number): drive_v3.Drive {
  const cached = driveClientsByUser.get(userId);
  if (cached) return cached;
  const oauth2Client = buildGoogleOAuth2ClientForUser(userId);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  driveClientsByUser.set(userId, drive);
  return drive;
}

export function isGoogleDriveEnabled(userId?: number): boolean {
  const effectiveUserId = userId ?? getOwnerDriveUserId();
  return config.googleDrive.enabled
    && effectiveUserId != null
    && isGoogleConfigured(effectiveUserId);
}

// ── Folder helpers ──────────────────────────────────────────────────

/**
 * Find or create a folder by name under a parent folder.
 */
async function getOrCreateFolder(userId: number, name: string, parentId?: string): Promise<string> {
  const cacheKey = `${userId}/${parentId || 'root'}/${name}`;
  const cached = folderIdCache.get(cacheKey);
  if (cached) return cached;

  const drive = getDrive(userId);

  // Search for existing folder
  const query = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;

  const res = await withTimeout(
    drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' }),
    DRIVE_API_TIMEOUT_MS,
  );

  if (res.data.files && res.data.files.length > 0) {
    const id = res.data.files[0].id!;
    folderIdCache.set(cacheKey, id);
    return id;
  }

  // Create folder
  const createRes = await withTimeout(
    drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined,
      },
      fields: 'id',
    }),
    DRIVE_API_TIMEOUT_MS,
  );

  const id = createRes.data.id!;
  folderIdCache.set(cacheKey, id);
  logger.info({ folder: name, parentId, folderId: id }, 'Created Google Drive folder');
  return id;
}

/**
 * Resolve the root "Nexus Hub IDEAS" folder ID.
 * Uses GOOGLE_DRIVE_ROOT_FOLDER_ID env var when available to skip the API call.
 */
async function getRootFolderId(userId: number): Promise<string> {
  // Fast path: cached in env
  if (config.googleDrive.rootFolderId) {
    const envId = config.googleDrive.rootFolderId;
    folderIdCache.set(`${userId}/root/${ROOT_FOLDER_NAME}`, envId);
    return envId;
  }

  const id = await getOrCreateFolder(userId, ROOT_FOLDER_NAME);

  // Log the ID so the user can persist it
  logger.info(
    { rootFolderId: id },
    `Google Drive root folder resolved — set GOOGLE_DRIVE_ROOT_FOLDER_ID=${id} in .env to skip future lookups`,
  );

  return id;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Ensure the full folder tree exists in Drive:
 *   Nexus Hub IDEAS/ → RESEARCH, IDEAS, SCRIPTS, VISUALS, REPORTS
 *
 * Call once at startup (optional) to pre-warm the cache.
 */
export async function ensureDriveFolders(userId?: number): Promise<void> {
  const effectiveUserId = userId ?? getOwnerDriveUserId();
  if (effectiveUserId == null || !isGoogleDriveEnabled(effectiveUserId)) return;

  try {
    const rootId = await getRootFolderId(effectiveUserId);
    await Promise.all(SUBFOLDERS.map((sf) => getOrCreateFolder(effectiveUserId, sf, rootId)));
    logger.info({ userId: effectiveUserId }, 'Google Drive folder structure verified');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to verify Drive folder structure — uploads will retry lazily');
  }
}

/**
 * Upload a DOCX file to Google Drive under Nexus Hub IDEAS/<subfolder>/
 *
 * @param localPath  Absolute path to the local file
 * @param filename   The filename to use in Drive
 * @param subfolder  One of RESEARCH, IDEAS, SCRIPTS, VISUALS, REPORTS
 * @returns The Drive web-view URL, or null on failure / disabled
 */
export async function uploadToDrive(
  userId: number,
  localPath: string,
  filename: string,
  subfolder: string,
): Promise<string | null> {
  if (!isGoogleDriveEnabled(userId)) return null;

  try {
    const drive = getDrive(userId);

    // Ensure folder structure: Nexus Hub IDEAS/<subfolder>
    const rootId = await getRootFolderId(userId);
    const folderId = await getOrCreateFolder(userId, subfolder, rootId);

    // Upload file — uses a longer timeout because file uploads stream
    // and can legitimately take a while on large DOCX files.
    const res = await withTimeout(
      drive.files.create({
        requestBody: {
          name: filename,
          parents: [folderId],
        },
        media: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          body: fs.createReadStream(localPath),
        },
        fields: 'id, webViewLink',
      }),
      DRIVE_API_TIMEOUT_MS,
    );

    const fileId = res.data.id!;
    const webLink = res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    logger.info({ userId, filename, subfolder, fileId }, 'Uploaded to Google Drive');
    return webLink;
  } catch (err: any) {
    // Don't fail the whole flow if Drive upload fails — local file is the fallback
    logger.warn({ err: err.message, filename, subfolder }, 'Google Drive upload failed — file saved locally only');
    return null;
  }
}

// ── Backup upload (off-site disaster recovery) ──────────────────────

const BACKUP_FOLDER_NAME = 'Nexus Hub Backups';

/**
 * Upload a daily database backup tarball to Google Drive under a dedicated
 * top-level folder ("Nexus Hub Backups"). This is our off-site disaster
 * recovery path — the local VPS could be fully destroyed and we'd still
 * have the DB because Drive syncs are geo-replicated by Google.
 *
 * Design notes:
 *   - Lives in its own root folder (NOT under "Nexus Hub IDEAS") because
 *     backups have a different retention + access policy than content files.
 *     You probably want to share IDEAS with collaborators but never share
 *     backups.
 *   - Uses `application/gzip` mimetype so Drive treats it as a downloadable
 *     binary, not a compressible text blob.
 *   - Retention: keeps the most recent 30 files by default. The `retain`
 *     parameter lets the caller override. Older backups are moved to
 *     Drive's trash (not hard-deleted) so they're recoverable for 30 days
 *     via Google's own trash.
 *   - Authorization: goes through `getDrive()` → `buildGoogleOAuth2Client()`
 *     → oauth-store (post-P1 bridge). As soon as `/connect google` completes
 *     and populates a fresh refresh token, backups start uploading without
 *     any code change or restart.
 *
 * Returns the Drive file ID on success, or null if uploads are disabled,
 * Google auth is broken, or any other error. Never throws — the local
 * backup is the fallback.
 *
 * @param localPath  Absolute path to the backup tarball
 * @param filename   Filename to use in Drive (e.g. nexushub-backup-2026-04-08.tar.gz)
 * @param retain     How many most-recent backups to keep in Drive (default 30)
 */
export async function uploadBackupToDrive(
  userId: number,
  localPath: string,
  filename: string,
  retain = 30,
): Promise<string | null> {
  if (!isGoogleDriveEnabled(userId)) return null;
  if (!fs.existsSync(localPath)) {
    logger.warn({ localPath }, 'uploadBackupToDrive: local file not found');
    return null;
  }

  try {
    const drive = getDrive(userId);
    const backupFolderId = await getOrCreateFolder(userId, BACKUP_FOLDER_NAME);

    // Upload the tarball — backups are small (~3MB) but we give them a
    // generous timeout because network variance + re-auth can add latency.
    const res = await withTimeout(
      drive.files.create({
        requestBody: {
          name: filename,
          parents: [backupFolderId],
        },
        media: {
          mimeType: 'application/gzip',
          body: fs.createReadStream(localPath),
        },
        fields: 'id, webViewLink, size',
      }),
      DRIVE_API_TIMEOUT_MS,
    );

    const fileId = res.data.id!;
    const size = res.data.size ? Number(res.data.size) : null;
    logger.info(
      { filename, fileId, sizeBytes: size, webLink: res.data.webViewLink },
      'Backup uploaded to Google Drive',
    );

    // Retention: list all files in the backup folder, sort by createdTime
    // descending, trash anything beyond the `retain` window. Google's trash
    // holds files for 30 days so a bad retention decision is recoverable.
    try {
      const listRes = await withTimeout(
        drive.files.list({
          q: `'${backupFolderId}' in parents and trashed=false`,
          orderBy: 'createdTime desc',
          fields: 'files(id, name, createdTime)',
          pageSize: 100,
        }),
        DRIVE_API_TIMEOUT_MS,
      );
      const files = listRes.data.files || [];
      if (files.length > retain) {
        const toTrash = files.slice(retain);
        for (const f of toTrash) {
          try {
            await withTimeout(
              drive.files.update({ fileId: f.id!, requestBody: { trashed: true } }),
              DRIVE_API_TIMEOUT_MS,
            );
            logger.info({ filename: f.name, fileId: f.id }, 'Trashed old Drive backup (retention)');
          } catch (err: any) {
            logger.warn({ err: err.message, fileId: f.id }, 'Failed to trash old Drive backup');
          }
        }
      }
    } catch (err: any) {
      // Retention failure is non-fatal — the upload already succeeded.
      logger.warn({ err: err.message }, 'Drive backup retention pass failed (upload still OK)');
    }

    return fileId;
  } catch (err: any) {
    logger.warn(
      { err: err.message, filename },
      'Google Drive backup upload failed — local backup is still valid',
    );
    return null;
  }
}
