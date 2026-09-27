import getPrisma from '@classmoji/database';

import { FORM_NOT_FOUND } from './form.service.ts';
import { FORM_DEFINITION_INVALID, formContractError, identityQuestionIds } from './formContract.ts';

/**
 * Which of a form's questions have their answers hidden by default.
 *
 * Answers to an identity question (`identity_question: true`) are staff-only and
 * shown only on an explicit, audited request for one response (the responses
 * drawer, MCP `form_response_get`). Every surface that reads other
 * people's answers masks with THIS set: the pages responses page and its CSV,
 * the MCP response tools, and team sets. One rule in one place, so the surfaces
 * can't disagree about what is hidden.
 *
 * The rule, over top-level fields (the contract refuses the flag inside a
 * repeat group):
 *  - flagged in the current revision, or in the draft: a flag hides answers as
 *    soon as it is saved, and an un-flag shows them only once it is published;
 *  - flagged in any older revision and absent from the current revision: a
 *    response is rendered against the revision it was filled against, so a
 *    deleted identity question would otherwise show its old answers again.
 *    Nothing published un-flagged it; it was removed. (A copy of it still in
 *    the draft is an unpublished edit and changes nothing.)
 *
 * Fails closed. Every stored definition goes through `identityQuestionIds`,
 * which throws FORM_DEFINITION_INVALID on a shape it can't read: a mask built on
 * a misread definition would come back empty and hide nothing.
 *
 * The same mask decides the response's `name` on those surfaces
 * (`responseNames`): a name that is the response's own answer to a masked
 * question is not shown as the name.
 */

type StoredDefinition = Parameters<typeof identityQuestionIds>[0];

/**
 * The top-level field ids of a stored definition: a field list, or `{ fields }`
 * as FormRevision.fields and Form.draft_fields hold it. None for null.
 *
 * @throws Error with code FORM_DEFINITION_INVALID on any other shape.
 */
function topLevelIds(definition: unknown, what: string): Set<string> {
  if (definition === null || definition === undefined) return new Set();
  const fields: unknown = Array.isArray(definition)
    ? definition
    : (definition as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) {
    throw formContractError(
      FORM_DEFINITION_INVALID,
      `identity mask: the ${what} is neither a field list nor a stored definition with a fields array.`
    );
  }
  const ids = new Set<string>();
  for (const field of fields) {
    const id = (field as { id?: unknown } | null)?.id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/**
 * The mask from the stored definitions themselves. Pure, for tests and for a
 * caller that has already loaded them.
 *
 * @param current the current revision's stored fields (null: never published)
 * @param draft `Form.draft_fields` (null: never edited)
 * @param olderRevisions every other revision's stored fields
 * @throws Error with code FORM_DEFINITION_INVALID on an unreadable definition.
 */
export function identityMaskFromDefinitions(
  current: unknown,
  draft: unknown,
  olderRevisions: readonly unknown[]
): Set<string> {
  const mask = identityQuestionIds(current as StoredDefinition, draft as StoredDefinition);
  const published = topLevelIds(current, 'current revision');
  for (const revision of olderRevisions) {
    for (const id of identityQuestionIds(revision as StoredDefinition)) {
      if (!published.has(id)) mask.add(id);
    }
  }
  return mask;
}

/**
 * The mask for one form, read from the database.
 *
 * "Current" is the revision `current_revision_id` names, else the newest (a
 * form taken back to DRAFT keeps its pointer, but belt and braces), else none.
 * No authorization here, by the forms services' design: callers resolve the
 * form inside the classroom they have already gated.
 *
 * Cost: the form row and every revision's stored fields — it grows with each
 * publish. A caller reads it once per request and passes it along (team sets
 * thread it through loadSetFields / loadInputs / staleness).
 *
 * @throws Error with code FORM_NOT_FOUND for an unknown form, and
 *   FORM_DEFINITION_INVALID on an unreadable stored definition.
 */
export async function identityMaskForForm({ formId }: { formId: string }): Promise<Set<string>> {
  const prisma = getPrisma();
  const [form, revisions] = await Promise.all([
    prisma.form.findUnique({
      where: { id: formId },
      select: { current_revision_id: true, draft_fields: true },
    }),
    prisma.formRevision.findMany({
      where: { form_id: formId },
      orderBy: { version: 'asc' },
      select: { id: true, fields: true },
    }),
  ]);
  if (!form) {
    throw Object.assign(new Error(`Form ${formId} not found`), { code: FORM_NOT_FOUND });
  }

  const current =
    revisions.find(revision => revision.id === form.current_revision_id) ?? revisions.at(-1);
  return identityMaskFromDefinitions(
    current?.fields ?? null,
    form.draft_fields ?? null,
    revisions.filter(revision => revision !== current).map(revision => revision.fields)
  );
}

// ─── The response's name ────────────────────────────────────────────────────

/**
 * Is this response's stored `name` its own answer to a masked question?
 *
 * A public fill copies the answer to a short-text "name" question into the
 * response's `name` (`identityPlan` in apps/pages; it skips identity questions).
 * A question flagged after responses came in leaves those names in place, and
 * `name` is shown on every list surface, so a name equal to the response's
 * answer to a masked question is that answer. Compared the way the fill path
 * stored it: the answer trimmed. Every masked question counts, not only the
 * one the fill path picked: a name equal to a hidden answer shows that answer
 * wherever it came from.
 */
export function nameIsMaskedAnswer(
  name: string | null | undefined,
  answers: unknown,
  mask: ReadonlySet<string>
): boolean {
  if (!name || mask.size === 0) return false;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const byField = answers as Record<string, unknown>;
  for (const id of mask) {
    const answer = byField[id];
    if (typeof answer === 'string' && answer.trim() === name) return true;
  }
  return false;
}

/** The fields `responseNames` reads from a response row. */
export interface NamedResponse {
  id: string;
  name: string | null;
  user_id: string | null;
  answers: unknown;
}

/**
 * The name each response shows on staff and agent surfaces, by response id.
 *
 * The stored `name`, except where it is the response's answer to a masked
 * question (`nameIsMaskedAnswer`). Then: the linked account's name (`name ||
 * login`), as a classroom fill stores it, or null without an account, as a
 * public form with no name question stores it (surfaces show the email then).
 * One user query for the whole list, and none when nothing is replaced.
 */
export async function responseNames(
  rows: readonly NamedResponse[],
  mask: ReadonlySet<string>
): Promise<Map<string, string | null>> {
  const replaced = new Set(
    rows.filter(row => nameIsMaskedAnswer(row.name, row.answers, mask)).map(row => row.id)
  );

  const userIds = [
    ...new Set(
      rows.filter(row => replaced.has(row.id) && row.user_id).map(row => row.user_id as string)
    ),
  ];
  const accounts =
    userIds.length === 0
      ? []
      : await getPrisma().user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, login: true },
        });
  const accountName = new Map(accounts.map(user => [user.id, user.name || user.login || null]));

  return new Map(
    rows.map(row => {
      if (!replaced.has(row.id)) return [row.id, row.name] as const;
      return [row.id, row.user_id ? (accountName.get(row.user_id) ?? null) : null] as const;
    })
  );
}
