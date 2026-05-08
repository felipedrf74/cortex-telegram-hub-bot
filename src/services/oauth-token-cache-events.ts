// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export interface OAuthTokenMutationEvent {
  userId: number;
  provider: string;
}

type OAuthTokenMutationListener = (event: OAuthTokenMutationEvent) => void;

const listeners = new Set<OAuthTokenMutationListener>();

export function registerOAuthTokenMutationListener(listener: OAuthTokenMutationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyOAuthTokenMutation(event: OAuthTokenMutationEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

export function _resetOAuthTokenMutationListenersForTests(): void {
  listeners.clear();
}
