// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { MeshPriority, SignalType } from './intelligence-bus';

export interface MeshDirective {
  id: string;
  date: string;
  target: string;
  domain: 'training' | 'cooking' | 'content' | 'secretary' | 'finance';
  summary: string;
  action: string;
  signalType: SignalType;
  signalId: number | string;
  meshPriority?: MeshPriority;
}

export interface ConflictNote {
  id: string;
  date: string;
  target: string;
  signalIds: Array<number | string>;
  signalTypes: SignalType[];
  meshPriority: MeshPriority;
  message: string;
}

export interface DirectiveResolution {
  accepted: MeshDirective[];
  shadowed: MeshDirective[];
  conflicts: ConflictNote[];
  criticalConflicts: ConflictNote[];
}

const DEFAULT_PRIORITY_MAP: Partial<Record<SignalType, MeshPriority>> = {
  sponsor_deliverable_due: 1,
  tax_deadline: 1,
  calendar_busy_blocks: 1,
  travel_window: 1,
  publishing_commitment: 2,
  rest_day_scheduled: 2,
  budget_remaining: 3,
  recovery_state: 3,
  session_prescription: 3,
  session_immovability: 2,
  fueling_requirements: 3,
  shoot_day_locked: 3,
  batch_cook_day: 3,
  meal_plan_window: 3,
  meal_execution_readiness: 3,
  fueling_support_status: 3,
  training_load_forecast: 3,
  fueling_gap_risk: 3,
  grocery_spend_forecast: 3,
  content_capture_opportunity: 4,
  inbox_pressure: 4,
  subscription_renewal_due: 4,
  expense_anomaly: 4,
  low_sleep: 2,
  low_hrv: 2,
  low_readiness: 2,
  planned_hard_run: 3,
  planned_hard_ride: 3,
  plan_drift: 2,
  high_adherence: 4,
  low_adherence: 4,
};

const NEGOTIATION_PRECEDENCE: Partial<Record<SignalType, number>> = {
  travel_window: 1,
  tax_deadline: 2,
  rest_day_scheduled: 3,
  low_sleep: 4,
  low_hrv: 4,
  low_readiness: 4,
  session_immovability: 5,
  calendar_busy_blocks: 6,
  publishing_commitment: 7,
  sponsor_deliverable_due: 8,
  shoot_day_locked: 9,
  batch_cook_day: 10,
  budget_remaining: 11,
  subscription_renewal_due: 12,
  expense_anomaly: 13,
  inbox_pressure: 14,
};

export function defaultMeshPriorityForSignal(signalType: SignalType): MeshPriority {
  return DEFAULT_PRIORITY_MAP[signalType] ?? 3;
}

export function resolveDirectiveSet(directives: MeshDirective[]): DirectiveResolution {
  if (directives.length === 0) {
    return { accepted: [], shadowed: [], conflicts: [], criticalConflicts: [] };
  }

  const normalized = directives
    .map((directive) => ({
      ...directive,
      meshPriority: directive.meshPriority ?? defaultMeshPriorityForSignal(directive.signalType),
    }))
    .sort((lhs, rhs) => {
      if (lhs.meshPriority !== rhs.meshPriority) {
        return lhs.meshPriority - rhs.meshPriority;
      }
      return String(lhs.signalId).localeCompare(String(rhs.signalId));
    });

  const topPriority = normalized[0].meshPriority;
  const contenders = normalized.filter((directive) => directive.meshPriority === topPriority);
  const shadowed = normalized.filter((directive) => directive.meshPriority !== topPriority);

  if (contenders.length === 1) {
    return {
      accepted: [contenders[0]],
      shadowed,
      conflicts: [],
      criticalConflicts: [],
    };
  }

  const negotiated = negotiateSamePriorityContenders(contenders);
  if (negotiated) {
    return {
      accepted: [negotiated.winner],
      shadowed: [...shadowed, ...negotiated.shadowed],
      conflicts: [],
      criticalConflicts: [],
    };
  }

  const note = buildConflictNote(contenders);
  return {
    accepted: [],
    shadowed,
    conflicts: [note],
    criticalConflicts: topPriority === 1 ? [note] : [],
  };
}

