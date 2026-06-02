#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Seed a local parity DB with an active, current-week training plan for the
 * authenticated parity user. This is evidence setup only: it does not create
 * retirement labels and should be run against temporary `.local` DB snapshots.
 */

import crypto from 'crypto';
import path from 'path';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';

const dbPath = readArg('--db');
const userId = parsePositiveInt(readArg('--user-id'));
const tenantId = parsePositiveInt(readArg('--tenant-id'));
const anchorDate = readArg('--date') ?? DateTime.now().setZone('Europe/Lisbon').toISODate();
const shouldWrite = hasFlag('--write');
const replaceActiveTraining = hasFlag('--replace-active-training');
const allowNonLocalDb = hasFlag('--allow-nonlocal-db');

if (!dbPath || !userId || !tenantId || !anchorDate) {
  console.error('Usage: npx tsx scripts/chatv2-seed-training-parity-fixture.ts --write --db <path> --user-id <id> --tenant-id <id> --replace-active-training [--date YYYY-MM-DD]');
  process.exit(1);
}
if (!shouldWrite) {
  console.error('Refusing to seed without --write. This script mutates a local parity DB snapshot.');
  process.exit(1);
}
const resolvedDbPath = path.resolve(dbPath);
if (!allowNonLocalDb && !resolvedDbPath.includes(`${path.sep}.local${path.sep}`)) {
  console.error(`Refusing to seed non-local DB path without --allow-nonlocal-db: ${resolvedDbPath}`);
  process.exit(1);
}

const db = new Database(resolvedDbPath);
try {
  ensureTables(db);
  const result = seedTrainingParityFixture(db, {
    userId,
    tenantId,
    anchorDate,
    replaceActiveTraining,
  });
  console.log(JSON.stringify({
    schemaVersion: 'chat_v2_training_parity_fixture_seed_result.v1',
    dbPath: resolvedDbPath,
    userId,
    tenantId,
    anchorDate,
    replaceActiveTraining,
    ...result,
  }, null, 2));
} finally {
  db.close();
}

