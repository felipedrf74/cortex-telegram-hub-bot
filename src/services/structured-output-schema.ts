// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Small, fail-closed JSON Schema subset used at cloud reasoning boundaries.
 *
 * Provider-side structured-output modes improve conformance, but they are not
 * the trust boundary: model responses are validated again here before a parsed
 * value is returned to product code. Unsupported schema keywords are rejected
 * before an SDK call instead of being silently ignored.
 */

export interface StructuredOutputValidation {
  valid: boolean;
  reason?: string;
}

const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_NODES = 1_000;

const SUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
]);

const JSON_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === 'boolean' || isRecord(value);
}

function finiteNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((item, index) => jsonDeepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => (
        key === rightKeys[index] && jsonDeepEqual(left[key], right[key])
      ));
  }
  return false;
}

function stableJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return value;
  }
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]),
    );
  }
  throw new Error('non-JSON schema value');
}

export function canonicalizeStructuredOutputSchema(schema: unknown): string {
  return JSON.stringify(stableJsonValue(schema));
}

export function validateStructuredOutputSchema(schema: unknown): StructuredOutputValidation {
  if (!isSchema(schema)) return { valid: false, reason: 'schema_must_be_object_or_boolean' };

  let encoded: string;
  try {
    encoded = canonicalizeStructuredOutputSchema(schema);
  } catch {
    return { valid: false, reason: 'schema_not_json_serializable' };
  }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_SCHEMA_BYTES) {
    return { valid: false, reason: 'schema_too_large' };
  }

  const state = { nodes: 0 };
  const visit = (candidate: unknown, depth: number): StructuredOutputValidation => {
    if (!isSchema(candidate)) return { valid: false, reason: 'nested_schema_invalid' };
    state.nodes += 1;
    if (depth > MAX_SCHEMA_DEPTH || state.nodes > MAX_SCHEMA_NODES) {
      return { valid: false, reason: 'schema_too_complex' };
    }
    if (typeof candidate === 'boolean') return { valid: true };

    if (Object.keys(candidate).some((key) => !SUPPORTED_SCHEMA_KEYS.has(key))) {
      return { valid: false, reason: 'unsupported_schema_keyword' };
    }
    for (const key of ['$schema', 'title', 'description'] as const) {
      if (candidate[key] !== undefined && typeof candidate[key] !== 'string') {
        return { valid: false, reason: 'invalid_schema_metadata' };
      }
    }

    const rawType = candidate.type;
    if (rawType !== undefined) {
      const types = Array.isArray(rawType) ? rawType : [rawType];
      if (types.length === 0
          || types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type))) {
        return { valid: false, reason: 'invalid_schema_type' };
      }
    }

    if (candidate.enum !== undefined && (!Array.isArray(candidate.enum) || candidate.enum.length === 0)) {
      return { valid: false, reason: 'invalid_schema_enum' };
    }

    if (candidate.properties !== undefined) {
      if (!isRecord(candidate.properties)) return { valid: false, reason: 'invalid_schema_properties' };
      for (const propertySchema of Object.values(candidate.properties)) {
        const result = visit(propertySchema, depth + 1);
        if (!result.valid) return result;
      }
    }

    if (candidate.required !== undefined) {
      if (!Array.isArray(candidate.required)
          || candidate.required.some((key) => typeof key !== 'string')
          || new Set(candidate.required).size !== candidate.required.length) {
        return { valid: false, reason: 'invalid_schema_required' };
      }
    }

    if (candidate.additionalProperties !== undefined) {
      const additional = candidate.additionalProperties;
      if (typeof additional !== 'boolean') {
        const result = visit(additional, depth + 1);
        if (!result.valid) return result;
      }
    }

    if (candidate.items !== undefined) {
      const result = visit(candidate.items, depth + 1);
      if (!result.valid) return result;
    }

    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = candidate[key];
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || branches.length === 0) {
        return { valid: false, reason: 'invalid_schema_composition' };
      }
      for (const branch of branches) {
        const result = visit(branch, depth + 1);
        if (!result.valid) return result;
      }
    }

    if (candidate.not !== undefined) {
      const result = visit(candidate.not, depth + 1);
      if (!result.valid) return result;
    }

    for (const key of [
      'minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties',
    ] as const) {
      if (candidate[key] !== undefined && !finiteNonNegativeInteger(candidate[key])) {
        return { valid: false, reason: 'invalid_schema_bound' };
      }
    }
    for (const key of [
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    ] as const) {
      if (candidate[key] !== undefined && !finiteNumber(candidate[key])) {
        return { valid: false, reason: 'invalid_schema_bound' };
      }
    }
    if (typeof candidate.multipleOf === 'number' && candidate.multipleOf <= 0) {
      return { valid: false, reason: 'invalid_schema_bound' };
    }
    if (candidate.uniqueItems !== undefined && typeof candidate.uniqueItems !== 'boolean') {
      return { valid: false, reason: 'invalid_schema_unique_items' };
    }
    if (candidate.pattern !== undefined) {
      if (typeof candidate.pattern !== 'string') return { valid: false, reason: 'invalid_schema_pattern' };
      try {
        new RegExp(candidate.pattern);
      } catch {
        return { valid: false, reason: 'invalid_schema_pattern' };
      }
    }

    return { valid: true };
  };

  return visit(schema, 0);
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

