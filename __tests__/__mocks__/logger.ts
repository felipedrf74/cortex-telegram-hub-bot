import { vi } from 'vitest';

const child = vi.fn();

export const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child,
};

child.mockReturnValue(logger);

export const LOGGER_REDACTION_PATHS = [] as const;
