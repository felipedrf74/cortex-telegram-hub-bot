// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getMealPlan,
  getPantryItems,
  getShoppingList,
  type MealPlan,
  type PantryItem,
  type ShoppingItem,
  type ShoppingList,
} from '../../cooking-chef';
import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  isReadModelFreshEnough,
} from '../read-models';
import {
  buildChatCoreV2MessageResponse,
  normalizeChatCoreV2Locale,
} from '../response-contracts';
import {
  COOKING_MEAL_PLAN_SUMMARY_CAPABILITY,
  MAX_VISIBLE_COOKING_ITEMS,
  hashStable,
  normalizeTimezone,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2CookingMealPlanSummaryData,
  ChatCoreV2CookingMealSummaryItem,
  ChatCoreV2CookingShoppingSummaryItem,
  ChatCoreV2DeterministicReadRouteResult,
} from './types';

const COOKING_WEEK_LENGTH_DAYS = 7;
const PANTRY_SCAN_LIMIT = 100;

export function buildCookingMealPlanSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const timezone = normalizeTimezone(input.timezone);
  const rangeStart = weekStartForDate(dateKey(now, timezone));
  const rangeEnd = addDays(rangeStart, COOKING_WEEK_LENGTH_DAYS - 1);
  const meals = getMealPlan(input.userId, rangeStart, rangeEnd, input.tenantId);
  const shoppingList = getShoppingList(input.userId, rangeStart, input.tenantId);
  const pantryItems = getPantryItems(input.userId, {
    tenantId: input.tenantId,
    includeExpired: true,
    limit: PANTRY_SCAN_LIMIT,
  });
  const data = buildCookingMealPlanSummaryData(rangeStart, rangeEnd, meals, shoppingList, pantryItems);
  const sourceEntityIds = [
    ...data.topMeals.map((meal) => meal.entityId),
    cookingShoppingListEntityId(rangeStart),
    cookingPantrySummaryEntityId(),
  ];
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2CookingMealPlanSummaryData>({
    capabilityId: COOKING_MEAL_PLAN_SUMMARY_CAPABILITY,
    domain: 'cooking',
    data,
    sourceEntityIds,
    sourceVersions: sourceVersionsForCooking(rangeStart, meals, shoppingList, pantryItems),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary: buildCookingMealPlanSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildCookingMealPlanSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', COOKING_MEAL_PLAN_SUMMARY_CAPABILITY],
  });

  return {
    capabilityId: COOKING_MEAL_PLAN_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function buildCookingMealPlanSummaryData(
  rangeStart: string,
  rangeEnd: string,
  meals: MealPlan[],
  shoppingList: ShoppingList | null,
  pantryItems: PantryItem[],
): ChatCoreV2CookingMealPlanSummaryData {
  const shoppingItems = shoppingList?.items ?? [];
  return {
    rangeStart,
    rangeEnd,
    plannedMealCount: meals.length,
    plannedDateCount: new Set(meals.map((meal) => meal.date)).size,
    shoppingListWeekStart: rangeStart,
    shoppingItemCount: shoppingItems.length,
    checkedShoppingItemCount: shoppingItems.filter((item) => item.checked).length,
    pantryAvailableShoppingItemCount: shoppingItems.filter((item) => item.pantry_status === 'pantry_available').length,
    pantryExpiredShoppingItemCount: shoppingItems.filter((item) => item.pantry_status === 'pantry_expired').length,
    pantryAvailableCount: pantryItems.filter((item) => item.availability_status === 'available').length,
    pantryUseSoonCount: pantryItems.filter((item) => item.freshness_status === 'use_soon').length,
    pantryUnknownCount: pantryItems.filter((item) => item.freshness_status === 'unknown').length,
    topMeals: meals.slice(0, MAX_VISIBLE_COOKING_ITEMS).map(mealToSummaryItem),
    topShoppingItems: shoppingItems.slice(0, MAX_VISIBLE_COOKING_ITEMS).map(shoppingItemToSummaryItem),
  };
}

function mealToSummaryItem(meal: MealPlan): ChatCoreV2CookingMealSummaryItem {
  return {
    entityId: cookingMealEntityId(meal.id),
    date: meal.date,
    mealType: meal.meal_type,
    title: meal.title,
  };
}

function shoppingItemToSummaryItem(item: ShoppingItem): ChatCoreV2CookingShoppingSummaryItem {
  return {
    name: item.name,
    aisle: item.aisle,
    checked: Boolean(item.checked),
    pantryStatus: item.pantry_status ?? null,
  };
}

function buildCookingMealPlanSummaryText(
  data: ChatCoreV2CookingMealPlanSummaryData,
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.plannedMealCount === 0 && data.shoppingItemCount === 0 && data.pantryAvailableCount === 0) {
    if (normalizedLocale === 'pt-BR') return 'Você ainda não tem refeições, compras ou despensa registadas para esta semana.';
    if (normalizedLocale === 'pt-PT') return 'Ainda não tens refeições, compras ou despensa registadas para esta semana.';
    return 'You have no meals, shopping list, or pantry items logged for this week yet.';
  }

  const header = buildCookingHeader(data, normalizedLocale);
  const sections: string[] = [];
  if (data.topMeals.length > 0) {
    sections.push(`${mealListLabel(normalizedLocale)}\n${data.topMeals.map((meal) => `- ${meal.title}${mealSuffix(meal, normalizedLocale)}`).join('\n')}`);
  }
  if (data.topShoppingItems.length > 0) {
    sections.push(`${shoppingListLabel(normalizedLocale)}\n${data.topShoppingItems.map((item) => `- ${item.name}${shoppingSuffix(item, normalizedLocale)}`).join('\n')}`);
  }
  return sections.length > 0 ? `${header}\n\n${sections.join('\n\n')}` : header;
}

