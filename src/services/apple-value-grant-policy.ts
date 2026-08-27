// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Production-value grants accept Apple's Production environment by default.
 * A Sandbox grant is a deliberately narrow App Review exception: the global
 * switch and exact authenticated review account must both match. Xcode is a
 * local-development environment and cannot authorize production value.
 */
export function isAppleValueGrantEnvironmentAllowed(
  environment: unknown,
  authenticatedUserId: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!Number.isSafeInteger(authenticatedUserId) || authenticatedUserId <= 0) return false;
  if (environment === 'Production') return true;
  if (environment === 'Xcode') return env.NODE_ENV !== 'production';
  if (environment !== 'Sandbox' || env.APPLE_ALLOW_SANDBOX_GRANTS !== 'true') return false;

  const rawReviewUserId = String(env.APPLE_APP_REVIEW_SANDBOX_USER_ID ?? '').trim();
  if (!/^[1-9]\d{0,14}$/u.test(rawReviewUserId)) return false;
  const reviewUserId = Number(rawReviewUserId);
  return Number.isSafeInteger(reviewUserId) && reviewUserId === authenticatedUserId;
}
