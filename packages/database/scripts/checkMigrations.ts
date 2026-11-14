/**
 * Fails (exit 1) when a migration breaks the transaction rule in
 * migrationRules.ts. Needs no install: CI runs it before any deploy migrates,
 * from the repository root:
 *
 *   node --experimental-strip-types packages/database/scripts/checkMigrations.ts
 *
 * (`npm run db:check-migrations` locally.) An optional argument names another
 * migrations directory.
 */
import { checkMigrationsDir, MIGRATIONS_DIR } from './migrationRules.ts';

const dir = process.argv[2] ?? MIGRATIONS_DIR;
const { checked, missing } = await checkMigrationsDir(dir);
const failing = checked.filter(migration => migration.problems.length > 0);

for (const { name, problems } of failing) {
  console.error(`\n${name}/migration.sql:`);
  for (const problem of problems) console.error(`  - ${problem}`);
}
for (const name of missing) {
  console.error(
    `\n${name}: this migration is listed as exempt or always-wrapped but its directory is gone. ` +
      'Applied migrations are never renamed or deleted; restore it (or, if it truly was removed, update the list in packages/database/scripts/).'
  );
}

if (failing.length > 0 || missing.length > 0) {
  console.error(
    `\n${failing.length} migration(s) break the transaction rule, ${missing.length} listed migration(s) missing. See packages/database/README.md.`
  );
  process.exitCode = 1;
} else {
  console.log(`Migrations OK: ${checked.length} checked, the rest exempt.`);
}
