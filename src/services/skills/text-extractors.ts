// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Shared text-extraction utilities used by per-skill parsers. Extracted from
// chat-action-planner.ts on 2026-05-15 to break the runtime-cycle dependency
// when per-skill parsers move to their own modules (planner-split, audit
// implementation plan Phase 0).

/**
 * Infer the connected provider mentioned in a text. Returns one of:
 * 'google' | 'outlook' | 'garmin' | 'apple_health' | 'stripe' | null
 */
export function inferProviderName(folded: string): string | null {
  if (/\b(google|gmail)\b/.test(folded)) return 'google';
  if (/\b(outlook|microsoft)\b/.test(folded)) return 'outlook';
  if (/\bgarmin\b/.test(folded)) return 'garmin';
  if (/\b(apple health|healthkit|saude|saúde)\b/.test(folded)) return 'apple_health';
  if (/\bstripe\b/.test(folded)) return 'stripe';
  return null;
}

/**
 * Infer the content platform from text. Returns one of:
 * 'tiktok' | 'instagram_reel' | 'youtube_shorts' | 'youtube' | 'carousel' |
 * 'blog' | 'newsletter' | 'generic'.
 */
export function inferContentPlatform(folded: string): string {
  if (/\btiktok\b/.test(folded)) return 'tiktok';
  if (/\b(reels?|instagram)\b/.test(folded)) return 'instagram_reel';
  if (/\b(shorts?|youtube shorts?)\b/.test(folded)) return 'youtube_shorts';
  if (/\byoutube\b/.test(folded)) return 'youtube';
  if (/\b(carousel|carrossel)\b/.test(folded)) return 'carousel';
  if (/\bblog\b/.test(folded)) return 'blog';
  if (/\bnewsletter\b/.test(folded)) return 'newsletter';
  return 'generic';
}

/**
 * Extract a topic / subject from a user message. Recognises common preamble
 * patterns like "sobre X", "about X", "called X", "titulo: X", or "title: X".
 * Returns null when no topic is confidently extractable.
 */
export function extractTopic(text: string): string | null {
  const patterns = [
    /\b(?:sobre|about|on|para|for|de)\s+(.+)$/i,
    /\b(?:chamad[oa]|called|named|titulo|título)\s+["“]?(.+?)["”]?$/i,
    /:\s*(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const topic = match?.[1]?.trim().replace(/[.?!]+$/g, '');
    if (topic && topic.length >= 3) return topic;
  }
  return null;
}
