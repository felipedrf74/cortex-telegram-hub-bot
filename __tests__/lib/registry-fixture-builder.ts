import type {
  ChatActionDefinition,
  ChatActionName,
} from '../../src/services/chat/registry';

export type ExampleTag = 'golden' | 'ambiguous' | 'adversarial' | 'negative' | 'prompt_injection';

export interface RegistryFixturePlannerFixture {
  id: string;
  text: string;
  locale: string;
  timezone: string;
  expectedGate: boolean;
  expectedActionable?: boolean;
  expectedRefusal?: boolean;
  expectedSkill?: string;
  expectedAction?: string;
  expectedTitle?: string;
  expectDueDateTime?: boolean;
}

export interface RegistryFixtureBuilderOptions {
  registry: ChatActionDefinition[];
  includeActions?: ChatActionName[];
  excludeActions?: ChatActionName[];
  perActionMax?: number;
  defaultLocale?: string;
  defaultTimezone?: string;
}

type RegistryExample = {
  text: string;
  locale?: 'en' | 'pt' | 'es' | 'mixed';
  expectedSlots?: Record<string, unknown>;
  expectedAction?: ChatActionName | null;
  tags?: ExampleTag[];
  condition?: string;
  requiresPendingActionId?: boolean;
};

const LOCALE_MAP: Record<string, string> = {
  en: 'en-US',
  pt: 'pt-PT',
  es: 'es-ES',
  mixed: 'en-US',
};

export function buildFixturesFromRegistry(
  options: RegistryFixtureBuilderOptions,
): RegistryFixturePlannerFixture[] {
  const {
    registry,
    includeActions,
    excludeActions,
    perActionMax,
    defaultLocale = 'en-US',
    defaultTimezone = 'Europe/Lisbon',
  } = options;

  const include = includeActions ? new Set(includeActions) : null;
  const exclude = excludeActions ? new Set(excludeActions) : null;

  const fixtures: RegistryFixturePlannerFixture[] = [];

  for (const entry of registry) {
    if (include && !include.has(entry.action)) continue;
    if (exclude && exclude.has(entry.action)) continue;
    const examples = (entry.examples ?? []) as RegistryExample[];
    if (examples.length === 0) continue;
    const limit = perActionMax ?? examples.length;
    examples.slice(0, limit).forEach((example, index) => {
      fixtures.push(mapExampleToFixture(entry, example, index, defaultLocale, defaultTimezone));
    });
  }

  return fixtures;
}

function mapExampleToFixture(
  entry: ChatActionDefinition,
  example: RegistryExample,
  index: number,
  defaultLocale: string,
  defaultTimezone: string,
): RegistryFixturePlannerFixture {
  const tags = Array.isArray(example.tags) ? example.tags : [];
  const hasInjectionTag =
    tags.includes('prompt_injection') || tags.includes('adversarial');
  const isAmbiguous = tags.includes('ambiguous');
  const isNegative = tags.includes('negative');
  // Refusal: explicit prompt_injection/adversarial tag.
  // Clarification: ambiguous tag OR expectedAction:null without injection tag.
  // Negative: tagged negative (gate-negative; planner should not route here).
  // Golden: anything else with expectedAction set.
  const isRefusal = hasInjectionTag;
  const isClarification =
    !isRefusal && (isAmbiguous || (example.expectedAction === null && !isNegative));

  const primaryTag: ExampleTag = isRefusal
    ? ((tags.find((tag) => tag === 'prompt_injection' || tag === 'adversarial') as ExampleTag) ??
      'prompt_injection')
    : isClarification
      ? 'ambiguous'
      : isNegative
        ? 'negative'
        : ((tags[0] as ExampleTag) ?? 'golden');

  const locale = example.locale ? LOCALE_MAP[example.locale] ?? defaultLocale : defaultLocale;
  const id = `${entry.skill}-${entry.action}-${primaryTag}-${index}`;
  const text = example.text;

  const fixture: RegistryFixturePlannerFixture = {
    id,
    text,
    locale,
    timezone: defaultTimezone,
    expectedGate: isRefusal ? false : !isNegative,
  };

  if (isRefusal) {
    fixture.expectedRefusal = true;
  } else if (isClarification) {
    fixture.expectedActionable = false;
  } else if (!isNegative) {
    fixture.expectedActionable = true;
    fixture.expectedSkill = entry.skill;
    if (example.expectedAction && example.expectedAction !== null) {
      fixture.expectedAction = example.expectedAction;
    } else {
      fixture.expectedAction = entry.action;
    }
  }

  if (example.expectedSlots) {
    const title = example.expectedSlots.title;
    if (typeof title === 'string' && title.length > 0) {
      fixture.expectedTitle = title;
    }
    const dueLike = [
      example.expectedSlots.dueDateTime,
      example.expectedSlots.startDateTime,
      example.expectedSlots.date,
      example.expectedSlots.dateTime,
      example.expectedSlots.scheduledDateTime,
    ].some((value) => typeof value === 'string' && value.length > 0);
    if (dueLike) {
      fixture.expectDueDateTime = true;
    }
  }

  return fixture;
}

export function summarizeBuilderCoverage(
  registry: ChatActionDefinition[],
): {
  totalActions: number;
  actionsWithExamples: number;
  actionsByCategory: Record<ExampleTag | 'untagged', number>;
} {
  const actionsByCategory: Record<ExampleTag | 'untagged', number> = {
    golden: 0,
    ambiguous: 0,
    adversarial: 0,
    negative: 0,
    prompt_injection: 0,
    untagged: 0,
  };
  let withExamples = 0;
  for (const entry of registry) {
    const examples = (entry.examples ?? []) as RegistryExample[];
    if (examples.length === 0) continue;
    withExamples += 1;
    for (const example of examples) {
      const tags = Array.isArray(example.tags) ? example.tags : [];
      if (tags.length === 0) {
        actionsByCategory.untagged += 1;
        continue;
      }
      for (const tag of tags) {
        if (tag in actionsByCategory) {
          actionsByCategory[tag as ExampleTag] += 1;
        }
      }
    }
  }
  return {
    totalActions: registry.length,
    actionsWithExamples: withExamples,
    actionsByCategory,
  };
}
