// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Process-local provenance for legacy model answers that are safe comparison
 * baselines. WeakSet membership cannot leak into JSON, adapter payloads, or
 * exact public response contracts.
 */
const eligibleLegacyModelResponses = new WeakSet<object>();

export function markChatShadowBaselineEligible<T extends object>(
  response: T,
  eligible: boolean,
): T {
  if (eligible) eligibleLegacyModelResponses.add(response);
  return response;
}

export function isChatShadowBaselineEligible(response: object): boolean {
  return eligibleLegacyModelResponses.has(response);
}

/** Final public-answer gates shared by both Chat pipeline terminals. */
export function isPublishedChatShadowBaselineEligible(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const responseQuality = metadata?.responseQuality as { status?: unknown } | undefined;
  const finalComposition = metadata?.finalAnswerComposition as { ok?: unknown } | undefined;
  const answerContract = metadata?.chatReasoning as { fallbackUsed?: unknown } | undefined;
  return responseQuality?.status === 'pass'
    && finalComposition?.ok === true
    && answerContract?.fallbackUsed !== true
    && metadata?.responseLanguageGuard === undefined;
}
