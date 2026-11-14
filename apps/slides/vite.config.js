import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
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
    ssr: {
      noExternal: ['reveal.js'],
    },
    resolve: {
      alias: {
        '.prisma/client/index-browser': '../../node_modules/.prisma/client/index-browser.js',
      },
      // yjs too: two copies in one bundle break live editing ("Yjs was
      // already imported") — the bridge's doc and the provider's would differ.
      dedupe: ['react', 'react-dom', 'react-router', 'yjs'],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-router',
        'reveal.js',
        // Live editing: pre-bundled together so every importer gets one yjs.
        'yjs',
        'y-protocols/awareness',
        '@hocuspocus/provider',
      ],
      entries: ['./app/root.jsx'],
      exclude: ['@classmoji/database', '@classmoji/services', '@prisma/client', 'octokit'],
    },
    plugins: [tailwindcss(), reactRouter(), tsconfigPaths(), ...sentryPlugins],
    server: {
      port: process.env.PORT ? Number(process.env.PORT) : 6500,
      host: '0.0.0.0',
      // HMR websocket on app port + 1 — the vite default (24678) is shared by
      // every vite app in the monorepo, so concurrent dev servers race for it.
      hmr: { port: (process.env.PORT ? Number(process.env.PORT) : 6500) + 1 },
      // Playwright writes its HTML report and per-test artifacts inside this
      // app while specs run; a watched write there would reload open editors.
      watch: {
        ignored: ['**/playwright-report/**', '**/test-results/**'],
      },
    },
    build: {
      sourcemap: process.env.NODE_ENV === 'production' ? 'hidden' : true,
    },
  });
};
