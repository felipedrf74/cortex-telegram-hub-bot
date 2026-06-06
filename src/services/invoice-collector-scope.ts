// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { isOwnerUserRef } from './user-service';

export type GlobalInvoiceCollectorProvider = 'Amazon' | 'Uber';

export class GlobalInvoiceCollectorScopeError extends Error {
  readonly code = 'GLOBAL_INVOICE_COLLECTOR_OWNER_ONLY';
  readonly provider: GlobalInvoiceCollectorProvider;
  readonly userId: number;

  constructor(provider: GlobalInvoiceCollectorProvider, userId: number) {
    super(`${provider} invoice collection uses global browser credentials and is owner-only until per-user sessions exist.`);
    this.name = 'GlobalInvoiceCollectorScopeError';
    this.provider = provider;
    this.userId = userId;
  }
}

export function isGlobalInvoiceCollectorOwnerUser(userId: number): boolean {
  return isOwnerUserRef(userId);
}

export function assertGlobalInvoiceCollectorOwnerScope(
  provider: GlobalInvoiceCollectorProvider,
  userId: number,
): void {
  if (!isGlobalInvoiceCollectorOwnerUser(userId)) {
    throw new GlobalInvoiceCollectorScopeError(provider, userId);
  }
}
