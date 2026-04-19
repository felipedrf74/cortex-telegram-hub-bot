// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ScreenContractSource = 'server' | 'localFallback';

export interface ScreenContractMeta {
  source: ScreenContractSource;
  isFallback: boolean;
  isPartial: boolean;
  isStale: boolean;
  generatedAt: string | null;
  reasonCodes: string[];
}

export function buildScreenContractMeta(
  partial: Partial<ScreenContractMeta> & Pick<ScreenContractMeta, 'source'>,
): ScreenContractMeta {
  const baseReasonCodes = partial.source === 'localFallback' ? ['LOCAL_FALLBACK'] : [];
  const reasonCodes = Array.from(new Set([...baseReasonCodes, ...(partial.reasonCodes ?? [])]))
    .filter((code) => typeof code === 'string' && code.trim().length > 0);

  return {
    source: partial.source,
    isFallback: partial.isFallback ?? (partial.source === 'localFallback'),
    isPartial: partial.isPartial ?? false,
    isStale: partial.isStale ?? false,
    generatedAt: partial.generatedAt ?? null,
    reasonCodes,
  };
}