export function resolveDirectiveMatrix(directives: MeshDirective[]): DirectiveResolution {
  const grouped = new Map<string, MeshDirective[]>();
  for (const directive of directives) {
    const key = `${directive.date}::${directive.target}`;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(directive);
    } else {
      grouped.set(key, [directive]);
    }
  }

  const aggregate: DirectiveResolution = {
    accepted: [],
    shadowed: [],
    conflicts: [],
    criticalConflicts: [],
  };

  for (const bucket of grouped.values()) {
    const resolved = resolveDirectiveSet(bucket);
    aggregate.accepted.push(...resolved.accepted);
    aggregate.shadowed.push(...resolved.shadowed);
    aggregate.conflicts.push(...resolved.conflicts);
    aggregate.criticalConflicts.push(...resolved.criticalConflicts);
  }

  return aggregate;
}

function negotiateSamePriorityContenders(
  directives: Array<MeshDirective & { meshPriority: MeshPriority }>,
): { winner: MeshDirective & { meshPriority: MeshPriority }; shadowed: Array<MeshDirective & { meshPriority: MeshPriority }> } | null {
  const merged = mergeCompatibleContenders(directives);
  if (merged) {
    return merged;
  }

  const ranked = directives
    .map((directive) => ({
      directive,
      precedence: NEGOTIATION_PRECEDENCE[directive.signalType] ?? 50,
    }))
    .sort((lhs, rhs) => {
      if (lhs.precedence !== rhs.precedence) {
        return lhs.precedence - rhs.precedence;
      }
      return String(lhs.directive.signalId).localeCompare(String(rhs.directive.signalId));
    });

  if (ranked.length < 2) return null;
  if (ranked[0].precedence === ranked[1].precedence) return null;

  return {
    winner: ranked[0].directive,
    shadowed: ranked.slice(1).map((entry) => entry.directive),
  };
}

function mergeCompatibleContenders(
  directives: Array<MeshDirective & { meshPriority: MeshPriority }>,
): { winner: MeshDirective & { meshPriority: MeshPriority }; shadowed: Array<MeshDirective & { meshPriority: MeshPriority }> } | null {
  if (directives.length < 2) return null;
  const target = directives[0]?.target;
  if (!target || directives.some((directive) => directive.target !== target)) return null;

  const signalTypes = new Set(directives.map((directive) => directive.signalType));

  if (target === 'availability' && signalTypes.has('travel_window') && signalTypes.has('calendar_busy_blocks')) {
    const travel = directives.find((directive) => directive.signalType === 'travel_window');
    if (!travel) return null;
    return {
      winner: {
        ...travel,
        id: directives.map((directive) => directive.id).sort().join('+'),
        signalId: directives.map((directive) => directive.signalId).sort().join('+'),
        summary: 'Travel blocks the day and the calendar is already too tight to treat it as flexible.',
      },
      shadowed: [],
    };
  }

  if (target === 'primary-commitment' && signalTypes.has('sponsor_deliverable_due') && signalTypes.has('shoot_day_locked')) {
    const shoot = directives.find((directive) => directive.signalType === 'shoot_day_locked');
    if (!shoot) return null;
    return {
      winner: {
        ...shoot,
        id: directives.map((directive) => directive.id).sort().join('+'),
        signalId: directives.map((directive) => directive.signalId).sort().join('+'),
        summary: 'Sponsor deliverable is due and the filming slot is ready, so treat this as one protected production block.',
      },
      shadowed: [],
    };
  }

  return null;
}

function buildConflictNote(directives: Array<MeshDirective & { meshPriority: MeshPriority }>): ConflictNote {
  const date = directives[0]?.date ?? '';
  const target = directives[0]?.target ?? 'unknown';
  const meshPriority = directives[0]?.meshPriority ?? 3;
  const summaries = directives.map((directive) => directive.summary);

  return {
    id: `${date}:${target}:${meshPriority}`,
    date,
    target,
    signalIds: directives.map((directive) => directive.signalId),
    signalTypes: directives.map((directive) => directive.signalType),
    meshPriority,
    message: summaries.length > 1
      ? `Same-priority conflict on ${date}: ${summaries.join(' vs ')}`
      : `Same-priority conflict on ${date}`,
  };
}
