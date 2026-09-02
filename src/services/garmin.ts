// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Garmin Connect API client — wraps `garmin-connect` for auth,
 * extends with direct API calls for health/wellness endpoints.
 *
 * Uses DB-backed token persistence (OAuth1 + OAuth2 stored per user)
 * so passive reads can refresh-or-fail without depending on token files
 * or silently kicking off a full MFA login.
 *
 * MFA support: When Garmin requires a verification code, we detect the
 * MFA challenge HTML, ask the user via Telegram for the code, submit it
 * to complete the login, and persist the resulting tokens.
 */
import { GarminConnect } from 'garmin-connect';
import axios from 'axios';
import qs from 'qs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { now } from '../utils/date-parser';
import * as fs from 'fs';
import {
  clearGarminSession,
  getGarminSession,
  hasActiveGarminConnection,
  isOwnerGarminUserId,
  markGarminConnectionActive,
  markGarminNeedsReauth,
  migrateLegacyGarminTokensToSession,
  resolveGarminUserId,
  touchGarminConnection,
  upsertGarminSession,
} from './garmin-session-store';
import { getCurrentContext, runWithContext } from '../utils/request-context';

// Do not intercept the process-wide `console.error`: the garmin-connect SDK
// can include request or environment-derived details in its arguments. The
// bounded `safeGet` path below converts expected data-endpoint 404s to an
// empty result and emits only the sanitized URL path through the app logger.

// ─── Garmin Connect API base URLs ────────────────────────────────────
const API = 'https://connectapi.garmin.com';

const URLS = {
  // Daily wellness summaries
  userSummary: (date: string) => `${API}/usersummary-service/usersummary/daily/${date}`,
  sleepData: (date: string) => `${API}/sleep-service/sleep/dailySleepData?date=${date}`,
  stressSummary: (date: string) => `${API}/wellness-service/wellness/dailyStress/${date}`,
  heartRateSummary: (date: string) => `${API}/wellness-service/wellness/dailyHeartRate?date=${date}`,
  hrvData: (date: string) => `${API}/hrv-service/hrv/${date}`,
  trainingReadiness: (date: string) => `${API}/metrics-service/metrics/trainingreadiness/daily/${date}`,
  trainingStatus: (date: string) => `${API}/metrics-service/metrics/trainingstatus/aggregated/${date}`,
  bodyBatteryEvents: (date: string) => `${API}/wellness-service/wellness/bodyBattery/events/${date}`,
  rhr: (date: string) => `${API}/wellness-service/wellness/dailyHeartRate?date=${date}`,

  // Activities
  activitiesByDate: (start: string, end: string) =>
    `${API}/activitylist-service/activities/search/activities?startDate=${start}&endDate=${end}&limit=20`,
  activityDetails: (id: number) => `${API}/activity-service/activity/${id}`,
  activitySplits: (id: number) => `${API}/activity-service/activity/${id}/splits`,
  activityExerciseSets: (id: number) => `${API}/activity-service/activity/${id}/exerciseSets`,
  trainingEffect: (id: number) => `${API}/activity-service/activity/${id}`,

  // Tomorrow's plan
  scheduledWorkouts: (start: string, end: string) =>
    `${API}/workout-service/schedule/${start}/${end}`,
  trainingPlanWorkouts: (date: string) =>
    `${API}/workout-service/api/trainingplan/scheduled/${date}`,
  workoutDetail: (id: number) => `${API}/workout-service/workout/${id}`,

  // Trends
  weeklyStress: (date: string, weeks: number) =>
    `${API}/wellness-service/wellness/weeklyStress/${date}?numOfWeeks=${weeks}`,
  weeklyIntensityMinutes: (date: string, weeks: number) =>
    `${API}/wellness-service/wellness/dailyIntensityMinutes?calendarDate=${date}&numOfWeeks=${weeks}`,
  racePredictions: () => `${API}/metrics-service/metrics/racePredictions`,
  goals: (type: string) => `${API}/goal-service/goal/${type}`,
} as const;

// ─── Types ────────────────────────────────────────────────────────────

/** Raw daily summary from Garmin */
export interface GarminDailySummary {
  totalSteps?: number;
  totalDistanceMeters?: number;
  activeKilocalories?: number;
  totalKilocalories?: number;
  restingHeartRate?: number;
  maxHeartRate?: number;
  averageStressLevel?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  averageHeartRate?: number;
  minHeartRate?: number;
  [key: string]: unknown;
}

export interface GarminActivity {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string; parentTypeId?: number };
  startTimeLocal: string;
  duration: number;        // seconds
  distance?: number;       // meters
  averageHR?: number;
  maxHR?: number;
  calories?: number;
  averageRunningCadenceInStepsPerMinute?: number;
  averageSpeed?: number;   // m/s
  elevationGain?: number;
  [key: string]: unknown;
}

/** Pre-extracted body battery summary (derived from events endpoint) */
export interface BodyBatterySummary {
  current: number | null;
  highest: number | null;
  lowest: number | null;
  charged: number | null;   // from dailySummary if available
  drained: number | null;   // from dailySummary if available
}

export interface GarminCoachData {
  date: string;
  summary: GarminDailySummary | null;
  sleepSummary: Record<string, unknown> | null;
  stressSummary: Record<string, unknown> | null;
  heartRateSummary: Record<string, unknown> | null;
  hrvSummary: Record<string, unknown> | null;
  trainingReadiness: unknown;
  trainingStatus: unknown;
  bodyBatterySummary: BodyBatterySummary;
  activities: GarminActivity[];
  activityDetails: Map<number, unknown>;
  tomorrowWorkouts: unknown[];
  tomorrowTrainingPlan: unknown;
  weeklyStress: unknown;
  weeklyIntensityMinutes: unknown;
  errors: string[];
}

export interface GarminReadOptions {
  /**
   * When true, data reads may refresh/reload existing tokens but must never
   * start a credentials-based Garmin login. Use this for cron, release,
   * health, iOS, and report-generation paths where no one can answer MFA.
   */
  silent?: boolean;
}

// ─── MFA Support ─────────────────────────────────────────────────────

/**
 * Pending MFA state: when Garmin requires a verification code,
 * we store the state here so the user can provide the code via Telegram.
 */
interface MfaPendingState {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  expiresAt: number;
}

let _mfaPending: MfaPendingState | null = null;
let _mfaNotifier: ((message: string) => Promise<void>) | null = null;

// ─── SSO cookie persistence (avoids MFA on re-login) ────────────────
const GARMIN_TOKEN_PATH = config?.garmin?.tokenPath || './data/garmin-tokens';
const LEGACY_SSO_COOKIES_FILE = `${GARMIN_TOKEN_PATH}/sso_cookies.json`;
const LEGACY_RATE_LIMIT_FILE = `${GARMIN_TOKEN_PATH}/rate_limit_until.txt`;
const warnedLegacyGarminPersistence = new Set<string>();

function garminPersistenceUserId(): number {
  const contextUserId = getCurrentContext()?.userId;
  if (Number.isFinite(contextUserId) && Number(contextUserId) > 0) return Number(contextUserId);
  const resolved = resolveGarminUserId();
  return Number.isFinite(resolved) && Number(resolved) > 0 ? Number(resolved) : 0;
}

function garminUserTokenDir(userId = garminPersistenceUserId()): string {
  return userId > 0 ? `${GARMIN_TOKEN_PATH}/${userId}` : GARMIN_TOKEN_PATH;
}

function ssoCookiesFile(userId = garminPersistenceUserId()): string {
  return `${garminUserTokenDir(userId)}/sso_cookies.json`;
}

function rateLimitFile(userId = garminPersistenceUserId()): string {
  return `${garminUserTokenDir(userId)}/rate_limit.json`;
}

export function _garminPersistencePathsForTests(userId: number): { ssoCookies: string; rateLimit: string } {
  return {
    ssoCookies: ssoCookiesFile(userId),
    rateLimit: rateLimitFile(userId),
  };
}

export function _writeGarminDebugDumpForTests(kind: string, html: string): string | null {
  return writeGarminDebugDump(kind, html);
}

function warnLegacyGarminPersistenceOnce(kind: string, userId: number): void {
  const key = `${kind}:${userId || 'unknown'}`;
  if (warnedLegacyGarminPersistence.has(key)) return;
  warnedLegacyGarminPersistence.add(key);
  logger.warn({ kind, userId: userId || null }, 'Garmin: using legacy global persistence file; per-user migration needed');
}

function writeGarminDebugDump(kind: string, html: string): string | null {
  if (process.env.GARMIN_DEBUG_DUMP !== 'true') return null;
  try {
    const userId = garminPersistenceUserId();
    const dir = './data/private';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = `${dir}/garmin-debug-${userId || 'unknown'}-${Date.now()}-${kind}.html`;
    fs.writeFileSync(filePath, html, { mode: 0o600 });
    logger.warn({ filePath, userId: userId || null, kind }, 'Garmin: debug HTML dumped to private path');
    return filePath;
  } catch (err) {
    logger.warn({ err, kind }, 'Garmin: failed to write debug HTML dump');
    return null;
  }
}

