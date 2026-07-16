/**
 * Role-tailored conversation starters returned by the identity surface
 * (`whoami` tool + `me` resource / `my_classrooms` mirror). These are advisory
 * example prompts an assistant can offer the user — they map to capabilities
 * the read/write tools already expose, tailored to the roles the caller
 * actually holds somewhere (staff vs student). Purely cosmetic: they gate
 * nothing and grant nothing.
 */

import type { Role } from '@prisma/client';

export interface Suggestions {
  /** Present iff the caller holds OWNER/TEACHER/ASSISTANT in any classroom. */
  faculty?: string[];
  /** Present iff the caller holds STUDENT in any classroom. */
  student?: string[];
}

const STAFF_ROLES: ReadonlySet<Role> = new Set<Role>(['OWNER', 'TEACHER', 'ASSISTANT']);

/** Staff-facing starters (grading, at-risk students, queue, regrades, deadlines). */
export const FACULTY_SUGGESTIONS: readonly string[] = [
  'Show me the grade distribution for one of my classes.',
  'Which students are struggling or falling behind?',
  "What's in my grading queue — any submissions still ungraded?",
  'Are there any open regrade requests I need to resolve?',
  'What assignments are due this week?',
];

/** Student-facing starters (upcoming work, grades, tokens, regrades). */
export const STUDENT_SUGGESTIONS: readonly string[] = [
  'What assignments do I have coming up, and when are they due?',
  'How am I doing — what are my current released grades?',
  'How many tokens do I have, and can I buy a deadline extension?',
  'Do I have any pending regrade requests?',
];

/**
 * Build the suggestion block from the caller's membership roles. A key is
 * included only when the caller holds a matching role somewhere, so a
 * staff-only user never sees student prompts and vice versa; a user who is both
 * (e.g. a TA taking another course) gets both.
 */
export function buildSuggestions(roles: Iterable<Role>): Suggestions {
  let isStaff = false;
  let isStudent = false;
  for (const role of roles) {
    if (STAFF_ROLES.has(role)) isStaff = true;
    else if (role === 'STUDENT') isStudent = true;
  }

  const suggestions: Suggestions = {};
  if (isStaff) suggestions.faculty = [...FACULTY_SUGGESTIONS];
  if (isStudent) suggestions.student = [...STUDENT_SUGGESTIONS];
  return suggestions;
}
