import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { withDatabaseForTestAsync } from '../../src/services/database';
import {
  executeSecretaryCalendarCommand,
  type SecretaryCalendarCommandCalendarIo,
} from '../../src/services/secretary-calendar-command-service';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

const START = '2026-08-31T09:00:00.000Z';
const END = '2026-08-31T10:00:00.000Z';

describe.sequential('Secretary calendar command Decision Center integration', () => {
  let db: Database.Database;
  let priorLogicV2: string | undefined;

  beforeEach(() => {
    priorLogicV2 = process.env.DECISION_CENTER_LOGIC_V2_ENABLED;
    process.env.DECISION_CENTER_LOGIC_V2_ENABLED = 'true';
    db = createMigratedTestDatabase();
    db.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status, auth_provider)
      VALUES (42, 42, 'Decision Tester', 'en-US', 'Europe/Lisbon', 'active', 'invite_code')
    `).run();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (priorLogicV2 == null) delete process.env.DECISION_CENTER_LOGIC_V2_ENABLED;
    else process.env.DECISION_CENTER_LOGIC_V2_ENABLED = priorLogicV2;
    db.close();
    vi.restoreAllMocks();
  });

  it('persists a real visible Decision review for an overlap and performs no provider write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-30T10:00:00.000Z'));
    const calendarIo: SecretaryCalendarCommandCalendarIo = {
      getEventsForSources: vi.fn().mockResolvedValue([{
        id: 'existing-event',
        source: 'google',
        summary: 'Existing commitment',
        start: START,
        end: END,
        blocksTime: true,
      }]),
      createEvent: vi.fn(() => {
        throw new Error('provider write must remain blocked');
      }),
    };

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarCommand({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-command-real-decision',
      source: 'google',
      title: 'Planning review',
      start: START,
      end: END,
      timezone: 'Europe/Lisbon',
      channel: 'ios',
      nowIso: '2026-08-30T10:00:00.000Z',
    }, { calendarIo }));

    expect(result).toMatchObject({
      status: 'review_required',
      replayed: false,
      warningCodes: ['CALENDAR_CONFLICT_REVIEW_REQUIRED'],
    });
    expect(calendarIo.createEvent).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT state, decision_item_id
        FROM secretary_calendar_command_receipts
       WHERE user_id = 42 AND tenant_id = '42'
         AND idempotency_key = 'calendar-command-real-decision'
    `).get()).toMatchObject({
      state: 'review_required',
      decision_item_id: expect.any(String),
    });
    expect(db.prepare(`
      SELECT items.status, intents.source_skill, intents.related_entity_type
        FROM notification_center_items AS items
        JOIN notification_intents AS intents ON intents.intent_id = items.intent_id
       WHERE items.item_id = (
         SELECT decision_item_id
           FROM secretary_calendar_command_receipts
          WHERE user_id = 42 AND tenant_id = '42'
            AND idempotency_key = 'calendar-command-real-decision'
       )
    `).get()).toMatchObject({
      status: 'unread',
      source_skill: 'secretary',
      related_entity_type: 'secretary_agenda_item',
    });
  });
});