function saveSsoCookies(cookieJar: Record<string, string>): void {
  try {
    const userId = garminPersistenceUserId();
    const dir = garminUserTokenDir(userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ssoCookiesFile(userId), JSON.stringify(cookieJar, null, 2));
    logger.info({ userId: userId || null }, 'Garmin: SSO cookies saved to per-user disk path');
  } catch (err) {
    logger.warn({ err }, 'Garmin: failed to save SSO cookies');
  }
}

function loadSsoCookies(): Record<string, string> | null {
  try {
    const userId = garminPersistenceUserId();
    const scopedFile = ssoCookiesFile(userId);
    const fileToRead = fs.existsSync(scopedFile)
      ? scopedFile
      : fs.existsSync(LEGACY_SSO_COOKIES_FILE)
        ? LEGACY_SSO_COOKIES_FILE
        : null;
    if (fileToRead) {
      if (fileToRead === LEGACY_SSO_COOKIES_FILE) warnLegacyGarminPersistenceOnce('sso_cookies', userId);
      const data = JSON.parse(fs.readFileSync(fileToRead, 'utf-8'));
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.info({ cookieCount: Object.keys(data).length }, 'Garmin: loaded saved SSO cookies');
        return data as Record<string, string>;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Garmin: failed to load SSO cookies');
  }
  return null;
}

// ─── Rate-limit backoff (persisted to disk to survive restarts) ──────
function _loadRateLimitedUntil(userId: number): number {
  try {
    const scopedFile = rateLimitFile(userId);
    // The legacy file holds a single process-wide deadline written before
    // backoff was per-user, so only the owner may inherit it. Reading it for
    // anyone lacking a scoped file recreates the shared bucket this is meant
    // to remove: after a deploy, every user's first read would hydrate from
    // that one file and inherit a deadline they never earned.
    const legacyReadable = isOwnerGarminUserId(userId) && fs.existsSync(LEGACY_RATE_LIMIT_FILE);
    const fileToRead = fs.existsSync(scopedFile)
      ? scopedFile
      : legacyReadable
        ? LEGACY_RATE_LIMIT_FILE
        : null;
    if (fileToRead) {
      if (fileToRead === LEGACY_RATE_LIMIT_FILE) warnLegacyGarminPersistenceOnce('rate_limit', userId);
      const raw = fs.readFileSync(fileToRead, 'utf-8').trim();
      const parsed = raw.startsWith('{') ? JSON.parse(raw).rateLimitedUntil : raw;
      const ts = parseInt(String(parsed), 10);
      if (!isNaN(ts) && ts > Date.now()) return ts;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Backoff deadlines keyed by user.
 *
 * Garmin rate-limits per ACCOUNT, not per IP, so one user tripping Cloudflare
 * must not stop every other user from syncing. This was previously a single
 * module-level scalar seeded at import time — before any request context
 * exists — which meant the process booted holding the owner's backoff and
 * applied it to everyone for two hours.
 *
 * Entries are lazily hydrated from that user's on-disk file on first read.
 */
const _rateLimitedUntilByUser = new Map<number, number>();

function rateLimitedUntilFor(userId: number): number {
  const cached = _rateLimitedUntilByUser.get(userId);
  if (cached !== undefined) return cached;
  const loaded = _loadRateLimitedUntil(userId);
  _rateLimitedUntilByUser.set(userId, loaded);
  return loaded;
}

function isRateLimited(userId = garminPersistenceUserId()): boolean {
  return Date.now() < rateLimitedUntilFor(userId);
}

function setRateLimited(durationMs = 2 * 60 * 60 * 1000, userId = garminPersistenceUserId()): void {
  const until = Date.now() + durationMs;
  _rateLimitedUntilByUser.set(userId, until);
  try {
    const dir = garminUserTokenDir(userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(rateLimitFile(userId), JSON.stringify({ rateLimitedUntil: until }));
  } catch { /* best-effort */ }
  logger.warn({ userId, backoffMinutes: durationMs / 60000, until: new Date(until).toISOString() }, 'Garmin: rate-limited by Cloudflare, backing off');
}

/** Test seam: drop cached backoff state so each case starts from disk. */
export function _resetGarminRateLimitCacheForTests(): void {
  _rateLimitedUntilByUser.clear();
}

/** Test seam: drive and observe per-user backoff without exporting the real helpers. */
export const _garminRateLimitForTests = {
  set: (userId: number, durationMs?: number) => setRateLimited(durationMs, userId),
  isLimited: (userId: number) => isRateLimited(userId),
};

/**
 * Test seam for the token-persistence tenant guard.
 *
 * `persistTokens` is private and normally reached through a data read, which
 * would need the whole SSO stack stood up. This exposes just enough to pin
 * the invariant: tokens from a client scoped to one user must never be
 * written under another user's id.
 */
export const _garminTokenPersistenceForTests = {
  /** Replace the pool with a single client, as the old singleton behaved. */
  setActiveClient: (client: unknown, userId: number | null) => {
    _clientPool.clear();
    if (client != null) {
      putPooledClient(userId, client as InstanceType<typeof GarminConnect>);
    }
  },
  /** Add a client without evicting others — how the pool is really used. */
  adoptClient: (client: unknown, userId: number | null) => {
    putPooledClient(userId, client as InstanceType<typeof GarminConnect>);
  },
  pooledUserIds: (): number[] => [..._clientPool.keys()].sort((a, b) => a - b),
  persist: (explicitUserId?: number) => persistTokens(explicitUserId),
};

function checkForRateLimit(html: string, status?: number): void {
  if (status === 429 || /Error\s*1015|rate.?limit|banned.*temporarily/i.test(html)) {
    setRateLimited();
    throw new Error('Garmin SSO rate-limited by Cloudflare — backing off 2 hours');
  }
}

/** Register a callback to notify the user when MFA is needed (called from bot.ts) */
export function setMfaNotifier(notifier: (message: string) => Promise<void>): void {
  _mfaNotifier = notifier;
}

/** Check if there's a pending MFA challenge */
export function isMfaPending(): boolean {
  return _mfaPending !== null && Date.now() < _mfaPending.expiresAt;
}

/**
 * Wait for an MFA code.
 *
 * Nothing resolves `_mfaPending`: the Telegram command handler this was built
 * for no longer exists, so this always rejects on timeout. The working
 * per-user path is `garmin-interactive-auth.ts`, driven by
 * `POST /api/v1/garmin/verify`. Kept only because `loginWithMfa` still calls
 * it; both are removed when the credential path is retired.
 */
function waitForMfaCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = 5 * 60 * 1000; // 5 minutes
    _mfaPending = { resolve, reject, expiresAt: Date.now() + timeoutMs };

    // Auto-reject after timeout
    setTimeout(() => {
      if (_mfaPending?.resolve === resolve) {
        _mfaPending = null;
        reject(new Error('MFA code timeout — no code provided within 5 minutes'));
      }
    }, timeoutMs);
  });
}

/**
 * Create a fresh axios instance with manual cookie handling for SSO flow.
 * The garmin-connect library's httpClient has no cookie jar and its request
 * interceptor adds stale Bearer tokens to SSO requests, breaking login.
 */
function createSsoClient(savedCookies?: Record<string, string>): {
  http: ReturnType<typeof axios.create>;
  getCookies: () => string;
  getCookieJar: () => Record<string, string>;
} {
  const cookieJar: Record<string, string> = savedCookies ? { ...savedCookies } : {};
  const http = axios.create({
    maxRedirects: 5,
    validateStatus: () => true, // Accept ALL statuses — we handle errors ourselves
  });

  // Response interceptor: collect Set-Cookie headers
  http.interceptors.response.use((response) => {
    const setCookies = response.headers['set-cookie'];
    if (setCookies) {
      for (const raw of setCookies) {
        const parts = raw.split(';')[0].split('=');
        if (parts.length >= 2) {
          cookieJar[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
      }
    }
    return response;
  });

  // Request interceptor: send collected cookies
  http.interceptors.request.use((cfg) => {
    const cookies = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) cfg.headers.Cookie = cookies;
    return cfg;
  });

  return {
    http,
    getCookies: () => Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; '),
    getCookieJar: () => ({ ...cookieJar }),
  };
}

/**
 * Custom MFA-aware login flow.
 * Uses a FRESH axios instance with cookie handling (not the library's httpClient)
 * to avoid stale Bearer tokens and missing cookies that break the SSO flow.
 * After getting the ticket, hands off to the library's OAuth1/OAuth2 exchange.
 */
async function loginWithMfa(client: InstanceType<typeof GarminConnect>): Promise<void> {
  const loginUserId = garminPersistenceUserId();
  if (isRateLimited(loginUserId)) {
    throw new Error(`Garmin SSO rate-limited — retry after ${new Date(rateLimitedUntilFor(loginUserId)).toISOString()}`);
  }

  const httpClient = client.client as any;

  // Clear stale tokens that would interfere with the library's OAuth exchange
  httpClient.oauth2Token = undefined;
  httpClient.oauth1Token = undefined;

  // Step 1: Fetch OAuth consumer credentials (needed for post-ticket OAuth1 exchange)
  await httpClient.fetchOauthConsumer();

  const SSO_EMBED = httpClient.url.GARMIN_SSO_EMBED;
  const SIGNIN_URL = httpClient.url.SIGNIN_URL;
  const SSO_ORIGIN = httpClient.url.GARMIN_SSO_ORIGIN;
  const GC_MODERN = httpClient.url.GC_MODERN;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  // Create HTTP client with cookie handling — reuse saved SSO cookies if available
  // (Garmin recognizes trusted sessions by cookie, skipping MFA)
  const savedCookies = loadSsoCookies();
  const { http, getCookieJar } = createSsoClient(savedCookies ?? undefined);

  // Step 2: Get SSO page + CSRF token (two requests to establish session cookies)
  const step1Params = { clientId: 'GarminConnect', locale: 'en', service: GC_MODERN };
  await http.get(`${SSO_EMBED}?${qs.stringify(step1Params)}`, {
    headers: { 'User-Agent': UA },
  });

  const step2Params = { id: 'gauth-widget', embedWidget: true, locale: 'en', gauthHost: SSO_EMBED };
  const step2Res = await http.get(`${SIGNIN_URL}?${qs.stringify(step2Params)}`, {
    headers: { 'User-Agent': UA },
  });
  const step2Html = typeof step2Res.data === 'string' ? step2Res.data : String(step2Res.data);
  const csrfMatch = /name="_csrf"\s+value="(.+?)"/.exec(step2Html);
  if (!csrfMatch) throw new Error('Garmin MFA login: CSRF token not found');
  const csrf = csrfMatch[1];
  logger.info('Garmin MFA: CSRF token obtained');

  // Step 3: Submit credentials
  const signinParams = {
    id: 'gauth-widget', embedWidget: true, clientId: 'GarminConnect',
    locale: 'en', gauthHost: SSO_EMBED, service: SSO_EMBED,
    source: SSO_EMBED, redirectAfterAccountLoginUrl: SSO_EMBED,
    redirectAfterAccountCreationUrl: SSO_EMBED,
  };
  const step3Url = `${SIGNIN_URL}?${qs.stringify(signinParams)}`;
  const formBody = qs.stringify({
    username: config.garmin.email,
    password: config.garmin.password,
    embed: 'true',
    _csrf: csrf,
  });

  const step3Res = await http.post(step3Url, formBody, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Dnt: '1',
      Origin: SSO_ORIGIN,
      Referer: SIGNIN_URL,
      'User-Agent': UA,
    },
  });
  const step3Html = typeof step3Res.data === 'string' ? step3Res.data : String(step3Res.data);

  // Check for Cloudflare rate limiting
  checkForRateLimit(step3Html, step3Res.status);

  // Capture the final URL after any redirects (for MFA form submission)
  const step3FinalUrl: string = step3Res.request?.res?.responseUrl ?? step3Res.config?.url ?? step3Url;

  logger.info({ step3Status: step3Res.status, step3FinalUrl, step3OrigUrl: step3Url }, 'Garmin MFA: step3 response status');

  // Check if we got the ticket directly (no MFA)
  let ticketMatch = /ticket=([^"]+)"/.exec(step3Html);
  if (ticketMatch) {
    logger.info('Garmin MFA: got ticket directly (no MFA needed)');
    saveSsoCookies(getCookieJar());
    await finishLogin(httpClient, ticketMatch[1]);
    return;
  }

  // Log response details for debugging
  const formActions = [...step3Html.matchAll(/action="([^"]+)"/g)].map(m => m[1]);
  const inputNames = [...step3Html.matchAll(/<input[^>]+name="([^"]+)"/g)].map(m => m[1]);
  const titleMatch = /<title>([^<]*)<\/title>/.exec(step3Html);
  logger.info({
    htmlLength: step3Html.length,
    title: titleMatch?.[1] || 'unknown',
    formActions,
    inputNames: inputNames.slice(0, 15),
    hasTicket: false,
  }, 'Garmin MFA: step3 response analysis');

  // Check for error conditions
  if (/account.*locked/i.test(step3Html)) {
    throw new Error('Garmin account is locked — unlock via connect.garmin.com');
  }
  if (/incorrect|invalid.*password|wrong.*password|login.*failed/i.test(step3Html)) {
    throw new Error('Garmin login failed — incorrect credentials');
  }

  // Detect MFA challenge: look for specific MFA form elements
  // Garmin MFA pages have forms with mfa-code/verificationCode/passcode inputs
  const hasMfaInput = /name="(mfa-code|mfa.?code|verificationCode|verification-code|passcode|code)"/i.test(step3Html);
  const hasMfaUrl = /verifyMFA|verify-mfa|challengeMFA|enterMfa/i.test(step3Html);
  const hasMfaTitle = /verify|mfa|two.?factor|security.?check|passcode|enter.*code/i.test(titleMatch?.[1] ?? '');

  // If no explicit MFA form found, check if this is the login page being re-shown
  // (which happens when credentials are accepted but MFA is needed, and the MFA
  // page is loaded via client-side redirect that our server-side flow doesn't follow)
  const isLoginPage = inputNames.includes('username') && inputNames.includes('password');

  if (!hasMfaInput && !hasMfaUrl && !hasMfaTitle) {
    if (isLoginPage) {
      // The login page was returned — credentials may have been accepted but MFA
      // challenge is triggered server-side. Try hitting the MFA endpoint directly.
      logger.info('Garmin MFA: login page re-shown, probing MFA endpoint directly');
    } else {
      // Save HTML for debugging
      writeGarminDebugDump('step3', step3Html);
      throw new Error('Garmin login failed — no ticket and no MFA challenge detected');
    }
  }

  logger.info({ hasMfaInput, hasMfaUrl, hasMfaTitle, isLoginPage }, 'Garmin MFA: challenge detected, requesting code from user');

  // Notify user via Telegram
  if (_mfaNotifier) {
    await _mfaNotifier(
      '🔐 <b>Garmin MFA Required</b>\n\n' +
      'Garmin is asking for a verification code.\n' +
      'Check your email for the code and reply with:\n\n' +
      '<code>/garminmfa 123456</code>\n\n' +
      '<i>You have 5 minutes to respond.</i>'
    );
  }

  // Wait for user to provide the code
  const mfaCode = await waitForMfaCode();
  logger.info('Garmin MFA: code received, submitting');

  // Determine MFA submission URL and field name from the page
  let mfaSubmitUrl: string;
  let codeFieldName: string;
  const mfaCsrfMatch = /name="_csrf"\s+value="(.+?)"/.exec(step3Html);
  const mfaCsrf = mfaCsrfMatch ? mfaCsrfMatch[1] : csrf;

  if (hasMfaInput || hasMfaUrl || hasMfaTitle) {
    // Extract form action from MFA page
    const actionMatch = /action="([^"]+)"/i.exec(step3Html);
    if (actionMatch) {
      const action = actionMatch[1];
      mfaSubmitUrl = action.startsWith('http') ? action : `https://sso.garmin.com${action}`;
    } else {
      // No action attribute = form submits to the current URL (after redirects)
      // This is the actual Garmin MFA behavior — the form POSTs back to the same page
      mfaSubmitUrl = step3FinalUrl;
    }
    // Extract code field name dynamically — Garmin uses "mfa-code" currently
    const codeMatch = /name="(mfa-code|mfa.?code|verificationCode|verification-code|passcode|code)"/i.exec(step3Html);
    codeFieldName = codeMatch ? codeMatch[1] : 'mfa-code';
  } else {
    // Login page re-shown — probe the known MFA endpoint
    mfaSubmitUrl = step3FinalUrl;
    codeFieldName = 'mfa-code';
  }

  // Extract all hidden input values from the MFA form to include in submission
  const hiddenInputs: Record<string, string> = {};
  const hiddenMatches = step3Html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi);
  for (const match of hiddenMatches) {
    const nameM = /name="([^"]+)"/.exec(match[0]);
    const valueM = /value="([^"]*)"/.exec(match[0]);
    if (nameM) hiddenInputs[nameM[1]] = valueM?.[1] ?? '';
  }

  logger.info({ mfaSubmitUrl, codeFieldName, hiddenInputs }, 'Garmin MFA: submitting code');

  const mfaBody = qs.stringify({
    ...hiddenInputs,       // include embed, _csrf, fromPage from the form
    [codeFieldName]: mfaCode,
  });

  const mfaRes = await http.post(mfaSubmitUrl, mfaBody, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Dnt: '1',
      Origin: SSO_ORIGIN,
      Referer: mfaSubmitUrl,
      'User-Agent': UA,
    },
  });
  const mfaHtml = typeof mfaRes.data === 'string' ? mfaRes.data : String(mfaRes.data);
  checkForRateLimit(mfaHtml, mfaRes.status);
  const mfaFinalUrl: string = mfaRes.request?.res?.responseUrl ?? mfaRes.config?.url ?? mfaSubmitUrl;
  logger.info({
    mfaStatus: mfaRes.status,
    mfaHtmlLength: mfaHtml.length,
    mfaFinalUrl,
    hasTicket: /ticket=/.test(mfaHtml),
    mfaFormActions: [...mfaHtml.matchAll(/action="([^"]+)"/g)].map(m => m[1]).slice(0, 5),
    mfaTitle: (/<title>([^<]*)<\/title>/.exec(mfaHtml))?.[1] || 'unknown',
    mfaInputNames: [...mfaHtml.matchAll(/<input[^>]+name="([^"]+)"/g)].map(m => m[1]).slice(0, 10),
  }, 'Garmin MFA: code submission response');

  // Check for ticket in the response (could be in HTML or a redirect URL)
  ticketMatch = /ticket=([^"&\s]+)/.exec(mfaHtml);

  // Also check if the final URL contains a ticket (Garmin may redirect with ticket in URL)
  if (!ticketMatch && mfaFinalUrl) {
    ticketMatch = /ticket=([^"&\s]+)/.exec(mfaFinalUrl);
  }

  if (!ticketMatch) {
    // Save for debugging
    writeGarminDebugDump('mfa', mfaHtml);
    const errDetail = mfaRes.status >= 400
      ? `HTTP ${mfaRes.status} — code may be wrong or session expired`
      : 'no ticket in response';
    throw new Error(`Garmin MFA failed — ${errDetail}`);
  }

  const ticket = ticketMatch[1];
  logger.info('Garmin MFA: ticket obtained after MFA verification');
  saveSsoCookies(getCookieJar());
  await finishLogin(httpClient, ticket);
}

/**
 * Complete the OAuth flow after getting the login ticket.
 * Mirrors the garmin-connect library's post-ticket flow.
 */
async function finishLogin(httpClient: any, ticket: string): Promise<void> {
  const oauth1 = await httpClient.getOauth1Token(ticket);
  await httpClient.exchange(oauth1);
  logger.info('Garmin: MFA login completed, OAuth tokens obtained');
}

// ─── Per-user client pool ─────────────────────────────────────────────
//
// This was a single process-wide `_client` plus an `_activeClientUserId`
// marker. Serving a second user meant tearing the authenticated client down
// and rebuilding it, so any interleaving of users thrashed — and the
// keep-alive fan-out interleaves by construction, one full teardown per user
// per tick. It also made `persistTokens` responsible for noticing that the
// live client belonged to somebody else, which is the cross-tenant write the
// tenant guard exists to catch. Keying clients by user makes that structural:
// you look up the client for a user, so it cannot be another user's.

interface PooledGarminClient {
  client: InstanceType<typeof GarminConnect>;
  lastUsedAt: number;
}

/** Legacy owner-credential path, which has no user in scope. */
const UNSCOPED_CLIENT_KEY = 0;
const CLIENT_POOL_MAX = 16;
const CLIENT_POOL_IDLE_MS = 30 * 60 * 1000;

const _clientPool = new Map<number, PooledGarminClient>();
/** In-flight bootstraps, per user. Two users no longer serialise on each other. */
const _clientBootstraps = new Map<number, Promise<InstanceType<typeof GarminConnect>>>();

function clientPoolKey(userId: number | null | undefined): number {
  return userId && userId > 0 ? userId : UNSCOPED_CLIENT_KEY;
}

function getPooledClient(userId: number | null): InstanceType<typeof GarminConnect> | null {
  const key = clientPoolKey(userId);
  const entry = _clientPool.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastUsedAt > CLIENT_POOL_IDLE_MS) {
    _clientPool.delete(key);
    return null;
  }
  entry.lastUsedAt = Date.now();
  return entry.client;
}

function putPooledClient(userId: number | null, client: InstanceType<typeof GarminConnect>): void {
  _clientPool.set(clientPoolKey(userId), { client, lastUsedAt: Date.now() });
  // Bound the pool so a large user base cannot grow it without limit; the
  // coldest entry simply re-hydrates from its stored session next time.
  while (_clientPool.size > CLIENT_POOL_MAX) {
    let coldestKey: number | null = null;
    let coldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of _clientPool) {
      if (entry.lastUsedAt < coldestAt) {
        coldestAt = entry.lastUsedAt;
        coldestKey = key;
      }
    }
    if (coldestKey === null) break;
    _clientPool.delete(coldestKey);
  }
}

/** Test seam: drop pooled clients so each case starts cold. */
export function _resetGarminClientPoolForTests(): void {
  _clientPool.clear();
  _clientBootstraps.clear();
}

/**
 * Silent mode flag — when true, getClient() will NOT trigger MFA
 * login if tokens are expired. Set by iOS API middleware before
 * calling Garmin functions, reset after the call completes.
 *
 * This avoids MFA email floods from iOS app background requests.
 * Telegram bot commands leave this false so MFA works interactively.
 */
let _silentMode = false;
export function setSilentMode(silent: boolean): void { _silentMode = silent; }

function createGarminClient(): InstanceType<typeof GarminConnect> {
  return new GarminConnect({
    username: config.garmin.email,
    password: config.garmin.password,
  });
}

function adoptAuthenticatedClient(
  client: InstanceType<typeof GarminConnect>,
  userId?: number | null,
): InstanceType<typeof GarminConnect> {
  putPooledClient(userId ?? null, client);
  if (userId) {
    touchGarminConnection(userId);
  }
  return client;
}

async function hydrateClientFromPersistedSession(
  userId: number | null,
  opts: { allowLegacyFile?: boolean } = {},
): Promise<InstanceType<typeof GarminConnect> | null> {
  const allowLegacyFile = opts.allowLegacyFile ?? true;
  const client = createGarminClient();
  const tokenDir = GARMIN_TOKEN_PATH;

  if (userId) {
    const dbSession = getGarminSession(userId);
    if (dbSession?.oauth1TokenJson && dbSession?.oauth2TokenJson) {
      try {
        client.loadToken(
          JSON.parse(dbSession.oauth1TokenJson),
          JSON.parse(dbSession.oauth2TokenJson),
        );
        await client.getUserSettings();
        logger.info({ userId }, 'Garmin: loaded tokens from garmin_sessions');
        return adoptAuthenticatedClient(client, userId);
      } catch (dbErr) {
        logger.warn({ dbErr, userId }, 'Garmin: garmin_sessions tokens expired or invalid');
      }
    }

    if (migrateLegacyGarminTokensToSession(userId)) {
      const migrated = getGarminSession(userId);
      if (migrated?.oauth1TokenJson && migrated?.oauth2TokenJson) {
        try {
          client.loadToken(
            JSON.parse(migrated.oauth1TokenJson),
            JSON.parse(migrated.oauth2TokenJson),
          );
          await client.getUserSettings();
          logger.info({ userId }, 'Garmin: migrated legacy DB token blob into garmin_sessions');
          return adoptAuthenticatedClient(client, userId);
        } catch (legacyErr) {
          logger.warn({ legacyErr, userId }, 'Garmin: migrated legacy DB tokens were invalid');
        }
      }
    }
  }

  const isOwnerRequest = isOwnerGarminUserId(userId);
  if (allowLegacyFile && isOwnerRequest && userId) {
    try {
      if (fs.existsSync(`${tokenDir}/oauth1_token.json`) && fs.existsSync(`${tokenDir}/oauth2_token.json`)) {
        client.loadTokenByFile(tokenDir);
        await client.getUserSettings();
        persistTokens(userId);
        markGarminConnectionActive(userId, config.garmin.email);
        logger.info({ userId }, 'Garmin: imported legacy filesystem tokens into garmin_sessions for owner only');
        return adoptAuthenticatedClient(client, userId);
      }
    } catch (err) {
      logger.warn({ err, userId }, 'Garmin: legacy filesystem tokens expired or invalid');
    }
  } else if (allowLegacyFile && userId) {
    logger.warn({ userId }, 'Garmin: skipped legacy filesystem token fallback for non-owner user');
  }

  return null;
}

/**
 * Whether the OWNER-ONLY global credential fallback is available.
 *
 * This is deployment configuration, not user state. Use it only to gate the
 * legacy credential/SSO path. It must never gate a per-user read: a user who
 * completed the interactive login has their own session in `garmin_sessions`
 * and does not depend on these env vars existing.
 */
export function isGarminConfigured(): boolean {
  return !!(config.garmin.email && config.garmin.password);
}

/**
 * Whether THIS user can read Garmin data — pure per-user truth.
 *
 * Previously this also required the global `GARMIN_EMAIL`/`GARMIN_PASSWORD`,
 * which meant an unset deployment credential disabled Garmin for every user,
 * including those who had connected their own account through
 * POST /api/v1/garmin/login. Mirrors `WhoopAdapter.isConfigured`, which is
 * likewise per-user connection state with no global env gate.
 */
export function isGarminConfiguredForUser(userId: number): boolean {
  return hasActiveGarminConnection(userId);
}

/**
 * Get an authenticated Garmin Connect client.
 * First tries to load persisted tokens; if expired or missing, does a fresh login.
 *
 * Concurrency: callers awaiting a cold client for the SAME user share one
 * bootstrap, so a 10-wide iOS dashboard fan-out produces one credential POST
 * and one MFA email rather than ten. Callers for different users proceed in
 * parallel — see the client pool above.
 */
/**
 * @param opts.silent  When true, return null instead of triggering MFA
 *                     login if saved tokens are expired. Used by iOS API
 *                     endpoints where no interactive user is present to
 *                     enter an MFA code. Default: false (Telegram bot
 *                     commands still get the full MFA flow).
 */
async function getClient(opts?: { silent?: boolean }): Promise<InstanceType<typeof GarminConnect>> {
  const silent = opts?.silent ?? getCurrentContext()?.garminSilent ?? _silentMode;
  const sessionUserId = resolveGarminUserId();

  const poolKey = clientPoolKey(sessionUserId);

  // Fast path — this user already has an authenticated client
  const pooled = getPooledClient(sessionUserId);
  if (pooled) {
    return pooled;
  }

  // Serialised path — one bootstrap per user. Concurrent callers for the SAME
  // user share it (the original reason this guard exists: a 10-wide iOS
  // dashboard fan-out would otherwise fire ten credential POSTs and ten MFA
  // emails). Callers for OTHER users no longer queue behind it.
  const inFlight = _clientBootstraps.get(poolKey);
  if (inFlight) {
    logger.debug({ userId: sessionUserId }, 'Garmin: bootstrap in progress, awaiting shared promise');
    return inFlight;
  }

  const bootstrap = (async () => {
    const hydrated = await hydrateClientFromPersistedSession(sessionUserId, { allowLegacyFile: true });
    if (hydrated) {
      return hydrated;
    }

    // ── Silent mode gate (April 10 2026) ────────────────────
    // iOS API endpoints pass { silent: true } because there's no
    // interactive user to answer an MFA code. Instead of triggering
    // loginWithMfa (which sends an email the user can't respond to
    // from the iOS app), we throw a descriptive error so the iOS
    // endpoint returns a clean "Garmin session expired" response.
    // The next Telegram bot command will trigger the real MFA flow
    // where the user can respond.
    if (silent) {
      logger.warn('Garmin: tokens expired and silent mode is ON — skipping MFA login. ' +
        'Send /readiness or /training in Telegram to re-authenticate with MFA.');
      if (sessionUserId) {
        await markGarminNeedsReauth(sessionUserId, 'silent_token_load_failed');
      }
      throw new Error('Garmin session expired — re-authenticate via Telegram bot');
    }

    if (sessionUserId && !isOwnerGarminUserId(sessionUserId)) {
      logger.warn(
        { userId: sessionUserId },
        'Garmin: refusing global credential MFA login for non-owner user without a per-user session',
      );
      throw new Error('Garmin session missing for this user — connect Garmin before reading Garmin data');
    }

    // Fresh login — go directly to our MFA-aware flow (avoids the library's
    // own login() which makes an unprotected SSO request that can trigger Cloudflare)
    if (isRateLimited()) throw new Error('Garmin SSO rate-limited — skipping login');
    const client = createGarminClient();
    try {
      await loginWithMfa(client);
      adoptAuthenticatedClient(client, sessionUserId);
      if (sessionUserId) {
        persistTokens(sessionUserId);
        markGarminConnectionActive(sessionUserId, config.garmin.email);
      }
      logger.info({ userId: sessionUserId }, 'Garmin: login successful (manual MFA flow), tokens saved to DB');
      return client;
    } catch (err) {
      // Drop only this user's slot; other users' clients stay authenticated.
      _clientPool.delete(poolKey);
      throw new Error(`Garmin login failed: ${(err as Error).message}`);
    }
  })();

  _clientBootstraps.set(poolKey, bootstrap);
  try {
    return await bootstrap;
  } finally {
    // Clear this user's slot so a future stale-token recovery can start a
    // fresh bootstrap. Runs after awaiting callers see the resolved value, so
    // concurrent waiters for this user all get the same client.
    _clientBootstraps.delete(poolKey);
  }
}

/**
 * Save current tokens to the DB session store (call after successful API
 * calls to persist any tokens that the garmin-connect interceptor refreshed).
 */
function persistTokens(explicitUserId?: number): void {
  try {
    const userId = resolveGarminUserId(explicitUserId);
    if (!userId) return;

    // Take the client belonging to THIS user. Previously there was one
    // process-wide client holding whoever authenticated last, and this
    // function had to notice that and refuse — writing its OAuth material
    // under another user's id is exactly the contamination
    // `cleanup-tainted-garmin-sessions` exists to detect. Keying the pool by
    // user makes the wrong client unreachable rather than merely rejected.
    const entry = _clientPool.get(clientPoolKey(userId));
    if (!entry) {
      logger.debug({ userId }, 'Garmin: no pooled client for this user, nothing to persist');
      return;
    }

    upsertGarminSession(userId, {
      oauth1: (entry.client.client as any).oauth1Token ?? null,
      oauth2: (entry.client.client as any).oauth2Token ?? null,
    });
    touchGarminConnection(userId);
  } catch (err) {
    logger.warn({ err }, 'Garmin: failed to persist refreshed tokens');
  }
}

/**
 * Proactively refresh the OAuth2 token using the OAuth1 token.
 * Called on a schedule to prevent token expiry.
 */
export type GarminRefreshOutcome = 'ok' | 'auth_rejected' | 'transient';

/**
 * Consecutive transient refresh failures per user. Demotion to needs_reauth
 * is a one-way door for non-owners, so a run of transient failures has to
 * accumulate before it counts as a dead session. Reset on any success.
 */
const _consecutiveRefreshFailures = new Map<number, number>();
const TRANSIENT_REFRESH_FAILURE_LIMIT = 3;

/** Test seam: clear transient-failure counters between cases. */
export function _resetGarminRefreshFailureCountersForTests(): void {
  _consecutiveRefreshFailures.clear();
}

/**
 * Classify a refresh failure.
 *
 * Only a genuine credential rejection means the user must reconnect. A 500,
 * a socket hang-up or a rate-limit is Garmin being unavailable, and demoting
 * the connection for that is a one-way door: `listGarminConnectedUserIds`
 * filters on `status = 'active'`, and the only non-owner route back is an
 * explicit POST /api/v1/garmin/* reconnect. One network blip would otherwise
 * evict a user from the refresh set permanently.
 */
export function classifyRefreshFailure(err: unknown): 'auth_rejected' | 'transient' {
  const status = extractErrorStatus(err);
  if (status === 401) return 'auth_rejected';
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  if (/invalid_grant|invalid_token|unauthorized|token (is )?(expired|revoked)/.test(msg)) {
    return 'auth_rejected';
  }
  return 'transient';
}

async function refreshOAuth2(): Promise<GarminRefreshOutcome> {
  try {
    const client = await getClient({ silent: true });
    // Access the underlying HttpClient to call refreshOauth2Token directly
    await (client.client as any).refreshOauth2Token();
    persistTokens();
    logger.info('Garmin: proactive OAuth2 token refresh successful');
    return 'ok';
  } catch (err) {
    const kind = classifyRefreshFailure(err);
    logger.warn({ err, kind }, 'Garmin: proactive OAuth2 refresh failed');
    return kind;
  }
}

/**
 * Keep-alive: refresh tokens proactively. Exported for use by the scheduler.
 *
 * Strategy: OAuth2 refresh ONLY. Never attempt a full re-login from here.
 *
 * Rationale: keep-alive runs on a fixed 30-minute cron. If the tokens are
 * beyond OAuth2 refresh (refresh token revoked, 400 invalid_grant, etc.),
 * triggering a full loginWithMfa() here would send a Garmin MFA email
 * EVERY 30 minutes until someone enters the code via Telegram — and in
 * practice the scheduler doesn't have an interactive bot context so the
 * MFA code would never arrive, leading to an infinite email flood.
 *
 * The correct recovery path for dead sessions is lazy: the next
 * user-initiated Garmin call (via safeGet → serializedAuthRecovery) will
 * detect the 403 and run ONE recovery attempt with MFA notification
 * wired to the interactive user. Until then, the bot runs without live
 * Garmin data — which is better than spamming the operator inbox.
 */
export async function keepAlive(): Promise<boolean> {
  // Runs for whichever user the caller scoped the request context to. The
  // global credential pair is not consulted: a user who linked their own
  // Garmin account needs their tokens refreshed regardless of whether the
  // owner's env credentials are set.
  const userId = resolveGarminUserId();
  if (!userId) {
    logger.warn('Garmin: keep-alive skipped — no user in scope');
    return false;
  }
  if (isRateLimited(userId)) {
    logger.info({ userId }, 'Garmin: skipping keep-alive, SSO rate-limited');
    return false;
  }
  if (isMfaPending()) {
    logger.info({ userId }, 'Garmin: skipping keep-alive, MFA pending');
    return false;
  }

  // Step 1: Try proactive OAuth2 refresh (no SSO login needed, no email)
  const outcome = await refreshOAuth2();
  if (outcome === 'ok') {
    // Validate with a lightweight call
    try {
      const client = await getClient({ silent: true });
      await client.getUserSettings();
      _consecutiveRefreshFailures.delete(userId);
      return true;
    } catch (err) {
      logger.warn({ err, userId }, 'Garmin: OAuth2 refresh succeeded but validation failed — deferring to lazy recovery');
      return false;
    }
  }

  // DO NOT trigger loginWithMfa here — that would send a Garmin MFA email
  // every 30 minutes.
  //
  // Demoting to needs_reauth removes the user from the keep-alive set
  // entirely (`listGarminConnectedUserIds` filters `status = 'active'`), and
  // for a non-owner the only route back is an explicit reconnect. So demote
  // on a genuine credential rejection, but let Garmin being briefly
  // unavailable pass — otherwise a single 500 permanently strands the user.
  const failures = (_consecutiveRefreshFailures.get(userId) ?? 0) + 1;
  _consecutiveRefreshFailures.set(userId, failures);

  if (outcome === 'auth_rejected' || failures >= TRANSIENT_REFRESH_FAILURE_LIMIT) {
    _consecutiveRefreshFailures.delete(userId);
    await markGarminNeedsReauth(userId, outcome === 'auth_rejected'
      ? 'keepalive_auth_rejected'
      : 'keepalive_refresh_failed');
    logger.warn(
      { userId, outcome, failures },
      'Garmin: keepalive marked the connection as needs_reauth',
    );
    return false;
  }

  logger.warn(
    { userId, failures, limit: TRANSIENT_REFRESH_FAILURE_LIMIT },
    'Garmin: transient refresh failure — leaving the connection active and retrying next tick',
  );
  return false;
}

/**
 * Pre-authenticate: validate the session and recover if needed.
 * Call this BEFORE batch API calls (e.g. coach briefing) to avoid
 * 10+ parallel 403s all triggering separate MFA flows.
 *
 * Pass `{ silent: true }` from CRON contexts where no interactive
 * user is present to respond to an MFA code. In both silent and
 * non-silent passive flows, recovery is now refresh-or-fail: it can
 * refresh tokens or reload them from the DB session store, but it must
 * never silently trigger a new MFA login.
 */
export async function ensureAuthenticated(
  opts: { silent?: boolean } = {},
): Promise<boolean> {
  // Scoped to the user in context. The deployment-wide credential pair is
  // deliberately NOT consulted: a user who linked their own Garmin account
  // must be able to pre-authenticate whether or not the owner's env vars are
  // set. `getClient` resolves and validates the per-user session.
  const userId = resolveGarminUserId();
  if (!userId) {
    logger.warn('Garmin: pre-auth skipped — no user in scope');
    return false;
  }
  const silent = opts.silent ?? getCurrentContext()?.garminSilent ?? _silentMode;
  try {
    const client = await getClient({ silent });
    await client.getUserSettings();
    logger.info('Garmin: pre-auth check passed');
    return true;
  } catch {
    if (silent) {
      logger.warn('Garmin: pre-auth check failed in silent mode, running silent recovery (OAuth2 + token reload only)');
      return silentAuthRecovery();
    }
    logger.warn('Garmin: pre-auth check failed, running full recovery');
    return serializedAuthRecovery();
  }
}

/**
 * Silent auth recovery — the cron-safe sibling of serializedAuthRecovery.
 *
 * Only attempts Step 1 (OAuth2 refresh) and Step 2 (token reload from
 * the DB session store). Explicitly DOES NOT call loginWithMfa so a
 * failing cron never triggers a Garmin passcode email. If both silent
 * steps fail, returns false and the caller should degrade gracefully
 * (coach briefing with data gaps, skipped job, etc.).
 *
 * This is the SAME failure mode keepAlive() already uses — we just
 * plumbed a second entry point through ensureAuthenticated so the
 * coach cron's pre-auth hook benefits from the same protection.
 */
async function silentAuthRecovery(): Promise<boolean> {
  const recoveryUserId = resolveGarminUserId();
  if (!recoveryUserId) {
    logger.warn('Garmin: silent recovery skipped — no user in scope');
    return false;
  }
  const inFlight = _silentRecoveries.get(recoveryUserId);
  if (inFlight) {
    logger.info({ userId: recoveryUserId }, 'Garmin: silent recovery deferring to in-flight recovery promise');
    return inFlight;
  }
  const recovery = (async () => {
    try {
      // Step 1: OAuth2 token refresh
      try {
        const client = await getClient({ silent: true });
        await (client.client as any).refreshOauth2Token();
        persistTokens();
        await client.getUserSettings();
        logger.info('Garmin: silent recovery — OAuth2 refresh succeeded');
        return true;
      } catch {
        logger.warn('Garmin: silent recovery — OAuth2 refresh failed, trying token reload');
      }

      // Step 2: Reload tokens from the DB session store
      const userId = resolveGarminUserId();
      const rehydrated = await hydrateClientFromPersistedSession(userId, { allowLegacyFile: false });
      if (rehydrated) {
        try {
          logger.info({ userId }, 'Garmin: silent recovery — DB token reload succeeded');
          return true;
        } catch {
          logger.warn({ userId }, 'Garmin: silent recovery — DB token reload failed');
        }
      }

      // Step 3 is INTENTIONALLY not attempted. Full re-login would
      // send a passcode email to the user with no interactive context
      // to answer it. Cron callers accept the graceful-degradation
      // path instead.
      if (userId) {
        await markGarminNeedsReauth(userId, 'silent_recovery_exhausted');
      }
      logger.warn('Garmin: silent recovery exhausted (OAuth2 + DB reload both failed). Marked needs_reauth.');
      return false;
    } finally {
      _silentRecoveries.delete(recoveryUserId);
    }
  })();
  _silentRecoveries.set(recoveryUserId, recovery);
  return recovery;
}

/**
 * Extract HTTP status from garmin-connect errors.
 * The library throws plain Errors with messages like "ERROR: (403), Forbidden, {...}"
 * instead of attaching a .response property, so we parse the message string.
 */
function extractErrorStatus(err: unknown): number | null {
  // Try standard axios-style first
  const axiosStatus = (err as { response?: { status?: number } })?.response?.status;
  if (axiosStatus) return axiosStatus;
  // Parse garmin-connect formatted error: "ERROR: (403), Forbidden, ..."
  const msg = (err as Error)?.message ?? '';
  const match = msg.match(/\((\d{3})\)/);
  return match ? parseInt(match[1], 10) : null;
}

// ─── Serialized auth recovery (prevents parallel MFA storms) ─────────
//
// Keyed by user, and split by recovery KIND. This was one unkeyed module
// scalar shared by both `silentAuthRecovery` and `serializedAuthRecovery`, so
// user B's read could receive user A's recovery verdict, and a silent
// recovery could be handed the interactive one's promise — the interactive
// path is allowed to be more invasive, so satisfying a silent caller with it
// is exactly backwards.
const _silentRecoveries = new Map<number, Promise<boolean>>();
const _serializedRecoveries = new Map<number, Promise<boolean>>();

/** Test seam: drop in-flight recovery state so each case starts clean. */
export function _resetGarminRecoveryStateForTests(): void {
  _silentRecoveries.clear();
  _serializedRecoveries.clear();
}

/**
 * Ensures only ONE auth recovery runs at a time.
 * All concurrent 403 callers await the same promise.
 *
 * Steps in order of invasiveness:
 *   1. OAuth2 refresh (silent, no email)
 *   2. Token reload from the DB session store (silent, no email)
 *   3. Mark the connection as needs_reauth and stop.
 */
async function serializedAuthRecovery(): Promise<boolean> {
  const recoveryUserId = resolveGarminUserId();
  if (!recoveryUserId) {
    logger.warn('Garmin: auth recovery skipped — no user in scope');
    return false;
  }
  const inFlight = _serializedRecoveries.get(recoveryUserId);
  if (inFlight) {
    logger.info({ userId: recoveryUserId }, 'Garmin: auth recovery already in progress, waiting...');
    return inFlight;
  }
  const recovery = (async () => {
    try {
      // Step 1: Try OAuth2 token refresh
      try {
        const client = await getClient({ silent: true });
        await (client.client as any).refreshOauth2Token();
        persistTokens();
        // Validate with lightweight call
        await client.getUserSettings();
        logger.info('Garmin: auth recovered via OAuth2 refresh');
        return true;
      } catch {
        logger.warn('Garmin: OAuth2 refresh failed in recovery, trying token reload');
      }

      // Step 2: Reload tokens from the DB session store
      const userId = resolveGarminUserId();
      const rehydrated = await hydrateClientFromPersistedSession(userId, { allowLegacyFile: false });
      if (rehydrated) {
        try {
          logger.info({ userId }, 'Garmin: auth recovered via DB token reload');
          return true;
        } catch {
          logger.warn({ userId }, 'Garmin: DB token reload failed in recovery');
        }
      }

      if (userId) {
        await markGarminNeedsReauth(userId, 'serialized_recovery_exhausted');
      }
      logger.warn('Garmin: passive recovery exhausted — marked needs_reauth instead of triggering MFA login');
      return false;
    } finally {
      _serializedRecoveries.delete(recoveryUserId);
    }
  })();
  _serializedRecoveries.set(recoveryUserId, recovery);
  return recovery;
}

/** Data endpoints where 404 means "no data" (not an auth failure) */
const DATA_ENDPOINTS_404_OK = [
  '/usersummary-service/',
  '/wellness-service/',
  '/workout-service/schedule/',
  '/workout-service/api/trainingplan/',
  '/hrv-service/',
  '/metrics-service/',
  '/sleep-service/',
];

/** Check if a URL is a data endpoint (not an auth endpoint) */
function isDataEndpoint(url: string): boolean {
  return DATA_ENDPOINTS_404_OK.some(prefix => url.includes(prefix));
}

async function safeGet<T = unknown>(url: string, opts: GarminReadOptions = {}): Promise<T> {
  const silent = opts.silent ?? getCurrentContext()?.garminSilent ?? _silentMode;
  const client = await getClient({ silent });
  try {
    const result = await client.get(url) as T;
    persistTokens();
    const userId = resolveGarminUserId();
    if (userId) {
      touchGarminConnection(userId);
    }
    return result;
  } catch (err: unknown) {
    const status = extractErrorStatus(err);

    // 404 on data endpoints = no data available (not an auth failure)
    if (status === 404 && isDataEndpoint(url)) {
      logger.debug({ status, url: url.split('?')[0] }, 'Garmin: data endpoint returned 404, treating as empty');
      return null as T;
    }

    // 403 on data endpoints = likely permission/feature issue, NOT auth failure
    if (status === 403 && isDataEndpoint(url)) {
      logger.debug({ status, url: url.split('?')[0] }, 'Garmin: data endpoint returned 403, treating as empty (not auth failure)');
      return null as T;
    }

    if (status === 401 || status === 403) {
      logger.warn({ status, url: url.split('?')[0], silent }, 'Garmin: auth error, waiting for recovery');

      // All concurrent 403s funnel through ONE recovery attempt. Silent
      // contexts use refresh/reload only; full re-login would email an MFA
      // passcode with no interactive user to answer it.
      const recovered = silent ? await silentAuthRecovery() : await serializedAuthRecovery();
      if (recovered) {
        try {
          const freshClient = await getClient({ silent });
          const result = await freshClient.get(url) as T;
          persistTokens();
          const userId = resolveGarminUserId();
          if (userId) {
            touchGarminConnection(userId);
          }
          logger.info({ url: url.split('?')[0] }, 'Garmin: recovered, retried successfully');
          return result;
        } catch (retryErr) {
          logger.error({ err: retryErr, url: url.split('?')[0] }, 'Garmin: recovered but retry still failed');
          throw retryErr;
        }
      }

      throw err; // recovery failed
    }
    throw err;
  }
}

function logGarminReadFallback(err: unknown, url: string, opts: GarminReadOptions): void {
  const resolvedUserId = getCurrentContext()?.userId ?? garminPersistenceUserId();
  const userId = resolvedUserId || null;
  logger.warn(
    { err, userId, url: url.split('?')[0], silent: opts.silent ?? getCurrentContext()?.garminSilent ?? _silentMode },
    'Garmin read failed, returning empty',
  );
}

// ─── Public API methods ───────────────────────────────────────────────

export async function getDailySummary(date: string, opts: GarminReadOptions = {}): Promise<GarminDailySummary | null> {
  try { return await safeGet<GarminDailySummary>(URLS.userSummary(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.userSummary(date), opts); return null; }
}

export async function getSleepData(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.sleepData(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.sleepData(date), opts); return null; }
}

export async function getStressSummary(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.stressSummary(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.stressSummary(date), opts); return null; }
}

