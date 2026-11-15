import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { envOnlyMacros } from 'vite-env-only';
import devtoolsJson from 'vite-plugin-devtools-json';
import tailwindcss from '@tailwindcss/vite';

// The Sentry plugins a build keeps: the config `buildEnd` reads, hidden source
// maps and Sentry's bundler plugin. The others add a tunnel route and a hook to
// the server build for Sentry on the server, which no app here runs.
const SENTRY_BUILD_PLUGINS = new Set([
  'sentry-react-router-config-injector',
  'sentry-react-router-update-source-map-setting',
  'sentry-vite-plugin',
]);

export default async ({ command, mode }) => {
  const isBuild = command === 'build';
  // Source maps for Sentry (error stack traces), only when SENTRY_AUTH_TOKEN is
  // set (CI deploys). Without it nothing here runs and the build is unchanged.
  // With it, maps are generated hidden, uploaded by `buildEnd` in
  // react-router.config.js and then deleted, so they are never served.
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
  const uploadSourceMaps = command === 'build' && Boolean(sentryAuthToken);
  const sentryPlugins = uploadSourceMaps
    ? (
        await (
          await import('@sentry/react-router/vite')
        ).sentryReactRouter(
          {
            org: 'dali-lab',
            // One project for webapp, pages and slides; debug ids tell the bundles apart.
            project: 'classmoji',
            authToken: sentryAuthToken,
            telemetry: false,
            // A fixed release for the uploaded artifacts (debug ids do the
            // matching; `buildEnd` creates it whatever `create` says). Nothing
            // is injected into the bundles, so their content and file names
            // do not change from build to build because of it.
            release: {
              name: 'classmoji-sourcemaps',
              inject: false,
              create: false,
              finalize: false,
              setCommits: false,
            },
            // Sentry runs in the browser only: no build-time instrumentation
            // of server modules, which would also bundle them into the server build.
            buildTimeInstrumentation: false,
          },
          { command, mode }
        )
      ).filter(plugin => SENTRY_BUILD_PLUGINS.has(plugin.name))
    : [];
  return defineConfig({
    // Strips the Sentry SDK's debug logging from the client bundle.
    define: { __SENTRY_DEBUG__: false },
    // Load .env from monorepo root so Vite watches it for changes.
    // This triggers a dev server restart when the setup wizard writes GitHub credentials.
    envDir: '../../',
    environments: {
      client: {
        build: {
          rollupOptions: {
            output: {
              // Preserve function and class names for better stack traces, as
              // `esbuild.keepNames` did before Vite 8 minified with Oxc. The
              // minifier's option, not Rolldown's `output.keepNames`: that one
              // writes class static blocks, which `build.target` cannot lower.
              minify: {
                compress: { keepNames: { function: true, class: true } },
                mangle: { keepNames: true },
              },
            },
          },
        },
      },
    },
    ssr: {
      // In production builds, bundle what lives in apps/webapp/node_modules (packages
      // npm doesn't hoist to the root): the Dockerfile only copies root node_modules
      // into the image, so anything left external must resolve there at runtime.
      // - @trigger.dev/react-hooks and the @trigger.dev/core it pulls in, with that
      //   core's own deps listed after it: npm nests them in apps/webapp whenever
      //   another workspace pins a different Trigger.dev version (all pins are the
      //   same today, so they sit at the root). Bundled, the image never loads the
      //   wrong copy or none at all when they are nested again.
      // - @trigger.dev/sdk must stay EXTERNAL: root has it together with its own
      //   nested node_modules, which only Node's resolution from the sdk's real
      //   location finds. Bundling it cuts it off from those.
      noExternal: isBuild
        ? [
            'use-sound',
            '@trigger.dev/react-hooks',
            '@trigger.dev/core',
            'zod-validation-error',
            '@opentelemetry/api',
            '@opentelemetry/core',
            'nanoid',
            'std-env',
            /@mantine\//,
            /@tabler\//,
            'lucide-react',
            'zustand',
          ]
        : ['use-sound'],
    },
    resolve: {
      alias: {
        '.prisma/client/index-browser': '../../node_modules/.prisma/client/index-browser.js',
      },
      dedupe: ['react', 'react-dom', 'react-router'],
      // `~/*` from tsconfig.json's `paths`, resolved by Vite itself.
      tsconfigPaths: true,
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-router', '@tiptap/extension-code-block-lowlight'],
      entries: ['./app/root.jsx'],
      exclude: [
        '@classmoji/database',
        '@classmoji/services',
        '@prisma/client',
        'octokit',
        'stripe',
        'nanoid',
        'dotenv',
        'graphql',
        'jsonwebtoken',
      ],
    },
    plugins: [devtoolsJson(), tailwindcss(), reactRouter(), envOnlyMacros(), ...sentryPlugins],
    server: {
      port: process.env.PORT ? Number(process.env.PORT) : 3000,
      host: '0.0.0.0',
      // HMR websocket on app port + 1 — the vite default (24678) is shared by
      // every vite app in the monorepo, so concurrent dev servers race for it.
      hmr: { port: (process.env.PORT ? Number(process.env.PORT) : 3000) + 1 },
      // .lvh.me / .localhost: class sites run on {subdomain}.lvh.me in dev and
      // the login round-trip lands on app.lvh.me here.
      allowedHosts: ['.ngrok-free.app', '.ngrok.io', '.lvh.me', '.localhost'],
      warmup: {
        //warm up all routes for dependency pre-bundling
        clientFiles: ['./app/root.jsx', './app/routes/**/*.jsx', './app/routes/**/*.tsx'],
      },
    },
    build: {
      // Vite 6's default target. Vite 8 raised its own default to Chrome/Edge
      // 111, Firefox 114 and Safari 16.4; this keeps the browsers we supported.
      target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
      // CSS keeps Vite 8's default target for now (the target is still to be
      // decided). Lowering it for the list above adds fallbacks the Vite 6
      // build never had, e.g. for every theme colour.
      cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'],
      // Only generate source maps for our own code, not node_modules
      sourcemap: uploadSourceMaps ? 'hidden' : process.env.NODE_ENV === 'production' ? false : true,
      chunkSizeWarningLimit: 1000, // Increase limit to 1MB to suppress chunk size warnings
      rollupOptions: {
        external: ['graphql'], // Mark graphql as external
        onwarn(warning, warn) {
          // Suppress sourcemap warnings from node_modules (antd, etc.)
          if (warning.code === 'SOURCEMAP_ERROR') return;
          // Suppress mixed static/dynamic import warnings
          if (
            warning.message?.includes('statically imported by') &&
            warning.message?.includes('dynamically imported')
          )
            return;
          warn(warning);
        },
        output: {
          sourcemapIgnoreList: relativeSourcePath => {
            // Exclude node_modules from source maps
            return relativeSourcePath.includes('node_modules');
          },
        },
      },
    },
  });
};
