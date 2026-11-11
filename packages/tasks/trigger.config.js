import { defineConfig } from '@trigger.dev/sdk';
// eslint-disable-next-line import/no-unresolved
import { prismaExtension } from '@trigger.dev/build/extensions/prisma';
// eslint-disable-next-line import/no-unresolved
import { aptGet, ffmpeg, syncEnvVars } from '@trigger.dev/build/extensions/core';
// eslint-disable-next-line import/no-unresolved
import { pythonExtension } from '@trigger.dev/python/extension';
import { InfisicalSDK } from '@infisical/sdk';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Options for the Python build extension that carries the team-set solver
 * (python/team_set_solver.py, OR-Tools CP-SAT).
 *
 * A FUNCTION, called only inside `build.extensions`, never at module top level:
 * the CLI's config-strip plugin replaces `build` with `{}` when it bundles this
 * file into the worker, but top-level statements survive — and a top-level file
 * read of a path resolved from this file's location would run inside the
 * deployed container, where that path does not exist.
 *
 * `requirements`, NOT `requirementsFile`. In @trigger.dev/python (still in
 * 4.8.3) the requirementsFile branch emits `COPY ./python/requirements.txt .`
 * followed by `pip install -r ./python/requirements.txt`; the COPY lands the file at
 * `./requirements.txt`, so a nested requirements file cannot be opened and the
 * image build fails (triggerdotdev/trigger.dev#1843). The `requirements` branch
 * writes the list to a file and installs it in one working directory. The file
 * stays the single source of truth — it is also what the local venv installs.
 *
 * `scripts` is resolved relative to this directory and copied to the same
 * relative path in the build output (`/app/python/…` when deployed). The glob
 * does not descend into dot-directories, so the local `.venv` is not copied.
 *
 * `devPythonBinaryPath` points `trigger dev` at the local venv (see
 * python/README.md) and is set only when that interpreter exists, so a checkout
 * without the venv still loads this config; the solve task then fails its runs
 * with `engine_error` rather than the whole dev worker refusing to start.
 * Deployed images ignore it and use the extension's /opt/venv. (The CLI, as of
 * 4.6.4, snapshots dev run environments before the extension sets it in
 * `onBuildComplete`, so the solve task also falls back to the venv itself —
 * `useLocalVenvIfUnset`.)
 */
