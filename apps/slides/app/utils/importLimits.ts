/**
 * importLimits.ts — the one size cap for a slides.com ZIP import.
 *
 * Shared by the import screen (the dropzone's own check and its hint) and the
 * import endpoint (the metered body read and the size check), which used to
 * carry a literal each. Browser-safe: no imports.
 *
 * TODO(media P3 merge): re-export `SLIDES_IMPORT_MAX_BYTES` and its label from
 * `@classmoji/utils` once that lands, so every app reads one constant.
 */

/** The largest ZIP the importer accepts. */
export const SLIDES_IMPORT_MAX_BYTES = 150 * 1024 * 1024;

/** `150 MB` — the cap as a person reads it. */
export const SLIDES_IMPORT_MAX_LABEL = `${SLIDES_IMPORT_MAX_BYTES / (1024 * 1024)} MB`;