export async function getHeartRateSummary(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.heartRateSummary(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.heartRateSummary(date), opts); return null; }
}

export async function getHrvData(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.hrvData(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.hrvData(date), opts); return null; }
}

export async function getTrainingReadiness(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.trainingReadiness(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.trainingReadiness(date), opts); return null; }
}

export async function getTrainingStatus(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.trainingStatus(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.trainingStatus(date), opts); return null; }
}

export async function getBodyBatteryEvents(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.bodyBatteryEvents(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.bodyBatteryEvents(date), opts); return null; }
}

export async function getBodyBatteryEventsForUser(userId: number, date: string): Promise<unknown> {
  return runWithContext({ source: 'manual', userId }, () => getBodyBatteryEvents(date));
}

export async function getRhr(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.rhr(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.rhr(date), opts); return null; }
}

export async function getActivitiesByDate(
  startDate: string,
  endDate: string,
  opts: GarminReadOptions = {},
): Promise<GarminActivity[]> {
  try {
    const result = await safeGet<GarminActivity[]>(URLS.activitiesByDate(startDate, endDate), opts);
    return Array.isArray(result) ? result : [];
  } catch (err) { logGarminReadFallback(err, URLS.activitiesByDate(startDate, endDate), opts); return []; }
}

export async function getActivitiesByDateForUser(
  userId: number,
  startDate: string,
  endDate: string,
): Promise<GarminActivity[]> {
  return runWithContext({ source: 'manual', userId }, () => getActivitiesByDate(startDate, endDate));
}

