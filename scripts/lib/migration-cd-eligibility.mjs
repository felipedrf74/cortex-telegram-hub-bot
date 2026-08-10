import { sha256, canonicalJson } from './release-canonical.mjs';

/**
 * Continuous-deployment migration eligibility.
 *
 * Unattended deployment can only accept migrations that a rollback survives. A
 * rollback restores the previous *image pair*, never an older database, so after
 * a rollback the predecessor code runs against the already-migrated schema. That
 * makes exactly one class of migration safe to apply unattended: additive
 * (expand) and data-only (backfill) changes that leave every structure the
 * predecessor reads or writes intact.
 *
 * Contract and destructive changes require a distinct owner-authorized
 * maintenance transaction once the deployed predecessor no longer needs the old
 * shape. The container executor for that transaction is not implemented yet;
 * this module only proves why unattended deployment must block it.
 *
 * Objects created earlier in the *same* migration are tracked, because the
 * predecessor cannot depend on something this migration just introduced. A
 * unique index on a brand-new table is additive; the same statement against a
 * pre-existing table can reject a write the predecessor would have made, so it
 * is not.
 *
 * The classifier is deliberately conservative: anything it does not positively
 * recognize is `unknown`, and `unknown` blocks unattended deployment.
 */

export const MIGRATION_CD_ELIGIBILITY_SCHEMA = 'nexus.migration-cd-eligibility.v1';

export const MIGRATION_STATEMENT_KINDS = Object.freeze({
  EXPAND: 'expand',
  BACKFILL: 'backfill',
  NEUTRAL: 'neutral',
  CONTRACT: 'contract',
  UNKNOWN: 'unknown',
});

const BLOCKING_KINDS = Object.freeze([
  MIGRATION_STATEMENT_KINDS.CONTRACT,
  MIGRATION_STATEMENT_KINDS.UNKNOWN,
]);

const KIND_RANK = Object.freeze({
  [MIGRATION_STATEMENT_KINDS.NEUTRAL]: 0,
  [MIGRATION_STATEMENT_KINDS.EXPAND]: 1,
  [MIGRATION_STATEMENT_KINDS.BACKFILL]: 2,
  [MIGRATION_STATEMENT_KINDS.UNKNOWN]: 3,
  [MIGRATION_STATEMENT_KINDS.CONTRACT]: 4,
});

const IDENT = '(?:"[^"]+"|\\[[^\\]]+\\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)';
// Any write aimed at SQLite's own catalog, schema-qualified or not.
const CATALOG_WRITE = new RegExp(
  '^(?:insert|update|delete|replace)\\b[\\s\\S]*?\\b(?:[A-Za-z_][A-Za-z0-9_$]*\\s*\\.\\s*)?'
  + '(?:sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema)\\b',
  'i',
);
// Both the schema qualifier and the object name are captured. Keying ownership
// on the bare name alone let `CREATE TEMP TABLE users` claim ownership of
// `main.users`, so a following `DROP TABLE main.users` read as "dropping a table
// this migration created" and was admitted as expand. The schema is part of the
// identity.
const QUALIFIED = `(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`;
const RELEASE_SCHEMA_CONVERGENCE_EXEMPTION_ID = 'release-schema-convergence-283';
const RELEASE_SCHEMA_CONVERGENCE_FILE = '283_release_schema_convergence.sql';
const RELEASE_SCHEMA_CONVERGENCE_SHA256 =
  '0bba559437983ed7e2f5540e18ba66a0248c1a34282b30015954ace6e29cbd32';
const RELEASE_SCHEMA_CONVERGENCE_NOT_NULL_ADD =
  "ALTER TABLE content_idea_memory ADD COLUMN feedback_sentiment TEXT NOT NULL DEFAULT 'generated'";

function identifierOf(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unquoted = /^"(.*)"$/.test(trimmed) ? trimmed.slice(1, -1)
    : (/^\[(.*)\]$/.test(trimmed) ? trimmed.slice(1, -1)
      : (/^`(.*)`$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed));
  return unquoted.toLowerCase();
}

function qualifiedKey(schemaRaw, nameRaw) {
  const name = identifierOf(nameRaw);
  if (name === null) return null;
  const schema = identifierOf(schemaRaw) ?? 'main';
  return `${schema === 'temp' ? 'temp' : schema}.${name}`;
}

/**
 * Resolve a statement target to a schema-qualified ownership key.
 *
 * An unqualified name is `main`, SQLite's default schema, so `users` and
 * `main.users` are the same object — while `temp.users` is a different one.
 * Collapsing them made a temporary shadow table license destroying the real one.
 */
function matchTarget(sql, pattern) {
  const match = pattern.exec(sql);
  if (!match) return null;
  return qualifiedKey(match[match.length - 2], match[match.length - 1]);
}

