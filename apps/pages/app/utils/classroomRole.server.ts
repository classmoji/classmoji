/**
 * A user's role in a classroom — the highest of the rows they hold there, or
 * null when they hold none (`acceptedOnly` counts only accepted invites, as
 * the class site does).
 *
 * The shared helper, so the pages app and the collab server run the same page
 * edit rule: `@classmoji/auth/classroom-role`. `highestRole` stays in
 * `./classroomRole.ts` for modules that must not reach the database.
 */
export { findClassroomRole, canEditPages } from '@classmoji/auth/classroom-role';
