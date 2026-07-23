// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Invoke the late-bound model override loader without weakening the startup
 * boundary. Database owns the dynamic import needed for its model-config
 * cycle, while this boundary keeps policy errors fatal and directly testable.
 */
export function loadPersistedModelOverrides(loader: () => void): void {
  loader();
}
