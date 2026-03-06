/**
 * Outlook OAuth2 Token Helper
 *
 * Usage:
 *   1. Fill in CLIENT_ID and CLIENT_SECRET below
 *   2. Run: npx ts-node scripts/get-outlook-token.ts
 *   3. Open the URL it prints in your browser
 *   4. Sign in with your Hotmail account
 *   5. You'll be redirected — copy the 'code' from the URL
 *   6. Paste it in the terminal
 *   7. It will print your REFRESH_TOKEN
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

// ─── Fill these in ───────────────────────────────────
const CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || 'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const TENANT_ID = process.env.OUTLOOK_TENANT_ID || 'consumers';
// ─────────────────────────────────────────────────────

const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
].join(' ');

const authUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?` +
  `client_id=${CLIENT_ID}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&response_mode=query`;

console.log('\n=== Outlook OAuth2 Token Helper ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in with your Hotmail/Outlook account');
console.log('3. After signing in, you\'ll be redirected to localhost:3000/callback');
console.log('   The server below will catch it automatically.\n');
console.log('Starting local server on http://localhost:3000 ...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:3000`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('Error:', error, url.searchParams.get('error_description'));
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
    const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      scope: SCOPES,
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
        console.log('SUCCESS! Add this to your .env file:');
        console.log('='.repeat(60));
        console.log(`\nOUTLOOK_REFRESH_TOKEN=${data.refresh_token}\n`);
        console.log('='.repeat(60));

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success!</h1><p>Refresh token printed in your terminal. You can close this tab.</p>');
      } else {
        console.error('Token exchange failed:', JSON.stringify(data, null, 2));
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

server.listen(3000, () => {
  console.log('Waiting for OAuth callback...');
});
