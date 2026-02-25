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
      dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        'reveal.js',
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
      hmr: true,
    },
    build: {
      sourcemap: process.env.NODE_ENV === 'production' ? 'hidden' : true,
    },
  });
};
