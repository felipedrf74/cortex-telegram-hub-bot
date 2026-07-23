// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Load model overrides after database migrations without weakening the startup
 * boundary. The dynamic require preserves the existing database/model-config
 * cycle, while policy errors from persisted Ollama selectors remain fatal.
 */
export function loadPersistedModelOverrides(
  loader: () => void = () => {
    const { loadModelOverrides } = require('./model-config');
    loadModelOverrides();
  },
): void {
  loader();
}
