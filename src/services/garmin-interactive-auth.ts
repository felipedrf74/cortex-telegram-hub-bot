// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import axios, { type AxiosInstance } from 'axios';
import qs from 'qs';
import { GarminConnect } from 'garmin-connect';
import { logger } from '../utils/logger';

type GarminClient = InstanceType<typeof GarminConnect>;

export interface GarminInteractiveTokens {
  oauth1: unknown;
  oauth2: unknown;
}

export interface GarminInteractiveLoginResult {
  mfaRequired: boolean;
  connected: boolean;
  status: 'active' | 'mfa_pending';
  email: string;
  tokens?: GarminInteractiveTokens;
  verificationFlow?: {
    channel: 'email_code';
    verifyEndpoint: string;
    instructions: string[];
  };
}

export interface GarminInteractiveVerifyResult {
  email: string;
  tokens: GarminInteractiveTokens;
}

interface PendingGarminMfaChallenge {
  client: GarminClient;
  http: AxiosInstance;
  email: string;
  html: string;
  fallbackCsrf: string;
  submitUrl: string;
  origin: string;
  userAgent: string;
  expiresAt: number;
}

interface SsoClient {
  http: AxiosInstance;
}

const PENDING_MFA_TTL_MS = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const pendingChallenges = new Map<number, PendingGarminMfaChallenge>();

export class GarminInteractiveAuthError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'GarminInteractiveAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createSsoClient(): SsoClient {
  const cookieJar: Record<string, string> = {};
  const http = axios.create({
    maxRedirects: 5,
    validateStatus: () => true,
  });

  http.interceptors.response.use((response) => {
    const setCookieHeader = response.headers['set-cookie'];
    const setCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    for (const raw of setCookies) {
      const [cookiePair] = String(raw).split(';');
      const [name, ...valueParts] = cookiePair.split('=');
      if (name && valueParts.length > 0) {
        cookieJar[name.trim()] = valueParts.join('=').trim();
      }
    }
    return response;
  });

  http.interceptors.request.use((cfg) => {
    const cookies = Object.entries(cookieJar).map(([key, value]) => `${key}=${value}`).join('; ');
    if (cookies) {
      cfg.headers = cfg.headers ?? {};
      cfg.headers.Cookie = cookies;
    }
    return cfg;
  });

  return { http };
}

function htmlBody(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function checkForRateLimit(html: string, status?: number): void {
  if (status === 429 || /Error\s*1015|rate.?limit|banned.*temporarily/i.test(html)) {
    throw new GarminInteractiveAuthError(
      'GARMIN_RATE_LIMITED',
      'Garmin temporarily rate-limited login. Try again later.',
      429,
    );
  }
}

function firstMatch(pattern: RegExp, value: string): string | null {
  const match = pattern.exec(value);
  return match?.[1] ?? null;
}

function extractTicket(html: string, finalUrl?: string | null): string | null {
  return firstMatch(/ticket=([^"&\s]+)/, html) ?? (finalUrl ? firstMatch(/ticket=([^"&\s]+)/, finalUrl) : null);
}