function buildCookingHeader(
  data: ChatCoreV2CookingMealPlanSummaryData,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts: string[] = [];
  if (data.plannedMealCount > 0) parts.push(countPhrase(data.plannedMealCount, locale, 'meals'));
  if (data.plannedDateCount > 0) parts.push(dateCoveragePhrase(data.plannedDateCount, locale));
  if (data.shoppingItemCount > 0) parts.push(countPhrase(data.shoppingItemCount, locale, 'shopping'));
  if (data.pantryAvailableShoppingItemCount > 0) parts.push(countPhrase(data.pantryAvailableShoppingItemCount, locale, 'pantry_available_shopping'));
  if (data.pantryExpiredShoppingItemCount > 0) parts.push(countPhrase(data.pantryExpiredShoppingItemCount, locale, 'pantry_expired_shopping'));
  if (data.pantryUseSoonCount > 0) parts.push(countPhrase(data.pantryUseSoonCount, locale, 'pantry_use_soon'));
  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}.` : '';
  const range = `${data.rangeStart} to ${data.rangeEnd}`;

  if (locale === 'pt-BR') return `Plano de refeições da semana (${range}).${detail}`;
  if (locale === 'pt-PT') return `Plano de refeições da semana (${range}).${detail}`;
  return `This week's meal plan (${range}).${detail}`;
}

function countPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'meals' | 'shopping' | 'pantry_available_shopping' | 'pantry_expired_shopping' | 'pantry_use_soon',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'meals') return `${count} ${plural(count, 'refeição planeada', 'refeições planeadas')}`;
    if (kind === 'shopping') return `${count} ${plural(count, 'item de compras', 'itens de compras')}`;
    if (kind === 'pantry_available_shopping') return `${count} já na despensa`;
    if (kind === 'pantry_expired_shopping') return `${count} ${plural(count, 'item expirado para rever', 'itens expirados para rever')}`;
    return `${count} ${plural(count, 'item da despensa a usar em breve', 'itens da despensa a usar em breve')}`;
  }
  if (kind === 'meals') return `${count} planned ${plural(count, 'meal', 'meals')}`;
  if (kind === 'shopping') return `${count} shopping ${plural(count, 'item', 'items')}`;
  if (kind === 'pantry_available_shopping') return `${count} already in the pantry`;
  if (kind === 'pantry_expired_shopping') return `${count} expired ${plural(count, 'item', 'items')} to review`;
  return `${count} pantry ${plural(count, 'item', 'items')} to use soon`;
}

