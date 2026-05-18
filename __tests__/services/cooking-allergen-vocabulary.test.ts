import { describe, expect, it } from 'vitest';

import {
  expandAllergenTerms,
  matchesCookingAllergenText,
  normalizeCookingSafetyText,
  violatesCookingDietaryRestrictionText,
} from '../../src/services/cooking-allergen-vocabulary';

describe('cooking allergen vocabulary', () => {
  it('normalizes Portuguese accents and punctuation for safety matching', () => {
    expect(normalizeCookingSafetyText('  Camarão-à-Brás  ')).toBe('camarao a bras');
  });

  it('expands Portuguese allergen clusters', () => {
    expect(expandAllergenTerms('marisco')).toEqual(expect.arrayContaining(['camarao', 'gambas', 'lagosta']));
    expect(expandAllergenTerms('frutos secos')).toEqual(expect.arrayContaining(['amendoa', 'noz', 'caju']));
  });

  it('matches Portuguese shellfish and tree-nut aliases inside recipe text', () => {
    expect(matchesCookingAllergenText('marisco', 'Arroz de camarão com limão')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Iogurte com amêndoa torrada')).toBe(true);
  });

  it('matches lactose, egg, gluten, soy, and sesame clusters across EN/PT terms', () => {
    expect(matchesCookingAllergenText('lactose', 'Queijo fresco')).toBe(true);
    expect(matchesCookingAllergenText('ovo', 'Egg fried rice')).toBe(true);
    expect(matchesCookingAllergenText('gluten', 'Pão de trigo')).toBe(true);
    expect(matchesCookingAllergenText('soy', 'Molho de soja')).toBe(true);
    expect(matchesCookingAllergenText('sésamo', 'Tahini dressing')).toBe(true);
  });

  it('enforces Portuguese vegetarian and vegan restrictions', () => {
    expect(violatesCookingDietaryRestrictionText('Bacalhau com batata', 'vegetariano')).toBe(true);
    expect(violatesCookingDietaryRestrictionText('Queijo fresco com mel', 'vegana')).toBe(true);
    expect(violatesCookingDietaryRestrictionText('Tofu com arroz', 'vegetariano')).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QA regression pins for the 2026-05-17 review (skill-hardening plan A3).
  // The independent QA verified these specific named pairs were NOT covered
  // by the original vocabulary file and produced false negatives — the kind
  // of false negative that ships allergen-positive food to an allergic user.
  // Pinning each pair as a separate it() block so failures localize cleanly.
  // ─────────────────────────────────────────────────────────────────────────

  it('blocks soy allergy when recipe contains edamame (EN + PT)', () => {
    expect(matchesCookingAllergenText('soy', 'Edamame salad with sea salt')).toBe(true);
    expect(matchesCookingAllergenText('soja', 'Salada de edamame com sal marinho')).toBe(true);
    expect(matchesCookingAllergenText('soy', 'Spicy edamame pods')).toBe(true);
  });

  it('blocks soy allergy across the full soy family (tofu/tempeh/edamame/natto/miso/lecitina)', () => {
    expect(matchesCookingAllergenText('soy', 'Tofu stir fry')).toBe(true);
    expect(matchesCookingAllergenText('soy', 'Tempeh tacos')).toBe(true);
    expect(matchesCookingAllergenText('soy', 'Natto rice bowl')).toBe(true);
    expect(matchesCookingAllergenText('soy', 'Miso glazed cod')).toBe(true);
    expect(matchesCookingAllergenText('soja', 'Lecitina de soja como emulsionante')).toBe(true);
  });

  it('blocks tree_nut allergy for pecan and pecã (EN + PT)', () => {
    expect(matchesCookingAllergenText('tree nut', 'Pecan pie with caramel')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Bolo de noz pecan')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Pecã torrada')).toBe(true);
  });

  it('blocks tree_nut allergy for pistache (BR-PT spelling) and pistachio (EN)', () => {
    expect(matchesCookingAllergenText('tree nut', 'Pistachio ice cream')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Bolo de pistache')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Pistaches caramelizados')).toBe(true);
  });

  it('blocks tree_nut allergy for brazil nut / castanha do pará', () => {
    expect(matchesCookingAllergenText('tree nut', 'Brazil nut pesto')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Castanha do pará com chocolate')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Mistura de castanha do brasil')).toBe(true);
  });

  it('blocks tree_nut allergy for pinhão (pine nut)', () => {
    expect(matchesCookingAllergenText('tree nut', 'Pine nut pesto')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Risoto com pinhão')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Pinhões assados')).toBe(true);
  });

  it('blocks tree_nut allergy for macadamia and walnut/avelã/noz', () => {
    expect(matchesCookingAllergenText('tree nut', 'Macadamia cookies')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Bolo de noz')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Avelã caramelizada')).toBe(true);
    expect(matchesCookingAllergenText('frutos secos', 'Macadâmia salgada')).toBe(true);
  });

  it('blocks peanut allergy for amendoim and manteiga de amendoim (PT)', () => {
    expect(matchesCookingAllergenText('peanut', 'Amendoim torrado com sal')).toBe(true);
    expect(matchesCookingAllergenText('peanut', 'Manteiga de amendoim caseira')).toBe(true);
    expect(matchesCookingAllergenText('amendoim', 'Spicy peanut sauce')).toBe(true);
  });

  it('blocks shellfish allergy for shrimp/prawn/camarão/gambas/lagosta', () => {
    expect(matchesCookingAllergenText('shellfish', 'Shrimp scampi')).toBe(true);
    expect(matchesCookingAllergenText('shellfish', 'Prawn linguine')).toBe(true);
    expect(matchesCookingAllergenText('marisco', 'Risoto de camarão')).toBe(true);
    expect(matchesCookingAllergenText('marisco', 'Açorda de gambas')).toBe(true);
    expect(matchesCookingAllergenText('marisco', 'Caldeirada de lagosta')).toBe(true);
  });

  it('enforces vegan restriction for Portuguese animal terms (frango/peixe/leite/queijo/mel)', () => {
    expect(violatesCookingDietaryRestrictionText('Frango grelhado com legumes', 'vegana')).toBe(true);
    expect(violatesCookingDietaryRestrictionText('Peixe assado no forno', 'vegana')).toBe(true);
    expect(violatesCookingDietaryRestrictionText('Bolo com leite e ovos', 'vegana')).toBe(true);
    expect(violatesCookingDietaryRestrictionText('Queijo da serra com torrada', 'vegana')).toBe(true);
    expect(violatesCookingDietaryRestrictionText('Granola com mel', 'vegana')).toBe(true);
  });
});

