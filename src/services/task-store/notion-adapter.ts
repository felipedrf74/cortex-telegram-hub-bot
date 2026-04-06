// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Notion Task Provider Adapter (TASK-16b)
 *
 * Treats one or more Notion databases per user as task lists. The mapping
 * between Notion's user-defined properties and Nexus's normalized fields
 * is stored in `notion-mapping.ts` (kv_store-backed). Until a database
 * has a mapping, the adapter doesn't sync it.
 *
 * Capabilities differ from Todoist:
 *   - hasWebhooks: false   — Notion has no public webhook system, polling only
 *   - hasIncrementalSync: false  — Notion's filter_after_timestamp is too coarse
 *   - canDelete: false     — Notion archives instead of deletes; we don't expose
 *                            archive in the API to avoid surprising users
 */

import { logger } from '../../utils/logger';
import { getTokens, isConnected } from '../oauth-store';
import { TaskProviderAdapter } from './adapter-interface';
import {
  NormalizedProject,
  NormalizedStatus,
  NormalizedTask,
  TaskProviderCapabilities,
} from './types';
import {
  NotionDatabaseMapping,
  getDatabaseMappings,
  getActiveDatabase,
} from './notion-mapping';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export class NotionAdapter implements TaskProviderAdapter {
  readonly provider = 'notion' as const;

  readonly capabilities: TaskProviderCapabilities = {
    canCreate: true,
    canComplete: true,
    canDelete: false,
    canUpdate: true,
    canAssignDue: true,
    hasWebhooks: false,
    hasIncrementalSync: false,
  };

  isConnected(userId: number): boolean {
    return isConnected(userId, 'notion');
  }

  // ── Reads ───────────────────────────────────────────────────────

  async getProjects(userId: number): Promise<NormalizedProject[]> {
    // For Notion, each mapped database IS a project. We don't list every
    // database in the workspace — that would expose private databases the
    // user didn't opt in to syncing.
    const mappings = getDatabaseMappings(userId);
    return mappings.map((m) => ({
      provider: 'notion' as const,
      externalId: m.databaseId,
      name: m.databaseName,
      isDefault: getActiveDatabase(userId) === m.databaseId,
    }));
  }

  async getTasks(
    userId: number,
    options?: { projectId?: string; sinceCursor?: string },
  ): Promise<{ tasks: NormalizedTask[]; nextCursor?: string }> {
    const token = this.getToken(userId);
    if (!token) return { tasks: [] };

    const mappings = getDatabaseMappings(userId);
    if (mappings.length === 0) return { tasks: [] };

    const allTasks: NormalizedTask[] = [];

    for (const mapping of mappings) {
      // Allow callers to scope to a single database
      if (options?.projectId && mapping.databaseId !== options.projectId) continue;

      try {
        const pages = await this.queryDatabase(token, mapping.databaseId);
        for (const page of pages) {
          const task = this.mapPageToTask(page, mapping);
          if (task) allTasks.push(task);
        }
      } catch (err) {
        logger.warn({ err, databaseId: mapping.databaseId }, 'Notion database query failed');
      }
    }

    return { tasks: allTasks };
  }

  /**
   * Page through every page in a Notion database. Notion paginates with a
   * `start_cursor`/`has_more` cursor; we follow it until exhausted.
   *
   * Cap at 1000 pages per database to defeat pathological inputs (a database
   * with 50k pages would otherwise burn through the rate limit).
   */
  private async queryDatabase(token: string, databaseId: string): Promise<any[]> {
    const PAGE_SIZE = 100;
    const HARD_CAP = 1000;
    const all: any[] = [];
    let cursor: string | undefined = undefined;

    while (all.length < HARD_CAP) {
      const body: any = { page_size: PAGE_SIZE };
      if (cursor) body.start_cursor = cursor;

      const response = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Notion query failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as any;
      all.push(...(data.results || []));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    return all;
  }

  // ── Writes ──────────────────────────────────────────────────────

  async createTask(
    userId: number,
    task: Omit<NormalizedTask, 'id' | 'provider' | 'externalId'>,
  ): Promise<NormalizedTask> {
    const token = this.getToken(userId);
    if (!token) throw new Error('Notion not connected');

    const mappings = getDatabaseMappings(userId);
    if (mappings.length === 0) throw new Error('No Notion database configured — finish /connect notion setup first');

    // Pick the user's active database, or fall back to the first mapped one
    const activeId = getActiveDatabase(userId);
    const mapping = (activeId && mappings.find((m) => m.databaseId === activeId)) || mappings[0];

    const properties: Record<string, any> = {
      [mapping.titleProperty]: {
        title: [{ text: { content: task.title } }],
      },
    };

    // Status — pick the Notion option that maps to our requested status
    if (mapping.statusProperty) {
      const notionStatusName = Object.entries(mapping.statusMapping).find(
        ([, nexus]) => nexus === task.status,
      )?.[0];
      if (notionStatusName) {
        // Try `status` type first; if the user mapped a `select`-type property
        // we'd use { select: { name } } instead. We can't tell from the mapping
        // alone, so we set both shapes — Notion ignores whichever doesn't match.
        properties[mapping.statusProperty] = {
          status: { name: notionStatusName },
          select: { name: notionStatusName },
        };
      }
    }

    if (mapping.dueDateProperty && task.dueDate) {
      properties[mapping.dueDateProperty] = { date: { start: task.dueDate } };
    }

    if (mapping.tagsProperty && task.tags && task.tags.length > 0) {
      properties[mapping.tagsProperty] = {
        multi_select: task.tags.map((name) => ({ name })),
      };
    }

    const response = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: mapping.databaseId },
        properties,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Notion createTask failed: ${response.status} ${text}`);
    }

    const page = (await response.json()) as any;
    const mapped = this.mapPageToTask(page, mapping);
    if (!mapped) {
      throw new Error('Notion returned a page without a recognizable title');
    }
    return mapped;
  }

  async completeTask(userId: number, externalId: string): Promise<void> {
    const token = this.getToken(userId);
    if (!token) throw new Error('Notion not connected');

    const mappings = getDatabaseMappings(userId);

    // Find the mapping that owns this page. We don't know which database the
    // page lives in just from its id, so we try each mapping in turn until
    // one accepts the PATCH.
    for (const mapping of mappings) {
      if (!mapping.statusProperty) continue;

      const completedNotionStatus = Object.entries(mapping.statusMapping).find(
        ([, nexus]) => nexus === 'completed',
      )?.[0];
      if (!completedNotionStatus) continue;

      const response = await fetch(`${NOTION_API}/pages/${externalId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            [mapping.statusProperty]: {
              status: { name: completedNotionStatus },
              select: { name: completedNotionStatus },
            },
          },
        }),
      });

      if (response.ok) return;
      // 404 means this page doesn't belong to this database — try the next mapping
      if (response.status !== 404) {
        const text = await response.text();
        logger.warn({ status: response.status, text }, 'Notion completeTask non-404 error');
      }
    }

    logger.warn({ externalId }, 'Notion completeTask: no mapping accepted the page');
  }

  async deleteTask(_userId: number, _externalId: string): Promise<void> {
    // Notion's API doesn't really delete — it archives. We expose canDelete:false
    // so the task service falls back to local soft-delete only.
    throw new Error('Notion adapter does not support delete');
  }

  // ── Mapping helpers ────────────────────────────────────────────

  /**
   * Convert a Notion page response into a NormalizedTask.
   *
   * Returns null if the page is missing the configured title property — this
   * is the only way to spot pages whose schema drifted away from the mapping
   * (e.g., user renamed their title column without updating the mapping).
   */
  mapPageToTask(page: any, mapping: NotionDatabaseMapping): NormalizedTask | null {
    const properties = page?.properties || {};
    const titleArr = properties[mapping.titleProperty]?.title || [];
    const title = titleArr.map((t: any) => t.plain_text || '').join('').trim();
    if (!title) return null;

    let status: NormalizedStatus = 'pending';
    if (mapping.statusProperty) {
      const prop = properties[mapping.statusProperty];
      const rawStatus =
        prop?.status?.name || prop?.select?.name || undefined;
      if (rawStatus && mapping.statusMapping[rawStatus]) {
        status = mapping.statusMapping[rawStatus];
      }
    }

    let dueDate: string | undefined;
    let dueIsDatetime = false;
    if (mapping.dueDateProperty) {
      const dateProp = properties[mapping.dueDateProperty]?.date;
      if (dateProp?.start) {
        dueDate = dateProp.start;
        dueIsDatetime = dateProp.start.includes('T');
      }
    }

    let priority = 0;
    if (mapping.priorityProperty) {
      const prop = properties[mapping.priorityProperty];
      const raw = prop?.select?.name || prop?.number;
      if (typeof raw === 'string') {
        const lower = raw.toLowerCase();
        if (/urgent|urgente/.test(lower)) priority = 4;
        else if (/high|alta/.test(lower)) priority = 3;
        else if (/medium|media|média/.test(lower)) priority = 2;
        else if (/low|baixa/.test(lower)) priority = 1;
      } else if (typeof raw === 'number') {
        priority = Math.max(0, Math.min(4, Math.round(raw)));
      }
    }

    let tags: string[] = [];
    if (mapping.tagsProperty) {
      const multi = properties[mapping.tagsProperty]?.multi_select || [];
      tags = multi.map((t: any) => t.name).filter(Boolean);
    }

    return {
      provider: 'notion',
      externalId: page.id,
      title,
      status,
      priority,
      dueDate,
      dueIsDatetime,
      tags,
      url: page.url || undefined,
      projectName: mapping.databaseName,
      providerData: page,
    };
  }

  // ── Internal ────────────────────────────────────────────────────

  private getToken(userId: number): string | null {
    const tokens = getTokens(userId, 'notion');
    if (!tokens) {
      logger.debug({ userId }, 'Notion not connected');
      return null;
    }
    return tokens.accessToken;
  }
}