export function validateStructuredOutputValue(
  value: unknown,
  schema: unknown,
): StructuredOutputValidation {
  const schemaValidation = validateStructuredOutputSchema(schema);
  if (!schemaValidation.valid) return schemaValidation;

  const check = (candidate: unknown, currentSchema: boolean | Record<string, unknown>): StructuredOutputValidation => {
    if (currentSchema === true) return { valid: true };
    if (currentSchema === false) return { valid: false, reason: 'boolean_schema_rejected' };

    if (currentSchema.const !== undefined && !jsonDeepEqual(candidate, currentSchema.const)) {
      return { valid: false, reason: 'const_mismatch' };
    }
    if (Array.isArray(currentSchema.enum)
        && !currentSchema.enum.some((allowed) => jsonDeepEqual(candidate, allowed))) {
      return { valid: false, reason: 'enum_mismatch' };
    }

    if (currentSchema.type !== undefined) {
      const types = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
      if (!types.some((type) => valueMatchesType(candidate, String(type)))) {
        return { valid: false, reason: 'type_mismatch' };
      }
    }

    if (Array.isArray(currentSchema.allOf)) {
      for (const branch of currentSchema.allOf) {
        const result = check(candidate, branch as boolean | Record<string, unknown>);
        if (!result.valid) return { valid: false, reason: 'all_of_mismatch' };
      }
    }
    if (Array.isArray(currentSchema.anyOf)
        && !currentSchema.anyOf.some((branch) => check(candidate, branch as boolean | Record<string, unknown>).valid)) {
      return { valid: false, reason: 'any_of_mismatch' };
    }
    if (Array.isArray(currentSchema.oneOf)) {
      const matches = currentSchema.oneOf.filter(
        (branch) => check(candidate, branch as boolean | Record<string, unknown>).valid,
      ).length;
      if (matches !== 1) return { valid: false, reason: 'one_of_mismatch' };
    }
    if (currentSchema.not !== undefined
        && check(candidate, currentSchema.not as boolean | Record<string, unknown>).valid) {
      return { valid: false, reason: 'not_schema_mismatch' };
    }

    if (typeof candidate === 'string') {
      if (typeof currentSchema.minLength === 'number' && candidate.length < currentSchema.minLength) {
        return { valid: false, reason: 'string_too_short' };
      }
      if (typeof currentSchema.maxLength === 'number' && candidate.length > currentSchema.maxLength) {
        return { valid: false, reason: 'string_too_long' };
      }
      if (typeof currentSchema.pattern === 'string' && !new RegExp(currentSchema.pattern).test(candidate)) {
        return { valid: false, reason: 'pattern_mismatch' };
      }
    }

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      if (typeof currentSchema.minimum === 'number' && candidate < currentSchema.minimum) {
        return { valid: false, reason: 'number_below_minimum' };
      }
      if (typeof currentSchema.maximum === 'number' && candidate > currentSchema.maximum) {
        return { valid: false, reason: 'number_above_maximum' };
      }
      if (typeof currentSchema.exclusiveMinimum === 'number' && candidate <= currentSchema.exclusiveMinimum) {
        return { valid: false, reason: 'number_below_exclusive_minimum' };
      }
      if (typeof currentSchema.exclusiveMaximum === 'number' && candidate >= currentSchema.exclusiveMaximum) {
        return { valid: false, reason: 'number_above_exclusive_maximum' };
      }
      if (typeof currentSchema.multipleOf === 'number') {
        const quotient = candidate / currentSchema.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
          return { valid: false, reason: 'number_not_multiple' };
        }
      }
    }

    if (Array.isArray(candidate)) {
      if (typeof currentSchema.minItems === 'number' && candidate.length < currentSchema.minItems) {
        return { valid: false, reason: 'array_too_short' };
      }
      if (typeof currentSchema.maxItems === 'number' && candidate.length > currentSchema.maxItems) {
        return { valid: false, reason: 'array_too_long' };
      }
      if (currentSchema.uniqueItems === true) {
        const unique = new Set(candidate.map((item) => JSON.stringify(stableJsonValue(item))));
        if (unique.size !== candidate.length) return { valid: false, reason: 'array_items_not_unique' };
      }
      if (currentSchema.items !== undefined) {
        for (const item of candidate) {
          const result = check(item, currentSchema.items as boolean | Record<string, unknown>);
          if (!result.valid) return result;
        }
      }
    }

    if (isRecord(candidate)) {
      const keys = Object.keys(candidate);
      if (typeof currentSchema.minProperties === 'number' && keys.length < currentSchema.minProperties) {
        return { valid: false, reason: 'object_too_small' };
      }
      if (typeof currentSchema.maxProperties === 'number' && keys.length > currentSchema.maxProperties) {
        return { valid: false, reason: 'object_too_large' };
      }
      if (Array.isArray(currentSchema.required)) {
        for (const key of currentSchema.required) {
          if (!Object.prototype.hasOwnProperty.call(candidate, key as string)) {
            return { valid: false, reason: 'required_property_missing' };
          }
        }
      }
      const properties = isRecord(currentSchema.properties) ? currentSchema.properties : {};
      for (const [key, child] of Object.entries(candidate)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          const result = check(child, properties[key] as boolean | Record<string, unknown>);
          if (!result.valid) return result;
          continue;
        }
        if (currentSchema.additionalProperties === false) {
          return { valid: false, reason: 'additional_property_forbidden' };
        }
        if (isSchema(currentSchema.additionalProperties)) {
          const result = check(child, currentSchema.additionalProperties);
          if (!result.valid) return result;
        }
      }
    }

    return { valid: true };
  };

  return check(value, schema as boolean | Record<string, unknown>);
}
