import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';

const PORT = process.env.PORT ? Number(process.env.PORT) : 7500;

export default () => {
  return defineConfig({
    resolve: {
      alias: {
        '.prisma/client/index-browser': '../../node_modules/.prisma/client/index-browser.js',
      },
      dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-router', 'react-router-dom'],
      entries: ['./app/root.tsx'],
      // Server-only. Leaving these in triggers a mid-session dep
      // re-optimization whose reload can transiently fail to resolve
      // @prisma/client during an in-flight SSR request.
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
      port: PORT,
      host: '0.0.0.0',
      // HMR websocket on app port + 1 — the vite default (24678) is shared by
      // every vite app in the monorepo, so concurrent dev servers race for it.
      hmr: { port: PORT + 1 },
    },
    build: {
      sourcemap: process.env.NODE_ENV === 'production' ? 'hidden' : true,
    },
  });
};
