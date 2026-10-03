/**
 * Turn OAuth tokens stored encrypted (`enc1:…`, written while encryption at
 * rest was on) back into plain text: sign-in accounts and Gitlab connections.
 * Idempotent; plain values are skipped. Dry run by default.
 *
 *   npx tsx packages/database/scripts/decryptOAuthTokens.ts          # count only
 *   npx tsx packages/database/scripts/decryptOAuthTokens.ts --apply  # decrypt
 *
 * Needs the deployment's BETTER_AUTH_SECRET (run with NODE_ENV=production so a
 * missing secret stops it). A value that won't decrypt is left as it is.
 * Never prints a token.
 */
import getPrisma, { decryptToken } from '../index.ts';

const apply = process.argv.includes('--apply');
const prisma = getPrisma();

const tables = [
  { table: 'accounts', fields: ['access_token', 'refresh_token', 'id_token'] },
  { table: 'gitlab_connections', fields: ['access_token', 'refresh_token'] },
] as const;

for (const { table, fields } of tables) {
  const encryptedWhere = fields.map(f => `${f} LIKE 'enc1:%'`).join(' OR ');
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, string | null>>>(
    `SELECT id, ${fields.join(', ')} FROM "${table}" WHERE ${encryptedWhere}`
  );
  let decryptable = 0;
  let failed = 0;
  for (const row of rows) {
    const plain: Record<string, string> = {};
    let ok = true;
    for (const field of fields) {
      const value = row[field];
      if (!value?.startsWith('enc1:')) continue;
      const decrypted = decryptToken(value);
      if (decrypted == null) ok = false;
      else plain[field] = decrypted;
    }
    if (!ok) {
      failed += 1;
      continue;
    }
    decryptable += 1;
    if (!apply) continue;
    // Raw SQL: written exactly as given, whatever the client does on write.
    const sets = Object.keys(plain).map((field, i) => `${field} = $${i + 1}`);
    await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET ${sets.join(', ')} WHERE id = $${sets.length + 1}`,
      ...Object.values(plain),
      row.id
    );
  }
  console.log(
    `${table}: ${rows.length} encrypted row(s); ${decryptable} ${apply ? 'decrypted' : 'decryptable'}, ${failed} would not decrypt`
  );
}
process.exit(0);
