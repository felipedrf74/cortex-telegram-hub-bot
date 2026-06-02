// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatActionRisk,
  ChatActionRiskClass,
  SlotValidator,
} from './types';

export function makeRequiredFieldsValidator(fields: string[], name = 'required_fields'): SlotValidator {
  return {
    name,
    label: `requires: ${fields.join(', ')}`,
    validate(slots) {
      const missing: string[] = [];
      for (const field of fields) {
        const value = slots[field];
        if (value === null || value === undefined || value === '') missing.push(field);
      }
      return { ok: missing.length === 0, missing: missing.length > 0 ? missing : undefined };
    },
  };
}

export const financePaymentActionValidator: SlotValidator = {
  name: 'finance_payment_action_fields',
  label: 'requires action plus amount for external payments/refunds or month for local mark-paid',
  validate(slots) {
    const missing: string[] = [];
    const action = typeof slots.action === 'string' ? slots.action.trim().toLowerCase() : '';
    if (!action) missing.push('action');
    if (action === 'mark_tax_paid' || action === 'mark_paid') {
      const month = slots.month;
      if (month === null || month === undefined || month === '') missing.push('month');
    } else {
      const amount = slots.amount;
      if (amount === null || amount === undefined || amount === '') missing.push('amount');
    }
    return { ok: missing.length === 0, missing: missing.length > 0 ? missing : undefined };
  },
};

export const STATUS_CARDS = [
  'understood_action',
  'checking_provider',
  'needs_input',
  'needs_confirmation',
  'executing',
  'verified_success',
  'verified_pending',
  'partial_success',
  'failed',
  'blocked',
  'retry',
  'undo',
  'connect_provider',
  'open_skill',
  'open_surface',
];

export function riskClassForRisk(risk: ChatActionRisk): ChatActionRiskClass {
  if (risk === 'read_only') return 'R0';
  if (risk === 'safe_write') return 'R1';
  if (risk === 'external_side_effect') return 'R2';
  if (risk === 'destructive' || risk === 'financial' || risk === 'admin_security') return 'R3';
  return 'R4';
}
