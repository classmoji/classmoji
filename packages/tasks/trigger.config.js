import { defineConfig } from '@trigger.dev/sdk';
// eslint-disable-next-line import/no-unresolved
import { prismaExtension } from '@trigger.dev/build/extensions/prisma';
// eslint-disable-next-line import/no-unresolved
import { aptGet, syncEnvVars } from '@trigger.dev/build/extensions/core';
import { InfisicalSDK } from '@infisical/sdk';

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID || 'proj_ijxcrutouxchmrbjmkkk',
  runtime: 'node',
  logLevel: 'log',
  machine: 'small-2x',
  maxDuration: 900,
  // Safety guard: a LOCAL dev worker must never write to a remote (e.g. prod
  // Neon) database. Trigger.dev loads the `.env` next to this config
  // (packages/tasks/.env), which can silently drift to a production
  // DATABASE_URL — causing local installs/webhooks to mutate prod. Fail loudly
  // before any task runs if we're in the DEVELOPMENT environment but pointed at
  // a non-local database. Deployed (STAGING/PRODUCTION) runs are unaffected.
  init: async ({ ctx }) => {
    if (ctx?.environment?.type !== 'DEVELOPMENT') return;
    const url = process.env.DATABASE_URL || '';
    const isLocal = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)[:/]/.test(url);
    if (!isLocal) {
      const masked = url.replace(/\/\/[^@]*@/, '//***@');
      throw new Error(
        `[db-safety] Local Trigger.dev (DEVELOPMENT) worker is pointed at a NON-LOCAL database: ${masked}. ` +
          `Refusing to run so local task runs cannot write to production. ` +
          `Fix DATABASE_URL in packages/tasks/.env to point at localhost.`
      );
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
  dirs: ['./src/workflows'],
  build: {
    extensions: [
      prismaExtension({
        schema: '../database/schema.prisma',
        mode: 'legacy',
      }),
      aptGet({
        packages: ['bash', 'git'],
      }),
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

          // Trigger.dev workers need a direct (unpooled) connection
          const unpooledUrl = mapped.find(s => s.name === 'DATABASE_URL_UNPOOLED')?.value;
          if (unpooledUrl) {
            const entry = mapped.find(s => s.name === 'DATABASE_URL');
            if (entry) entry.value = unpooledUrl;
            else mapped.push({ name: 'DATABASE_URL', value: unpooledUrl });
          }

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
