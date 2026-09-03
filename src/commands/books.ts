// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Book Knowledge bot commands — /addbook, /booknote, /books, /bookidea
 */

import { getDb } from '../services/database';
import { writeGovernedSignal } from '../services/intelligence-bus';
import { escapeHtml } from '../utils/chat-html-formatter';
import { logger } from '../utils/logger';
import { getCurrentRequestId, generateRequestId } from '../utils/request-context';
import { config } from '../config';
import {
  contentEngineApiBaseUrl,
  ForwardedAiBudgetError,
  ForwardedContentPolicyError,
  ForwardedLocalInferenceError,
  parseForwardedContentEngineError,
} from '../services/content-engine';
import {
  AiBudgetError,
  withAiBudgetReservation,
} from '../services/cost-guardrail';
import { normalizeContentOutputLanguage } from '../services/content-output-language';
import { createInternalAttributionToken } from '../services/internal-attribution';
import { getContentCreatorProfile } from '../state/content-creator-profile';
import {
  contentScopeForInsert,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
  platformOrSystemSeedContentScopePredicate,
} from '../services/content-tenant-scope';

const CONTENT_ENGINE_URL = contentEngineApiBaseUrl();
const BOOKS_SIGNAL_PRODUCER_VERSION = 'books-command.v1';

function safeErrorName(error: unknown): string {
  const candidate = error instanceof Error && error.name ? error.name : typeof error;
  return candidate.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'UnknownError';
}

// ── Seed books (extracted on first deploy if table is empty) ────────

// Seed books are explicit operator configuration. Missing/empty config must
// stay neutral instead of projecting a founder-specific canon globally.
function getSeedBooks(): Array<{ title: string; author: string }> {
  try {
    const rows = getDb().prepare(
      'SELECT title, author FROM config_seed_books WHERE enabled = 1'
    ).all() as Array<{ title: string; author: string }>;
    if (rows.length > 0) return rows;
  } catch { /* table does not exist yet */ }
  return [];
}

/**
 * Seed default books if the library is empty. Called on startup.
 * Extraction runs asynchronously — does not block.
 */