/** Remove `--` line comments and block comments without touching string literals. */
export function stripSqlComments(sql) {
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;
  let inBacktick = false;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (!inSingle && !inDouble && !inBracket && !inBacktick) {
      if (char === '-' && next === '-') {
        // A comment is SQL whitespace. Preserve a token boundary so
        // `UPDATE OR/**/REPLACE` cannot become the harmless-looking
        // `UPDATE ORREPLACE` before classification.
        out += ' ';
        while (index < sql.length && sql[index] !== '\n') index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        out += ' ';
        index += 2;
        while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
        index += 2;
        continue;
      }
    }
    if (char === "'" && !inDouble && !inBracket && !inBacktick) inSingle = !inSingle;
    else if (char === '"' && !inSingle && !inBracket && !inBacktick) inDouble = !inDouble;
    else if (char === '[' && !inSingle && !inDouble && !inBacktick) inBracket = true;
    else if (char === ']' && inBracket) inBracket = false;
    else if (char === '`' && !inSingle && !inDouble && !inBracket) inBacktick = !inBacktick;
    out += char;
    index += 1;
  }
  return out;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Mask SQL string literals while retaining identifiers and token positions. */
function maskSqlStringLiterals(sql) {
  let out = '';
  let inSingle = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'") {
      out += ' ';
      if (inSingle && sql[index + 1] === "'") {
        out += ' ';
        index += 1;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }
    out += inSingle ? ' ' : char;
  }
  return out;
}

function keywordIndexOutsideQuotedTokens(sql, keyword) {
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;
  let inBacktick = false;
  const lower = sql.toLowerCase();
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'" && !inDouble && !inBracket && !inBacktick) {
      if (inSingle && sql[index + 1] === "'") index += 1;
      else inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle && !inBracket && !inBacktick) {
      if (inDouble && sql[index + 1] === '"') index += 1;
      else inDouble = !inDouble;
      continue;
    }
    if (char === '[' && !inSingle && !inDouble && !inBacktick) {
      inBracket = true;
      continue;
    }
    if (char === ']' && inBracket) {
      inBracket = false;
      continue;
    }
    if (char === '`' && !inSingle && !inDouble && !inBracket) {
      if (inBacktick && sql[index + 1] === '`') index += 1;
      else inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBracket || inBacktick) continue;
    if (lower.startsWith(keyword, index)
        && (index === 0 || !/[A-Za-z0-9_$]/.test(sql[index - 1]))
        && !/[A-Za-z0-9_$]/.test(sql[index + keyword.length] ?? '')) {
      return index;
    }
  }
  return -1;
}