function dateCoveragePhrase(count: number, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `cobrindo ${count} ${plural(count, 'dia', 'dias')}`;
  return `covering ${count} ${plural(count, 'day', 'days')}`;
}

function mealListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Refeições principais:';
  if (locale === 'pt-PT') return 'Refeições principais:';
  return 'Top meals:';
}

function shoppingListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Compras principais:';
  if (locale === 'pt-PT') return 'Compras principais:';
  return 'Top shopping items:';
}

function mealSuffix(meal: ChatCoreV2CookingMealSummaryItem, locale: ChatCoreV2NormalizedLocale): string {
  return ` (${meal.date}, ${mealTypeLabel(meal.mealType, locale)})`;
}

function shoppingSuffix(item: ChatCoreV2CookingShoppingSummaryItem, locale: ChatCoreV2NormalizedLocale): string {
  const parts = [
    item.aisle,
    item.checked ? checkedLabel(locale) : null,
    item.pantryStatus ? pantryStatusLabel(item.pantryStatus, locale) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function mealTypeLabel(mealType: string, locale: ChatCoreV2NormalizedLocale): string {
  const normalized = String(mealType || '').toLowerCase();
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    const labels: Record<string, string> = {
      breakfast: 'pequeno-almoço',
      lunch: 'almoço',
      dinner: 'jantar',
      snack: 'lanche',
    };
    return labels[normalized] ?? normalized;
  }
  return normalized;
}

function checkedLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return 'feito';
  return 'checked';
}

function pantryStatusLabel(status: string, locale: ChatCoreV2NormalizedLocale): string {
  if (status === 'pantry_available') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return 'já na despensa';
    return 'already in pantry';
  }
  if (status === 'pantry_expired') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return 'verificar validade';
    return 'check freshness';
  }
  if (locale === 'pt-BR' || locale === 'pt-PT') return 'necessário';
  return 'needed';
}

function sourceVersionsForCooking(
  rangeStart: string,
  meals: MealPlan[],
  shoppingList: ShoppingList | null,
  pantryItems: PantryItem[],
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const meal of meals.slice(0, MAX_VISIBLE_COOKING_ITEMS)) {
    versions[cookingMealEntityId(meal.id)] = hashStable({
      date: meal.date,
      mealType: meal.meal_type,
      title: meal.title,
      recipeIdPresent: meal.recipe_id != null,
      lifecycleState: meal.lifecycle_state,
      createdAt: meal.created_at,
    });
  }
  versions[cookingShoppingListEntityId(rangeStart)] = hashStable({
    weekStart: rangeStart,
    status: shoppingList?.status ?? null,
    itemCount: shoppingList?.items.length ?? 0,
    checkedCount: shoppingList?.items.filter((item) => item.checked).length ?? 0,
    items: (shoppingList?.items ?? []).slice(0, MAX_VISIBLE_COOKING_ITEMS).map((item) => ({
      name: item.name,
      checked: item.checked,
      aisle: item.aisle,
      pantryStatus: item.pantry_status ?? null,
    })),
  });
  versions[cookingPantrySummaryEntityId()] = hashStable({
    count: pantryItems.length,
    availableCount: pantryItems.filter((item) => item.availability_status === 'available').length,
    useSoonCount: pantryItems.filter((item) => item.freshness_status === 'use_soon').length,
    expiredCount: pantryItems.filter((item) => item.freshness_status === 'expired').length,
  });
  return versions;
}

function cookingMealEntityId(mealId: number): string {
  return `cooking_meal:${mealId}`;
}

function cookingShoppingListEntityId(weekStart: string): string {
  return `cooking_shopping_list:${weekStart}`;
}

function cookingPantrySummaryEntityId(): string {
  return 'cooking_pantry_summary';
}

function dateKey(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : now.toISOString().slice(0, 10);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function weekStartForDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  const utcDay = parsed.getUTCDay();
  const mondayOffset = ((utcDay + 6) % 7);
  return addDays(date, -mondayOffset);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
