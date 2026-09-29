/**
 * importLimits.ts — the one size cap for a slides.com ZIP import, read by the
 * import screen (the dropzone's check and its hint) and the import endpoint
 * (the metered body read and the size check). The shared constant, so every
 * app reads the same one.
 */

export { SLIDES_IMPORT_MAX_BYTES, SLIDES_IMPORT_MAX_LABEL } from '@classmoji/utils/repo-limits';
