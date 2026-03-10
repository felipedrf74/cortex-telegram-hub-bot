export type DomainName = 'secretary' | 'triathlon' | 'content';

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