export async function getActivityDetails(activityId: number, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.activityDetails(activityId), opts); }
  catch (err) { logGarminReadFallback(err, URLS.activityDetails(activityId), opts); return null; }
}

export async function getActivitySplits(activityId: number, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.activitySplits(activityId), opts); }
  catch (err) { logGarminReadFallback(err, URLS.activitySplits(activityId), opts); return null; }
}

export async function getActivityExerciseSets(activityId: number, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.activityExerciseSets(activityId), opts); }
  catch (err) { logGarminReadFallback(err, URLS.activityExerciseSets(activityId), opts); return null; }
}

export async function getTrainingEffect(activityId: number, opts: GarminReadOptions = {}): Promise<unknown> {
  try {
    const details = await safeGet<Record<string, unknown>>(URLS.trainingEffect(activityId), opts);
    return details?.summaryDTO ?? details;
  } catch (err) { logGarminReadFallback(err, URLS.trainingEffect(activityId), opts); return null; }
}

export async function getScheduledWorkouts(
  startDate: string,
  endDate: string,
  opts: GarminReadOptions = {},
): Promise<unknown[]> {
  try {
    const result = await safeGet<unknown[]>(URLS.scheduledWorkouts(startDate, endDate), opts);
    return Array.isArray(result) ? result : [];
  } catch (err) { logGarminReadFallback(err, URLS.scheduledWorkouts(startDate, endDate), opts); return []; }
}