export function seedBooksIfEmpty(sendAlert: (msg: string) => Promise<void>): void {
  const db = getDb();
  const seedBooks = getSeedBooks();
  if (seedBooks.length === 0) return;
  ensureContentTenantScopeColumns(db);
  const count = (db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM book_library
     WHERE ${platformOrSystemSeedContentScopePredicate()}
  `).get() as { cnt?: number } | undefined)?.cnt ?? 0;
  if (count > 0) return;

  logger.info('Seeding book library with %d configured books', seedBooks.length);
  const systemScope = contentScopeForInsert(0, 0, 'platform_internal', 'pending');

  // Insert all as 'pending', then extract sequentially in background
  for (const book of seedBooks) {
    db.prepare(`
      INSERT INTO book_library (
        title, author, extraction_status, user_id, owner_scope, tenant_id,
        owner_user_id, visibility_scope, lifecycle_state, scope_status,
        created_by, updated_by, audit_metadata_json
      )
      VALUES (?, ?, 'pending', 0, 'system', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, title, author) DO UPDATE SET
        extraction_status = 'pending',
        owner_scope = 'system',
        tenant_id = excluded.tenant_id,
        owner_user_id = excluded.owner_user_id,
        visibility_scope = excluded.visibility_scope,
        lifecycle_state = excluded.lifecycle_state,
        scope_status = excluded.scope_status,
        updated_by = excluded.updated_by
    `).run(
      book.title,
      book.author,
      systemScope.tenantId,
      systemScope.ownerUserId,
      systemScope.visibilityScope,
      systemScope.lifecycleState,
      systemScope.scopeStatus,
      systemScope.createdBy,
      systemScope.updatedBy,
      systemScope.auditMetadataJson,
    );
  }

  // Fire-and-forget extraction
  (async () => {
    for (let i = 0; i < seedBooks.length; i++) {
      const book = seedBooks[i];
      try {
        await sendAlert(`📚 Seeding book library... ${i + 1}/${seedBooks.length} <b>${escapeHtml(book.title)}</b> — extracting...`);
        await extractAndStore(book.title, book.author);
        // 10s delay between books to avoid rate limits
        if (i < seedBooks.length - 1) {
          await new Promise(r => setTimeout(r, 10_000));
        }
      } catch (err: any) {
        logger.error(
          { errorName: safeErrorName(err), titleLength: book.title.length },
          'Failed to seed book',
        );
      }
    }
    await sendAlert(`📚 Book library seeding complete! ${seedBooks.length} books extracted.`);
  })().catch(err => logger.error({ errorName: safeErrorName(err) }, 'Book seeding failed'));
}

// ── Core extraction function ────────────────────────────────────────

type PortalBookScope = {
  userId: number;
  tenantId?: number;
};

type BookExtractionOptions = {
  abortSignal?: AbortSignal;
  creatorContext?: BookCreatorContext;
};

type BookCreatorContext = {
  creatorProfile: string | undefined;
  language: ReturnType<typeof normalizeContentOutputLanguage>;
};

type ExtractedBookFramework = {
  name: string;
  description: string;
  use_in_content?: string;
  pillar?: string;
};

type ExtractedBookIdea = {
  idea: string;
  context?: string;
  use_when?: string;
};

type ExtractedBook = {
  title: string;
  author: string;
  core_thesis: string;
  key_frameworks: ExtractedBookFramework[];
  quotable_ideas: ExtractedBookIdea[];
  pillar_mapping: string[];
  counter_arguments: string[];
  related_thinkers: string[];
  personal_notes: string[];
};

type BookExtractionResult = {
  book: ExtractedBook;
  degraded: boolean;
  warnings: Array<'research_source_unavailable'>;
};

class ContentBookExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 409 | 422 | 429 | 502 | 503 = 502,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentBookExtractionError';
  }
}

function resolveBookCreatorContext(scope?: PortalBookScope): BookCreatorContext {
  if (!scope) {
    return { creatorProfile: undefined, language: 'en-US' };
  }

  try {
    const profile = getContentCreatorProfile(scope.userId, scope.tenantId);
    const language = normalizeContentOutputLanguage(profile.languagePreference, 'en-US');
    const creatorProfile = [
      'Creator scope: current authenticated Nexus Hub user only.',
      `Primary output language: ${language}.`,
      profile.audience ? `Audience: ${profile.audience}` : null,
      profile.pillars.length > 0 ? `Pillars: ${profile.pillars.join(', ')}` : null,
      profile.niches.length > 0 ? `Niches: ${profile.niches.join(', ')}` : null,
      profile.voiceRules.length > 0 ? `Voice rules: ${profile.voiceRules.join('; ')}` : null,
      profile.contentGoals.length > 0 ? `Content goals: ${profile.contentGoals.join('; ')}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n').slice(0, 6000);
    return { creatorProfile, language };
  } catch (err) {
    logger.warn(
      { errorName: safeErrorName(err), userId: scope.userId, tenantId: scope.tenantId },
      'Book extraction creator profile unavailable',
    );
    throw new ContentBookExtractionError(
      'CONTENT_CREATOR_PROFILE_UNAVAILABLE',
      'The creator profile is temporarily unavailable. No book extraction was started.',
      503,
      { retryable: true },
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, maxLength: number, allowFormattingWhitespace = false): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < 1 || text.length > maxLength) return null;
  const unsupported = allowFormattingWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
    : /[\u0000-\u001f\u007f-\u009f]/;
  return unsupported.test(text) ? null : text;
}

function readOptionalBoundedString(
  value: unknown,
  maxLength: number,
  allowFormattingWhitespace = false,
): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return readBoundedString(value, maxLength, allowFormattingWhitespace);
}

function readBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
  allowFormattingWhitespace = false,
): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const values = value.map((item) => readBoundedString(item, maxLength, allowFormattingWhitespace));
  return values.every((item): item is string => item !== null) ? values : null;
}