function teamSetSolverPythonOptions() {
  const pythonDir = join(dirname(fileURLToPath(import.meta.url)), 'python');
  const requirements = readFileSync(join(pythonDir, 'requirements.txt'), 'utf8')
    .split('\n')
    .map(line => line.replace(/\s+#.*$/, '').trim())
    .filter(line => line && !line.startsWith('#'));
  const venvPython = join(pythonDir, '.venv', 'bin', 'python');
  return {
    requirements,
    scripts: ['./python/**/*.py'],
    ...(existsSync(venvPython) ? { devPythonBinaryPath: venvPython } : {}),
  };
}

/**
 * The chat agents' tasks (`quiz-attempt`, `ask-moji`) live in
 * the private ai-agent submodule. Trigger.dev registers only task files inside this
 * project, so `src/private-agents` re-exports them (`@classmoji/ai-agent/trigger`),
 * and `dirs` lists it only when the submodule's entry exists: a checkout
 * without the submodule (or with one from before the tasks moved) builds and
 * runs every other task.
 *
 * Top level on purpose, and harmless there: `dirs` is read only at build time,
 * and inside the deployed worker this check just finds nothing (an existsSync,
 * never a read or a throw; see teamSetSolverPythonOptions above).
 */
const privateAgentsEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../apps/ai-agent/src/trigger/index.ts'
);
const hasPrivateAgents = existsSync(privateAgentsEntry);

/**
 * Refuses a deployed build without the private agents: deploying it would
 * remove `quiz-attempt` and `ask-moji` from the environment. Runs from
 * `build.extensions` only, which the deployed worker never sees, so the throw
 * reaches the CLI (CI and a manual `trigger:deploy` alike), never a run.
 * `trigger dev` (target "dev") starts without them.
 */
function requirePrivateAgentsOnDeploy() {
  return {
    name: 'classmoji-require-private-agents',
    onBuildStart(context) {
      if (context.target === 'dev' || hasPrivateAgents) return;
      throw new Error(
        `[private-agents] ${privateAgentsEntry} is missing, so this ${context.target} build would ship without the quiz-attempt and ask-moji chat agents. ` +
          'Populate the ai-agent submodule (git submodule update --init apps/ai-agent) at a commit that has src/trigger, then build again.'
      );
    },
  };
}

/**
 * The Postgres majors the `db-backup` task carries a client for. Each run asks
 * the server its major and uses that client (`clientFor` in
 * src/helpers/dbBackup.ts): pg_dump refuses a server newer than itself, and a
 * dump from a newer pg_dump may not restore into the server's own version. So
 * a Neon upgrade to any major listed here needs no change; production was on
 * 16 when this was written. Newest last: its psql asks the version.
 */
const POSTGRES_CLIENT_MAJORS = [16, 17, 18];

/**
 * Installs `postgresql-client-<major>` for each major from the PostgreSQL
 * project's own apt repository (PGDG): Debian bookworm, the node-24 image's
 * base, ships only 15. Binaries are called by absolute path under
 * `/usr/lib/postgresql/<major>/bin`, so Debian's pg_wrapper never picks one.
 * Like aptGet/ffmpeg, it does nothing for `trigger dev`, which uses the
 * client on PATH.
 */
function postgresClient(majors) {
  const root = '/usr/lib/postgresql';
  const newest = Math.max(...majors);
  const packages = majors.map(major => `postgresql-client-${major}`).join(' ');
  const check = majors.map(major => `${root}/${major}/bin/pg_dump --version`).join(' && ');
  return {
    name: 'classmoji-postgres-client',
    onBuildComplete(context) {
      if (context.target === 'dev') return;
      context.addLayer({
        id: 'postgres-client',
        image: {
          instructions: [
            'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && ' +
              'install -d /usr/share/postgresql-common/pgdg && ' +
              'curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc && ' +
              'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && ' +
              `apt-get update && apt-get install -y --no-install-recommends ${packages} && ` +
              `${check} && ` +
              'apt-get clean && rm -rf /var/lib/apt/lists/*',
          ],
        },
        deploy: {
          env: {
            PG_BIN_ROOT: root,
            PSQL_PATH: `${root}/${newest}/bin/psql`,
          },
          override: true,
        },
      });
    },
  };
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID || 'proj_ijxcrutouxchmrbjmkkk',
  // Pinned to a Node major, the one the rest of the repo runs (Node 24): unset
  // or bare 'node' follows Trigger's current Node LTS, so a CLI upgrade alone
  // could move the worker to another major. Deploys on Trigger's
  // node:24-bookworm image.
  runtime: 'node-24',
  logLevel: 'log',
  machine: 'small-2x',
  maxDuration: 900,
  // Reuse the task process between runs on a machine Trigger.dev keeps warm.
  // Without it every run starts a fresh Node process — even on a reused
  // machine — and re-imports its modules: `content-checkpoint` (Present, Save
  // version) would pay its renderer imports (BlockNote server editor, jsdom)
  // on every run, and the collab warm-ups (a no-op `content-checkpoint` run at
  // most once a minute while a live doc is open) would keep only the machine
  // warm, not the process. A warm machine (and so a kept-alive process) takes
  // the next run of ANY task in this deployment with the same machine size,
  // which is why content-checkpoint has its own preset. Recycle after
  // Trigger.dev's documented default of 50 runs to bound any build-up.
  processKeepAlive: { enabled: true, maxExecutionsPerProcess: 50 },
  // Safety guard: a LOCAL dev worker must never write to a remote (e.g. prod
  // Neon) database. Trigger.dev loads the `.env` next to this config
  // (packages/tasks/.env), which can silently drift to a production
  // DATABASE_URL — causing local installs/webhooks to mutate prod. Fail loudly
  // before any task runs if we're in the DEVELOPMENT environment but pointed at
  // a non-local database. Deployed (STAGING/PRODUCTION) runs are unaffected.
  init: async ({ ctx }) => {
    if (ctx?.environment?.type !== 'DEVELOPMENT') return;
    const isLocal = url =>
      /@(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)[:/]/.test(url);
    // DATABASE_URL_UNPOOLED, when set, is used by the few places that need a
    // direct connection, so it must be local too.
    for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
      const url = process.env[name] || '';
      if (name !== 'DATABASE_URL' && !url) continue;
      if (!isLocal(url)) {
        const masked = url.replace(/\/\/[^@]*@/, '//***@');
        throw new Error(
          `[db-safety] Local Trigger.dev (DEVELOPMENT) worker is pointed at a NON-LOCAL database: ${masked}. ` +
            `Refusing to run so local task runs cannot write to production. ` +
            `Fix ${name} in packages/tasks/.env to point at localhost.`
        );
      }
    }
  },
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 1,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ['./src/workflows', ...(hasPrivateAgents ? ['./src/private-agents'] : [])],
  // The CLI's default ignore list (test and spec files) plus test fixtures:
  // every other file under `dirs` is imported to discover tasks, and a fixture
  // repository's browser script must never be. Setting this replaces the
  // defaults, so they are repeated here.
  ignorePatterns: [
    '**/*.test.ts',
    '**/*.test.mts',
    '**/*.test.cts',
    '**/*.test.js',
    '**/*.test.mjs',
    '**/*.test.cjs',
    '**/*.spec.ts',
    '**/*.spec.mts',
    '**/*.spec.cts',
    '**/*.spec.js',
    '**/*.spec.mjs',
    '**/*.spec.cjs',
    '**/__fixtures__/**',
  ],
  build: {
    // jsdom cannot be bundled: it reads files beside its own modules at load
    // (`__dirname`-relative default stylesheet, `require.resolve` of the XHR
    // sync worker), so a bundled copy throws on import. `content-checkpoint`
    // pulls it in through @blocknote/server-util (@classmoji/page-schema/server).
    // Kept external, the CLI installs the version the importer resolves.
    external: ['jsdom'],
    extensions: [
      // First, so a deploy without the private agents fails before any layer.
      requirePrivateAgentsOnDeploy(),
      prismaExtension({
        schema: '../database/schema.prisma',
        mode: 'legacy',
        // Only the Node client. schema.prisma's `workerClient` generator is
        // the Cloudflare Workers client, which the worker never loads.
        clientGenerator: 'client',
      }),
      aptGet({
        // git-lfs: `gh-create_git_repo` copies templates that keep their
        // files in Git LFS (see helpers/templatePush.ts).
        packages: ['bash', 'git', 'git-lfs'],
      }),
      // For `media-video-process`. No version: the extension installs Debian's
      // `ffmpeg` package — on the node-24 image (bookworm) that is 5.1.x, a
      // fixed release with libx264 and the native aac/mjpeg encoders. (Version
      // '7' would pull johnvansickle's static `ffmpeg-git`, i.e. whatever git
      // master is on build day.) Sets FFMPEG_PATH / FFPROBE_PATH in deployed
      // images; it does nothing for `trigger dev`, which uses ffmpeg on PATH.
      ffmpeg(),
      // For `db-backup` (pg_dump, pg_restore --list, psql).
      postgresClient(POSTGRES_CLIENT_MAJORS),
      pythonExtension(teamSetSolverPythonOptions()),
      syncEnvVars(async ctx => {
        // Skip sync if credentials not available (allows local dev without Infisical)
        if (!process.env.INFISICAL_CLIENT_ID || !process.env.INFISICAL_CLIENT_SECRET) {
          console.warn('[Infisical] Credentials not found, skipping secret sync.');
          return {};
        }

        try {
          // Initialize Infisical client
          const client = new InfisicalSDK({
            siteUrl: process.env.INFISICAL_HOST || 'https://app.infisical.com',
          });

          // Authenticate with Universal Auth
          await client.auth().universalAuth.login({
            clientId: process.env.INFISICAL_CLIENT_ID,
            clientSecret: process.env.INFISICAL_CLIENT_SECRET,
          });

          // Map Trigger.dev environment to Infisical environment.
          // Preview deploys (e.g. branch "dev") pull from Infisical's dev env.
          // NOTE: never default to 'prod'. An unmapped environment (e.g. the
          // local `dev` environment) must NOT pull production secrets — doing so
          // injects the prod Neon DATABASE_URL into local dev workers, so local
          // task runs write to production. Unknown env => sync nothing.
          const envMap = { prod: 'prod', staging: 'sta', preview: 'dev', dev: 'dev' };
          const infisicalEnv = envMap[ctx.environment];
          if (!infisicalEnv) {
            console.warn(
              `[Infisical] No Infisical env mapped for Trigger.dev env "${ctx.environment}", skipping secret sync.`
            );
            return {};
          }

          console.log(
            `[Infisical] Syncing secrets from environment: ${infisicalEnv} (Trigger.dev env: ${ctx.environment})`
          );

          // Fetch all secrets from Infisical
          const { secrets } = await client.secrets().listSecrets({
            environment: infisicalEnv,
            projectId: process.env.INFISICAL_PROJECT_ID,
            includeImports: true, // Include secret references if used
          });

          console.log(`[Infisical] Successfully fetched ${secrets.length} secrets`);

          // Transform to Trigger.dev format
          const mapped = secrets.map(secret => ({
            name: secret.secretKey,
            value: secret.secretValue,
          }));

          // Tasks use the pooled DATABASE_URL, the same one the web apps use.
          // The direct endpoint is synced as DATABASE_URL_UNPOOLED like any other
          // secret, for the few places that need session state (a session-level
          // advisory lock, a session setting).
          return mapped;
        } catch (error) {
          console.error('[Infisical] Failed to sync secrets:', error.message);
          // Return empty object to allow deployment to continue with existing vars
          return {};
        }
      }),
    ],
  },
});