export async function getTrainingPlanWorkouts(date: string, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.trainingPlanWorkouts(date), opts); }
  catch (err) { logGarminReadFallback(err, URLS.trainingPlanWorkouts(date), opts); return null; }
}

export async function getWorkoutDetail(workoutId: number, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.workoutDetail(workoutId), opts); }
  catch (err) { logGarminReadFallback(err, URLS.workoutDetail(workoutId), opts); return null; }
}

export async function getWeeklyStress(date: string, weeks = 1, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.weeklyStress(date, weeks), opts); }
  catch (err) { logGarminReadFallback(err, URLS.weeklyStress(date, weeks), opts); return null; }
}

export async function getWeeklyIntensityMinutes(date: string, weeks = 1, opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.weeklyIntensityMinutes(date, weeks), opts); }
  catch (err) { logGarminReadFallback(err, URLS.weeklyIntensityMinutes(date, weeks), opts); return null; }
}

export async function getRacePredictions(opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.racePredictions(), opts); }
  catch (err) { logGarminReadFallback(err, URLS.racePredictions(), opts); return null; }
}

export async function getActiveGoals(opts: GarminReadOptions = {}): Promise<unknown> {
  try { return await safeGet(URLS.goals('active'), opts); }
  catch (err) { logGarminReadFallback(err, URLS.goals('active'), opts); return null; }
}

