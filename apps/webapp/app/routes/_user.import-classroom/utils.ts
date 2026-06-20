/**
 * Client-side helpers for the GitHub Classroom import wizard.
 *
 * Import data is pulled live from the GitHub Classroom REST API (no ZIP upload):
 * phase 1 lists the classrooms the teacher administers (`/api/github-classrooms`),
 * and the heavy per-classroom fetch + import runs in a background job. This file
 * holds only the client-safe pieces: the listed-classroom shape and slugify.
 */

/** A classroom from phase-1 listing — cheap metadata only (no assignments yet). */
export interface ListedClassroom {
  githubId: number;
  name: string;
  archived: boolean;
  /** null only if the classroom has no organization (can't be imported). */
  organization: { id: number; login: string } | null;
}

/** Slugify a classroom name. Mirrors `_user.create-classroom/utils.ts` so slugs
 * are identical across the create and import flows (the availability check relies
 * on that equivalence). */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
