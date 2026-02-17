import { defineConfig } from '@trigger.dev/sdk';
// eslint-disable-next-line import/no-unresolved
import { prismaExtension } from '@trigger.dev/build/extensions/prisma';
// eslint-disable-next-line import/no-unresolved
import { aptGet, syncEnvVars } from '@trigger.dev/build/extensions/core';
import { InfisicalSDK } from '@infisical/sdk';

export default defineConfig({
  project: 'proj_ijxcrutouxchmrbjmkkk',
  runtime: 'node',
  logLevel: 'log',
  machine: 'small-2x',
  maxDuration: 900,
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
      syncEnvVars(async (ctx) => {

        // Skip sync if credentials not available (allows local dev without Infisical)
        if (!process.env.INFISICAL_CLIENT_ID || !process.env.INFISICAL_CLIENT_SECRET) {
          console.warn('[Infisical] Credentials not found, skipping secret sync');
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

          // Use prod environment for all Trigger.dev environments
          // TODO: Create dev and sta environments in Infisical for environment-specific secrets
          const infisicalEnv = 'prod';

          console.log(`[Infisical] Syncing secrets from environment: ${infisicalEnv} (Trigger.dev env: ${ctx.environment})`);

          // Fetch all secrets from Infisical
          const { secrets } = await client.secrets().listSecrets({
            environment: infisicalEnv,
            projectId: process.env.INFISICAL_PROJECT_ID,
            includeImports: true, // Include secret references if used
          });

          console.log(`[Infisical] Successfully fetched ${secrets.length} secrets`);

          // Transform to Trigger.dev format
          return secrets.map((secret) => ({
            name: secret.secretKey,
            value: secret.secretValue,
          }));
        } catch (error) {
          console.error('[Infisical] Failed to sync secrets:', error.message);
          // Return empty object to allow deployment to continue with existing vars
          return {};
        }
      }),
    ],
  },
});
