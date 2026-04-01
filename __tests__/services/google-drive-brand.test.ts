/**
 * Google Drive Brand Rename Tests
 *
 * Validates that 'Cortex IDEAS' has been renamed to 'Nexus Hub IDEAS'
 * throughout the Google Drive service.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const GOOGLE_DRIVE_PATH = path.resolve(__dirname, '../../src/services/google-drive.ts');

describe('Google Drive — brand rename (Cortex → Nexus Hub)', () => {
  const source = fs.readFileSync(GOOGLE_DRIVE_PATH, 'utf-8');

  it('should NOT contain "Cortex IDEAS" anywhere in the source', () => {
    const matches = source.match(/Cortex IDEAS/g);
    expect(matches).toBeNull();
  });

  it('should use "Nexus Hub IDEAS" as ROOT_FOLDER_NAME', () => {
    expect(source).toContain("const ROOT_FOLDER_NAME = 'Nexus Hub IDEAS'");
  });

  it('should reference "Nexus Hub IDEAS" in JSDoc comments', () => {
    // The file has several JSDoc comments mentioning the folder structure
    const nexusHubMentions = source.match(/Nexus Hub IDEAS/g);
    expect(nexusHubMentions).not.toBeNull();
    expect(nexusHubMentions!.length).toBeGreaterThanOrEqual(3);
  });
});
