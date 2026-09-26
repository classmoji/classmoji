import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for webapp unit tests.
 *
 * Picks up *.test.ts and *.test.tsx under app/, leaving the Playwright suites
 * under tests/ (which use *.spec.ts) untouched.
 *
 * `.tsx` is included so a presentational component can be asserted against the
 * markup it actually renders (`react-dom/server`, already a dependency) rather
 * than against a regex over its source. `environment: 'node'` is enough for
 * that: `renderToStaticMarkup` needs no DOM. A test that has to mount, rerender
 * or click opts into jsdom with a `// @vitest-environment jsdom` docblock (see
 * admin.$class.settings.ai/__tests__/formRemount.test.tsx).
 *
 * The `~` alias mirrors `tsconfig.json`'s `paths`, so a component under test
 * resolves its imports the same way the app does.
 */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) },
  },
  test: {
    include: ['app/**/__tests__/**/*.test.ts?(x)', 'app/**/*.test.ts?(x)'],
    environment: 'node',
  },
});
