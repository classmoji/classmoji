/**
 * The rule every migration not in EXEMPT_MIGRATIONS follows: one transaction,
 * opened and closed by the file itself (packages/database/README.md says why).
 *
 * Read by migrationTransactions.test.ts and by checkMigrations.ts, which CI
 * runs before any deploy migrates, with no install:
 * `node --experimental-strip-types packages/database/scripts/checkMigrations.ts`.
 * So this file imports nothing but Node built-ins and its own list.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEMPT_MIGRATIONS } from './exemptMigrations.ts';

export { EXEMPT_MIGRATIONS };

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * The three migrations that cannot run statement by statement (a temporary
 * table, SET LOCAL): wrapped, always checked, and never allowed to opt out.
 */
export const ALWAYS_WRAPPED: readonly string[] = [
  '20260920000000_coursework_phase1_additive',
  '20260920000003_one_score_per_grader',
  '20261002120000_quiz_assignments',
];

/** First line of a migration that must run outside a transaction. */
export const NO_TRANSACTION_MARKER = '-- classmoji:no-transaction:';

/**
 * Statements Postgres refuses inside a transaction block, the only reason to
 * opt out. Short on purpose; extend it only for a statement Postgres really
 * refuses in a transaction.
 */
const NON_TRANSACTIONAL: ReadonlyArray<[string, RegExp]> = [
  ['CREATE [UNIQUE] INDEX CONCURRENTLY', /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i],
  ['DROP INDEX CONCURRENTLY', /^DROP\s+INDEX\s+CONCURRENTLY\b/i],
  ['REINDEX ... CONCURRENTLY', /^REINDEX\b[\s\S]*\bCONCURRENTLY\b/i],
  ['VACUUM', /^VACUUM\b/i],
];

