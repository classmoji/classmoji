import { reactRouter } from '@react-router/dev/vite';
import { defineConfig, defaultClientConditions, defaultServerConditions } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';

export default () => {
  return defineConfig({
    ssr: {
      noExternal: ['reveal.js'],
      resolve: {
        conditions: ['development', ...defaultServerConditions],
      },
    },
    resolve: {
      // Vite 6 default client conditions must be set explicitly because
      // @react-router/dev resolves its vite peer dep to root node_modules (Vite 5)
      // which doesn't export defaultClientConditions, leaving conditions empty.
      conditions: ['development', ...defaultClientConditions],
      alias: {
        '.prisma/client/index-browser': '../../node_modules/.prisma/client/index-browser.js',
      },
      // yjs too: two copies in one bundle break live editing ("Yjs was
      // already imported") — the bridge's doc and the provider's would differ.
      dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom', 'yjs'],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        'reveal.js',
        // Live editing: pre-bundled together so every importer gets one yjs.
        'yjs',
        'y-protocols/awareness',
        '@hocuspocus/provider',
      ],
      entries: ['./app/root.jsx'],
      exclude: [
        '@classmoji/database',
        '@classmoji/services',
        '@prisma/client',
        'octokit',
        '@octokit/auth-app',
      ],
    },
    plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
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
