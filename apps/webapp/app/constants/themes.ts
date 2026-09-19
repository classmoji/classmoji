/**
 * Classroom canvas themes — now owned by @classmoji/utils.
 *
 * The definitions moved to `packages/utils/src/themes.ts` when the public forms
 * fill pages (apps/pages) needed the same tints the webapp shell uses: two apps
 * reading one list beats two lists drifting apart, and `apps/mcp` already
 * carries a hand-copied third that this move makes retirable.
 *
 * This file stays as a re-export so that no webapp call site changes —
 * `constants/index.ts` re-exports it and `CommonLayout` still imports
 * `getThemeByKey` from `~/constants`. New code should import from
 * `@classmoji/utils/themes` directly.
 */
export * from '@classmoji/utils/themes';
