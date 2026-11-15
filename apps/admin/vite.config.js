import { reactRouter } from '@react-router/dev/vite';
import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const PORT = process.env.PORT ? Number(process.env.PORT) : 7500;

// BUILD_TARGET=cloudflare builds the app as a Cloudflare Worker
// (workers/app.ts, wrangler.jsonc). Anything else is the Fly/Node build,
// exactly as before: the Cloudflare plugins are not even loaded.
const CLOUDFLARE = process.env.BUILD_TARGET === 'cloudflare';

// Vite 6's default target. Vite 8 raised its own default to Chrome/Edge 111,
// Firefox 114 and Safari 16.4; this keeps the browsers we supported. On Workers
// it is the client's only: the Cloudflare plugin sets the Worker's own target,
// and Vite refuses a list that names two ES versions.
const BROWSER_TARGET = ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'];
// CSS is built for Vite 8's default browsers (CSS_TARGET), except that
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
const CSS_TARGET = ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'];
const LOWER_MEDIA_RANGE_SYNTAX = 64 | 128;

export default async () => {
  const workerPlugins = CLOUDFLARE
    ? await (async () => {
        const { cloudflare } = await import('@cloudflare/vite-plugin');
        const { classmojiWorkerSwaps } = await import('@classmoji/workers/vite');
        return [classmojiWorkerSwaps(), cloudflare({ viteEnvironment: { name: 'ssr' } })];
      })()
    : [];

  return defineConfig({
    css: { lightningcss: { include: LOWER_MEDIA_RANGE_SYNTAX } },
    resolve: {
      alias: {
        '.prisma/client/index-browser': '../../node_modules/.prisma/client/index-browser.js',
      },
      dedupe: ['react', 'react-dom', 'react-router'],
      // `~/*` from tsconfig.json's `paths`, resolved by Vite itself.
      tsconfigPaths: true,
    },
    // Vite's default resolve conditions, stated explicitly (see
    // apps/pages/vite.config.js). On Workers the Cloudflare plugin sets the ssr
    // conditions (`workerd` first); a `node` condition here would leak into
    // the Worker.
    environments: {
      client: {
        resolve: { conditions: [...defaultClientConditions] },
        ...(CLOUDFLARE && { build: { target: BROWSER_TARGET } }),
      },
      ...(CLOUDFLARE ? {} : { ssr: { resolve: { conditions: [...defaultServerConditions] } } }),
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-router'],
      entries: ['./app/root.tsx'],
      // Server-only. Leaving these in triggers a mid-session dep
      // re-optimization whose reload can transiently fail to resolve
      // @prisma/client during an in-flight SSR request.
      exclude: ['@classmoji/database', '@classmoji/services', '@prisma/client', 'octokit'],
    },
    plugins: [tailwindcss(), ...workerPlugins, reactRouter()],
    server: {
      port: PORT,
      host: '0.0.0.0',
      // HMR websocket on app port + 1 — the vite default (24678) is shared by
      // every vite app in the monorepo, so concurrent dev servers race for it.
      hmr: { port: PORT + 1 },
    },
    build: {
      ...(!CLOUDFLARE && { target: BROWSER_TARGET }),
      cssTarget: CSS_TARGET,
      sourcemap: process.env.NODE_ENV === 'production' ? 'hidden' : true,
    },
  });
};
