import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

function readPortalOAuthRoutes(): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../../src/portal/oauth-routes.ts'),
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
    const source = readPortalOAuthRoutes();
    const section = sectionBetween(
      source,
      "app.get('/oauth/google/callback'",
      "app.get('/oauth/outlook/callback'",
    );

    expect(source).toContain('services.isIOSState(state)');
    expect(source).toContain('services.parseIOSState(state)');
    expect(source).toContain('services.consumeNonce(parsed.nonce)');
    expect(source).toContain('nonceData.provider !== provider');
    expect(source).toContain('res.redirect(`me.nexushub.app://oauth/${provider}?status=${status}${suffix}`)');
    expect(section).toContain("handleIOSAwareOAuthCallback(\n        'google'");
    expect(section).toContain('resetGoogleClients');
  });

  it('keeps the Outlook callback on the iOS nonce + custom scheme path', () => {
    const source = readPortalOAuthRoutes();
    const section = sectionBetween(
      source,
      "app.get('/oauth/outlook/callback'",
      "app.get('/oauth/strava/callback'",
    );

    expect(source).toContain('services.isIOSState(state)');
    expect(source).toContain('services.parseIOSState(state)');
    expect(source).toContain('services.consumeNonce(parsed.nonce)');
    expect(source).toContain('nonceData.provider !== provider');
    expect(source).toContain('res.redirect(`me.nexushub.app://oauth/${provider}?status=${status}${suffix}`)');
    expect(section).toContain("handleIOSAwareOAuthCallback(\n      'outlook'");
    expect(section).toContain('resetMicrosoftClients');
  });

  it('keeps the Strava callback on the iOS nonce + custom scheme path', () => {
    const source = readPortalOAuthRoutes();
    const section = sectionBetween(
      source,
      "app.get('/oauth/strava/callback'",
      "app.get('/oauth/whoop/callback'",
    );

    expect(source).toContain('services.isIOSState(state)');
    expect(source).toContain('services.parseIOSState(state)');
    expect(source).toContain('services.consumeNonce(parsed.nonce)');
    expect(source).toContain('nonceData.provider !== provider');
    expect(source).toContain('res.redirect(`me.nexushub.app://oauth/${provider}?status=${status}${suffix}`)');
    expect(section).toContain("handleIOSAwareOAuthCallback('strava'");
  });

  it('keeps the WHOOP callback on the iOS nonce + custom scheme path', () => {
    const source = readPortalOAuthRoutes();
    const section = sectionBetween(
      source,
      "app.get('/oauth/whoop/callback'",
      "app.get('/oauth/fitbit/callback'",
    );

    expect(source).toContain('services.isIOSState(state)');
    expect(source).toContain('services.parseIOSState(state)');
    expect(source).toContain('services.consumeNonce(parsed.nonce)');
    expect(source).toContain('nonceData.provider !== provider');
    expect(source).toContain('res.redirect(`me.nexushub.app://oauth/${provider}?status=${status}${suffix}`)');
    expect(section).toContain("handleIOSAwareOAuthCallback('whoop'");
  });
});