// ─── Composite: Fetch all daily coach data in parallel ────────────────

export async function fetchDailyCoachData(opts: GarminReadOptions = {}): Promise<GarminCoachData> {
  const today = now().toFormat('yyyy-MM-dd');
  const tomorrow = now().plus({ days: 1 }).toFormat('yyyy-MM-dd');
  const errors: string[] = [];

  // Phase 1: Parallel fetch of all daily data + activities
  const [
    summary, sleep, stress, heartRate, hrv,
    trainingReadiness, trainingStatus, bodyBattery, rhr,
    activities,
  ] = await Promise.allSettled([
    getDailySummary(today, opts),
    getSleepData(today, opts),
    getStressSummary(today, opts),
    getHeartRateSummary(today, opts),
    getHrvData(today, opts),
    getTrainingReadiness(today, opts),
    getTrainingStatus(today, opts),
    getBodyBatteryEvents(today, opts),
    getRhr(today, opts),
    getActivitiesByDate(today, today, opts),
  ]).then(results => results.map((r, i) => {
    if (r.status === 'rejected') {
      const names = ['summary', 'sleep', 'stress', 'heartRate', 'hrv', 'trainingReadiness', 'trainingStatus', 'bodyBattery', 'rhr', 'activities'];
      errors.push(`${names[i]}: ${r.reason?.message ?? 'unknown error'}`);
      return null;
    }
    return r.value;
  }));

  const activityList = (activities as GarminActivity[] | null) ?? [];

  // Phase 2: Activity-specific enrichment (parallel)
  const activityDetails = new Map<number, unknown>();
  if (activityList.length > 0) {
    const detailPromises = activityList.map(async (a) => {
      try {
        const [effect, details] = await Promise.all([
          getTrainingEffect(a.activityId, opts),
          isStrength(a)
            ? getActivityExerciseSets(a.activityId, opts)
            : isRunning(a)
              ? getActivityDetails(a.activityId, opts) // includes running dynamics
              : getActivitySplits(a.activityId, opts),
        ]);
        activityDetails.set(a.activityId, { trainingEffect: effect, extra: details });
      } catch (err) {
        errors.push(`activity ${a.activityId}: ${(err as Error).message}`);
      }
    });
    await Promise.all(detailPromises);
  }

  // Phase 3: Tomorrow's scheduled workouts + training plan (parallel)
  const [tomorrowWorkouts, tomorrowTrainingPlan, weeklyStress, weeklyIntensityMinutes] = await Promise.allSettled([
    getScheduledWorkouts(tomorrow, tomorrow, opts),
    getTrainingPlanWorkouts(tomorrow, opts),
    getWeeklyStress(today, 1, opts),
    getWeeklyIntensityMinutes(today, 1, opts),
  ]).then(results => results.map((r, i) => {
    if (r.status === 'rejected') {
      const names = ['scheduledWorkouts', 'trainingPlan', 'weeklyStress', 'weeklyIntensity'];
      errors.push(`${names[i]}: ${r.reason?.message ?? 'unknown error'}`);
      return null;
    }
    return r.value;
  }));

  // Pre-extract / summarize data (raw blobs are 200KB+ and blow the payload budget)
  const bodyBatterySummaryData = extractBodyBatterySummary(
    bodyBattery,
    summary as GarminDailySummary | null,
  );

  return {
    date: today,
    summary: summary as GarminDailySummary | null,
    sleepSummary: summarizeSleep(sleep),
    stressSummary: summarizeStress(stress),
    heartRateSummary: summarizeHeartRate(heartRate),
    hrvSummary: summarizeHrv(hrv),
    trainingReadiness,
    trainingStatus,
    bodyBatterySummary: bodyBatterySummaryData,
    activities: activityList,
    activityDetails,
    tomorrowWorkouts: (tomorrowWorkouts as unknown[]) ?? [],
    tomorrowTrainingPlan,
    weeklyStress,
    weeklyIntensityMinutes,
    errors,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function isStrength(activity: GarminActivity): boolean {
  const key = activity.activityType?.typeKey?.toLowerCase() ?? '';
  return key.includes('strength') || key.includes('gym') || key.includes('weight');
}

function isRunning(activity: GarminActivity): boolean {
  const key = activity.activityType?.typeKey?.toLowerCase() ?? '';
  return key.includes('running') || key.includes('trail') || key.includes('treadmill');
}

// ─── Data summarization (reduce 200KB+ blobs to ~500 bytes) ──────────

/**
 * Summarize sleep data to key metrics only (raw is ~200KB of interval data).
 */
function summarizeSleep(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  // dailySleepDTO has the summary; sleepLevels/wellnessEpochSPO2DataDTOList are the big arrays
  const dto = (s.dailySleepDTO ?? s) as Record<string, unknown>;
  return {
    sleepTimeSeconds: dto.sleepTimeSeconds,
    deepSleepSeconds: dto.deepSleepSeconds,
    lightSleepSeconds: dto.lightSleepSeconds,
    remSleepSeconds: dto.remSleepSeconds,
    awakeSleepSeconds: dto.awakeSleepSeconds,
    sleepScores: dto.sleepScores,
    sleepQualityTypePK: dto.sleepQualityTypePK,
    averageSpO2Value: dto.averageSpO2Value,
    lowestSpO2Value: dto.lowestSpO2Value,
    averageRespirationValue: dto.averageRespirationValue,
    averageStress: dto.averageStress,
    bodyBatteryChange: dto.bodyBatteryChange,
    restlessMomentsCount: dto.restlessMomentsCount,
    sleepStartTimestampLocal: dto.sleepStartTimestampLocal,
    sleepEndTimestampLocal: dto.sleepEndTimestampLocal,
  };
}

/**
 * Summarize stress data (raw is ~23KB of interval values).
 */
function summarizeStress(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  return {
    overallStressLevel: s.overallStressLevel,
    restStressDuration: s.restStressDuration,
    activityStressDuration: s.activityStressDuration,
    lowStressDuration: s.lowStressDuration,
    mediumStressDuration: s.mediumStressDuration,
    highStressDuration: s.highStressDuration,
    stressQualifier: s.stressQualifier,
    maxStressLevel: s.maxStressLevel,
    averageStressLevel: s.averageStressLevel,
  };
}

/**
 * Summarize heart rate data (raw is ~11KB of interval values).
 */
function summarizeHeartRate(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  return {
    restingHeartRate: s.restingHeartRate,
    maxHeartRate: s.maxHeartRate,
    minHeartRate: s.minHeartRate,
    lastSevenDaysAvgRestingHeartRate: s.lastSevenDaysAvgRestingHeartRate,
    // heartRateValues is the big array — skip it
  };
}

/**
 * Summarize HRV data (raw is ~12KB).
 */
function summarizeHrv(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  // The summary is typically in hrvSummary or at top level
  const summary = (s.hrvSummary ?? s) as Record<string, unknown>;
  return {
    weeklyAvg: summary.weeklyAvg,
    lastNight: summary.lastNight,
    lastNightAvg: summary.lastNightAvg,
    lastNight5MinHigh: summary.lastNight5MinHigh,
    baseline: summary.baseline,
    status: summary.status,
    startTimestampLocal: summary.startTimestampLocal,
  };
}

/**
 * Extract a simple body battery summary from the events endpoint data.
 * The bodyBatteryValuesArray entries are: [timestamp, status, bbValue, ...]
 * Also merges values from dailySummary if available.
 */
function extractBodyBatterySummary(
  eventsData: unknown,
  summary: GarminDailySummary | null,
): BodyBatterySummary {
  const result: BodyBatterySummary = {
    current: null,
    highest: null,
    lowest: null,
    charged: summary?.bodyBatteryChargedValue ?? null,
    drained: summary?.bodyBatteryDrainedValue ?? null,
  };

  // Try to get values from dailySummary first (most reliable when available)
  if (summary) {
    result.highest = summary.bodyBatteryHighestValue ?? null;
    result.lowest = summary.bodyBatteryLowestValue ?? null;
    // Some summaries have a "most recent" field
    const mostRecent = (summary as Record<string, unknown>).bodyBatteryMostRecentValue;
    if (typeof mostRecent === 'number') result.current = mostRecent;
  }

  // Extract from events data (fallback or supplement)
  if (Array.isArray(eventsData)) {
    const allValues: number[] = [];
    for (const event of eventsData) {
      const bbArray = (event as Record<string, unknown>)?.bodyBatteryValuesArray;
      if (Array.isArray(bbArray)) {
        for (const entry of bbArray) {
          if (Array.isArray(entry) && typeof entry[2] === 'number') {
            allValues.push(entry[2]);
          }
        }
      }
    }
    if (allValues.length > 0) {
      result.current = result.current ?? allValues[allValues.length - 1];
      result.highest = result.highest ?? Math.max(...allValues);
      result.lowest = result.lowest ?? Math.min(...allValues);
    }
  }

  return result;
}

/**
 * Summarize activity details to essential coaching metrics only.
 * Raw activityDetails can be 20–30KB per activity (exercise sets, split intervals, etc.).
 * We extract just what the coach needs: training effect, key stats, and set summaries.
 */
export function summarizeActivityDetails(
  detailsMap: Map<number, unknown>,
): Record<number, unknown> {
  const result: Record<number, unknown> = {};
  for (const [id, raw] of detailsMap) {
    if (!raw || typeof raw !== 'object') {
      result[id] = null;
      continue;
    }
    const detail = raw as Record<string, unknown>;

    // Always keep training effect (small object)
    const trainingEffect = detail.trainingEffect;

    // Summarize the "extra" (exercise sets, splits, or running dynamics)
    const extra = detail.extra;
    let extraSummary: unknown = null;

    if (extra && typeof extra === 'object') {
      const e = extra as Record<string, unknown>;

      // Strength training: exerciseSets — just count sets/reps/exercises
      if (Array.isArray(e.exerciseSets)) {
        const sets = e.exerciseSets as Record<string, unknown>[];
        const exercises = new Map<string, { sets: number; totalReps: number; maxWeight: number }>();
        for (const set of sets) {
          const name = String(set.exerciseName ?? set.category ?? 'unknown');
          const reps = Number(set.repetitionCount ?? set.reps ?? 0);
          const weight = Number(set.weight ?? 0);
          const existing = exercises.get(name) ?? { sets: 0, totalReps: 0, maxWeight: 0 };
          existing.sets++;
          existing.totalReps += reps;
          existing.maxWeight = Math.max(existing.maxWeight, weight);
          exercises.set(name, existing);
        }
        extraSummary = {
          type: 'strength',
          totalSets: sets.length,
          totalReps: sets.reduce((sum, s) => sum + Number((s as Record<string, unknown>).repetitionCount ?? 0), 0),
          exercises: Object.fromEntries(exercises),
        };
      }
      // Running: summarize splits/dynamics
      else if (Array.isArray(e.lapDTOs) || e.summaryDTO) {
        const summary = e.summaryDTO as Record<string, unknown> | undefined;
        extraSummary = {
          type: 'running',
          avgPace: summary?.averageSpeed,
          maxPace: summary?.maxSpeed,
          avgCadence: summary?.averageRunCadence,
          avgHeartRate: summary?.averageHR,
          maxHeartRate: summary?.maxHR,
          totalAscent: summary?.elevationGain,
          groundContactTime: summary?.avgGroundContactTime,
          verticalOscillation: summary?.avgVerticalOscillation,
          lapCount: Array.isArray(e.lapDTOs) ? (e.lapDTOs as unknown[]).length : undefined,
        };
      }
      // Splits (cycling, etc.): summarize lap count
      else if (Array.isArray(e.lapDTOs || e.splitSummaries)) {
        const laps = (e.lapDTOs ?? e.splitSummaries) as unknown[];
        extraSummary = {
          type: 'splits',
          lapCount: laps.length,
        };
      }
    }

    result[id] = { trainingEffect, extra: extraSummary };
  }
  return result;
}