function singleQuotedTokenLength(value, offset = 0) {
  if (value[offset] !== "'") return null;
  for (let index = offset + 1; index < value.length; index += 1) {
    if (value[index] !== "'") continue;
    if (value[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return null;
}

function simpleDefaultTokenLength(value) {
  const leading = /^\s*/.exec(value)?.[0].length ?? 0;
  const source = value.slice(leading);
  if (source[0] === "'") {
    const length = singleQuotedTokenLength(source);
    return length === null ? null : leading + length;
  }
  if (/^[xX]'/.test(source)) {
    const length = singleQuotedTokenLength(source, 1);
    return length === null ? null : leading + length;
  }
  const number = /^(?:[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))/.exec(source);
  if (number) return leading + number[0].length;
  const literal = /^(?:null|true|false|current_time|current_date|current_timestamp)\b/i.exec(source);
  return literal ? leading + literal[0].length : null;
}

function hasOnlySimpleAddColumnDefault(sql) {
  const defaultIndex = keywordIndexOutsideQuotedTokens(sql, 'default');
  if (defaultIndex === -1) return true;
  const source = sql.slice(defaultIndex + 'default'.length);
  const tokenLength = simpleDefaultTokenLength(source);
  if (tokenLength === null) return false;
  const remainder = source.slice(tokenLength).trim();
  return remainder === '' || /^(?:collate|constraint|primary|not|unique|check|references|generated)\b/i
    .test(remainder);
}

function referencedTableTargets(sql) {
  const masked = maskSqlStringLiterals(sql);
  const referenceCount = masked.match(/\breferences\b/gi)?.length ?? 0;
  const targets = [];
  const pattern = new RegExp(`\\breferences\\s+${QUALIFIED}`, 'gi');
  for (const match of masked.matchAll(pattern)) {
    const target = qualifiedKey(match[match.length - 2], match[match.length - 1]);
    if (target !== null) targets.push(target);
  }
  return { referenceCount, targets };
}

function referencesOnlyOwnedTables(sql, ownedTables) {
  const { referenceCount, targets } = referencedTableTargets(sql);
  return referenceCount === targets.length
    && targets.every((target) => ownedTables.has(target));
}

const SIMPLE_INDEX_TERM = `${IDENT}`
  + '(?:\\s+collate\\s+(?:binary|nocase|rtrim))?'
  + '(?:\\s+(?:asc|desc))?';

/**
 * A plain column index cannot reject predecessor writes. Expression and partial
 * indexes can: their expressions/predicates are evaluated on every write and
 * may throw for values the predecessor previously accepted.
 */
function isSimpleColumnIndex(sql) {
  const columnList = `${SIMPLE_INDEX_TERM}(?:\\s*,\\s*${SIMPLE_INDEX_TERM})*`;
  return new RegExp(
    `\\bon\\s+${QUALIFIED}\\s*\\(\\s*${columnList}\\s*\\)\\s*$`,
    'i',
  ).test(sql);
}

/**
 * Split a migration into statements. Trigger bodies carry their own `;`
 * separators inside `BEGIN ... END`, so a naive split would shred them into
 * fragments and the trailing `END` would read as an unrecognized statement.
 */
export function splitSqlStatements(sql) {
  const source = stripSqlComments(sql);
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;
  let inBacktick = false;
  let bodyDepth = 0;
  let caseDepth = 0;

  const currentIsBodyCarrier = () => /^\s*create\s+(?:temp\s+|temporary\s+)?trigger\b/i.test(current);

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" && !inDouble && !inBracket && !inBacktick) inSingle = !inSingle;
    else if (char === '"' && !inSingle && !inBracket && !inBacktick) inDouble = !inDouble;
    else if (char === '[' && !inSingle && !inDouble && !inBacktick) inBracket = true;
    else if (char === ']' && inBracket) inBracket = false;
    else if (char === '`' && !inSingle && !inDouble && !inBracket) inBacktick = !inBacktick;

    const quoted = inSingle || inDouble || inBracket || inBacktick;

    if (!quoted && /[A-Za-z]/.test(char)) {
      const boundaryBefore = index === 0 || !/[A-Za-z0-9_]/.test(source[index - 1]);
      if (boundaryBefore && currentIsBodyCarrier()) {
        const word = /^[A-Za-z]+/.exec(source.slice(index))?.[0] ?? '';
        // `CASE ... END` inside a trigger body also ends with END. Tracking it on
        // its own counter keeps a CASE expression from closing the trigger body
        // early, which used to shred the trigger into fragments and leave a bare
        // `END` that classified as harmless transaction control.
        if (/^case$/i.test(word)) caseDepth += 1;
        else if (/^begin$/i.test(word)) bodyDepth += 1;
        else if (/^end$/i.test(word)) {
          if (caseDepth > 0) caseDepth -= 1;
          else if (bodyDepth > 0) bodyDepth -= 1;
        }
      }
    }

    if (char === ';' && !quoted && bodyDepth === 0) {
      const statement = normalizeWhitespace(current);
      if (statement) statements.push(statement);
      current = '';
      continue;
    }
    current += char;
  }
  const tail = normalizeWhitespace(current);
  if (tail) statements.push(tail);
  return statements;
}

export function emptyMigrationContext() {
  return {
    // `createdTables` is *definite* creation only. `CREATE TABLE IF NOT EXISTS`
    // may be a no-op over a table that already holds production rows, so it can
    // never license a later DROP/DELETE/RENAME in the same migration.
    createdTables: new Set(),
    conditionalTables: new Set(),
    createdIndexes: new Set(),
    conditionalIndexes: new Set(),
  };
}

/**
 * Classify `CREATE TRIGGER`.
 *
 * A trigger attached to a pre-existing table runs inside the predecessor's own
 * writes. If its body can abort, delete, or rewrite rows, the predecessor's
 * behaviour changes the moment the migration lands — and a rollback cannot undo
 * it, because rollback restores images and leaves the schema in place. So a
 * trigger is additive only when its target table was *definitely* created by the
 * same migration; otherwise it must be proven harmless.
 */
function triggerVerdict(sql, context) {
  const table = matchTarget(sql, new RegExp(`\\bon\\s+${QUALIFIED}`, 'i'));
  const ownsTarget = table !== null && context.createdTables.has(table);

  // Owning the *target* is not enough: the trigger BODY can write anywhere.
  // `CREATE TABLE shadow; CREATE TRIGGER t AFTER INSERT ON shadow BEGIN
  // DELETE FROM users; END; INSERT INTO shadow ...` deletes production rows
  // during the migration while every statement looks additive. So the body's
  // write targets are resolved first, and ownership only excuses a trigger whose
  // body writes exclusively to tables this migration created.
  const bodyTargets = [];
  const bodyPatterns = [
    new RegExp(`\\bdelete\\s+from\\s+${QUALIFIED}`, 'gi'),
    new RegExp(`\\bupdate\\s+(?:or\\s+\\w+\\s+)?${QUALIFIED}\\s+set\\b`, 'gi'),
    new RegExp(`\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+${QUALIFIED}`, 'gi'),
    new RegExp(`\\breplace\\s+into\\s+${QUALIFIED}`, 'gi'),
  ];
  for (const pattern of bodyPatterns) {
    for (const match of sql.matchAll(pattern)) {
      const target = qualifiedKey(match[match.length - 2], match[match.length - 1]);
      if (target !== null) bodyTargets.push(target);
    }
  }
  const bodyTouchesForeignTable = bodyTargets.some(
    (target) => !context.createdTables.has(target),
  );

  if (ownsTarget && !bodyTouchesForeignTable) {
    return verdict(MIGRATION_STATEMENT_KINDS.EXPAND, 'create_trigger_on_new_table');
  }
  if (ownsTarget && bodyTouchesForeignTable) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'trigger_body_writes_pre_existing_table');
  }
  // RAISE(ABORT|FAIL|ROLLBACK) turns a predecessor write into an error.
  if (/\braise\s*\(\s*(?:abort|fail|rollback)\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'trigger_raises_on_pre_existing_table');
  }
  if (/\bdelete\s+from\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'trigger_deletes_on_pre_existing_table');
  }
  if (/\binstead\s+of\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'trigger_instead_of_on_pre_existing_object');
  }
  if (/\bupdate\b/i.test(sql) || /\binsert\b/i.test(sql) || /\breplace\s+into\b/i.test(sql)) {
    // A write-amplifying trigger on a pre-existing table changes predecessor
    // semantics in ways this classifier cannot bound; require explicit review.
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'trigger_writes_on_pre_existing_table');
  }
  return verdict(MIGRATION_STATEMENT_KINDS.UNKNOWN, 'trigger_on_pre_existing_table_unclassified');
}

