// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Telegram + APNs-safe formatter for `SecretaryAgendaItem.reasoningTrail`
 * (C2 workstream).
 *
 * Two-language output (PT-PT/PT-BR vs. EN-US). Renders ONLY enum codes +
 * ISO slot fragments — never user copy. The trail nodes already enforce
 * that contract at the producer (W-E privacy test pins it), so this
 * formatter inherits the guarantee.
 *
 * Plan reference: Wave 1 workstream C2 in graceful-stirring-scone
 */

import type { Lang } from '../utils/i18n';
import type {
  ReasoningTrailNode,
  SecretaryAgendaItem,
} from './secretary-scheduling-arbitrator';

/**
 * Format a Secretary agenda item's reasoning trail for a Telegram reply.
 *
 * Returns HTML-safe text (uses Grammy's `parse_mode: 'HTML'`). The item
 * title IS included once at the top (the user already sees the title in
 * Decision Center / their own messages — not new PII), but the trail
 * nodes themselves remain enum/slot-only.
 */
export function formatReasoningTrailForTelegram(
  agenda: SecretaryAgendaItem,
  lang: Lang,
): string {
  const isPt = lang === 'pt-PT' || lang === 'pt-BR';
  const title = escapeHtml(agenda.title);
  const status = labelForStatus(agenda.decisionAction, lang);
  const header = isPt
    ? `🧭 <b>Porque Secretary decidiu:</b> ${title}\nEstado: ${status}`
    : `🧭 <b>Why Secretary decided:</b> ${title}\nStatus: ${status}`;

  if (agenda.reasoningTrail.length === 0) {
    const empty = isPt
      ? '_(Sem rasto de raciocínio guardado para esta decisão.)_'
      : '_(No reasoning trail stored for this decision.)_';
    return `${header}\n\n${empty}`;
  }

  const lines = agenda.reasoningTrail.map((node) => formatNode(node, lang));
  return `${header}\n\n${lines.join('\n')}`;
}

function formatNode(node: ReasoningTrailNode, lang: Lang): string {
  const isPt = lang === 'pt-PT' || lang === 'pt-BR';
  switch (node.kind) {
    case 'validation':
      return isPt
        ? `• ⚠ Validação: <code>${node.reasonCode ?? 'unknown'}</code>`
        : `• ⚠ Validation: <code>${node.reasonCode ?? 'unknown'}</code>`;
    case 'priority': {
      const w = node.weight ?? 0;
      return isPt
        ? `• ⚖ Prioridade: peso ${w} (${escapeHtml(node.detail ?? '')})`
        : `• ⚖ Priority: weight ${w} (${escapeHtml(node.detail ?? '')})`;
    }
    case 'phase_boost': {
      const w = node.weight ?? 0;
      const sign = w >= 0 ? '+' : '';
      return isPt
        ? `• 🎯 Fase do objectivo: ${sign}${w} (${escapeHtml(node.detail ?? '')})`
        : `• 🎯 Goal phase: ${sign}${w} (${escapeHtml(node.detail ?? '')})`;
    }
    case 'candidate':
      return isPt
        ? `• 🪟 Janelas candidatas: ${escapeHtml(node.detail ?? '')}`
        : `• 🪟 Candidate windows: ${escapeHtml(node.detail ?? '')}`;
    case 'busy_block':
      return isPt
        ? `• 📌 Conflitos: ${escapeHtml(node.detail ?? '')}`
        : `• 📌 Conflicts: ${escapeHtml(node.detail ?? '')}`;
    case 'considered': {
      const slot = node.slot ? `${node.slot.start} → ${node.slot.end}` : '';
      return isPt
        ? `• 🤔 Considerado: <code>${slot}</code>`
        : `• 🤔 Considered: <code>${slot}</code>`;
    }
    case 'compression':
      return isPt
        ? `• ✂ Comprimido: <code>${node.reasonCode ?? ''}</code> (${escapeHtml(node.detail ?? '')})`
        : `• ✂ Compressed: <code>${node.reasonCode ?? ''}</code> (${escapeHtml(node.detail ?? '')})`;
    case 'reflow':
      return isPt
        ? `• ↪ Realocado: <code>${node.reasonCode ?? ''}</code>`
        : `• ↪ Reflowed: <code>${node.reasonCode ?? ''}</code>`;
    case 'chosen': {
      const slot = node.slot ? `${node.slot.start} → ${node.slot.end}` : '';
      return isPt
        ? `• ✅ Escolhido: <code>${slot}</code> (${escapeHtml(node.detail ?? '')})`
        : `• ✅ Chosen: <code>${slot}</code> (${escapeHtml(node.detail ?? '')})`;
    }
    case 'rejected':
      return isPt
        ? `• ⛔ Rejeitado${node.reasonCode ? `: <code>${node.reasonCode}</code>` : ''}`
        : `• ⛔ Rejected${node.reasonCode ? `: <code>${node.reasonCode}</code>` : ''}`;
    case 'deferred':
      return isPt
        ? `• ⏳ Adiado${node.reasonCode ? `: <code>${node.reasonCode}</code>` : ''}`
        : `• ⏳ Deferred${node.reasonCode ? `: <code>${node.reasonCode}</code>` : ''}`;
    case 'unscheduled':
      return isPt
        ? `• 🚫 Sem horário${node.reasonCode ? `: <code>${node.reasonCode}</code>` : ''}`
        : `• 🚫 Unscheduled${node.reasonCode ? `: <code>${node.reasonCode}</code>` : ''}`;
    default:
      return isPt ? '• …' : '• …';
  }
}

function labelForStatus(status: string, lang: Lang): string {
  const isPt = lang === 'pt-PT' || lang === 'pt-BR';
  const ptMap: Record<string, string> = {
    scheduled: 'Agendado',
    reflowed: 'Realocado',
    compressed: 'Comprimido',
    deferred: 'Adiado',
    unscheduled: 'Sem horário',
    rejected: 'Rejeitado',
    needs_more_context: 'Precisa mais contexto',
  };
  const enMap: Record<string, string> = {
    scheduled: 'Scheduled',
    reflowed: 'Reflowed',
    compressed: 'Compressed',
    deferred: 'Deferred',
    unscheduled: 'Unscheduled',
    rejected: 'Rejected',
    needs_more_context: 'Needs more context',
  };
  return (isPt ? ptMap : enMap)[status] ?? status;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
