/**
 * The student contact fields only an OWNER may receive.
 *
 * Two staff-facing screens list students — the roster
 * (admin.$class.students) and the gradebook (admin.$class.grades) — and both
 * read from services that return whole `User` rows. Each one therefore has to
 * project its payload down to the fields it renders before returning it, and
 * the contact trio is the part where the two must agree. Keeping the trio in
 * one place is what stops them agreeing today and drifting apart tomorrow.
 *
 * The GRADE fields (`letter_grade`, `comment`) deliberately live outside this
 * helper: they are OWNER-only on the roster but are the whole point of the
 * gradebook, which serves them to a TEACHER as well. One helper covering all
 * five would encode the wrong policy on one of the two screens.
 *
 * Server-only by name (`.server.ts`) because it exists to decide what never
 * reaches the browser — the caller returns `{...identity, ...pick(user, isOwner)}`
 * so the keys are ABSENT for non-owners rather than present and null. There is
 * then nothing for the client to hide.
 */

interface ContactFields {
  email?: string | null;
  provider_email?: string | null;
  school_id?: string | null;
}

/**
 * Spread into a projected student row: the contact fields when the caller is a
 * real OWNER of the classroom, and nothing at all otherwise.
 */
export const pickOwnerOnlyContactFields = (user: ContactFields, isOwner: boolean): ContactFields =>
  isOwner
    ? {
        email: user.email ?? null,
        provider_email: user.provider_email ?? null,
        school_id: user.school_id ?? null,
      }
    : {};
