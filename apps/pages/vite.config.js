import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';

export default () => {
  return defineConfig({
    ssr: {
      // BlockNote + Mantine have CSS imports that Vite must process during SSR
      noExternal: [
        /^@blocknote\//,
        /^@mantine\//,
      ],
    },
    resolve: {
      alias: {
        '.prisma/client/index-browser': '../../node_modules/.prisma/client/index-browser.js',
      },
      dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
    },
    optimizeDeps: {
      // Pre-bundle the heavy editor deps on startup. Without this they're
      // discovered lazily on first page-editor load, which triggers a
      // mid-session dep re-optimization + reload; an in-flight SSR request can
      // then transiently fail to resolve server-only @prisma/client.
      include: [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        '@mantine/core',
        '@tabler/icons-react',
        'use-local-storage-state',
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
      port: process.env.PORT ? Number(process.env.PORT) : 7100,
      host: '0.0.0.0',
      // HMR websocket on app port + 1 — the vite default (24678) is shared by
      // every vite app in the monorepo, so concurrent dev servers race for it.
      hmr: { port: (process.env.PORT ? Number(process.env.PORT) : 7100) + 1 },
      // Vite's host check lives INSIDE viteDevServer.middlewares, which
      // server.ts mounts ahead of the class-site rewriter — so a Host it does
      // not recognize is 403'd before any of our routing sees it. Class sites
      // are served on {subdomain}.lvh.me in dev, and a PRO custom domain can be
      // ANY hostname the instructor owns, which is unlistable ahead of time.
      // `true` in dev is the honest answer: this server only ever runs locally,
      // and the alternative is that the one local check that exercises the
      // custom-domain path (`curl -H "Host: cs52.me"`) cannot reach it. The
      // production server never constructs vite at all, but the list is kept
      // for a prod-shaped run rather than shipping the check switched off.
      allowedHosts: process.env.NODE_ENV === 'production' ? ['.lvh.me', '.localhost'] : true,
    },
    build: {
      sourcemap: process.env.NODE_ENV === 'production' ? 'hidden' : true,
    },
  });
};
