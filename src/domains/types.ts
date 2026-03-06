export type DomainName = 'secretary' | 'triathlon' | 'content' | 'qliksense' | 'aws';

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
