// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Telegram-specific formatters for content engine responses.
 *
 * These are TRANSPORT ADAPTERS, not core logic. They take structured
 * response objects from content-engine.ts and produce Telegram HTML
 * strings. The raw response types (DeepSearchResponse, ScriptResponse,
 * etc.) are the canonical API — use them directly for iOS/portal.
 *
 * All format functions are re-exported from content-engine.ts for
 * backward compatibility with the Telegram handler. New code should
 * import directly from this file to make the transport coupling explicit.
 *
 * @deprecated — These will be removed when Telegram is fully deprecated.
 *   New surfaces (iOS, portal) should render the structured response
 *   objects directly, never these HTML strings.
 */

// Re-export from content-engine.ts — the format functions are still
// defined there for now. As we migrate, they'll move here and
// content-engine.ts will only export the structured response types.
export {
  formatDeepSearch,
  formatSources,
  formatHotNews,
  formatTrending,
  formatReaction,
  formatHooks,
  formatScript,
  formatTitles,
  formatThumbnail,
  formatCaption,
  formatCompetitor,
  formatGaps,
  formatSeo,
  formatRepurpose,
  formatFeedback,
  formatReport,
} from './content-engine';
