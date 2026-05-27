// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** The built-in domains. Kept as a narrow type for domain handlers. */
export type DefaultDomainName =
  | 'secretary'
  | 'triathlon'
  | 'content'
  | 'finance'
  | 'cooking'
  | 'connections'
  | 'notifications'
  | 'decision_center';

/**
 * Any domain/skill name — includes the three defaults plus any dynamically
 * registered skill.  The `(string & {})` arm keeps autocomplete for known
 * values while accepting arbitrary strings at compile time.
 */
export type DomainName = DefaultDomainName | (string & {});

export interface DomainContext {
  domain: DomainName;
  systemPrompt: string;
  stateContext: string;
  history: DomainMessage[];
}

export interface DomainMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DomainResponse {
  text: string;
  domain: DomainName;
  toolsUsed?: string[];
}

export interface ClassificationResult {
  domain: DomainName;
  confidence: number;
  /**
   * Option 3 (O3-A7): confidence-driven second-opinion telemetry.
   * These fields are set only when TaskRoutingProvider.classify accepts
   * a primary classifier result, deems it below the configured confidence
   * floor, and then returns the fallback provider's classification.
   */
  fallbackUsed?: boolean;
  fallbackReason?: 'low_confidence';
  primaryProvider?: string;
  fallbackProvider?: string;
  primaryDomain?: DomainName;
  primaryConfidence?: number;
}

export interface Todo {
  id: number;
  title: string;
  description: string | null;
  domain: string;
  priority: string;
  status: string;
  due_date: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Note {
  id: number;
  content: string;
  domain: string;
  tags: string | null;
  created_at: string;
}

export interface Reminder {
  id: number;
  message: string;
  remind_at: string;
  recurring: string | null;
  status: string;
  created_at: string;
}

// ── Invoice Filing ──────────────────────────────────────────────────

export interface InvoiceFiling {
  id: number;
  vendor: string;
  amount: string | null;
  document_date: string | null;
  invoice_number: string | null;
  source: 'photo' | 'email' | 'amazon' | 'uber';
  source_ref: string | null;
  remote_path: string | null;
  folder_path: string | null;
  filename: string | null;
  file_size_bytes: number | null;
  compressed_size_bytes: number | null;
  status: 'filed' | 'failed' | 'duplicate';
  error_message: string | null;
  created_at: string;
}

export interface InvoiceVendor {
  id: number;
  name: string;
  sender_pattern: string;
  subject_patterns: string | null;
  enabled: number;       // SQLite boolean: 1 = active, 0 = disabled
  created_at: string;
}

// ── Skill Registry ─────────────────────────────────────────────────

export interface InstalledSkill {
  id: number;
  name: string;
  description: string | null;
  version: string;
  domain: string | null;
  enabled: number;       // SQLite boolean: 1 = enabled, 0 = disabled
  config_json: string | null;
  installed_at: string;
  updated_at: string;
}

export interface SkillSubmodule {
  id: number;
  skill_id: number;
  module_name: string;
  version: string;
  enabled: number;       // SQLite boolean: 1 = enabled, 0 = disabled
  config_json: string | null;
  created_at: string;
}
