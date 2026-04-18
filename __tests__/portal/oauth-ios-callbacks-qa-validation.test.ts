import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

function readPortalServer(): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../../src/portal/server.ts'),
    'utf-8',
  );
}

function sectionBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find section between ${startMarker} and ${endMarker}`);
  }
  return source.slice(start, end);
}

describe('Portal iOS OAuth callback QA validation', () => {
  it('keeps the Google callback on the iOS nonce + custom scheme path', () => {
    const source = readPortalServer();
    const section = sectionBetween(
      source,
      "app.get('/oauth/google/callback'",
      "app.get('/oauth/outlook/callback'",
    );

    expect(section).toContain("isIOSState(state)");
    expect(section).toContain('parseIOSState(state)');
    expect(section).toContain('consumeNonce(parsed.nonce)');
    expect(section).toContain("nonceData.provider !== 'google'");
    expect(section).toContain("res.redirect(`me.nexushub.app://oauth/google?status=error");
    expect(section).toContain("res.redirect(`me.nexushub.app://oauth/google?status=success");
  });

  it('keeps the Outlook callback on the iOS nonce + custom scheme path', () => {
    const source = readPortalServer();
    const section = sectionBetween(
      source,
      "app.get('/oauth/outlook/callback'",
      "app.get('/oauth/strava/callback'",
    );

    expect(section).toContain("isIOSState(state)");
    expect(section).toContain('parseIOSState(state)');
    expect(section).toContain('consumeNonce(parsed.nonce)');
    expect(section).toContain("nonceData.provider !== 'outlook'");
    expect(section).toContain("res.redirect(`me.nexushub.app://oauth/outlook?status=error");
    expect(section).toContain("res.redirect(`me.nexushub.app://oauth/outlook?status=success");
  });

  it('keeps the Strava callback on the iOS nonce + custom scheme path', () => {
    const source = readPortalServer();
    const section = sectionBetween(
      source,
      "app.get('/oauth/strava/callback'",
      "app.get('/oauth/whoop/callback'",
    );

    expect(section).toContain("isIOSState(state)");
    expect(section).toContain('parseIOSState(state)');
    expect(section).toContain('consumeNonce(parsed.nonce)');
    expect(section).toContain("nonceData.provider !== 'strava'");
    expect(section).toContain("res.redirect('me.nexushub.app://oauth/strava?status=success')");
    expect(section).toContain("res.redirect(`me.nexushub.app://oauth/strava?status=error");
  });

  it('keeps the WHOOP callback on the iOS nonce + custom scheme path', () => {
    const source = readPortalServer();
    const section = sectionBetween(
      source,
      "app.get('/oauth/whoop/callback'",
      "app.get('/oauth/fitbit/callback'",
    );

    expect(section).toContain("isIOSState(state)");
    expect(section).toContain('parseIOSState(state)');
    expect(section).toContain('consumeNonce(parsed.nonce)');
    expect(section).toContain("nonceData.provider !== 'whoop'");
    expect(section).toContain("res.redirect('me.nexushub.app://oauth/whoop?status=success')");
    expect(section).toContain("res.redirect(`me.nexushub.app://oauth/whoop?status=error");
  });
});
