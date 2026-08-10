#!/usr/bin/env npx tsx
/**
 * One-time setup script: create admin user + invite code + clean test users.
 *
 * Usage: npx tsx scripts/setup-admin.ts
 *
 * This script:
 *   1. Creates (or updates) the admin user with tier='owner'
 *   2. Creates an invite code for new users
 *   3. Removes all test/sandbox users and their data
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { getDb } from '../src/services/database';
import { initDatabase } from '../src/services/database-bootstrap';
import * as crypto from 'crypto';

// Initialize the database connection before any queries
initDatabase();
const db = getDb();

// ── 1. Create admin user ─────────────────────────────────────────

const ADMIN_EMAIL = 'felipedrf74@gmail.com';
const ADMIN_FIRST_NAME = 'Felipe';
const ADMIN_LAST_NAME = 'Dominguez';

console.log('\n═══ 1. ADMIN USER ═══');

// Check if admin already exists
const existing = db.prepare('SELECT id, email, tier FROM users WHERE email = ?').get(ADMIN_EMAIL) as any;

let adminUserId: number;

if (existing) {
  // Update to owner tier
  db.prepare(`
    UPDATE users SET
      tier = 'owner',
      first_name = ?,
      last_name = ?,
      email_verified = 1,
      status = 'active',
      daily_message_limit = 0,
      daily_token_limit = 0,
      daily_cost_limit_usd = 0,
      auth_provider = COALESCE(auth_provider, 'google')
    WHERE id = ?
  `).run(ADMIN_FIRST_NAME, ADMIN_LAST_NAME, existing.id);
  adminUserId = existing.id;
  console.log(`  ✅ Updated existing user #${existing.id} to owner tier`);
} else {
  // Create new admin user
  const result = db.prepare(`
    INSERT INTO users (email, first_name, last_name, email_verified, auth_provider, tier, status,
      daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (?, ?, ?, 1, 'google', 'owner', 'active', 0, 0, 0)
  `).run(ADMIN_EMAIL, ADMIN_FIRST_NAME, ADMIN_LAST_NAME);
  adminUserId = result.lastInsertRowid as number;
  console.log(`  ✅ Created admin user #${adminUserId}`);
}

console.log(`  📧 Email: ${ADMIN_EMAIL}`);
console.log(`  👤 Name: ${ADMIN_FIRST_NAME} ${ADMIN_LAST_NAME}`);
console.log(`  👑 Tier: owner (unlimited)`);
console.log(`  🆔 User ID: ${adminUserId}`);

// ── 2. Create invite code ────────────────────────────────────────

console.log('\n═══ 2. INVITE CODE ═══');

// Delete any existing unused codes first
const deletedCodes = db.prepare('DELETE FROM invite_codes WHERE used_count = 0').run();
if (deletedCodes.changes > 0) {
  console.log(`  🗑️  Cleared ${deletedCodes.changes} unused invite codes`);
}

// Create a new code — 8 chars, 10 uses, no expiry
const inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
db.prepare(`
  INSERT INTO invite_codes (code, created_by, max_uses, expires_at)
  VALUES (?, ?, 10, NULL)
`).run(inviteCode, adminUserId);

console.log(`  ✅ Invite code created`);
console.log(`  🔑 Code: ${inviteCode}`);
console.log(`  📝 Max uses: 10`);
console.log(`  ⏰ Expires: never`);
console.log(`  ℹ️  Users must sign in with Google (email verified) to use this code`);

// ── 3. Clean test/sandbox users ──────────────────────────────────

console.log('\n═══ 3. CLEANUP TEST USERS ═══');

// Find test users: sandbox users (Beta-*), demo users, and any non-admin users
// that have no real auth provider or are clearly test accounts
const testUsers = db.prepare(`
  SELECT id, first_name, email, auth_provider, tier FROM users
  WHERE id != ?
    AND (
      first_name LIKE 'Beta-%'
      OR auth_provider = 'invite_code'
      OR (email IS NULL AND auth_provider = 'telegram' AND tier != 'owner')
    )
`).all(adminUserId) as any[];

console.log(`  Found ${testUsers.length} test/sandbox users to clean`);

if (testUsers.length > 0) {
  // Delete their data from all user-scoped tables
  const tables = [
    'ios_devices', 'messages', 'onboarding_sessions', 'user_profiles',
    'conversations', 'todos', 'notes', 'reminders', 'shared_memory',
    'saved_ideas', 'content_topic_feedback', 'content_ref_channels',
    'content_knowledge', 'content_patterns', 'content_research_briefs',
    'content_scripts', 'content_performance', 'content_learned_patterns',
    'content_pipeline', 'content_topics', 'content_notifications',
    'book_library', 'video_transcripts', 'video_studies',
    'report_documents', 'push_preferences',
    'invoice_filings', 'invoice_vendors', 'invoice_queue',
    'finance_transactions', 'finance_tax_events',
    'recipes', 'meal_plans', 'shopping_lists',
    'fitness_training_plans', 'training_completions',
    'native_tasks', 'native_task_lists',
    'apple_health_data', 'readiness_scores',
    'webhook_subscriptions', 'webhook_events',
    'user_oauth_tokens', 'garmin_user_tokens',
    'email_verification_codes', 'subscriptions',
    'api_usage', 'audit_trail', 'client_errors',
    'user_skill_overrides',
  ];

  for (const user of testUsers) {
    console.log(`  🗑️  Deleting user #${user.id} (${user.first_name || user.email || 'unnamed'})`);
    for (const table of tables) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id);
      } catch { /* table may not exist */ }
    }
    // Delete the user row itself
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  }

  console.log(`  ✅ Cleaned ${testUsers.length} test users and all their data`);
} else {
  console.log(`  ✅ No test users found — database is clean`);
}

// Also clean orphaned devices (devices with no matching user)
const orphanedDevices = db.prepare(`
  DELETE FROM ios_devices WHERE user_id NOT IN (SELECT id FROM users)
`).run();
if (orphanedDevices.changes > 0) {
  console.log(`  🗑️  Cleaned ${orphanedDevices.changes} orphaned device registrations`);
}

// ── Summary ──────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════');
console.log('  ✅ Setup complete!');
console.log('');
console.log('  Your admin account:');
console.log(`    Email: ${ADMIN_EMAIL}`);
console.log(`    Login: Google Sign-In (PKCE)`);
console.log(`    Tier: owner (unlimited AI, no cost caps)`);
console.log('');
console.log('  Invite code for new users:');
console.log(`    Code: ${inviteCode}`);
console.log('    Flow: User enters code → signs in with Google → account created');
console.log('');
console.log('  Remaining users in database:');
const remaining = db.prepare('SELECT id, email, first_name, tier FROM users ORDER BY id').all() as any[];
for (const u of remaining) {
  console.log(`    #${u.id} ${u.email || '(no email)'} — ${u.first_name || '?'} — ${u.tier}`);
}
console.log('═══════════════════════════════════════════════');