function verdict(kind, reason) {
  return { kind, reason };
}

function addColumnVerdict(sql, context) {
  const table = matchTarget(sql, new RegExp(`^alter\\s+table\\s+${QUALIFIED}\\s+add\\b`, 'i'));
  const newTable = table !== null && context.createdTables.has(table);
  const masked = maskSqlStringLiterals(sql);
  const hasNotNull = /\bnot\s+null\b/i.test(masked);
  const hasCheck = /\bcheck\s*\(/i.test(masked);
  const hasGeneratedExpression = /\b(?:generated\s+(?:always\s+)?as|as)\s*\(/i.test(masked);
  const { referenceCount } = referencedTableTargets(sql);
  if (!newTable && !hasOnlySimpleAddColumnDefault(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'add_column_unsafe_default_expression');
  }
  if (!newTable && hasCheck) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'add_column_check_constraint');
  }
  if (!newTable && hasGeneratedExpression) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'add_column_generated_expression');
  }
  if (referenceCount > 0
      && (!newTable || !referencesOnlyOwnedTables(sql, context.createdTables))) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'add_column_foreign_key_constraint');
  }
  if (hasNotNull && !newTable) {
    // The classifier does not attempt to prove every SQLite DEFAULT expression
    // non-NULL. A NULL-valued default is accepted when the table is empty and
    // then rejects predecessor INSERTs, so any new NOT NULL constraint on a
    // pre-existing table fails closed.
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'add_column_not_null_constraint');
  }
  if (/\bunique\b/i.test(masked) && !newTable) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'add_column_unique_constraint');
  }
  if (/\bprimary\s+key\b/i.test(masked) && !newTable) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'add_column_primary_key');
  }
  return verdict(MIGRATION_STATEMENT_KINDS.EXPAND, 'add_column_additive');
}

/**
 * Classify one normalized SQL statement, updating `context` with objects this
 * migration creates.
 *
 * Order matters: destructive patterns are matched before additive ones so a
 * statement that both creates and drops cannot be waved through on its prefix.
 */
