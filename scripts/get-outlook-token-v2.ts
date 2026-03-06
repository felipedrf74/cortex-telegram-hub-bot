/**
 * Outlook OAuth2 Token Helper — Device Code Flow
 *
 * This flow doesn't need redirect URIs and works reliably
 * with personal Microsoft accounts (Hotmail, Outlook.com).
 *
 * IMPORTANT: In Azure Portal → App Registration → Authentication:
 *   - Enable "Allow public client flows" → YES
 *
 * Usage:
 *   OUTLOOK_CLIENT_ID="your-id" npx ts-node scripts/get-outlook-token-v2.ts
 */

const CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || 'YOUR_CLIENT_ID';
const TENANT = 'consumers'; // personal Microsoft accounts

const SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Tasks.ReadWrite',
  'https://graph.microsoft.com/User.Read',
].join(' ');

async function main() {
  console.log('\n=== Outlook OAuth2 Token Helper (Device Code Flow) ===\n');

  // Step 1: Request device code
  const deviceCodeUrl = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
  const deviceRes = await fetch(deviceCodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPES,
    }).toString(),
  });

  const deviceData = await deviceRes.json() as any;

  if (deviceData.error) {
    console.error('Error:', deviceData.error);
    console.error('Description:', deviceData.error_description);
    console.error('\nMake sure:');
    console.error('  1. Your Client ID is correct');
    console.error('  2. App supports "Personal accounts only"');
    console.error('  3. In Azure → Authentication → "Allow public client flows" is YES');
    process.exit(1);
  }

  console.log('Go to:', deviceData.verification_uri);
  console.log('Enter code:', deviceData.user_code);
  console.log('\nWaiting for you to sign in...\n');

  // Step 2: Poll for token
  const tokenUrl = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
  const interval = (deviceData.interval || 5) * 1000;

  while (true) {
    await new Promise((r) => setTimeout(r, interval));

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceData.device_code,
      }).toString(),
    });

    const tokenData = await tokenRes.json() as any;

    if (tokenData.error === 'authorization_pending') {
      process.stdout.write('.');
      continue;
    }

    if (tokenData.error === 'slow_down') {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    if (tokenData.error) {
      console.error('\nError:', tokenData.error);
      console.error('Description:', tokenData.error_description);
      process.exit(1);
    }

    if (tokenData.refresh_token) {
      console.log('\n');
      console.log('='.repeat(60));
      console.log('SUCCESS! Add this to your .env file:');
      console.log('='.repeat(60));
      console.log(`\nOUTLOOK_REFRESH_TOKEN=${tokenData.refresh_token}`);
      console.log(`OUTLOOK_TENANT_ID=consumers\n`);
      console.log('='.repeat(60));
      process.exit(0);
    }
  }
}

main().catch(console.error);