function seedTrainingParityFixture(
  db: Database.Database,
  input: {
    userId: number;
    tenantId: number;
    anchorDate: string;
    replaceActiveTraining: boolean;
  },
): {
  planId: number;
  weekId: number;
  sessionIds: number[];
  fixtureHash: string;
} {
  const anchor = DateTime.fromISO(input.anchorDate, { zone: 'Europe/Lisbon' });
  if (!anchor.isValid) throw new Error(`Invalid --date: ${input.anchorDate}`);
  const weekStart = anchor.startOf('week');
  const weekEnd = weekStart.plus({ weeks: 7, days: 6 });
  const todayName = anchor.toFormat('EEEE');
  const tomorrowName = anchor.plus({ days: 1 }).toFormat('EEEE');
  const sundayName = weekStart.plus({ days: 6 }).toFormat('EEEE');
  const preferences = JSON.stringify({
    schemaVersion: 'chat_v2_training_parity_fixture.v1',
    seededFor: 'chatv2_legacy_parity',
    anchorDate: anchor.toISODate(),
  });

  const tx = db.transaction(() => {
    if (input.replaceActiveTraining) {
      db.prepare(`
        UPDATE fitness_training_plans
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE user_id = ? AND tenant_id = ? AND status = 'active'
      `).run(input.userId, input.tenantId);
    }

    const planResult = db.prepare(`
      INSERT INTO fitness_training_plans (
        user_id, tenant_id, name, sport, goal, duration_weeks, periodization,
        status, start_date, end_date, preferences_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      input.userId,
      input.tenantId,
      'ChatV2 parity active training plan',
      'running',
      'Reliable endurance with safe recovery',
      8,
      'block',
      weekStart.toISODate(),
      weekEnd.toISODate(),
      preferences,
    );
    const planId = Number(planResult.lastInsertRowid);

    const weekResult = db.prepare(`
      INSERT INTO training_weeks (
        plan_id, week_number, focus, intensity_pct, volume_sessions,
        notes, auto_adjusted, adjustment_reason, created_at
      ) VALUES (?, 1, ?, 82, 4, ?, 0, NULL, datetime('now'))
    `).run(
      planId,
      'Base endurance and controlled recovery',
      'Parity fixture week with completed, scheduled, easy, and recovery sessions.',
    );
    const weekId = Number(weekResult.lastInsertRowid);

    const insertSession = db.prepare(`
      INSERT INTO training_sessions (
        week_id, plan_id, tenant_id, day_of_week, session_type, title,
        description, exercises_json, duration_minutes, intensity_text,
        calendar_event_id, calendar_source, status, created_at, updated_at,
        description_json, preferred_time_unavailable, session_identity_key,
        session_shape_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, datetime('now'), datetime('now'), ?, 0, ?, ?)
    `);
    const sessions = [
      {
        day: todayName,
        type: 'running',
        title: 'Easy Run after Soreness',
        description: 'Keep this easy after a sore week. Stay conversational and stop if pain appears.',
        duration: 35,
        intensity: 'easy',
        status: 'scheduled',
        key: 'today_easy_after_soreness',
      },
      {
        day: tomorrowName,
        type: 'running',
        title: 'Tempo Intervals',
        description: 'Controlled tempo work with warm-up and cool-down.',
        duration: 48,
        intensity: 'moderate',
        status: 'pending',
        key: 'tempo_intervals',
      },
      {
        day: sundayName,
        type: 'recovery',
        title: 'Recovery Session',
        description: 'Low-load recovery session after a sore week.',
        duration: 30,
        intensity: 'recovery',
        status: 'pending',
        key: 'recovery_session_after_sore_week',
      },
      {
        day: weekStart.toFormat('EEEE'),
        type: 'running',
        title: 'Completed Base Run',
        description: 'Completed aerobic base run.',
        duration: 42,
        intensity: 'steady',
        status: 'completed',
        key: 'completed_base_run',
      },
    ];
    const sessionIds = sessions.map((session) => Number(insertSession.run(
      weekId,
      planId,
      input.tenantId,
      session.day,
      session.type,
      session.title,
      session.description,
      JSON.stringify([]),
      session.duration,
      session.intensity,
      session.status,
      JSON.stringify({ sections: [{ title: 'Summary', body: session.description }] }),
      `chatv2-parity:${session.key}`,
      stableSha256({ planId: 'fixture', key: session.key, duration: session.duration, intensity: session.intensity }),
    ).lastInsertRowid));

    const completedSessionId = sessionIds[3]!;
    db.prepare(`
      INSERT INTO training_completions (
        session_id, plan_id, completed_at, actual_exercises_json, rpe_overall,
        duration_minutes, energy_level, soreness_level, notes, created_at
      ) VALUES (?, ?, datetime('now'), ?, 6, 42, 7, 3, ?, datetime('now'))
    `).run(
      completedSessionId,
      planId,
      JSON.stringify([]),
      'Parity fixture completed run.',
    );

    return { planId, weekId, sessionIds };
  });

  const seeded = tx();
  const fixtureHash = `sha256:${stableSha256({
    schemaVersion: 'chat_v2_training_parity_fixture.v1',
    userId: input.userId,
    tenantId: input.tenantId,
    anchorDate: anchor.toISODate(),
    planName: 'ChatV2 parity active training plan',
    sessionKeys: [
      'today_easy_after_soreness',
      'tempo_intervals',
      'recovery_session_after_sore_week',
      'completed_base_run',
    ],
  })}`;
  return { ...seeded, fixtureHash };
}

function ensureTables(db: Database.Database): void {
  const names = new Set((db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all() as Array<{ name: string }>).map((row) => row.name));
  const required = [
    'fitness_training_plans',
    'training_weeks',
    'training_sessions',
    'training_completions',
  ];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`DB is missing required training table(s): ${missing.join(', ')}`);
}

function stableSha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
