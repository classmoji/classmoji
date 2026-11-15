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
// CSS keeps Vite 8's default target. Tailwind 4's CSS needs these browsers
// anyway; lowering it for the list above would rewrite the theme colours with
// fallbacks the Vite 6 build never had.
const CSS_TARGET = ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'];

export default async () => {
  const workerPlugins = CLOUDFLARE
    ? await (async () => {
        const { cloudflare } = await import('@cloudflare/vite-plugin');
        const { classmojiWorkerSwaps } = await import('@classmoji/workers/vite');
        return [classmojiWorkerSwaps(), cloudflare({ viteEnvironment: { name: 'ssr' } })];
      })()
    : [];

  return defineConfig({
    resolve: {
      alias: {
        '.prisma/client/index-browser': '../../node_modules/.prisma/client/index-browser.js',
      },
      dedupe: ['react', 'react-dom', 'react-router'],
      // `~/*` from tsconfig.json's `paths`, resolved by Vite itself.
      tsconfigPaths: true,
    },
    // Vite 6's default conditions, stated here: the React Router plugin reads
    // them from the repo root's Vite 5, which has none, and server.ts's Vite 6
    // would otherwise resolve with ["development"] only (no `browser`). See
    // apps/pages/vite.config.js. Vite 5 builds ignore `environments`.
    // On Workers the Cloudflare plugin sets the ssr conditions (`workerd`
    // first); a `node` condition here would leak into the Worker.
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
