// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type BetterSqlite3 from 'better-sqlite3';
import { getDb } from '../services/database';

let cachedStatements: Record<string, BetterSqlite3.Statement> | null = null;

export function getPortalSnapshotStatements(): Record<string, BetterSqlite3.Statement> {
  if (cachedStatements) return cachedStatements;

  const db = getDb();
  cachedStatements = {
    todayUsage: db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now')`),
    weekUsage: db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now', '-7 days')`),
    monthUsage: db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now', '-30 days')`),
    byCategory: db.prepare(`
      SELECT category, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost
      FROM api_usage WHERE ts >= date('now', '-7 days')
      GROUP BY category ORDER BY cost DESC`),
    thisMonthInvoices: db.prepare(`
      SELECT COUNT(*) as c FROM invoice_filings
      WHERE document_date >= date('now', 'start of month') AND status = 'filed'`),
    lastMonthInvoices: db.prepare(`
      SELECT COUNT(*) as c FROM invoice_filings
      WHERE document_date >= date('now', 'start of month', '-1 month')
        AND document_date < date('now', 'start of month')
        AND status = 'filed'`),
    recentFilings: db.prepare(`
      SELECT vendor, document_date, amount, status
      FROM invoice_filings ORDER BY created_at DESC LIMIT 10`),
    emailTodaySent: db.prepare(`
      SELECT COUNT(*) as c FROM email_log WHERE ts >= date('now') AND status = 'sent'`),
    emailTodayFailed: db.prepare(`
      SELECT COUNT(*) as c FROM email_log WHERE ts >= date('now') AND status = 'failed'`),
    recentEmailLog: db.prepare(`
      SELECT recipient, subject, status, source, ts, error_message
      FROM email_log ORDER BY ts DESC LIMIT 20`),
    jobHistoryRecent: db.prepare(`
      SELECT job_name, result, ts
      FROM job_history ORDER BY ts DESC LIMIT 200`),
    lastSuccessForJob: db.prepare(`
      SELECT ts FROM job_history
      WHERE job_name = ? AND result = 'success'
      ORDER BY ts DESC LIMIT 1`),
    lastFailureForJob: db.prepare(`
      SELECT ts FROM job_history
      WHERE job_name = ? AND result = 'failed'
      ORDER BY ts DESC LIMIT 1`),
    jobHistory7d: db.prepare(`
      SELECT job_name, result, ts, duration_ms
      FROM job_history WHERE ts >= date('now', '-7 days')
      ORDER BY ts ASC`),
    jobHistoryMonth: db.prepare(`
      SELECT job_name, result, ts, duration_ms
      FROM job_history WHERE ts >= date('now', '-45 days')
      ORDER BY ts ASC`),
    domainMessagesToday: db.prepare(`
      SELECT domain, COUNT(*) as count
      FROM conversations WHERE created_at >= date('now')
      GROUP BY domain`),
    domainMessagesTotal: db.prepare(`
      SELECT domain, COUNT(*) as count, MAX(created_at) as last_at
      FROM conversations
      GROUP BY domain`),
  };

  return cachedStatements;
}

