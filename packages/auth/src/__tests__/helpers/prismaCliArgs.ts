/**
 * Prisma 7's CLI takes its datasource URL (and the migrations folder) from a
 * config file, not from the schema, and has no `--schema`-only way to migrate.
 * The integration suites deploy copies of packages/database's schema and
 * migrations, so for each copy this writes a `prisma.config.mjs` beside its
 * schema.prisma (a plain object: the copies live in a temporary folder where
 * `prisma/config` cannot be imported) and turns `--schema <copy>` into
 * `--config <that file>`. The URL comes from the command's DATABASE_URL.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const CONFIG = (schemaFile: string) => `export default {
  schema: ${JSON.stringify(schemaFile)},
  migrations: { path: 'migrations' },
  datasource: { url: process.env.DATABASE_URL },
};
`;

/**
 * The config file for the schema at `schemaPath`: packages/database's own
 * `prisma.config.ts` for the real schema (never a file written into the
 * package), else one written once beside the copy.
 */
export function configBeside(schemaPath: string): string {
  const own = join(dirname(schemaPath), 'prisma.config.ts');
  if (existsSync(own)) return own;
  const file = join(dirname(schemaPath), 'prisma.config.mjs');
  if (!existsSync(file)) writeFileSync(file, CONFIG(basename(schemaPath)));
  return file;
}

/** `args` with every `--schema <path>` replaced by `--config <its config>`. */
export function withConfigArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--schema' && i + 1 < args.length) {
      out.push('--config', configBeside(args[++i]));
    } else {
      out.push(args[i]);
    }
  }
  return out;
}