export function classifySqlStatement(statement, context = emptyMigrationContext()) {
  const sql = normalizeWhitespace(statement);
  if (!sql) return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'empty_statement');

  // SQLite's catalog can be rewritten directly once `writable_schema` is on.
  // A migration that edits sqlite_master/sqlite_schema is performing arbitrary,
  // unanalysable schema surgery — it can drop, rename or retype anything without
  // ever issuing a DDL statement this classifier could read. It is never
  // admissible unattended, and it must be caught before the DML branches below
  // would otherwise read `UPDATE sqlite_master` as an ordinary backfill.
  if (CATALOG_WRITE.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'catalog_mutation');
  }
  if (new RegExp(`^pragma\\s+(?:${IDENT}\\s*\\.\\s*)?writable_schema\\b`, 'i').test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'writable_schema_pragma');
  }

  if (/^drop\s+table\b/i.test(sql)) {
    const table = matchTarget(sql, new RegExp(`^drop\\s+table\\s+(?:if\\s+exists\\s+)?${QUALIFIED}`, 'i'));
    if (table !== null && context.conditionalTables.has(table)) {
      // `CREATE TABLE IF NOT EXISTS x; DROP TABLE x;` can destroy a table that
      // already held production rows. Conditional creation proves nothing about
      // ownership, so this fails closed.
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'drop_conditionally_created_table');
    }
    if (table !== null && context.createdTables.has(table)) {
      return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'drop_same_migration_table');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'drop_table');
  }
  if (/\bdrop\s+column\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'drop_column');
  }
  if (/^drop\s+index\b/i.test(sql)) {
    const index = matchTarget(sql, new RegExp(`^drop\\s+index\\s+(?:if\\s+exists\\s+)?${QUALIFIED}`, 'i'));
    if (index !== null && context.conditionalIndexes.has(index)) {
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'drop_conditionally_created_index');
    }
    if (index !== null && context.createdIndexes.has(index)) {
      return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'drop_same_migration_index');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'drop_schema_object');
  }
  if (/^drop\s+(?:view|trigger)\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'drop_schema_object');
  }
  if (/^alter\s+table\b[^;]*\brename\b/i.test(sql) || /\brename\s+to\b/i.test(sql)) {
    const table = matchTarget(sql, new RegExp(`^alter\\s+table\\s+${QUALIFIED}\\s+rename\\b`, 'i'));
    if (table !== null && context.createdTables.has(table)) {
      return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'rename_same_migration_table');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'rename');
  }
  if (/^delete\s+from\b/i.test(sql)) {
    const table = matchTarget(sql, new RegExp(`^delete\\s+from\\s+${QUALIFIED}`, 'i'));
    if (table !== null && context.conditionalTables.has(table)) {
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'delete_from_conditionally_created_table');
    }
    if (table !== null && context.createdTables.has(table)) {
      return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'delete_same_migration_rows');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'delete_rows');
  }
  if (/^replace\s+into\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'replace_into_may_delete_rows');
  }
  if (/^create\s+unique\s+index\b/i.test(sql)) {
    const named = new RegExp(
      `^create\\s+unique\\s+index\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`,
      'i',
    ).exec(sql);
    if (named) context.createdIndexes.add(identifierOf(named[named.length - 1]));
    const table = matchTarget(sql, new RegExp(`\\bon\\s+${QUALIFIED}\\s*\\(`, 'i'));
    if (table !== null && context.createdTables.has(table)) {
      return verdict(MIGRATION_STATEMENT_KINDS.EXPAND, 'create_unique_index_on_new_table');
    }
    // A new uniqueness constraint can reject a write the predecessor makes.
    return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'create_unique_index');
  }
  if (/^alter\s+table\b[^;]*\badd\s+column\b/i.test(sql)
      || /^alter\s+table\s+[^;]*\badd\s+/i.test(sql)) {
    return addColumnVerdict(sql, context);
  }
  if (/^alter\s+table\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.UNKNOWN, 'unclassified_alter_table');
  }
  if (/^create\s+virtual\s+table\b/i.test(sql)) {
    const table = matchTarget(
      sql,
      new RegExp(`^create\\s+virtual\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`, 'i'),
    );
    // Creating a virtual table never licenses dropping it later in the same
    // migration. With IF NOT EXISTS the statement is a no-op against a
    // pre-existing table, so a following DROP destroys data this migration did
    // not create. And even unconditionally, DROP on an FTS table also removes
    // its shadow tables, so treating it as "we made it, we can unmake it" is
    // wrong. Registering it as conditional makes any later DROP contract.
    if (table !== null) context.conditionalTables.add(table);
    return verdict(MIGRATION_STATEMENT_KINDS.EXPAND, 'create_virtual_table');
  }
  if (/^create\s+(?:temp\s+|temporary\s+)?table\b/i.test(sql)) {
    const temporary = /^create\s+(?:temp|temporary)\s+table\b/i.test(sql);
    const table = matchTarget(
      sql,
      new RegExp(`^create\\s+(?:temp\\s+|temporary\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`, 'i'),
    );
    // `CREATE TEMP TABLE users` creates `temp.users`, never `main.users`. Keying
    // it as the unqualified name is what let a temp shadow license dropping the
    // real table.
    const key = table === null
      ? null
      : (temporary ? `temp.${table.split('.').pop()}` : table);
    const ownedReferenceTargets = new Set(context.createdTables);
    // A self-reference is confined to the new object as well. Conditional
    // creation cannot license later destructive operations, but its own
    // self-reference is harmless whether the statement creates or is a no-op.
    if (key !== null) ownedReferenceTargets.add(key);
    const persistent = key !== null && !key.startsWith('temp.');
    const referencesAreCompatible = !persistent
      || referencesOnlyOwnedTables(sql, ownedReferenceTargets);
    if (key !== null) {
      if (/\bif\s+not\s+exists\b/i.test(sql)) context.conditionalTables.add(key);
      else context.createdTables.add(key);
    }
    if (!referencesAreCompatible) {
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'create_table_references_pre_existing_table');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.EXPAND, 'create_table');
  }
  if (/^create\s+(?:temp\s+|temporary\s+)?index\b/i.test(sql)) {
    const index = matchTarget(
      sql,
      new RegExp(`^create\\s+(?:temp\\s+|temporary\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`, 'i'),
    );
    if (index !== null) {
      if (/\bif\s+not\s+exists\b/i.test(sql)) context.conditionalIndexes.add(index);
      else context.createdIndexes.add(index);
    }
    const table = matchTarget(sql, new RegExp(`\\bon\\s+${QUALIFIED}\\s*\\(`, 'i'));
    if (table === null || (!context.createdTables.has(table) && !isSimpleColumnIndex(sql))) {
      return verdict(
        MIGRATION_STATEMENT_KINDS.CONTRACT,
        'create_expression_or_partial_index_on_pre_existing_table',
      );
    }
    return verdict(MIGRATION_STATEMENT_KINDS.EXPAND, 'create_schema_object');
  }
  if (/^create\s+(?:temp\s+|temporary\s+)?trigger\b/i.test(sql)) {
    return triggerVerdict(sql, context);
  }
  if (/^create\s+(?:temp\s+|temporary\s+)?view\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.EXPAND, 'create_view');
  }
  if (/^insert\b/i.test(sql)) {
    // `INSERT OR REPLACE` deletes the conflicting row before inserting, so it is
    // a delete in insert's clothing. `OR IGNORE`/`OR ABORT`/`OR FAIL` do not
    // remove existing rows and stay backfills.
    if (/^insert\s+or\s+replace\b/i.test(sql)) {
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'insert_or_replace_may_delete_rows');
    }
    if (/^insert\s+or\s+rollback\b/i.test(sql)) {
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'insert_or_rollback_aborts_transaction');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.BACKFILL, 'insert_rows');
  }
  if (/^update\b/i.test(sql)) {
    // SQLite's UPDATE conflict clause has the same destructive REPLACE
    // semantics as INSERT OR REPLACE: a uniqueness conflict deletes the
    // pre-existing row before retaining the updated row. Image-only rollback
    // cannot restore those bytes, so this is a contract migration.
    if (/^update\s+or\s+replace\b/i.test(sql)) {
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'update_or_replace_may_delete_rows');
    }
    if (/^update\s+or\s+rollback\b/i.test(sql)) {
      return verdict(MIGRATION_STATEMENT_KINDS.CONTRACT, 'update_or_rollback_aborts_transaction');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.BACKFILL, 'update_rows');
  }
  if (/^(?:begin|commit|end|savepoint|release)\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'transaction_control');
  }
  if (/^pragma\b/i.test(sql)) {
    // Existing governed rebuilds use only this connection-scoped FK toggle.
    // Other pragmas can rewrite database headers, schemas, journal mode, or
    // persistent metadata, so they require an explicit classifier decision
    // instead of inheriting a broad neutral default.
    if (/^pragma\s+(?:main\s*\.\s*)?foreign_keys\s*=\s*(?:on|off|0|1)$/i.test(sql)) {
      return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'foreign_keys_pragma');
    }
    return verdict(MIGRATION_STATEMENT_KINDS.UNKNOWN, 'unclassified_pragma');
  }
  if (/^(?:analyze|reindex|vacuum)\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'maintenance_statement');
  }
  if (/^select\b/i.test(sql)) {
    return verdict(MIGRATION_STATEMENT_KINDS.NEUTRAL, 'select_only');
  }
  return verdict(MIGRATION_STATEMENT_KINDS.UNKNOWN, 'unclassified_statement');
}