function extractInputValue(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return firstMatch(new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']*)["']`, 'i'), html)
    ?? firstMatch(new RegExp(`value=["']([^"']*)["'][^>]*name=["']${escaped}["']`, 'i'), html);
}

function hasMfaChallenge(html: string, title: string | null, inputNames: string[]): boolean {
  const hasMfaInput = /name=["'](mfa-code|mfa.?code|verificationCode|verification-code|passcode|code)["']/i.test(html);
  const hasMfaUrl = /verifyMFA|verify-mfa|challengeMFA|enterMfa/i.test(html);
  const hasMfaTitle = /verify|mfa|two.?factor|security.?check|passcode|enter.*code/i.test(title ?? '');
  const isLoginPage = inputNames.includes('username') && inputNames.includes('password');
  return hasMfaInput || hasMfaUrl || hasMfaTitle || isLoginPage;
}

function extractInputNames(html: string): string[] {
  return [...html.matchAll(/<input[^>]+name=["']([^"']+)["']/g)].map((match) => match[1]);
}

function resolveActionUrl(action: string, fallback: string): string {
  if (!action) return fallback;
  if (action.startsWith('http')) return action;
  return new URL(action, 'https://sso.garmin.com').toString();
}

function extractHiddenInputs(html: string): Record<string, string> {
  const hiddenInputs: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]+type=["']hidden["'][^>]*>/gi)) {
    const input = match[0];
    const name = firstMatch(/name=["']([^"']+)["']/, input);
    if (!name) continue;
    hiddenInputs[name] = firstMatch(/value=["']([^"']*)["']/, input) ?? '';
  }
  return hiddenInputs;
}

async function completeLogin(client: GarminClient, ticket: string): Promise<GarminInteractiveTokens> {
  const httpClient = client.client as any;
  const oauth1 = await httpClient.getOauth1Token(ticket);
  await httpClient.exchange(oauth1);
  return {
    oauth1: httpClient.oauth1Token ?? null,
    oauth2: httpClient.oauth2Token ?? null,
  };
}

function requireValidTokens(tokens: GarminInteractiveTokens): GarminInteractiveTokens {
  if (!tokens.oauth1 || !tokens.oauth2) {
    throw new GarminInteractiveAuthError(
      'GARMIN_TOKEN_PERSISTENCE_FAILED',
      'Garmin login completed but did not return session tokens.',
      502,
    );
  }
  return tokens;
}

export async function startGarminInteractiveLogin(
  userId: number,
  email: string,
  password: string,
): Promise<GarminInteractiveLoginResult> {
  const normalizedEmail = email.toLowerCase();
  const client = new GarminConnect({ username: normalizedEmail, password });
  const httpClient = client.client as any;
  httpClient.oauth2Token = undefined;
  httpClient.oauth1Token = undefined;
  await httpClient.fetchOauthConsumer();

  const ssoEmbed = httpClient.url.GARMIN_SSO_EMBED;
  const signinUrl = httpClient.url.SIGNIN_URL;
  const ssoOrigin = httpClient.url.GARMIN_SSO_ORIGIN;
  const gcModern = httpClient.url.GC_MODERN;
  const { http } = createSsoClient();

  await http.get(`${ssoEmbed}?${qs.stringify({ clientId: 'GarminConnect', locale: 'en', service: gcModern })}`, {
    headers: { 'User-Agent': UA },
  });

  const signinPage = await http.get(`${signinUrl}?${qs.stringify({
    id: 'gauth-widget',
    embedWidget: true,
    locale: 'en',
    gauthHost: ssoEmbed,
  })}`, {
    headers: { 'User-Agent': UA },
  });
  const signinHtml = htmlBody(signinPage.data);
  const csrf = extractInputValue(signinHtml, '_csrf');
  if (!csrf) {
    throw new GarminInteractiveAuthError('GARMIN_LOGIN_FAILED', 'Garmin login page did not include a CSRF token.', 502);
  }

  const credentialSubmitUrl = `${signinUrl}?${qs.stringify({
    id: 'gauth-widget',
    embedWidget: true,
    clientId: 'GarminConnect',
    locale: 'en',
    gauthHost: ssoEmbed,
    service: ssoEmbed,
    source: ssoEmbed,
    redirectAfterAccountLoginUrl: ssoEmbed,
    redirectAfterAccountCreationUrl: ssoEmbed,
  })}`;

  const credentialResponse = await http.post(credentialSubmitUrl, qs.stringify({
    username: normalizedEmail,
    password,
    embed: 'true',
    _csrf: csrf,
  }), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Dnt: '1',
      Origin: ssoOrigin,
      Referer: signinUrl,
      'User-Agent': UA,
    },
  });

  const credentialHtml = htmlBody(credentialResponse.data);
  checkForRateLimit(credentialHtml, credentialResponse.status);
  const credentialFinalUrl: string = credentialResponse.request?.res?.responseUrl
    ?? credentialResponse.config?.url
    ?? credentialSubmitUrl;
  const ticket = extractTicket(credentialHtml, credentialFinalUrl);
  if (ticket) {
    logger.info({ userId }, 'Garmin interactive login completed without MFA');
    const tokens = requireValidTokens(await completeLogin(client, ticket));
    pendingChallenges.delete(userId);
    return {
      mfaRequired: false,
      connected: true,
      status: 'active',
      email: normalizedEmail,
      tokens,
    };
  }

  if (/account.*locked/i.test(credentialHtml)) {
    throw new GarminInteractiveAuthError('GARMIN_ACCOUNT_LOCKED', 'Garmin account is locked. Unlock it in Garmin first.', 423);
  }
  if (/incorrect|invalid.*password|wrong.*password|login.*failed/i.test(credentialHtml)) {
    throw new GarminInteractiveAuthError('AUTH_FAILED', 'Garmin rejected those credentials.', 401);
  }

  const inputNames = extractInputNames(credentialHtml);
  const title = firstMatch(/<title>([^<]*)<\/title>/i, credentialHtml);
  if (!hasMfaChallenge(credentialHtml, title, inputNames)) {
    throw new GarminInteractiveAuthError('GARMIN_LOGIN_FAILED', 'Garmin did not return a login ticket or MFA challenge.', 502);
  }

  pendingChallenges.set(userId, {
    client,
    http,
    email: normalizedEmail,
    html: credentialHtml,
    fallbackCsrf: csrf,
    submitUrl: credentialFinalUrl,
    origin: ssoOrigin,
    userAgent: UA,
    expiresAt: Date.now() + PENDING_MFA_TTL_MS,
  });

  logger.info({ userId }, 'Garmin interactive login requires MFA');
  return {
    mfaRequired: true,
    connected: false,
    status: 'mfa_pending',
    email: normalizedEmail,
    verificationFlow: {
      channel: 'email_code',
      verifyEndpoint: '/api/v1/garmin/verify',
      instructions: [
        'Check your email for the Garmin verification code.',
        'Enter the code in the Garmin reconnect screen to finish the connection.',
      ],
    },
  };
}

