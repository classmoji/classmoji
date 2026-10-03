/**
 * Encrypt OAuth tokens stored before encryption at rest (see index.ts):
 * sign-in accounts and Gitlab connections. Idempotent; already encrypted
 * values are skipped. Dry run by default.
 *
 *   npx tsx packages/database/scripts/encryptOAuthTokens.ts          # count only
 *   npx tsx packages/database/scripts/encryptOAuthTokens.ts --apply  # encrypt
 *
 * Needs the deployment's BETTER_AUTH_SECRET: tokens encrypted under another
 * secret can't be read back.
 */
import getPrisma from '../index.ts';

const apply = process.argv.includes('--apply');
const prisma = getPrisma();

const tables = [
  { table: 'accounts', model: 'account', fields: ['access_token', 'refresh_token', 'id_token'] },
  {
    table: 'gitlab_connections',
    model: 'gitLabConnection',
    fields: ['access_token', 'refresh_token'],
  },
] as const;

for (const { table, model, fields } of tables) {
  const plainWhere = fields.map(f => `(${f} IS NOT NULL AND ${f} NOT LIKE 'enc1:%')`).join(' OR ');
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, string | null>>>(
    `SELECT id, ${fields.join(', ')} FROM "${table}" WHERE ${plainWhere}`
  );
  console.log(`${table}: ${rows.length} row(s) with plain-text tokens`);
  if (!apply) continue;
  for (const row of rows) {
    const data: Record<string, string> = {};
    for (const field of fields) {
      const value = row[field];
      if (value && !value.startsWith('enc1:')) data[field] = value;
    }
    // The client encrypts on write.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any)[model].update({ where: { id: row.id }, data });
  }
  console.log(`${table}: encrypted ${rows.length}`);
}
process.exit(0);