/** Classify one migration file's contents; the file verdict is its worst statement. */
export function classifyMigrationSql(sql) {
  const statements = splitSqlStatements(sql);
  const context = emptyMigrationContext();
  const reasons = [];
  let kind = MIGRATION_STATEMENT_KINDS.NEUTRAL;
  for (const statement of statements) {
    const result = classifySqlStatement(statement, context);
    if (KIND_RANK[result.kind] > KIND_RANK[kind]) kind = result.kind;
    if (BLOCKING_KINDS.includes(result.kind)) reasons.push(result.reason);
  }
  return {
    kind,
    statementCount: statements.length,
    blockingReasons: [...new Set(reasons)].sort(),
    predecessorCompatible: !BLOCKING_KINDS.includes(kind),
  };
}

/**
 * Apply a narrowly scoped, digest-bound compatibility exemption without
 * weakening the generic SQL classifier. Every governed transition must create
 * its exact replacement before dropping its exact obsolete index. Migration
 * 283 also carries one exact NOT NULL addition whose literal default is bound
 * by the migration digest. Any other blocking statement remains ineligible.
 */
function governedCompatibilityVerdict({ file, sql, verdict: genericVerdict, exemptions = [] }) {
  const migrationSha256 = sha256(Buffer.from(sql));
  const exemption = exemptions.find((candidate) => (
    (candidate?.file === file || `migrations/${candidate?.file}` === file)
      && candidate?.sha256 === migrationSha256
  ));
  if (!exemption) return genericVerdict;
  if (exemption.genericKind !== genericVerdict.kind
      || !Object.values(MIGRATION_STATEMENT_KINDS).includes(exemption.effectiveKind)
      || BLOCKING_KINDS.includes(exemption.effectiveKind)
      || !Array.isArray(exemption.allowedDropIndexes)
      || exemption.allowedDropIndexes.length === 0
      || exemption.allowedDropIndexes.some((transition) => {
        const replacement = transition?.replacement;
        const identifier = (value) => (
          typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
        );
        const columns = (value) => (
          Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
          && value.every(identifier)
        );
        return !transition || Object.keys(transition).sort().join(',')
            !== 'allowAbsent,columns,name,replacement,tableName,unique'
          || !replacement || Object.keys(replacement).sort().join(',')
            !== 'columns,name,tableName,unique'
          || !identifier(transition.name) || !identifier(transition.tableName)
          || !columns(transition.columns) || transition.unique !== true
          || transition.allowAbsent !== true
          || !identifier(replacement.name) || !identifier(replacement.tableName)
          || !columns(replacement.columns) || replacement.unique !== true;
      })) {
    return genericVerdict;
  }
  const statements = splitSqlStatements(sql);
  const context = emptyMigrationContext();
  const blockingStatements = [];
  for (const [position, statement] of statements.entries()) {
    const result = classifySqlStatement(statement, context);
    if (BLOCKING_KINDS.includes(result.kind)) {
      blockingStatements.push({ position, statement, result });
    }
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const claimed = new Set();
  const normalizedFile = file.startsWith('migrations/')
    ? file.slice('migrations/'.length)
    : file;
  const exactConvergenceExemption = exemption.id === RELEASE_SCHEMA_CONVERGENCE_EXEMPTION_ID
    && normalizedFile === RELEASE_SCHEMA_CONVERGENCE_FILE
    && exemption.file === RELEASE_SCHEMA_CONVERGENCE_FILE
    && migrationSha256 === RELEASE_SCHEMA_CONVERGENCE_SHA256
    && exemption.sha256 === RELEASE_SCHEMA_CONVERGENCE_SHA256;
  if (!exactConvergenceExemption) return genericVerdict;
  const allowedNotNullAdds = blockingStatements.filter(({ statement, result }) => (
    result.kind === MIGRATION_STATEMENT_KINDS.CONTRACT
    && result.reason === 'add_column_not_null_constraint'
    && statement === RELEASE_SCHEMA_CONVERGENCE_NOT_NULL_ADD
  ));
  if (allowedNotNullAdds.length !== 1) return genericVerdict;
  claimed.add(allowedNotNullAdds[0].position);
  const transitionNames = exemption.allowedDropIndexes.map(({ name }) => name.toLowerCase());
  const replacementNames = exemption.allowedDropIndexes
    .map(({ replacement }) => replacement.name.toLowerCase());
  if (new Set(transitionNames).size !== transitionNames.length
      || new Set(replacementNames).size !== replacementNames.length) {
    return genericVerdict;
  }
  for (const transition of exemption.allowedDropIndexes) {
    const replacement = transition.replacement;
    const columnPattern = replacement.columns.map(escape).join('\\s*,\\s*');
    const createPattern = new RegExp(
      `^create\\s+unique\\s+index\\s+(?:if\\s+not\\s+exists\\s+)?${escape(replacement.name)}`
      + `\\s+on\\s+${escape(replacement.tableName)}\\s*\\(\\s*${columnPattern}\\s*\\)$`,
      'i',
    );
    const dropPattern = new RegExp(
      `^drop\\s+index\\s+(?:if\\s+exists\\s+)?${escape(transition.name)}$`,
      'i',
    );
    const creates = blockingStatements.filter(({ statement, result }) => (
      result.kind === MIGRATION_STATEMENT_KINDS.CONTRACT
      && result.reason === 'create_unique_index'
      && createPattern.test(statement)
    ));
    const drops = blockingStatements.filter(({ statement, result }) => (
      result.kind === MIGRATION_STATEMENT_KINDS.CONTRACT
      && result.reason === 'drop_schema_object'
      && dropPattern.test(statement)
    ));
    if (creates.length !== 1 || drops.length !== 1
        || creates[0].position >= drops[0].position) {
      return genericVerdict;
    }
    claimed.add(creates[0].position);
    claimed.add(drops[0].position);
  }
  if (claimed.size !== blockingStatements.length) return genericVerdict;
  return {
    ...genericVerdict,
    kind: exemption.effectiveKind,
    blockingReasons: [],
    predecessorCompatible: true,
  };
}

/**
 * Aggregate the per-file verdicts into the independent `cdEligibility` result.
 *
 * This is deliberately separate from `authorization.authorizesPromotion`, which
 * answers a different question: whether an owner has approved a specific
 * irreversible operation. Ordinary continuous deployment must never be derived
 * from that field.
 */
export function evaluateMigrationCdEligibility({
  changedMigrations = [],
  blockingErrors = [],
  irreversibleFindings = [],
  compatibilityExemptions = [],
} = {}) {
  const reasons = [];
  const files = [];

  for (const migration of changedMigrations) {
    const sql = migration.sql ?? '';
    const result = governedCompatibilityVerdict({
      file: migration.file,
      sql,
      verdict: classifyMigrationSql(sql),
      exemptions: compatibilityExemptions,
    });
    files.push({
      file: migration.file,
      kind: result.kind,
      statementCount: result.statementCount,
      predecessorCompatible: result.predecessorCompatible,
      blockingReasons: result.blockingReasons,
    });
    for (const reason of result.blockingReasons) {
      reasons.push(`${migration.file}:${reason}`);
    }
  }

  for (const finding of irreversibleFindings) {
    reasons.push(`${finding.file}:irreversible:${finding.reason}`);
  }
  for (const error of blockingErrors) {
    reasons.push(`migration_safety_error:${error}`);
  }

  if (changedMigrations.length === 0 && reasons.length === 0) {
    reasons.push('no_migration_changes');
  }

  const predecessorCompatible = files.every((file) => file.predecessorCompatible)
    && irreversibleFindings.length === 0;
  const eligible = predecessorCompatible && blockingErrors.length === 0;

  return {
    schema: MIGRATION_CD_ELIGIBILITY_SCHEMA,
    eligible,
    predecessorCompatible,
    reasons: [...new Set(reasons)].sort(),
    files: files.sort((left, right) => left.file.localeCompare(right.file)),
  };
}

/**
 * A stable digest over the exact migration verdict. The signed release manifest
 * carries this digest so the VPS can trust a migration decision it never
 * recomputed.
 */
export function migrationCdEligibilityDigest(result) {
  return sha256(canonicalJson({
    schema: result.schema,
    eligible: result.eligible,
    predecessorCompatible: result.predecessorCompatible,
    reasons: result.reasons,
    files: result.files,
  }));
}

export const MIGRATION_INVENTORY_SCHEMA = 'nexus.migration-inventory.v1';
const MIGRATION_FILE = /^\d{3}_[^/]*\.sql$/;

/**
 * Build the complete ordered inventory of migration files in a release.
 *
 * This exists because eligibility computed from a Git delta is not the set the
 * migrator applies. The migrator applies every file the *ledger* has not
 * recorded, which can include migrations introduced by an earlier release that
 * was blocked. Binding the whole inventory — ordered, with byte digests and
 * per-file classifications — lets the deployment host reconcile what it is about
 * to apply against what CI actually classified, instead of trusting a summary
 * verdict about an unrelated delta.
 */
export function buildMigrationInventory({
  readDir,
  readFile,
  migrationsDir = 'migrations',
  compatibilityExemptions = [],
}) {
  const files = readDir(migrationsDir).filter((file) => MIGRATION_FILE.test(file)).sort();
  return files.map((file) => {
    const bytes = readFile(`${migrationsDir}/${file}`);
    const sql = bytes.toString('utf8');
    const verdict = governedCompatibilityVerdict({
      file,
      sql,
      verdict: classifyMigrationSql(sql),
      exemptions: compatibilityExemptions,
    });
    return {
      file,
      sha256: sha256(bytes),
      kind: verdict.kind,
      predecessorCompatible: verdict.predecessorCompatible,
    };
  });
}

export function assertMigrationInventoryShape(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new Error('migration inventory must be a non-empty ordered array');
  }
  let previous = '';
  for (const entry of inventory) {
    const keys = Object.keys(entry).sort().join(',');
    if (keys !== 'file,kind,predecessorCompatible,sha256') {
      throw new Error('migration inventory entry fields do not match the governed schema');
    }
    if (typeof entry.file !== 'string'
      || entry.file.includes('..')
      || !MIGRATION_FILE.test(entry.file)) {
      throw new Error(`migration inventory entry ${entry.file} is not a migration filename`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`migration inventory entry ${entry.file} has no byte digest`);
    }
    if (!Object.values(MIGRATION_STATEMENT_KINDS).includes(entry.kind)) {
      throw new Error(`migration inventory entry ${entry.file} has an ungoverned kind`);
    }
    if (typeof entry.predecessorCompatible !== 'boolean') {
      throw new Error(`migration inventory entry ${entry.file} has no compatibility flag`);
    }
    // The two fields are not independent: compatibility is *derived* from the
    // kind. Accepting `kind: "contract"` alongside `predecessorCompatible: true`
    // would let a tampered or miscomputed inventory declare a destructive
    // migration safe, and the reconciler trusts this flag when it decides what
    // may be applied unattended.
    const derivedCompatible = !BLOCKING_KINDS.includes(entry.kind);
    if (entry.predecessorCompatible !== derivedCompatible) {
      throw new Error(
        `migration inventory entry ${entry.file} claims predecessorCompatible=`
        + `${entry.predecessorCompatible} for kind ${entry.kind}`,
      );
    }
    // Ordering is part of the contract: the migrator applies in sorted order, so
    // an out-of-order inventory could not be reconciled against it.
    if (entry.file <= previous) {
      throw new Error('migration inventory is not strictly ordered');
    }
    previous = entry.file;
  }
  return inventory;
}

