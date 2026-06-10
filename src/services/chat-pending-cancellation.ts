// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export function isPendingChatWorkCancellationTurn(text: string): boolean {
  const folded = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^(?:cancel|cancelar|never\s*mind|nevermind|forget\s+it|nvm|esquece|deixa(?:\s+(?:pra|para)\s+la)?|deixa\s+estar)[.!?]*$/.test(folded);
}
