import js from '@eslint/js';
import globals from 'globals';
import pluginImport from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import pluginPrettier from 'eslint-plugin-prettier';

/**
 * The content-delivery signing choke point, enforced by lint.
 *
 * A signed blob URL is the Cloudflare Worker's ONLY proof that a classroom is
 * entitled to the bytes behind a sha: the Worker caches blobs by content
 * (`blobs/{sha}` in R2, shared across classrooms) and cannot know which files
 * a classroom owns. So a signature over a sha outside that classroom's asset
 * map would let one classroom read another's cached private bytes — and it
 * would verify, because the app made the claim.
 *
 * `contentDelivery.service.ts` is where that claim is checked. Every mint goes
 * through its `mintSigned` gate, which requires a row read from the
 * classroom's own map. A module that imports the signers directly bypasses the
 * gate, so this makes reaching for them a lint error rather than a code review
 * someone has to remember to do.
 *
 * The allowlist is deliberately tiny:
 *   - `contentDelivery.service.ts` — the gate itself;
 *   - `deckRenderToken.service.ts` — render tokens, a different signature over
 *     a deck id rather than a sha, with no asset map to check against;
 *   - `apps/content/src/verify.ts` — the Worker's VERIFY seam, allowlisted in
 *     that app's own config; it re-exports the package and mints nothing;
 *   - tests, which have to reach the primitives to prove the gate's output.
 *
 * Globs are tail-matched (`**\/classmoji/...`) because flat-config `files`
 * resolve against each PACKAGE's own eslint.config.js, not this file.
 */
const CONTENT_SIGNING = {
  name: '@classmoji/content-signing',
  message:
    'Sign through ClassmojiService.contentDelivery instead. Every blob URL must be minted ' +
    "inside contentDelivery.service.ts, which requires proof the sha is in that classroom's " +
    'asset map — importing the signers directly bypasses that check.',
};

const CONTENT_SIGNING_ALLOWED = [
  '**/classmoji/contentDelivery.service.ts',
  '**/classmoji/deckRenderToken.service.ts',
  '**/__tests__/**/*.{js,jsx,ts,tsx}',
  '**/tests/**/*.{js,jsx,ts,tsx}',
  '**/*.test.{js,jsx,ts,tsx}',
  '**/*.spec.{js,jsx,ts,tsx}',
];

export default [
  js.configs.recommended,
  pluginImport.flatConfigs.recommended,
  prettier,

  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      prettier: pluginPrettier,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2025,
        ...globals.node,
      },
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
          moduleDirectory: ['node_modules', 'src'],
        },
      },
      'import/external-module-folders': ['node_modules', '../../node_modules'],
      // don't forget if you add a new package to also add it here
      'import/core-modules': [
        '@classmoji/services',
        '@classmoji/database',
        '@classmoji/utils',
        '@classmoji/content-signing',
        '@classmoji/tasks',
      ],
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prettier/prettier': 'error',
      'no-restricted-imports': ['error', { paths: [CONTENT_SIGNING] }],
    },
  },

  // The other half of the content-signing choke point. See CONTENT_SIGNING.
  {
    files: CONTENT_SIGNING_ALLOWED,
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['cypress/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, cy: 'readonly', Cypress: 'readonly' },
    },
    rules: {
      'no-unused-expressions': 'off',
    },
  },
];
