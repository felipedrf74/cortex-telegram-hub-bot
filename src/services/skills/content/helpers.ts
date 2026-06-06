// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionName } from '../../chat/registry';

export function missingContentAgencySlots(action: ChatActionName, args: Record<string, unknown>): string[] {
  if (action !== 'content_brief_create' && action !== 'content_script_create') return [];
  const required = action === 'content_script_create'
    ? ['topic', 'platform']
    : ['objective', 'platform'];
  return required.filter((field) => isMissingContentSlot(field, args[field]));
}

function isMissingContentSlot(field: string, value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (field === 'platform' && trimmed === 'generic') return true;
  return false;
}
