/**
 * Prisma CLI configuration. Prisma 7 reads the datasource URL and the seed
 * command from here (no longer from schema.prisma's datasource or a
 * `package.json#prisma` block).
 *
 * The CLI does NOT load .env: callers set DATABASE_URL (the root scripts
 * through dotenv-cli, the webapp's release_command from Fly's environment).
 * `prisma generate` needs no URL, so it is optional here.
 *
 * Found from the current directory only: run the CLI from packages/database,
 * or pass `--config packages/database/prisma.config.ts`. The schema and
 * migrations paths are read relative to this file; the seed is a shell
 * command run from the caller's directory, so its script path is built from
 * this file's location. It imports nothing but `prisma/config` and Node
 * built-ins, so it loads anywhere the `prisma` package is installed (the
 * Docker images run the release command from this directory).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const seedScript = fileURLToPath(new URL('./scripts/seed.js', import.meta.url));

export default defineConfig({
  schema: 'schema.prisma',
  migrations: {
    path: 'migrations',
    // Prisma runs this through execa's command parser (prisma/build/cli.js):
    // split on spaces, no shell, quotes reach Node literally, and a space after
    // a backslash is kept. So the path's spaces are escaped that way.
    seed: `node ${seedScript.replaceAll(' ', '\\ ')}`,
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
