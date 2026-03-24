/**
 * Google OAuth2 Token Helper
 *
 * Usage:
 *   1. Go to https://console.cloud.google.com/apis/credentials
 *   2. Create OAuth 2.0 Client ID (type: Web application)
 *   3. Add http://localhost:3001/callback as Authorized redirect URI
 *   4. Enable these APIs in your project:
 *      - Google Calendar API
 *      - Gmail API
 *   5. Fill in CLIENT_ID and CLIENT_SECRET below (or set env vars)
 *   6. Run: npx ts-node scripts/get-google-token.ts
 *   7. Open the URL in your browser, sign in with your Google account
 *   8. The refresh token will be printed in your terminal
 */

import http from 'http';
import { URL } from 'url';

// ─── Fill these in ───────────────────────────────────
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
// ─────────────────────────────────────────────────────

const REDIRECT_URI = 'http://localhost:3001/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\n=== Google OAuth2 Token Helper ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in with your Google account');
console.log('3. Grant the requested permissions');
console.log('4. You\'ll be redirected — the server will catch it.\n');
console.log('Starting local server on http://localhost:3001 ...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:3001`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('Error:', error);
      res.writeHead(400);
      res.end('Error: ' + error);
      server.close();
      return;
    }

    if (!code) {
      res.writeHead(400);
      res.end('No code received');
      return;
    }

    console.log('Authorization code received! Exchanging for tokens...\n');

    // Exchange code for tokens
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();

    try {
      const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      const data = await tokenResponse.json() as any;

      if (data.refresh_token) {
        console.log('='.repeat(60));
        console.log('SUCCESS! Add these to your .env file:');
        console.log('='.repeat(60));
        console.log(`\nGOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
        console.log(`GOOGLE_CALENDAR_ID=primary\n`);
        console.log('='.repeat(60));

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success!</h1><p>Refresh token printed in your terminal. You can close this tab.</p>');
      } else {
        console.error('Token exchange failed:', JSON.stringify(data, null, 2));
        console.log('\nNote: If you don\'t see a refresh_token, make sure:');
        console.log('  - You included access_type=offline in the auth URL');
        console.log('  - You included prompt=consent');
        console.log('  - This is the first time authorizing (or you revoked previous access)');
        res.writeHead(400);
        res.end('Token exchange failed. Check terminal.');
      }
    } catch (err) {
      console.error('Request failed:', err);
      res.writeHead(500);
      res.end('Request failed');
    }

    setTimeout(() => server.close(), 1000);
  }
});

server.listen(3001, () => {
  console.log('Waiting for OAuth callback...');
});
