import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// The Sentry plugins a build keeps: the config `buildEnd` reads, hidden source
// maps and Sentry's bundler plugin. The others add a tunnel route and a hook to
// the server build for Sentry on the server, which no app here runs.
const SENTRY_BUILD_PLUGINS = new Set([
  'sentry-react-router-config-injector',
  'sentry-react-router-update-source-map-setting',
  'sentry-vite-plugin',
]);

// CSS is built for Vite 8's default browsers (`build.cssTarget`), except that
// media-query range syntax (`width >= 40rem`) is lowered to min-width and
// max-width: Safari and iOS 15.4-16.3 render nearly all of this CSS but not range
// syntax, and would lose every breakpoint. Older browsers (below Chrome/Edge
// 111, Firefox 113, Safari 15.4) were already unsupported: the theme colours
// are oklch() and the utilities sit in `@layer`. Vite's CSS minifier passes
// `css.lightningcss` to Lightning CSS with those targets; without this it also
// rewrites min-width queries (Tailwind's and those in node_modules CSS) into
// range syntax. The value is Lightning CSS's
// `Features.MediaIntervalSyntax | Features.MediaRangeSyntax` (64 | 128 in both
// lightningcss copies installed, 1.31 and 1.33; no app depends on it directly).
const LOWER_MEDIA_RANGE_SYNTAX = 64 | 128;

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
    css: { lightningcss: { include: LOWER_MEDIA_RANGE_SYNTAX } },
    ssr: {
      noExternal: ['reveal.js'],
    },
    resolve: {
      // yjs too: two copies in one bundle break live editing ("Yjs was
      // already imported") — the bridge's doc and the provider's would differ.
      dedupe: ['react', 'react-dom', 'react-router', 'yjs'],
      // `~/*` from tsconfig.json's `paths`, resolved by Vite itself.
      tsconfigPaths: true,
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
    plugins: [tailwindcss(), reactRouter(), ...sentryPlugins],
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
      // Vite 6's default target. Vite 8 raised its own default to Chrome/Edge
      // 111, Firefox 114 and Safari 16.4; this keeps the browsers we supported.
      target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
      // Vite 8's default browsers; see LOWER_MEDIA_RANGE_SYNTAX.
      cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'],
      sourcemap: process.env.NODE_ENV === 'production' ? 'hidden' : true,
    },
  });
};
