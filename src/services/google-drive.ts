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
import { buildGoogleOAuth2Client, registerGoogleClientReset } from './google-auth';

const ROOT_FOLDER_NAME = 'Nexus Hub IDEAS';
const SUBFOLDERS = ['RESEARCH', 'IDEAS', 'SCRIPTS', 'VISUALS', 'REPORTS'] as const;

let driveClient: drive_v3.Drive | null = null;

/** Cache: "parentId/name" → Google Drive folder ID */
const folderIdCache = new Map<string, string>();

// Reset the cached Drive client when /connect google writes a fresh token.
// The folder ID cache is also dropped because folders are owned per-account
// — switching tokens without invalidating would point at the wrong folders.
registerGoogleClientReset(() => {
  driveClient = null;
  folderIdCache.clear();
});

// ── Auth ────────────────────────────────────────────────────────────

function getDrive(): drive_v3.Drive {
  if (driveClient) return driveClient;
  // Token resolution goes through oauth-store first (encrypted + audited),
  // env-var fallback for backward compat. See google-auth.ts.
  const oauth2Client = buildGoogleOAuth2Client();
  driveClient = google.drive({ version: 'v3', auth: oauth2Client });
  return driveClient;
}

export function isGoogleDriveEnabled(): boolean {
  return config.googleDrive.enabled
    && !!config.google.clientId
    && !!config.google.clientSecret
    && !!config.google.refreshToken;
}

// ── Folder helpers ──────────────────────────────────────────────────

/**
 * Find or create a folder by name under a parent folder.
 */
async function getOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const cacheKey = `${parentId || 'root'}/${name}`;
  const cached = folderIdCache.get(cacheKey);
  if (cached) return cached;

  const drive = getDrive();

  // Search for existing folder
  const query = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;

  const res = await drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' });

  if (res.data.files && res.data.files.length > 0) {
    const id = res.data.files[0].id!;
    folderIdCache.set(cacheKey, id);
    return id;
  }

  // Create folder
  const createRes = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id',
  });

  const id = createRes.data.id!;
  folderIdCache.set(cacheKey, id);
  logger.info({ folder: name, parentId, folderId: id }, 'Created Google Drive folder');
  return id;
}

/**
 * Resolve the root "Nexus Hub IDEAS" folder ID.
 * Uses GOOGLE_DRIVE_ROOT_FOLDER_ID env var when available to skip the API call.
 */
async function getRootFolderId(): Promise<string> {
  // Fast path: cached in env
  if (config.googleDrive.rootFolderId) {
    const envId = config.googleDrive.rootFolderId;
    folderIdCache.set(`root/${ROOT_FOLDER_NAME}`, envId);
    return envId;
  }

  const id = await getOrCreateFolder(ROOT_FOLDER_NAME);

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
export async function ensureDriveFolders(): Promise<void> {
  if (!isGoogleDriveEnabled()) return;

  try {
    const rootId = await getRootFolderId();
    await Promise.all(SUBFOLDERS.map((sf) => getOrCreateFolder(sf, rootId)));
    logger.info('Google Drive folder structure verified');
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
  localPath: string,
  filename: string,
  subfolder: string,
): Promise<string | null> {
  if (!isGoogleDriveEnabled()) return null;

  try {
    const drive = getDrive();

    // Ensure folder structure: Nexus Hub IDEAS/<subfolder>
    const rootId = await getRootFolderId();
    const folderId = await getOrCreateFolder(subfolder, rootId);

    // Upload file
    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
      },
      media: {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: fs.createReadStream(localPath),
      },
      fields: 'id, webViewLink',
    });

    const fileId = res.data.id!;
    const webLink = res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    logger.info({ filename, subfolder, fileId }, 'Uploaded to Google Drive');
    return webLink;
  } catch (err: any) {
    // Don't fail the whole flow if Drive upload fails — local file is the fallback
    logger.warn({ err: err.message, filename, subfolder }, 'Google Drive upload failed — file saved locally only');
    return null;
  }
}
