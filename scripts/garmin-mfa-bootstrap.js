#!/usr/bin/env node
/**
 * Garmin Connect MFA Bootstrap Script
 *
 * Handles the initial login with MFA, saves OAuth tokens for
 * garmin-connect package to reuse via refreshOauth2Token().
 *
 * Usage: cd ~/telegram-hub-bot && NODE_PATH=./node_modules node scripts/garmin-mfa-bootstrap.js
 */
require('dotenv').config();
const axios = require('axios');
const qs = require('qs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';
const GARMIN_SSO = 'https://sso.garmin.com/sso';
const GARMIN_SSO_EMBED = 'https://sso.garmin.com/sso/embed';
const GARMIN_SSO_ORIGIN = 'https://sso.garmin.com';
const SIGNIN_URL = `${GARMIN_SSO}/signin`;
const GC_MODERN = 'https://connect.garmin.com/modern';
const GC_API = 'https://connectapi.garmin.com';

const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TICKET_RE = /ticket=([^"]+)"/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// Manual cookie jar
let cookies = {};
function updateCookies(response) {
  const setCookies = response.headers['set-cookie'];
  if (setCookies) {
    for (const c of setCookies) {
      const [nameVal] = c.split(';');
      const [name, ...valParts] = nameVal.split('=');
      cookies[name.trim()] = valParts.join('=').trim();
    }
  }
}
function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function bootstrap() {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  const tokenPath = process.env.GARMIN_TOKEN_PATH || './data/garmin-tokens';

  if (!email || !password) {
    console.error('ERROR: Set GARMIN_EMAIL and GARMIN_PASSWORD in .env');
    process.exit(1);
  }

  console.log(`\n🏃 Garmin MFA Bootstrap for: ${email}\n`);

  // Default client follows redirects normally
  const client = axios.create({ maxRedirects: 10, validateStatus: s => s < 500 });
  // No-redirect client for step 3 to capture the 302
  const noRedirectClient = axios.create({ maxRedirects: 0, validateStatus: s => s < 500 });

  try {
    // Step 1: Get login page (sets session cookies)
    console.log('Step 1: Loading login page...');
    const step1Params = { clientId: 'GarminConnect', locale: 'en', service: GC_MODERN };
    const step1Res = await client.get(`${GARMIN_SSO_EMBED}?${qs.stringify(step1Params)}`, {
      headers: { 'User-Agent': UA }
    });
    updateCookies(step1Res);

    // Step 2: Get CSRF token
    console.log('Step 2: Getting CSRF token...');
    const step2Params = { id: 'gauth-widget', embedWidget: true, locale: 'en', gauthHost: GARMIN_SSO_EMBED };
    const step2Res = await client.get(`${SIGNIN_URL}?${qs.stringify(step2Params)}`, {
      headers: { 'User-Agent': UA, Cookie: cookieHeader() }
    });
    updateCookies(step2Res);
    const csrfMatch = CSRF_RE.exec(step2Res.data);
    if (!csrfMatch) throw new Error('CSRF token not found on login page');
    const csrf = csrfMatch[1];
    console.log('   CSRF obtained.');

    // Step 3: Submit credentials (use noRedirectClient to catch MFA 302)
    console.log('Step 3: Submitting credentials...');
    const step3Params = {
      id: 'gauth-widget', embedWidget: true, clientId: 'GarminConnect', locale: 'en',
      gauthHost: GARMIN_SSO_EMBED, service: GARMIN_SSO_EMBED,
      source: GARMIN_SSO_EMBED, redirectAfterAccountLoginUrl: GARMIN_SSO_EMBED,
      redirectAfterAccountCreationUrl: GARMIN_SSO_EMBED
    };
    const formBody = qs.stringify({ username: email, password, embed: 'true', _csrf: csrf });

    const step3Res = await noRedirectClient.post(`${SIGNIN_URL}?${qs.stringify(step3Params)}`, formBody, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Dnt: '1', Origin: GARMIN_SSO_ORIGIN, Referer: SIGNIN_URL,
        'User-Agent': UA, Cookie: cookieHeader()
      }
    });
    updateCookies(step3Res);

    // ── Branch A: Got a ticket directly (no MFA, no redirect) ──
    if (step3Res.status === 200) {
      const ticketMatch = TICKET_RE.exec(step3Res.data);
      if (ticketMatch) {
        console.log('   Login successful (no MFA).');
        await completeAuth(ticketMatch[1], tokenPath);
        return;
      }
    }

    // ── Branch B: 302 redirect → MFA challenge ──
    if (step3Res.status === 302) {
      const mfaPageUrl = step3Res.headers['location'];
      if (!mfaPageUrl) throw new Error('Got 302 but no Location header');

      console.log(`   302 → MFA redirect detected.`);
      console.log(`   MFA URL: ${mfaPageUrl.substring(0, 80)}...`);

      // Follow the redirect with GET to load the MFA page
      console.log('Step 3b: Loading MFA page...');
      const mfaPageRes = await client.get(mfaPageUrl, {
        headers: { 'User-Agent': UA, Cookie: cookieHeader(), Referer: SIGNIN_URL }
      });
      updateCookies(mfaPageRes);

      const mfaHtml = mfaPageRes.data;

      // Verify we're on the MFA page
      const isMFA = mfaHtml.includes('mfa-code') || mfaHtml.includes('verifyMFA') ||
                    mfaHtml.includes('verification') || mfaHtml.includes('verifyFactor');
      if (!isMFA) {
        // Maybe we got a ticket after the redirect?
        const ticketMatch = TICKET_RE.exec(mfaHtml);
        if (ticketMatch) {
          console.log('   Login successful (ticket in redirect page).');
          await completeAuth(ticketMatch[1], tokenPath);
          return;
        }
        console.error('ERROR: Redirect page is not MFA and has no ticket.');
        const titleMatch = /<title>([^<]*)<\/title>/.exec(mfaHtml);
        if (titleMatch) console.error('Page title:', titleMatch[1]);
        process.exit(1);
      }

      console.log('   📱 MFA challenge detected! Check your email for the code.\n');
      const code = await ask('Enter MFA code: ');

      // Extract CSRF from the MFA page (may differ from login CSRF)
      const mfaCsrfMatch = CSRF_RE.exec(mfaHtml);
      const mfaCsrf = mfaCsrfMatch ? mfaCsrfMatch[1] : csrf;

      // Step 4: Submit MFA code to the SAME verifyMFA URL (form has no action)
      console.log('\nStep 4: Submitting MFA code...');
      const mfaBody = qs.stringify({
        'mfa-code': code,
        embed: 'true',
        _csrf: mfaCsrf,
        fromPage: 'setupEnterMfaCode'
      });

      // POST to the MFA page URL (the form has no action attribute = posts to current URL)
      const mfaSubmitRes = await client.post(mfaPageUrl, mfaBody, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Dnt: '1', Origin: GARMIN_SSO_ORIGIN,
          Referer: mfaPageUrl,
          'User-Agent': UA, Cookie: cookieHeader()
        }
      });
      updateCookies(mfaSubmitRes);

      const mfaResultHtml = mfaSubmitRes.data;
      const mfaTicketMatch = TICKET_RE.exec(mfaResultHtml);

      if (!mfaTicketMatch) {
        const titleMatch = /<title>([^<]*)<\/title>/.exec(mfaResultHtml);
        console.error('\nERROR: MFA verification failed.');
        if (titleMatch) console.error('Page title:', titleMatch[1]);
        const errorMatch = /class="error"[^>]*>([^<]+)</g;
        let errM;
        while ((errM = errorMatch.exec(mfaResultHtml)) !== null) {
          if (errM[1].trim()) console.error('Error msg:', errM[1].trim());
        }
        // Also check for status-msg
        const statusMatch = /class="status-msg"[^>]*>([^<]+)</g;
        let stM;
        while ((stM = statusMatch.exec(mfaResultHtml)) !== null) {
          if (stM[1].trim()) console.error('Status msg:', stM[1].trim());
        }
        console.error('\nThe code may have expired. Run the script again for a new code.');
        process.exit(1);
      }

      console.log('   MFA verified successfully!');
      await completeAuth(mfaTicketMatch[1], tokenPath);
      return;
    }

    // ── Branch C: 200 response but no ticket, check for inline MFA ──
    if (step3Res.status === 200) {
      const html = step3Res.data;
      const isMFA = html.includes('verifyFactor') || html.includes('MFA') ||
                    html.includes('mfa-code') || html.includes('verifyMFA');
      if (isMFA) {
        // MFA was rendered inline (no redirect) — handle same as above but URL stays /signin
        console.log('   📱 MFA challenge detected (inline). Check your email for the code.\n');
        const code = await ask('Enter MFA code: ');
        const mfaCsrfMatch = CSRF_RE.exec(html);
        const mfaCsrf = mfaCsrfMatch ? mfaCsrfMatch[1] : csrf;

        console.log('\nStep 4: Submitting MFA code (inline)...');
        const mfaBody = qs.stringify({
          'mfa-code': code, embed: 'true', _csrf: mfaCsrf, fromPage: 'setupEnterMfaCode'
        });
        const mfaUrl = `${SIGNIN_URL}?${qs.stringify(step3Params)}`;
        const mfaRes = await client.post(mfaUrl, mfaBody, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Dnt: '1', Origin: GARMIN_SSO_ORIGIN, Referer: SIGNIN_URL,
            'User-Agent': UA, Cookie: cookieHeader()
          }
        });
        updateCookies(mfaRes);
        const mfaHtml = mfaRes.data;
        const mfaTicketMatch = TICKET_RE.exec(mfaHtml);
        if (!mfaTicketMatch) {
          console.error('ERROR: Inline MFA verification failed.');
          process.exit(1);
        }
        console.log('   MFA verified successfully!');
        await completeAuth(mfaTicketMatch[1], tokenPath);
        return;
      }

      // No MFA either
      console.error('ERROR: Login failed. No ticket and no MFA challenge detected.');
      const titleMatch = /<title>([^<]*)<\/title>/.exec(html);
      if (titleMatch) console.error('Page title:', titleMatch[1]);
      console.error('First 500 chars:', html.substring(0, 500));
      process.exit(1);
    }

    // ── Branch D: Unexpected status ──
    console.error(`ERROR: Unexpected step 3 status: ${step3Res.status}`);
    process.exit(1);

  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      if (err.response.headers && err.response.headers['location']) {
        console.error('Location:', err.response.headers['location']);
      }
    }
    process.exit(1);
  }
}

