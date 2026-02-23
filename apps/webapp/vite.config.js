import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { envOnlyMacros } from 'vite-env-only';
import devtoolsJson from 'vite-plugin-devtools-json';
import tailwindcss from '@tailwindcss/vite';

export default ({ command }) => {
  const isBuild = command === 'build';
  return defineConfig({
    ssr: {
      // In production builds, bundle workspace-local node_modules that npm doesn't
      // hoist to the root — the Dockerfile only copies root node_modules to the
      // production image, so non-hoisted packages would be missing at runtime.
      noExternal: isBuild
        ? ['use-sound', /@trigger\.dev\//, /@mantine\//, /@tabler\//, 'lucide-react', 'zustand']
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
        'nodemailer',
        'graphql',
        'jsonwebtoken',
      ],
    },
    plugins: [
      devtoolsJson(),
      tailwindcss(),
      reactRouter(),
      tsconfigPaths(),
      envOnlyMacros(),
    ],
    server: {
      port: process.env.PORT ? Number(process.env.PORT) : 3000,
      host: '0.0.0.0',
      hmr: true,
      allowedHosts: ['.ngrok-free.app', '.ngrok.io'],
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
        external: ['graphql', 'nodemailer'], // Mark graphql as external
        onwarn(warning, warn) {
          // Suppress sourcemap warnings from node_modules (antd, etc.)
          if (warning.code === 'SOURCEMAP_ERROR') return;
          // Suppress mixed static/dynamic import warnings
          if (warning.message?.includes('statically imported by') && warning.message?.includes('dynamically imported')) return;
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
