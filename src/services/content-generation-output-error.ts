// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export interface ContentGenerationProvenance {
  provider: string;
  grounded: boolean;
}

/**
 * A provider completed successfully at the transport layer, but its output
 * could not satisfy the Content structured-output contract. Callers must not
 * turn this into an empty successful generation response.
 */
export class ContentGenerationOutputError extends Error {
  readonly code = 'CONTENT_GENERATION_OUTPUT_INVALID';
  readonly status = 502;
  readonly details: Record<string, unknown>;

  constructor(
    reason: string,
    provenance: ContentGenerationProvenance,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super('The content provider returned an invalid structured response.');
    this.name = 'ContentGenerationOutputError';
    this.details = {
      ...context,
      reason,
      provider: provenance.provider,
      grounded: provenance.grounded,
    };
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function isContentGenerationOutputError(
  error: unknown,
): error is ContentGenerationOutputError {
  return error instanceof ContentGenerationOutputError;
}
