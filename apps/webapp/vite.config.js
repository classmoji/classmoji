import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { envOnlyMacros } from 'vite-env-only';
import devtoolsJson from 'vite-plugin-devtools-json';
import tailwindcss from '@tailwindcss/vite';

export default ({ command }) => {
  const isBuild = command === 'build';
  return defineConfig({
    // Load .env from monorepo root so Vite watches it for changes.
    // This triggers a dev server restart when the setup wizard writes GitHub credentials.
    envDir: '../../',
    ssr: {
      // In production builds, bundle what lives in apps/webapp/node_modules (packages
      // npm doesn't hoist to the root): the Dockerfile only copies root node_modules
      // into the image, so anything left external must resolve there at runtime.
      // - @trigger.dev/react-hooks and the @trigger.dev/core it pulls in are
      //   webapp-local (root core is an older version), and so are that core's own
      //   deps listed after it; each must be bundled or the image loads the wrong
      //   copy or none at all (zod-validation-error/v4 is missing from root).
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
      dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        '@tiptap/extension-code-block-lowlight',
      ],
      entries: ['./app/root.jsx'],
      exclude: [
        '@classmoji/database',
        '@classmoji/services',
        '@prisma/client',
        'octokit',
        '@octokit/auth-app',
        'stripe',
        'nanoid',
        'dotenv',
        'graphql',
        'jsonwebtoken',
      ],
    },
    plugins: [devtoolsJson(), tailwindcss(), reactRouter(), tsconfigPaths(), envOnlyMacros()],
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
      // Only generate source maps for our own code, not node_modules
      sourcemap: process.env.NODE_ENV === 'production' ? false : true,
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
    esbuild: {
      keepNames: true, // Preserve function names for better stack traces
    },
  });
};
