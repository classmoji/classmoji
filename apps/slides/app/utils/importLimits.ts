/**
 * importLimits.ts — the one size cap for a slides.com ZIP import, read by the
 * import screen (the dropzone's check and its hint) and the import endpoint
 * (the metered body read and the size check).
 *
 * TEMPORARY local values: `@classmoji/utils/repo-limits` exports the shared
 * pair on the services slice (feat/media-p3-review-services). AFTER THE MERGE,
 * replace everything below this comment with ONE line:
 *
 *   export { SLIDES_IMPORT_MAX_BYTES, SLIDES_IMPORT_MAX_LABEL } from '@classmoji/utils/repo-limits';
 *
 * Same values (150 MiB, `150 MB`). Browser-safe: no imports.
 */

/** The largest ZIP the importer accepts. */
export const SLIDES_IMPORT_MAX_BYTES = 150 * 1024 * 1024;

/** `150 MB` — the cap as a person reads it. */
export const SLIDES_IMPORT_MAX_LABEL = `${SLIDES_IMPORT_MAX_BYTES / (1024 * 1024)} MB`;
