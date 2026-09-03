// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { invalidateContentDerivedCaches as invalidateCanonicalContentCaches } from './cache-coherence-registry';

/**
 * Content writes affect creator workflow state plus the Home/plan surfaces that
 * summarize next-best creative action. Keep that ownership here so Content
 * routes do not need to know the exact downstream cache families.
 */
export function invalidateContentDerivedCaches(userId?: number): void {
  invalidateCanonicalContentCaches(userId);
}