/**
 * Reconcile the signed inventory with what the production ledger has applied.
 *
 * This is the gate that closes the blocked-then-bypassed hole: a contract
 * migration blocked in release A stays pending, so it is still pending when an
 * unrelated release B arrives with an empty migration delta. B is refused here,
 * regardless of B's own summary verdict or of any acknowledgement that cleared
 * A's block.
 */
export function reconcileMigrationLedger({ inventory, appliedFiles, legacyRows = [] }) {
  const applied = new Set(appliedFiles);
  const inventoryFiles = new Set(inventory.map((entry) => entry.file));

  const legacyFiles = new Set(legacyRows.map((entry) => entry.file));
  if (legacyFiles.size !== legacyRows.length) {
    throw new Error('release migration reconciliation contains duplicate legacy rows');
  }
  const observedLegacy = [...applied].filter((file) => legacyFiles.has(file)).sort();
  const expectedLegacy = [...legacyFiles].sort();
  const missingLegacy = expectedLegacy.filter((file) => !applied.has(file));

  // A ledger entry the release does not carry means the database was migrated by
  // something this release does not contain. Refuse rather than guess.
  const unknownApplied = [...applied]
    .filter((file) => !inventoryFiles.has(file) && !legacyFiles.has(file))
    .sort();

  // A set-membership-only check would admit a ledger with a hole, then let the
  // migrator run an older migration after later schema changes. Canonical rows
  // must therefore be exactly the leading inventory prefix. Signed legacy rows
  // remain a separate exact set and do not participate in prefix ordering.
  const canonicalApplied = inventory.filter((entry) => applied.has(entry.file));
  const expectedCanonicalPrefix = inventory.slice(0, canonicalApplied.length);
  const outOfPrefixApplied = canonicalApplied
    .filter((entry, index) => entry.file !== expectedCanonicalPrefix[index]?.file)
    .map((entry) => entry.file);

  const pending = inventory.filter((entry) => !applied.has(entry.file));
  const blocking = pending.filter((entry) => !entry.predecessorCompatible);

  return {
    schema: MIGRATION_INVENTORY_SCHEMA,
    admitted: blocking.length === 0
      && unknownApplied.length === 0
      && missingLegacy.length === 0
      && outOfPrefixApplied.length === 0,
    pending: pending.map((entry) => entry.file),
    blocking: blocking.map((entry) => ({
      file: entry.file,
      kind: entry.kind,
    })),
    unknownApplied,
    admittedLegacy: observedLegacy,
    missingLegacy,
    outOfPrefixApplied,
    reasons: [
      ...blocking.map((entry) => `${entry.file}:pending_not_predecessor_compatible:${entry.kind}`),
      ...unknownApplied.map((file) => `${file}:applied_but_absent_from_release`),
      ...missingLegacy.map((file) => `${file}:required_legacy_row_absent`),
      ...outOfPrefixApplied.map((file) => `${file}:applied_outside_ordered_inventory_prefix`),
    ].sort(),
  };
}
