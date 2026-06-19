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
      hmr: true,
    },
    build: {
      sourcemap: process.env.NODE_ENV === 'production' ? 'hidden' : true,
    },
  });
};