function readBookFrameworks(value: unknown): ExtractedBookFramework[] | null {
  if (!Array.isArray(value) || value.length > 6) return null;
  const frameworks: ExtractedBookFramework[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) return null;
    const name = readBoundedString(item.name, 500);
    const description = readBoundedString(item.description, 4_000, true);
    const useInContent = readOptionalBoundedString(item.use_in_content, 4_000, true);
    const pillar = readOptionalBoundedString(item.pillar, 500);
    if (!name || !description || useInContent === null || pillar === null) return null;
    frameworks.push({
      name,
      description,
      ...(useInContent ? { use_in_content: useInContent } : {}),
      ...(pillar ? { pillar } : {}),
    });
  }
  return frameworks;
}

function readBookIdeas(value: unknown): ExtractedBookIdea[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const ideas: ExtractedBookIdea[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) return null;
    const idea = readBoundedString(item.idea, 4_000, true);
    const context = readOptionalBoundedString(item.context, 4_000, true);
    const useWhen = readOptionalBoundedString(item.use_when, 4_000, true);
    if (!idea || context === null || useWhen === null) return null;
    ideas.push({
      idea,
      ...(context ? { context } : {}),
      ...(useWhen ? { use_when: useWhen } : {}),
    });
  }
  return ideas;
}

function invalidBookOutput(): ContentBookExtractionError {
  return new ContentBookExtractionError(
    'CONTENT_BOOK_OUTPUT_INVALID',
    'Content Engine book extraction response did not match the bounded contract.',
    502,
    { retryable: true },
  );
}

function validateBookExtractionResponse(
  value: unknown,
  expectedTitle: string,
  expectedAuthor: string,
): BookExtractionResult {
  if (
    !isPlainRecord(value)
    || typeof value.duration_ms !== 'number'
    || !Number.isSafeInteger(value.duration_ms)
    || value.duration_ms < 0
  ) {
    throw invalidBookOutput();
  }
  if (!isPlainRecord(value.quality_report)) throw invalidBookOutput();
  const warnings = readBoundedStringArray(value.quality_report.warnings, 10, 500);
  if (!warnings) throw invalidBookOutput();
  const allowedWarnings = new Set([
    'prompt_over_budget',
    'prompt_section_truncated',
    'no_source_data',
    'research_source_unavailable',
    'provider_output_invalid',
  ]);
  if (warnings.some((warning) => !allowedWarnings.has(warning))) throw invalidBookOutput();
  if (warnings.includes('no_source_data')) {
    throw new ContentBookExtractionError(
      'CONTENT_BOOK_SOURCE_UNAVAILABLE',
      'Book extraction requires usable research sources before it can be stored.',
      503,
      { retryable: true },
    );
  }
  if (warnings.includes('provider_output_invalid')) throw invalidBookOutput();
  if (!isPlainRecord(value.book)) throw invalidBookOutput();

  const responseTitle = readBoundedString(value.book.title, 500);
  const responseAuthor = readBoundedString(value.book.author, 500);
  const coreThesis = readBoundedString(value.book.core_thesis, 4_000, true);
  const keyFrameworks = readBookFrameworks(value.book.key_frameworks);
  const quotableIdeas = readBookIdeas(value.book.quotable_ideas);
  const pillarMapping = readBoundedStringArray(value.book.pillar_mapping, 20, 500);
  const counterArguments = readBoundedStringArray(value.book.counter_arguments, 20, 4_000, true);
  const relatedThinkers = readBoundedStringArray(value.book.related_thinkers, 20, 500);
  const personalNotes = readBoundedStringArray(value.book.personal_notes, 20, 4_000, true);
  if (
    !responseTitle
    || !responseAuthor
    || responseTitle !== expectedTitle.trim()
    || responseAuthor !== expectedAuthor.trim()
    || !coreThesis
    || !keyFrameworks
    || !quotableIdeas
    || !pillarMapping
    || !counterArguments
    || !relatedThinkers
    || !personalNotes
  ) {
    throw invalidBookOutput();
  }
  const sourceWarnings: Array<'research_source_unavailable'> = warnings.includes('research_source_unavailable')
    ? ['research_source_unavailable']
    : [];
  return {
    book: {
      title: responseTitle,
      author: responseAuthor,
      core_thesis: coreThesis,
      key_frameworks: keyFrameworks,
      quotable_ideas: quotableIdeas,
      pillar_mapping: pillarMapping,
      counter_arguments: counterArguments,
      related_thinkers: relatedThinkers,
      personal_notes: personalNotes,
    },
    degraded: sourceWarnings.length > 0,
    warnings: sourceWarnings,
  };
}

function throwIfBookExtractionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('content_book_client_disconnected'), {
      name: 'AbortError',
      code: 'CONTENT_CLIENT_DISCONNECTED',
    });
}

function bookWhere(title: string, author: string, scope?: PortalBookScope): { clause: string; params: unknown[] } {
  if (!scope) {
    return {
      clause: `title = ? AND author = ? AND ${platformOrSystemSeedContentScopePredicate()}`,
      params: [title, author],
    };
  }
  return {
    clause: `title = ? AND author = ? AND ${contentScopePredicate()}`,
    params: [title, author, ...contentScopeParams(scope.userId, scope.tenantId)],
  };
}

function restoreCancelledBookExtraction(
  db: ReturnType<typeof getDb>,
  where: { clause: string; params: unknown[] },
): void {
  // The public add/retry paths place the row in `pending` before extraction.
  // Restore only our still-in-flight marker so a concurrent terminal update is
  // never overwritten by a late disconnect handler.
  db.prepare(`
    UPDATE book_library
       SET extraction_status = 'pending',
           updated_at = datetime('now')
     WHERE ${where.clause}
       AND extraction_status = 'extracting'
  `).run(...where.params);
}

async function extractAndStore(
  title: string,
  author: string,
  scope?: PortalBookScope,
  options: BookExtractionOptions = {},
): Promise<Omit<BookExtractionResult, 'book'>> {
  throwIfBookExtractionAborted(options.abortSignal);
  // Resolve private creator context before changing lifecycle state. A failed
  // profile read must leave both new and existing library rows untouched.
  const { creatorProfile, language } = options.creatorContext ?? resolveBookCreatorContext(scope);
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const where = bookWhere(title, author, scope);

  // Mark as extracting
  db.prepare(`UPDATE book_library SET extraction_status = 'extracting' WHERE ${where.clause}`)
    .run(...where.params);

  try {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(
      options.abortSignal?.reason instanceof Error
        ? options.abortSignal.reason
        : Object.assign(new Error('content_book_client_disconnected'), {
          name: 'AbortError',
          code: 'CONTENT_CLIENT_DISCONNECTED',
        }),
    );
    if (options.abortSignal?.aborted) abortFromCaller();
    else options.abortSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(
      new Error('content_book_extraction_timed_out'),
      { name: 'TimeoutError', code: 'CONTENT_BOOK_EXTRACTION_TIMEOUT' },
    )), 180_000);

    // Distributed tracing: propagate the current requestId so the Python
    // content-engine can log it. Same pattern as engineFetch in
    // services/content-engine.ts. (Quarter audit item.)
    const requestId = getCurrentRequestId() || generateRequestId();
    let data: unknown;
    try {
      const resp = await fetch(`${CONTENT_ENGINE_URL}/books/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
          'X-Internal-Secret': config.contentEngine.internalApiSecret,
        },
        body: JSON.stringify({
          title,
          author,
          creator_profile: creatorProfile,
          language,
          user_id: scope?.userId,
          tenant_id: scope?.tenantId ?? scope?.userId,
          internal_attribution_token: scope
            ? createInternalAttributionToken({
                userId: scope.userId,
                tenantId: scope.tenantId ?? scope.userId,
                category: 'content_engine_book',
              }) ?? undefined
            : undefined,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = (await resp.text()).slice(0, 8_192);
        const forwardedError = parseForwardedContentEngineError(resp, body);
        if (forwardedError instanceof ForwardedAiBudgetError) throw forwardedError;
        if (forwardedError instanceof ForwardedContentPolicyError) {
          throw new ContentBookExtractionError(
            forwardedError.code,
            forwardedError.publicMessage,
            forwardedError.status,
            { ...forwardedError.details },
          );
        }
        if (forwardedError instanceof ForwardedLocalInferenceError) {
          if (forwardedError.code === 'ACCOUNT_DELETION_IN_PROGRESS') throw forwardedError;
          throw new ContentBookExtractionError(
            forwardedError.code,
            forwardedError.publicMessage,
            forwardedError.status,
            { ...forwardedError.details },
          );
        }
        throw new ContentBookExtractionError(
          'CONTENT_BOOK_ENGINE_REQUEST_FAILED',
          'Content Engine book extraction is temporarily unavailable.',
          503,
          { retryable: true },
        );
      }
      data = await resp.json() as unknown;
    } finally {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', abortFromCaller);
    }
    throwIfBookExtractionAborted(options.abortSignal);
    const extraction = validateBookExtractionResponse(data, title, author);
    const { book } = extraction;

    // Store extracted knowledge
    throwIfBookExtractionAborted(options.abortSignal);
    db.prepare(`
      UPDATE book_library SET
        core_thesis = ?,
        key_frameworks = ?,
        quotable_ideas = ?,
        pillar_mapping = ?,
        personal_notes = ?,
        extraction_status = 'extracted',
        extraction_date = datetime('now')
      WHERE ${where.clause}
    `).run(
      book.core_thesis,
      JSON.stringify(book.key_frameworks),
      JSON.stringify(book.quotable_ideas),
      JSON.stringify(book.pillar_mapping),
      JSON.stringify(book.personal_notes || []),
      ...where.params,
    );

    // The legacy content mesh treats book_knowledge as global. Avoid writing
    // tenant/user-scoped portal books into that bus until shared context has
    // tenant namespaces for content reference signals.
    if (!scope) {
      throwIfBookExtractionAborted(options.abortSignal);
      writeGovernedSignal({
        source_agent: 'book-extractor',
        signal_type: 'book_knowledge',
        provenance: {
          producerVersion: BOOKS_SIGNAL_PRODUCER_VERSION,
          source: 'runtime',
          observedAt: new Date().toISOString(),
        },
        payload: {
          title: book.title,
          author: book.author,
          core_thesis: book.core_thesis,
          key_frameworks: book.key_frameworks,
          pillar_mapping: book.pillar_mapping,
          quotable_ideas: book.quotable_ideas,
          counter_arguments: book.counter_arguments,
          related_thinkers: book.related_thinkers,
        },
      });
    }

    logger.info({ titleLength: title.length, authorLength: author.length }, 'Book extracted and stored');
    return { degraded: extraction.degraded, warnings: extraction.warnings };
  } catch (err: any) {
    if (options.abortSignal?.aborted) {
      restoreCancelledBookExtraction(db, where);
      throwIfBookExtractionAborted(options.abortSignal);
    }
    db.prepare(`UPDATE book_library SET extraction_status = 'failed' WHERE ${where.clause}`)
      .run(...where.params);
    throw err;
  }
}

// ── Portal Handler (no Telegram context) ────────────────────────────

export async function handleAddBookFromPortal(
  title: string,
  author: string,
  scope?: PortalBookScope,
  options: BookExtractionOptions = {},
): Promise<{
  ok: boolean;
  message: string;
  code?: string;
  status?: 400 | 403 | 409 | 422 | 429 | 502 | 503;
  details?: Record<string, unknown>;
  degraded?: boolean;
  warnings?: Array<'research_source_unavailable'>;
}> {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const where = bookWhere(title, author, scope);
  const existing = db.prepare(`SELECT extraction_status FROM book_library WHERE ${where.clause}`)
    .get(...where.params) as any;

  if (existing?.extraction_status === 'extracted') {
    return { ok: true, message: `${title} already in library` };
  }

  try {
    // Profile availability is an admission prerequisite. Resolve it before
    // quota reservation and before inserting or changing any library row.
    const creatorContext = resolveBookCreatorContext(scope);
    const startExtraction = async (): Promise<Omit<BookExtractionResult, 'book'>> => {
      throwIfBookExtractionAborted(options.abortSignal);
      if (scope) {
        const insertScope = contentScopeForInsert(scope.userId, scope.tenantId, 'user_private', 'pending');
        db.prepare(`
          INSERT INTO book_library (
            title, author, extraction_status, user_id, owner_scope, tenant_id,
            owner_user_id, visibility_scope, lifecycle_state, scope_status,
            created_by, updated_by, audit_metadata_json
          )
          VALUES (?, ?, 'pending', ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, title, author) DO UPDATE SET
            extraction_status = 'pending',
            tenant_id = excluded.tenant_id,
            owner_user_id = excluded.owner_user_id,
            visibility_scope = excluded.visibility_scope,
            lifecycle_state = excluded.lifecycle_state,
            scope_status = excluded.scope_status,
            updated_by = excluded.updated_by,
            updated_at = datetime('now')
        `).run(
          title,
          author,
          scope.userId,
          insertScope.tenantId,
          insertScope.ownerUserId,
          insertScope.visibilityScope,
          insertScope.lifecycleState,
          insertScope.scopeStatus,
          insertScope.createdBy,
          insertScope.updatedBy,
          insertScope.auditMetadataJson,
        );
      } else {
        const systemScope = contentScopeForInsert(0, 0, 'platform_internal', 'pending');
        db.prepare(`
          INSERT INTO book_library (
            title, author, extraction_status, user_id, owner_scope, tenant_id,
            owner_user_id, visibility_scope, lifecycle_state, scope_status,
            created_by, updated_by, audit_metadata_json
          )
          VALUES (?, ?, 'pending', 0, 'system', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, title, author) DO UPDATE SET
            extraction_status = 'pending',
            owner_scope = 'system',
            tenant_id = excluded.tenant_id,
            owner_user_id = excluded.owner_user_id,
            visibility_scope = excluded.visibility_scope,
            lifecycle_state = excluded.lifecycle_state,
            scope_status = excluded.scope_status,
            updated_by = excluded.updated_by,
            updated_at = datetime('now')
        `).run(
          title,
          author,
          systemScope.tenantId,
          systemScope.ownerUserId,
          systemScope.visibilityScope,
          systemScope.lifecycleState,
          systemScope.scopeStatus,
          systemScope.createdBy,
          systemScope.updatedBy,
          systemScope.auditMetadataJson,
        );
      }

      return extractAndStore(title, author, scope, { ...options, creatorContext });
    };

    let extraction: Omit<BookExtractionResult, 'book'>;
    if (scope) {
      const runId = getCurrentRequestId() || generateRequestId();
      extraction = await withAiBudgetReservation({
        userId: scope.userId,
        requestSource: 'interactive',
        baseCategory: 'content_engine_book',
        jobName: 'content_book_extract',
        runId,
      }, startExtraction);
    } else {
      // Unsigned platform seed/operator work acquires the shared system
      // reservation inside /internal/ai-complete. Do not hold a second outer
      // system lock here without a signed re-entry token.
      extraction = await startExtraction();
    }
    return {
      ok: true,
      message: `${title} extracted successfully`,
      ...(extraction.degraded
        ? { degraded: true, warnings: extraction.warnings }
        : {}),
    };
  } catch (err: any) {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : Object.assign(new Error('content_book_client_disconnected'), {
          name: 'AbortError',
          code: 'CONTENT_CLIENT_DISCONNECTED',
        });
    }
    if (err instanceof AiBudgetError || err?.name === 'AiBudgetError' || err?.name === 'ForwardedAiBudgetError') {
      throw err;
    }
    const knownError = err instanceof ContentBookExtractionError;
    return {
      ok: false,
      code: knownError ? err.code : 'CONTENT_BOOK_EXTRACTION_FAILED',
      status: knownError ? err.status : 503,
      details: knownError ? err.details : { retryable: true },
      message: `Extraction failed: ${knownError
        ? err.message
        : 'Book extraction is temporarily unavailable.'}`,
    };
  }
}

// ── Bot Command Handlers ────────────────────────────────────────────
//
// Legacy chat-command handlers with no live callers (the Telegram bot
// framework was removed 2026-07). Kept for reference; the live entry
// points are handleAddBookFromPortal (content-admin routes) and
// seedBooksIfEmpty (scheduler). Minimal structural stand-in for the
// removed bot framework's Context type:
type Context = {
  match?: { toString(): string };
  reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  replyWithChatAction: (action: string) => Promise<unknown>;
};

export async function handleAddBook(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim() || '';
  const parts = input.split('|').map(s => s.trim());

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await ctx.reply(
      '📚 <b>Usage:</b> <code>/addbook Title | Author</code>\n\n' +
      'Example: <code>/addbook Example Book | Example Author</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const [title, author] = parts;
  const db = getDb();

  // Check if already exists
  const existing = db.prepare('SELECT extraction_status FROM book_library WHERE title = ? AND author = ?')
    .get(title, author) as any;

  if (existing?.extraction_status === 'extracted') {
    await ctx.reply(`📚 <b>${escapeHtml(title)}</b> by ${escapeHtml(author)} is already in the library.`, { parse_mode: 'HTML' });
    return;
  }

  // Insert or update to pending
  db.prepare(`
    INSERT INTO book_library (title, author, extraction_status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(title, author) DO UPDATE SET extraction_status = 'pending'
  `).run(title, author);

  await ctx.reply(
    `📚 Added <b>${escapeHtml(title)}</b> by ${escapeHtml(author)}. Researching key concepts... (takes ~30s)`,
    { parse_mode: 'HTML' },
  );

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    await extractAndStore(title, author);
    clearInterval(typingInterval);

    // Fetch stored data for summary
    const row = db.prepare('SELECT core_thesis, pillar_mapping, key_frameworks FROM book_library WHERE title = ? AND author = ?')
      .get(title, author) as any;

    const pillars = JSON.parse(row?.pillar_mapping || '[]').join(', ') || 'general';
    const frameworks = JSON.parse(row?.key_frameworks || '[]');
    const frameworkNames = frameworks.map((f: any) => f.name).join(', ');

    let msg = `✅ <b>${escapeHtml(title)}</b> — extracted!\n\n`;
    msg += `📖 <i>${escapeHtml(row?.core_thesis?.slice(0, 200) || '')}</i>\n\n`;
    msg += `🏷 Pillars: ${escapeHtml(pillars)}\n`;
    msg += `🧩 Frameworks: ${escapeHtml(frameworkNames)}\n`;
    msg += `\n💡 Use <code>/bookidea [topic]</code> to find relevant ideas from this book.`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err: any) {
    clearInterval(typingInterval);
    logger.error(
      { errorName: safeErrorName(err), titleLength: title.length, authorLength: author.length },
      'Book extraction failed',
    );
    const publicMessage = err instanceof ContentBookExtractionError
      ? err.message
      : 'Book extraction is temporarily unavailable.';
    await ctx.reply(`❌ Extraction failed: ${escapeHtml(publicMessage)}`, { parse_mode: 'HTML' });
  }
}

export async function handleBookNote(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim() || '';
  const parts = input.split('|').map(s => s.trim());

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await ctx.reply(
      '📝 <b>Usage:</b> <code>/booknote Book Title | Your note</code>\n\n' +
      'Example: <code>/booknote Example Book | Apply this framework to the next tutorial</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const [titleQuery, note] = parts;
  const db = getDb();

  const book = db.prepare('SELECT id, title, author, personal_notes FROM book_library WHERE title LIKE ?')
    .get(`%${titleQuery}%`) as any;

  if (!book) {
    await ctx.reply(`❌ Book not found. Use <code>/books</code> to see your library.`, { parse_mode: 'HTML' });
    return;
  }

  const notes: string[] = JSON.parse(book.personal_notes || '[]');
  notes.push(note);

  db.prepare('UPDATE book_library SET personal_notes = ? WHERE id = ?')
    .run(JSON.stringify(notes), book.id);

  // This legacy Telegram command has no authenticated tenant boundary. Keep
  // the note in the book record and never mirror private user-authored text to
  // the platform-global book_knowledge signal mesh.

  await ctx.reply(
    `📝 Note added to <b>${escapeHtml(book.title)}</b>:\n\n<i>${escapeHtml(note)}</i>\n\n✅ Note saved to this book.`,
    { parse_mode: 'HTML' },
  );
}

export async function handleListBooks(ctx: Context): Promise<void> {
  const db = getDb();
  const books = db.prepare(`
    SELECT title, author, pillar_mapping, times_referenced, extraction_status, key_frameworks
    FROM book_library
    ORDER BY times_referenced DESC, created_at DESC
  `).all() as any[];

  if (books.length === 0) {
    await ctx.reply('📚 Library is empty. Use <code>/addbook Title | Author</code> to add books.', { parse_mode: 'HTML' });
    return;
  }

  let msg = `📚 <b>Book Library</b> (${books.length} books)\n\n`;

  for (const book of books) {
    const status = book.extraction_status === 'extracted' ? '✅' :
                   book.extraction_status === 'extracting' ? '⏳' :
                   book.extraction_status === 'failed' ? '❌' : '⏸';
    const pillars = JSON.parse(book.pillar_mapping || '[]').join(', ') || '—';
    const frameworks = JSON.parse(book.key_frameworks || '[]');
    const fwCount = frameworks.length;

    msg += `${status} <b>${escapeHtml(book.title)}</b>\n`;
    msg += `   ✍️ ${escapeHtml(book.author)} · 🏷 ${escapeHtml(pillars)}\n`;
    msg += `   🧩 ${fwCount} frameworks · 📊 Referenced ${book.times_referenced}x\n\n`;
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
}

export async function handleBookIdea(ctx: Context): Promise<void> {
  const topic = ctx.match?.toString().trim();
  if (!topic) {
    await ctx.reply('💡 <b>Usage:</b> <code>/bookidea [topic]</code>\n\nSearches your book library for relevant frameworks and ideas.', { parse_mode: 'HTML' });
    return;
  }

  const db = getDb();
  const books = db.prepare(`
    SELECT title, author, core_thesis, key_frameworks, quotable_ideas, personal_notes
    FROM book_library
    WHERE extraction_status = 'extracted'
  `).all() as any[];

  if (books.length === 0) {
    await ctx.reply('📚 No extracted books. Add some with <code>/addbook</code>.', { parse_mode: 'HTML' });
    return;
  }

  // Local search — find frameworks and ideas matching the topic
  const topicLower = topic.toLowerCase();
  const keywords = topicLower.split(/\s+/);
  const matches: { book: string; type: string; content: string; score: number }[] = [];

  for (const book of books) {
    const frameworks: any[] = JSON.parse(book.key_frameworks || '[]');
    const ideas: any[] = JSON.parse(book.quotable_ideas || '[]');
    const notes: string[] = JSON.parse(book.personal_notes || '[]');

    for (const fw of frameworks) {
      const text = `${fw.name} ${fw.description} ${fw.use_in_content} ${fw.pillar}`.toLowerCase();
      const score = keywords.filter(k => text.includes(k)).length;
      if (score > 0) {
        matches.push({
          book: book.title,
          type: '🧩 Framework',
          content: `<b>${escapeHtml(fw.name)}</b>\n${escapeHtml(fw.description)}\n<i>Use: ${escapeHtml(fw.use_in_content)}</i>`,
          score,
        });
      }
    }

    for (const idea of ideas) {
      const text = `${idea.idea} ${idea.context} ${idea.use_when}`.toLowerCase();
      const score = keywords.filter(k => text.includes(k)).length;
      if (score > 0) {
        matches.push({
          book: book.title,
          type: '💬 Quote',
          content: `"${escapeHtml(idea.idea)}"\n<i>Use when: ${escapeHtml(idea.use_when)}</i>`,
          score,
        });
      }
    }

    for (const note of notes) {
      const score = keywords.filter(k => note.toLowerCase().includes(k)).length;
      if (score > 0) {
        matches.push({
          book: book.title,
          type: '📝 Note',
          content: escapeHtml(note),
          score,
        });
      }
    }

    // Also check core thesis
    const thesisScore = keywords.filter(k => (book.core_thesis || '').toLowerCase().includes(k)).length;
    if (thesisScore > 0) {
      matches.push({
        book: book.title,
        type: '📖 Thesis',
        content: escapeHtml(book.core_thesis?.slice(0, 200) || ''),
        score: thesisScore,
      });
    }
  }

  // Sort by relevance
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, 8);

  if (top.length === 0) {
    await ctx.reply(`💡 No matches for "<b>${escapeHtml(topic)}</b>" in the book library. Try broader keywords.`, { parse_mode: 'HTML' });
    return;
  }

  let msg = `💡 <b>Book ideas for:</b> ${escapeHtml(topic)}\n\n`;
  for (const m of top) {
    msg += `${m.type} from <b>${escapeHtml(m.book)}</b>:\n${m.content}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}