export async function verifyGarminInteractiveLogin(
  userId: number,
  code: string,
): Promise<GarminInteractiveVerifyResult> {
  const pending = pendingChallenges.get(userId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingChallenges.delete(userId);
    throw new GarminInteractiveAuthError(
      'NO_PENDING',
      'No pending Garmin login. Restart Garmin login to request a fresh code.',
      409,
    );
  }

  const action = firstMatch(/action=["']([^"']+)["']/i, pending.html);
  const submitUrl = resolveActionUrl(action ?? '', pending.submitUrl);
  const codeFieldName = firstMatch(/name=["'](mfa-code|mfa.?code|verificationCode|verification-code|passcode|code)["']/i, pending.html)
    ?? 'mfa-code';
  const hiddenInputs = extractHiddenInputs(pending.html);
  hiddenInputs._csrf = hiddenInputs._csrf ?? extractInputValue(pending.html, '_csrf') ?? pending.fallbackCsrf;

  const response = await pending.http.post(submitUrl, qs.stringify({
    ...hiddenInputs,
    [codeFieldName]: code,
  }), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Dnt: '1',
      Origin: pending.origin,
      Referer: submitUrl,
      'User-Agent': pending.userAgent,
    },
  });
  const body = htmlBody(response.data);
  checkForRateLimit(body, response.status);
  const finalUrl: string = response.request?.res?.responseUrl ?? response.config?.url ?? submitUrl;
  const ticket = extractTicket(body, finalUrl);
  if (!ticket) {
    throw new GarminInteractiveAuthError(
      'VERIFY_FAILED',
      response.status >= 400
        ? 'Garmin rejected the verification code or the challenge expired.'
        : 'Garmin verification did not return a session ticket.',
      400,
    );
  }

  const tokens = requireValidTokens(await completeLogin(pending.client, ticket));
  pendingChallenges.delete(userId);
  logger.info({ userId }, 'Garmin interactive MFA verification completed');
  return {
    email: pending.email,
    tokens,
  };
}

export function clearGarminInteractiveLoginForTests(userId?: number): void {
  if (typeof userId === 'number') {
    pendingChallenges.delete(userId);
    return;
  }
  pendingChallenges.clear();
}
