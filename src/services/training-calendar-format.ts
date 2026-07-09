// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// Canonical emoji for Training calendar event titles. Every writer that
// renders a provider calendar title for a training session — the direct
// Training calendar sync, the persistence-path intent titles, and the
// Secretary provider adapter — must share this single mapping. Divergent
// copies previously caused visible emoji ping-pong between writers and
// broke title-equality duplicate detection for marker-less events.
export function emojiForTrainingSession(sessionType: string | null | undefined): string {
  switch ((sessionType || '').toLowerCase()) {
    case 'gym':
      return '💪';
    case 'run':
      return '🏃';
    case 'ride':
    case 'bike':
    case 'cycling':
      return '🚴';
    case 'swim':
      return '🏊';
    default:
      return '🏋️';
  }
}
