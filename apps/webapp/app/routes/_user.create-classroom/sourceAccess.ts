/**
 * Who may import FROM a classroom, and what they may carry out of it.
 *
 * SERVER-SIDE DECISION. The create-classroom picker hides what a viewer cannot
 * choose, but the source id and the copy selections both arrive in the request
 * body, so the answer has to be recomputed here from real membership rows.
 *
 * The rule: **owners and teachers may import; only owners may copy the API
 * keys.** Copying a class means copying its `ClassroomSettings`, and the
 * `apiKeys` group carries `openai_api_key` / `anthropic_api_key` — real
 * credentials. Letting a teacher take those would move the owner's LLM billing
 * into a classroom the teacher controls, which is why this gate was originally
 * owner-only for everything. Everything else in an import is course material a
 * teacher can already read in the app, so the narrower rule is the accurate one.
 */

/** Roles that may be used as an import source. Assistants and students cannot. */
export const SOURCE_ROLES = ['OWNER', 'TEACHER'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

/** Shown to the user when their key selection was dropped. */
export const API_KEYS_STRIPPED_WARNING =
  'AI API keys were not copied — only an owner of the source classroom can copy its keys.';

export type SourceAccess =
  | { allowed: false }
  | {
      allowed: true;
      isOwner: boolean;
      /** The selections to actually apply — `apiKeys` removed for non-owners. */
      configSelections: Record<string, boolean>;
      /** Non-empty when something was dropped from the request. */
      warnings: string[];
    };

/**
 * Decide access from the requester's membership rows on the SOURCE classroom.
 *
 * Takes every matching row rather than one: memberships are unique per
 * (classroom, user, role) and a person may legitimately hold OWNER *and*
 * TEACHER in the same classroom. Reading the role off a single arbitrary row
 * could hand back TEACHER for someone who is also the owner and strip keys they
 * are entitled to copy.
 */
export const resolveSourceAccess = (
  roles: readonly string[],
  configSelections: Record<string, boolean> = {}
): SourceAccess => {
  const usable = roles.filter((r): r is SourceRole =>
    (SOURCE_ROLES as readonly string[]).includes(r)
  );
  if (usable.length === 0) {
    return { allowed: false };
  }

  const isOwner = usable.includes('OWNER');
  if (isOwner || !configSelections.apiKeys) {
    // Copied on this branch too, so the caller's object is never aliased and the
    // "returns a fresh object" contract holds regardless of which path ran.
    return { allowed: true, isOwner, configSelections: { ...configSelections }, warnings: [] };
  }

  // Rewritten to `false` rather than deleted: the key is what the review step
  // and the persisted job row read, and an absent key would read as "not asked
  // for" instead of "asked for and refused".
  return {
    allowed: true,
    isOwner: false,
    configSelections: { ...configSelections, apiKeys: false },
    warnings: [API_KEYS_STRIPPED_WARNING],
  };
};
