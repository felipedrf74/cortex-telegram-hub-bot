// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Book Knowledge bot commands — /addbook, /booknote, /books, /bookidea
 */

import type { Context } from 'grammy';
import { getDb } from '../services/database';
import { writeSignal } from '../services/intelligence-bus';
import { escapeHtml } from '../utils/telegram-formatter';
import { logger } from '../utils/logger';
import { getCurrentRequestId, generateRequestId } from '../utils/request-context';
import { config } from '../config';

const CONTENT_ENGINE_URL = `http://localhost:${config.contentEngine.port}/api/v1`;

// ── Seed books (extracted on first deploy if table is empty) ────────

const SEED_BOOKS = [
  { title: 'The Law', author: 'Frédéric Bastiat' },
  { title: 'Economics in One Lesson', author: 'Henry Hazlitt' },
  { title: 'Human Action', author: 'Ludwig von Mises' },
  { title: 'The Road to Serfdom', author: 'Friedrich Hayek' },
  { title: 'Democracy: The God That Failed', author: 'Hans-Hermann Hoppe' },
  { title: 'Anatomy of the State', author: 'Murray Rothbard' },
];

/**
 * Seed default books if the library is empty. Called on startup.
 * Extraction runs asynchronously — does not block.
 */
export function seedBooksIfEmpty(sendAlert: (msg: string) => Promise<void>): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM book_library').get() as any)?.cnt ?? 0;
  if (count > 0) return;

  logger.info('Seeding book library with %d default books', SEED_BOOKS.length);

  // Insert all as 'pending', then extract sequentially in background
  for (const book of SEED_BOOKS) {
    db.prepare(`
      INSERT OR IGNORE INTO book_library (title, author, extraction_status)
      VALUES (?, ?, 'pending')
    `).run(book.title, book.author);
  }

  // Fire-and-forget extraction
  (async () => {
    for (let i = 0; i < SEED_BOOKS.length; i++) {
      const book = SEED_BOOKS[i];
      try {
        await sendAlert(`📚 Seeding book library... ${i + 1}/${SEED_BOOKS.length} <b>${escapeHtml(book.title)}</b> — extracting...`);
        await extractAndStore(book.title, book.author);
        // 10s delay between books to avoid rate limits
        if (i < SEED_BOOKS.length - 1) {
          await new Promise(r => setTimeout(r, 10_000));
        }
      } catch (err: any) {
        logger.error({ err, book: book.title }, 'Failed to seed book');
      }
    }
    await sendAlert(`📚 Book library seeding complete! ${SEED_BOOKS.length} books extracted.`);
  })().catch(err => logger.error({ err }, 'Book seeding failed'));
}

// ── Core extraction function ────────────────────────────────────────

async function extractAndStore(title: string, author: string): Promise<void> {
  const db = getDb();

  // Mark as extracting
  db.prepare("UPDATE book_library SET extraction_status = 'extracting' WHERE title = ? AND author = ?")
    .run(title, author);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);

    // Distributed tracing: propagate the current requestId so the Python
    // content-engine can log it. Same pattern as engineFetch in
    // services/content-engine.ts. (Quarter audit item.)
    const requestId = getCurrentRequestId() || generateRequestId();
    const resp = await fetch(`${CONTENT_ENGINE_URL}/books/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({ title, author }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`Content Engine ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as any;
    const book = data.book;

    // Store extracted knowledge
    db.prepare(`
      UPDATE book_library SET
        core_thesis = ?,
        key_frameworks = ?,
        quotable_ideas = ?,
        pillar_mapping = ?,
        personal_notes = ?,
        extraction_status = 'extracted',
        extraction_date = datetime('now')
      WHERE title = ? AND author = ?
    `).run(
      book.core_thesis,
      JSON.stringify(book.key_frameworks),
      JSON.stringify(book.quotable_ideas),
      JSON.stringify(book.pillar_mapping),
      JSON.stringify(book.personal_notes || []),
      title,
      author,
    );

    // Write book_knowledge signal to the intelligence bus
    writeSignal({
      source_agent: 'book-extractor',
      signal_type: 'book_knowledge',
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

    logger.info({ title, author }, 'Book extracted and stored');
  } catch (err: any) {
    db.prepare("UPDATE book_library SET extraction_status = 'failed' WHERE title = ? AND author = ?")
      .run(title, author);
    throw err;
  }
}

// ── Portal Handler (no Telegram context) ────────────────────────────

export async function handleAddBookFromPortal(
  title: string, author: string,
): Promise<{ ok: boolean; message: string }> {
  const db = getDb();
  const existing = db.prepare('SELECT extraction_status FROM book_library WHERE title = ? AND author = ?')
    .get(title, author) as any;

  if (existing?.extraction_status === 'extracted') {
    return { ok: true, message: `${title} already in library` };
  }

  db.prepare(`
    INSERT INTO book_library (title, author, extraction_status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(title, author) DO UPDATE SET extraction_status = 'pending'
  `).run(title, author);

  try {
    await extractAndStore(title, author);
    return { ok: true, message: `${title} extracted successfully` };
  } catch (err: any) {
    return { ok: false, message: `Extraction failed: ${err.message?.slice(0, 100)}` };
  }
}

// ── Bot Command Handlers ────────────────────────────────────────────

export async function handleAddBook(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim() || '';
  const parts = input.split('|').map(s => s.trim());

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await ctx.reply(
      '📚 <b>Usage:</b> <code>/addbook Title | Author</code>\n\n' +
      'Example: <code>/addbook The Law | Frédéric Bastiat</code>',
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
    logger.error({ err, title, author }, 'Book extraction failed');
    await ctx.reply(`❌ Extraction failed: ${escapeHtml(err.message?.slice(0, 100) || 'Unknown error')}`, { parse_mode: 'HTML' });
  }
}

export async function handleBookNote(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim() || '';
  const parts = input.split('|').map(s => s.trim());

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await ctx.reply(
      '📝 <b>Usage:</b> <code>/booknote Book Title | Your note</code>\n\n' +
      'Example: <code>/booknote The Law | Legal plunder is the perfect analogy for Brazilian tax system</code>',
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

  // Write high-priority signal — personal notes are the most valuable
  writeSignal({
    source_agent: 'book-extractor',
    signal_type: 'book_knowledge',
    priority: 'urgent',
    payload: {
      title: book.title,
      author: book.author,
      note_type: 'personal',
      note,
    },
  });

  await ctx.reply(
    `📝 Note added to <b>${escapeHtml(book.title)}</b>:\n\n<i>${escapeHtml(note)}</i>\n\n✅ This note will be prioritized in future script generation.`,
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
