// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

type TaskListLike = {
  id: string;
  displayName?: string;
  name?: string;
  wellknownListName?: string;
};

type TaskProviderLike = {
  getLists?: () => Promise<any>;
  findListByName?: (name: string) => Promise<any>;
  getDefaultList?: () => Promise<any>;
};

const CAPTURE_LIST_ALIASES = ['inbox', 'tasks', 'tarefas'];

function normalizeListName(name: unknown): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

export function isCaptureListAlias(name: unknown): boolean {
  const normalized = normalizeListName(name);
  return CAPTURE_LIST_ALIASES.includes(normalized);
}

function extractLists(result: any): TaskListLike[] {
  const candidate = result?.data || result || [];
  return Array.isArray(candidate) ? candidate : [];
}

function listDisplayName(list: TaskListLike | null | undefined): string {
  return String(list?.displayName || list?.name || '').trim();
}

export async function resolvePreferredCaptureList(todo: TaskProviderLike): Promise<TaskListLike | null> {
  const listsResult = await todo.getLists?.();
  const lists = extractLists(listsResult);

  const aliasMatch = lists.find((list) => isCaptureListAlias(listDisplayName(list)));
  if (aliasMatch) return aliasMatch;

  const wellKnownDefault = lists.find((list) => list?.wellknownListName === 'defaultList');
  if (wellKnownDefault) return wellKnownDefault;

  if (todo.findListByName) {
    for (const alias of ['Tasks', 'Tarefas', 'Inbox']) {
      const match = await todo.findListByName(alias);
      if (match) return match;
    }
  }

  return (await todo.getDefaultList?.()) || null;
}

export async function resolveTaskCreationList(
  todo: TaskProviderLike,
  requestedListName?: string | null,
): Promise<TaskListLike | null> {
  const trimmed = String(requestedListName || '').trim();
  if (!trimmed || isCaptureListAlias(trimmed)) {
    return resolvePreferredCaptureList(todo);
  }

  const explicit = await todo.findListByName?.(trimmed);
  if (explicit) return explicit;

  return (await todo.getDefaultList?.()) || null;
}