async function completeAuth(ticket, tokenPath) {
  console.log('Step 5: Exchanging ticket for OAuth1 token...');

  // Fetch OAuth consumer keys
  const consumerRes = await axios.get(OAUTH_CONSUMER_URL);
  const consumer = { key: consumerRes.data.consumer_key, secret: consumerRes.data.consumer_secret };

  // Set up OAuth1
  const OAuth = require('oauth-1.0a');
  const oauth = OAuth({
    consumer,
    signature_method: 'HMAC-SHA1',
    hash_function(base_string, key) {
      return crypto.createHmac('sha1', key).update(base_string).digest('base64');
    }
  });

  // garmin-connect package uses GET with params in URL (not POST)
  const oauth1Params = { ticket, 'login-url': `${GARMIN_SSO}/embed`, 'accepts-mfa-tokens': true };
  const oauth1Url = `${GC_API}/oauth-service/oauth/preauthorized?${qs.stringify(oauth1Params)}`;
  const oauthHeader = oauth.toHeader(oauth.authorize({ url: oauth1Url, method: 'GET' }, null));

  const oauth1Res = await axios.get(oauth1Url, {
    headers: { ...oauthHeader, 'User-Agent': 'com.garmin.android.apps.connectmobile' }
  });
  const oauth1Token = qs.parse(oauth1Res.data);
  console.log('   OAuth1 token obtained.');

  // OAuth2 exchange
  console.log('Step 6: Exchanging for OAuth2 token...');
  const oauth2Url = `${GC_API}/oauth-service/oauth/exchange/user/2.0`;
  const oauthHeader2 = oauth.toHeader(oauth.authorize(
    { url: oauth2Url, method: 'POST' },
    { key: oauth1Token.oauth_token, secret: oauth1Token.oauth_token_secret }
  ));
  const oauth2Res = await axios.post(oauth2Url, null, {
    headers: { ...oauthHeader2, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'com.garmin.android.apps.connectmobile' }
  });
  const oauth2Token = oauth2Res.data;
  console.log('   OAuth2 token obtained.');

  // Save tokens
  fs.mkdirSync(tokenPath, { recursive: true });
  // garmin-connect package expects oauth1_token.json and oauth2_token.json
  fs.writeFileSync(path.join(tokenPath, 'oauth1_token.json'), JSON.stringify(oauth1Token, null, 2));
  fs.writeFileSync(path.join(tokenPath, 'oauth2_token.json'), JSON.stringify(oauth2Token, null, 2));
  console.log(`\n✅ Tokens saved to ${tokenPath}/`);

  // Quick test
  console.log('\nStep 7: Verifying API access...');
  const testRes = await axios.get(`${GC_API}/userprofile-service/socialProfile`, {
    headers: { Authorization: `Bearer ${oauth2Token.access_token}` }
  });
  console.log(`   Profile: ${testRes.data.displayName || testRes.data.userName || 'OK'}`);
  console.log('\n🎉 Bootstrap complete! The bot can now use Garmin Connect.\n');
}

bootstrap().catch(err => { console.error('Fatal:', err); process.exit(1); });
