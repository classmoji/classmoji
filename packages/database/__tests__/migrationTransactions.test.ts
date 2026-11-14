/**
 * Every migration not in EXEMPT_MIGRATIONS runs in ONE transaction it opens
 * itself (packages/database/README.md says why). The same rules as
 * scripts/checkMigrations.ts, which CI runs before a deploy migrates.
 */
import { describe, expect, it } from 'vitest';

import {
  ALWAYS_WRAPPED,
  EXEMPT_MIGRATIONS,
  NO_TRANSACTION_MARKER,
  checkMigration,
  checkMigrationsDir,
  splitStatements,
} from '../scripts/migrationRules.ts';

const report = await checkMigrationsDir();

describe('migrations run in a transaction they open themselves', () => {
  it('every exempt and always-wrapped migration still exists (a rename must not escape the rule)', () => {
    expect(report.missing).toEqual([]);
  });

  it('the exempt list is frozen at the 131 migrations that predate the rule', () => {
    expect(EXEMPT_MIGRATIONS).toHaveLength(131);
    for (const name of ALWAYS_WRAPPED) expect(EXEMPT_MIGRATIONS).not.toContain(name);
  });

  it('the always-wrapped migrations are checked', () => {
    expect(report.checked.map(({ name }) => name)).toEqual(
      expect.arrayContaining([...ALWAYS_WRAPPED])
    );
  });

  it.each(report.checked.map(({ name, problems }) => [name, problems] as const))(
    '%s',
    (name, problems) => {
      expect(problems, `packages/database/migrations/${name}/migration.sql`).toEqual([]);
    }
  );
});

describe('the rules', () => {
  const wrapped = (body: string) => `-- what this does\nBEGIN;\n\n${body}\n\nCOMMIT;\n`;
  const one = (sql: string) => checkMigration(sql, { allowOptOut: true });

  it('accepts BEGIN; / BEGIN TRANSACTION; / START TRANSACTION; ... COMMIT;', () => {
    expect(one(wrapped('ALTER TABLE "a" ADD COLUMN "b" int;'))).toEqual([]);
    expect(one('BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;')).toEqual([]);
    expect(one('start transaction;\nselect 1;\ncommit;')).toEqual([]);
  });

  it('refuses a migration without the wrapper, and says what to add', () => {
    const problems = one('ALTER TABLE "a" ADD COLUMN "b" int;\n');
    expect(problems.join('\n')).toMatch(/first statement must be BEGIN;/);
    expect(problems.join('\n')).toMatch(/last statement must be COMMIT;/);
    expect(problems.join('\n')).toMatch(/Add `BEGIN;` as the first line/);
  });

  it('refuses BEGIN; without COMMIT; and says that deploy would apply nothing', () => {
    const problems = one('BEGIN;\nALTER TABLE "a" ADD COLUMN "b" int;\n').join('\n');
    expect(problems).toMatch(/last statement must be COMMIT;/);
    expect(problems).toMatch(/applies NOTHING/);
  });

  it('refuses a UTF-8 byte order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(one(bom + wrapped('SELECT 1;')).join('\n')).toMatch(/byte order mark/);
  });

  it('refuses a second transaction or a ROLLBACK inside the wrapper', () => {
    expect(one(wrapped('SELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;')).join('\n')).toMatch(
      /only one transaction/
    );
    expect(one(wrapped('ROLLBACK;')).join('\n')).toMatch(/only one transaction/);
  });

  it('ignores BEGIN/END inside DO $$ ... $$ bodies, strings and comments', () => {
    const sql = wrapped(
      [
        "DO $$ BEGIN IF true THEN RAISE NOTICE 'COMMIT;'; END IF; END $$;",
        'DO $body$\nBEGIN\n  PERFORM 1;\nEND\n$body$;',
        "SELECT 'BEGIN; COMMIT;';",
        '/* BEGIN; */ SELECT 1; -- COMMIT;',
      ].join('\n')
    );
    expect(one(sql)).toEqual([]);
  });

  it('refuses a statement Postgres will not run inside a transaction, inside the wrapper', () => {
    expect(one(wrapped('CREATE INDEX CONCURRENTLY "i" ON "a" ("b");')).join('\n')).toMatch(
      /cannot run inside a transaction/
    );
  });

  it('accepts the opt-out for exactly one non-transactional statement', () => {
    const sql = `${NO_TRANSACTION_MARKER} the index build must not lock writes\nCREATE INDEX CONCURRENTLY "i" ON "a" ("b");\n`;
    expect(one(sql)).toEqual([]);
  });

  it('refuses the opt-out without a reason, for a statement that can be wrapped, or with more than one statement', () => {
    expect(
      one(`${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY "i" ON "a" ("b");`).join('\n')
    ).toMatch(/give the reason/);
    expect(
      one(`${NO_TRANSACTION_MARKER} faster\nALTER TABLE "a" ADD COLUMN "b" int;`).join('\n')
    ).toMatch(/only for a statement Postgres refuses inside a transaction/);
    expect(
      one(
        `${NO_TRANSACTION_MARKER} index\nCREATE INDEX CONCURRENTLY "i" ON "a" ("b");\nALTER TABLE "a" ADD COLUMN "c" int;`
      ).join('\n')
    ).toMatch(/exactly one statement/);
  });

  it('refuses the opt-out where it is not allowed (the always-wrapped migrations)', () => {
    const sql = `${NO_TRANSACTION_MARKER} index\nCREATE INDEX CONCURRENTLY "i" ON "a" ("b");`;
    expect(checkMigration(sql, { allowOptOut: false }).join('\n')).toMatch(/must stay wrapped/);
  });

  it('splits statements the way Postgres does', () => {
    expect(
      splitStatements('-- c\nSELECT \'a;b\'; DO $x$ BEGIN END $x$; SELECT "a;" FROM t /* ; */;\n')
    ).toEqual(["SELECT 'a;b'", 'DO $x$ BEGIN END $x$', 'SELECT "a;" FROM t']);
  });
});