const OPEN = /^(?:BEGIN(?:\s+(?:TRANSACTION|WORK))?|START\s+TRANSACTION)$/i;
const CLOSE = /^COMMIT(?:\s+(?:TRANSACTION|WORK))?$/i;
/** Any statement that opens, ends or abandons a transaction. */
const TRANSACTION_CONTROL =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK(?!\s+TO\b)|ABORT)\b(?!\s*\()/i;

const HOW_TO_WRAP =
  'Add `BEGIN;` as the first line (after any leading comments) and `COMMIT;` as the last ' +
  'line of migration.sql, so the whole migration applies or none of it does. If it holds ' +
  `a statement Postgres refuses inside a transaction (${NON_TRANSACTIONAL.map(([n]) => n).join(', ')}), ` +
  `put that statement alone in its own migration whose first line is \`${NO_TRANSACTION_MARKER} <reason>\`.`;

/**
 * The file's statements, in order, without comments: split on `;` the way
 * Postgres reads them, skipping semicolons in comments (`--`, nested `/* *\/`),
 * strings ('...', E'...'), quoted identifiers ("...") and dollar-quoted bodies
 * ($$...$$, $tag$...$tag$), so a DO block's BEGIN/END is not mistaken for a
 * transaction.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const flush = () => {
    const statement = current.trim();
    if (statement) statements.push(statement);
    current = '';
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      current += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      current += ' ';
      continue;
    }
    if (c === "'") {
      const escapes = /[eE]$/.test(current) && !/[A-Za-z0-9_][eE]$/.test(current);
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/[A-Za-z0-9_]$/.test(current)) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? sql.length : end + tag[0].length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ';') {
      flush();
      i++;
      continue;
    }
    current += c;
    i++;
  }
  flush();
  return statements;
}

const normalize = (statement: string) => statement.replace(/\s+/g, ' ').trim();
const nonTransactional = (statement: string) =>
  NON_TRANSACTIONAL.find(([, pattern]) => pattern.test(statement))?.[0];

/** Every way `sql` breaks the rule; empty when it follows it. */
export function checkMigration(sql: string, { allowOptOut }: { allowOptOut: boolean }): string[] {
  if (sql.charCodeAt(0) === 0xfeff) {
    return [
      'The file starts with a UTF-8 byte order mark, which Postgres refuses: save migration.sql as UTF-8 without a BOM.',
    ];
  }
  const problems: string[] = [];
  const statements = splitStatements(sql).map(normalize);
  const firstLine = sql.split('\n', 1)[0].trim();

  if (firstLine.toLowerCase().startsWith(NO_TRANSACTION_MARKER)) {
    if (!allowOptOut) {
      return [
        `This migration must stay wrapped in BEGIN/COMMIT: it cannot run statement by statement. Remove \`${NO_TRANSACTION_MARKER}\`.`,
      ];
    }
    const reason = firstLine.slice(NO_TRANSACTION_MARKER.length).trim();
    if (!reason) {
      problems.push(
        `Opted out of the transaction without saying why: give the reason after the marker, e.g. \`${NO_TRANSACTION_MARKER} the index build must not block writes\`.`
      );
    }
    if (statements.length !== 1) {
      problems.push(
        `A migration that opts out of the transaction must hold exactly one statement (it has ${statements.length}). ` +
          'Move everything else into a separate, wrapped migration.'
      );
    }
    if (!statements.some(nonTransactional)) {
      problems.push(
        `The \`${NO_TRANSACTION_MARKER}\` opt-out is only for a statement Postgres refuses inside a transaction ` +
          `(${NON_TRANSACTIONAL.map(([n]) => n).join(', ')}); this migration has none. ${HOW_TO_WRAP}`
      );
    }
    return problems;
  }

  const first = statements[0] ?? '';
  const last = statements.at(-1) ?? '';
  if (!OPEN.test(first)) {
    problems.push(
      `The first statement must be BEGIN; (it is \`${first.slice(0, 60)}\`). ${HOW_TO_WRAP}`
    );
  }
  if (statements.length < 2 || !CLOSE.test(last)) {
    problems.push(
      `The last statement must be COMMIT; (it is \`${last.slice(0, 60)}\`). ` +
        (OPEN.test(first)
          ? 'Without it `prisma migrate deploy` reports success and applies NOTHING (the open transaction is rolled back). '
          : '') +
        HOW_TO_WRAP
    );
  }
  const inner = statements.slice(OPEN.test(first) ? 1 : 0, CLOSE.test(last) ? -1 : undefined);
  const control = inner.filter(statement => TRANSACTION_CONTROL.test(statement));
  if (control.length > 0) {
    problems.push(
      `A migration runs as only one transaction: remove ${control
        .map(statement => `\`${statement.slice(0, 40)}\``)
        .join(', ')} between the opening BEGIN; and the final COMMIT;.`
    );
  }
  for (const statement of inner) {
    const kind = nonTransactional(statement);
    if (kind) {
      problems.push(
        `\`${statement.slice(0, 60)}\` (${kind}) cannot run inside a transaction: move it alone into its own migration whose first line is \`${NO_TRANSACTION_MARKER} <reason>\`.`
      );
    }
  }
  return problems;
}

export interface MigrationsReport {
  /** Each checked migration and what is wrong with it (empty: fine). */
  checked: Array<{ name: string; problems: string[] }>;
  /** Names in EXEMPT_MIGRATIONS or ALWAYS_WRAPPED with no directory any more. */
  missing: string[];
}

/**
 * Check every migration directory in `dir` that is not exempt. A missing
 * exempt or always-wrapped directory is reported too: renaming one must not
 * be a way around the rule.
 */
export async function checkMigrationsDir(dir: string = MIGRATIONS_DIR): Promise<MigrationsReport> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const exempt = new Set(EXEMPT_MIGRATIONS);
  const checked: MigrationsReport['checked'] = [];
  for (const name of names) {
    // An always-wrapped migration is checked even if someone lists it as exempt.
    if (exempt.has(name) && !ALWAYS_WRAPPED.includes(name)) continue;
    const sql = await readFile(join(dir, name, 'migration.sql'), 'utf8');
    checked.push({
      name,
      problems: checkMigration(sql, { allowOptOut: !ALWAYS_WRAPPED.includes(name) }),
    });
  }
  const present = new Set(names);
  const missing = [...EXEMPT_MIGRATIONS, ...ALWAYS_WRAPPED].filter(name => !present.has(name));
  return { checked, missing };
}
