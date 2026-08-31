import getPrisma from '@classmoji/database';
import { repeatGroups, type FormField, type ResolvedTargetRef } from './formContract.ts';
import type { Prisma } from '@prisma/client';

/**
 * Forms — the TIER-2 resolver: who a `repeat_group` repeats over, for ONE
 * respondent, right now.
 *
 * Tier 1 (`roster_select`) is materialized into the revision at publish and is
 * the same for everybody. Tier 2 is not: "your teammates" is a different answer
 * per filler and a different answer next week, so it is resolved per request —
 * in the classroom-authed loader on the way in, and AGAIN inside the submit
 * transaction on the way out.
 *
 * ── The whole point: never a silent findFirst ──────────────────────────────
 * `team.service.findUserTeamByTag` is a `findFirst`. For a lookup that decides
 * WHO A STUDENT REVIEWS, "pick one of the matches" is not a behaviour anybody
 * asked for — a student in a project team and a lab pair would silently review
 * whichever row Postgres returned first, and nothing anywhere would say so. So
 * this module runs its own `findMany` and answers with a discriminated state:
 *
 *   OK             one team, at least one other student on it
 *   SOLO_TEAM      one team, and the filler is the only person on it
 *   NO_TEAM        the filler is on no team at all in this classroom
 *   TEAM_UNTAGGED  they are on teams, but none carries the scoped tag
 *                  (also: the scope names a tag/assignment that cannot be
 *                  resolved to a team set — `detail` says which)
 *   AMBIGUOUS_TEAM more than one team matches; the form must be re-scoped
 *
 * Every one of those is rendered to the filler as its own message and is
 * actionable by an instructor. Four of the five block the form; SOLO_TEAM does
 * not — a team of one has nothing to review and the rest of the form is still
 * a form.
 *
 * ── Cross-classroom safety ─────────────────────────────────────────────────
 * `tag_id` and `repository_id` come out of a stored DEFINITION, which an MCP
 * call or an import could have written. Both are re-read scoped to
 * `classroomId` before they are used, and the team query is classroom-scoped
 * too — so a definition carrying another course's tag id resolves to
 * TEAM_UNTAGGED, not to that course's teams.
 *
 * ── Targets ────────────────────────────────────────────────────────────────
 * Teammates, minus the filler, deduped by user id, and filtered to people who
 * hold a STUDENT membership in THIS classroom. That last filter is not tidying:
 * a TA or an instructor sitting on a project team is not a peer, and a peer
 * review that asked students to rate their instructor would be a different
 * (and much worse) instrument.
 */

// ─── Result shape ───────────────────────────────────────────────────────────

export type RepeatScope = {
  by: 'tag' | 'repository' | 'classroom';
  tag_id?: string;
  repository_id?: string;
};

/** The `repeat` block of a repeat_group definition, as the resolver reads it. */
export interface RepeatDefinition {
  over?: string;
  scope: RepeatScope;
  exclude_self?: boolean;
  min_entries?: number;
  max_entries?: number;
  require_all_targets?: boolean;
}

/** One person to be reviewed. Names are snapshotted, never re-joined later. */
export interface RepeatTarget {
  user_id: string;
  name: string;
  email?: string | null;
  login?: string | null;
}

export type RepeatResolutionState =
  | 'OK'
  | 'SOLO_TEAM'
  | 'NO_TEAM'
  | 'TEAM_UNTAGGED'
  | 'AMBIGUOUS_TEAM';

/** Why a TEAM_UNTAGGED happened — three different instructor actions. */
export type UntaggedDetail =
  | 'tag-missing'
  | 'repository-missing'
  | 'repository-untagged'
  | 'no-team-with-tag';

export type RepeatResolution =
  | {
      state: 'OK' | 'SOLO_TEAM';
      scope: RepeatScope;
      team: { id: string; name: string };
      targets: RepeatTarget[];
    }
  | {
      state: 'NO_TEAM';
      scope: RepeatScope;
      targets: [];
    }
  | {
      state: 'TEAM_UNTAGGED';
      scope: RepeatScope;
      detail: UntaggedDetail;
      targets: [];
    }
  | {
      state: 'AMBIGUOUS_TEAM';
      scope: RepeatScope;
      /** Named so the instructor can see WHICH sets collided. */
      teamNames: string[];
      targets: [];
    };

/** States that must not render a fillable review block. */
export const BLOCKING_REPEAT_STATES: RepeatResolutionState[] = [
  'NO_TEAM',
  'TEAM_UNTAGGED',
  'AMBIGUOUS_TEAM',
];

export const isBlockingRepeatState = (state: RepeatResolutionState): boolean =>
  BLOCKING_REPEAT_STATES.includes(state);

/**
 * Prisma client OR an open transaction client. The submit path re-resolves
 * INSIDE the transaction that holds the form's row lock, so every query here
 * has to be able to run on `tx`.
 */
type Client = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

const db = (client?: Client): Client => client ?? getPrisma();

// ─── Scope → tag ────────────────────────────────────────────────────────────

/**
 * The tag that defines the team set for this scope, or null for `classroom`
 * (which means "any team of theirs in this course").
 *
 * The `repository` branch is the fallback chain the student team page already
 * uses: an explicit `Repository.tag_id` when the assignment has one, otherwise
 * the tag NAMED after the repository's slug, which is what team formation
 * creates. Reproduced here rather than imported because that page reads it in
 * the opposite direction (tag → teams for a repo) and does no classroom
 * re-scoping of an id that came out of a stored definition.
 */
async function tagForScope(
  client: Client,
  classroomId: string,
  scope: RepeatScope
): Promise<{ tagId: string } | { untagged: UntaggedDetail }> {
  if (scope.by === 'tag') {
    const tag = await db(client).tag.findFirst({
      where: { id: scope.tag_id ?? '', classroom_id: classroomId },
      select: { id: true },
    });
    return tag ? { tagId: tag.id } : { untagged: 'tag-missing' };
  }

  const repository = await db(client).repository.findFirst({
    where: { id: scope.repository_id ?? '', classroom_id: classroomId },
    select: { id: true, slug: true, tag_id: true },
  });
  if (!repository) return { untagged: 'repository-missing' };

  if (repository.tag_id) {
    // Re-scoped even though it came off a classroom-scoped row: a tag_id
    // pointing at another course's tag is a data bug, not a licence.
    const tag = await db(client).tag.findFirst({
      where: { id: repository.tag_id, classroom_id: classroomId },
      select: { id: true },
    });
    if (tag) return { tagId: tag.id };
  }

  if (repository.slug) {
    const byName = await db(client).tag.findFirst({
      where: { classroom_id: classroomId, name: repository.slug },
      select: { id: true },
    });
    if (byName) return { tagId: byName.id };
  }

  return { untagged: 'repository-untagged' };
}

// ─── The resolver ───────────────────────────────────────────────────────────

/**
 * Who this person reviews, for one repeat group.
 *
 * @param repeat  the group's `repeat` block, straight off the definition.
 * @param client  optional transaction client — the submit path passes `tx`.
 */
export async function resolveRepeatTargets({
  classroomId,
  userId,
  repeat,
  client,
}: {
  classroomId: string;
  userId: string;
  repeat: RepeatDefinition;
  client?: Client;
}): Promise<RepeatResolution> {
  const prisma = db(client);
  const scope = repeat.scope;

  let tagId: string | null = null;
  if (scope.by !== 'classroom') {
    const resolved = await tagForScope(prisma, classroomId, scope);
    if ('untagged' in resolved) {
      return { state: 'TEAM_UNTAGGED', scope, detail: resolved.untagged, targets: [] };
    }
    tagId = resolved.tagId;
  }

  const teams = await prisma.team.findMany({
    where: {
      classroom_id: classroomId,
      memberships: { some: { user_id: userId } },
      ...(tagId ? { tags: { some: { tag_id: tagId } } } : {}),
    },
    select: {
      id: true,
      name: true,
      memberships: {
        select: {
          user_id: true,
          user: { select: { id: true, name: true, login: true, email: true } },
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  if (teams.length === 0) {
    if (!tagId) return { state: 'NO_TEAM', scope, targets: [] };
    // Scoped by a tag and found nothing. WHY matters: "you are on no team" and
    // "your team is not part of this review's team set" are different problems
    // with different fixes, and telling a student the first when the second is
    // true sends them to the wrong person.
    const anyTeam = await prisma.team.count({
      where: { classroom_id: classroomId, memberships: { some: { user_id: userId } } },
    });
    return anyTeam > 0
      ? { state: 'TEAM_UNTAGGED', scope, detail: 'no-team-with-tag', targets: [] }
      : { state: 'NO_TEAM', scope, targets: [] };
  }

  if (teams.length > 1) {
    return {
      state: 'AMBIGUOUS_TEAM',
      scope,
      teamNames: teams.map(team => team.name),
      targets: [],
    };
  }

  const team = teams[0];
  const excludeSelf = repeat.exclude_self !== false;

  // Deduped by user id: a person can hold two memberships of the same team
  // through a legacy import, and two cards for one teammate would be two
  // reviews of them that the long export would count twice.
  const byUser = new Map<string, RepeatTarget>();
  for (const membership of team.memberships) {
    if (excludeSelf && membership.user_id === userId) continue;
    if (byUser.has(membership.user_id)) continue;
    byUser.set(membership.user_id, {
      user_id: membership.user_id,
      name: (membership.user.name || membership.user.login || '').trim(),
      email: membership.user.email,
      login: membership.user.login,
    });
  }

  // Students only — see the header. Done as ONE query over the candidate ids
  // rather than per target.
  const candidateIds = [...byUser.keys()];
  const students =
    candidateIds.length === 0
      ? []
      : await prisma.classroomMembership.findMany({
          where: { classroom_id: classroomId, role: 'STUDENT', user_id: { in: candidateIds } },
          select: { user_id: true },
        });
  const studentIds = new Set(students.map(row => row.user_id));

  const targets = candidateIds
    .filter(id => studentIds.has(id))
    .map(id => byUser.get(id) as RepeatTarget)
    .sort((a, b) => a.name.localeCompare(b.name) || a.user_id.localeCompare(b.user_id));

  return {
    // A team of one is a legitimate, non-broken state: the group renders a note
    // instead of cards and the rest of the form still submits.
    state: targets.length === 0 ? 'SOLO_TEAM' : 'OK',
    scope,
    team: { id: team.id, name: team.name },
    targets,
  };
}

/**
 * Resolve EVERY repeat group in a definition, for one respondent.
 *
 * Keyed by field id, in definition order. A definition with no repeat groups
 * costs no queries at all, which is what keeps this callable unconditionally
 * from the classroom loader.
 */
export async function resolveRepeatGroups({
  classroomId,
  userId,
  fields,
  client,
}: {
  classroomId: string;
  userId: string;
  fields: FormField[];
  client?: Client;
}): Promise<Record<string, RepeatResolution>> {
  const groups = repeatGroups(fields);
  const resolutions: Record<string, RepeatResolution> = {};
  for (const group of groups) {
    resolutions[group.id] = await resolveRepeatTargets({
      classroomId,
      userId,
      repeat: group.repeat as RepeatDefinition,
      client,
    });
  }
  return resolutions;
}

// ─── The stored snapshot ────────────────────────────────────────────────────

/**
 * One target as it is written into `FormResponse.resolved_context`.
 *
 * Names are COPIED, never a foreign key. The whole reason this column exists is
 * that a review has to stay readable after the person reviewed leaves the
 * course or deletes their account — re-joining to `users` at read time would
 * put the instructor's export at the mercy of a roster change.
 */
export interface SnapshotTarget {
  user_id: string;
  name: string;
  login?: string | null;
  email?: string | null;
  /** True once the person is no longer on the team the review was written for. */
  removed: boolean;
}

/**
 * The `resolved_context` payload.
 *
 * TWO keys, and the split is load-bearing. `targets` is the flat, generic map
 * the read surfaces already walk (`answerFormat.targetsFor`, the response
 * drawer, the long CSV) — it must stay `{ [groupId]: SnapshotTarget[] }`.
 * `groups` carries the per-group provenance an instructor needs when a review
 * looks wrong: which team, which scope, resolved when.
 */
export interface ResolvedContextSnapshot {
  targets: Record<string, SnapshotTarget[]>;
  groups: Record<
    string,
    {
      team_id: string | null;
      team_name: string | null;
      scope: RepeatScope;
      state: RepeatResolutionState;
      resolved_at: string;
    }
  >;
}

/**
 * Build the snapshot for one response.
 *
 * `previous` is the snapshot already on the row (a server draft's, or the
 * earlier submission's). Its targets are MERGED IN as `removed: true` when they
 * are no longer resolved — that merge is the only record that a departed
 * teammate was ever a teammate, and it is what lets their review keep
 * validating and keep appearing in the export. It is a union, never a
 * replacement: an autosave landing the moment after somebody left must not
 * erase the evidence.
 *
 * `resolvedAt` is passed in rather than read from the clock here, so the caller
 * that is already inside a transaction stamps every group with one instant.
 */
export function buildResolvedContext({
  resolutions,
  previous,
  resolvedAt,
}: {
  resolutions: Record<string, RepeatResolution>;
  previous?: unknown;
  resolvedAt: Date;
}): ResolvedContextSnapshot {
  const stamp = resolvedAt.toISOString();
  const prior = priorTargets(previous);

  const snapshot: ResolvedContextSnapshot = { targets: {}, groups: {} };

  for (const [groupId, resolution] of Object.entries(resolutions)) {
    const live = new Map<string, SnapshotTarget>(
      resolution.targets.map(target => [
        target.user_id,
        {
          user_id: target.user_id,
          name: target.name,
          login: target.login ?? null,
          email: target.email ?? null,
          removed: false,
        },
      ])
    );

    for (const target of prior[groupId] ?? []) {
      if (live.has(target.user_id)) continue;
      live.set(target.user_id, { ...target, removed: true });
    }

    snapshot.targets[groupId] = [...live.values()];
    snapshot.groups[groupId] = {
      team_id: 'team' in resolution ? resolution.team.id : null,
      team_name: 'team' in resolution ? resolution.team.name : null,
      scope: resolution.scope,
      state: resolution.state,
      resolved_at: stamp,
    };
  }

  return snapshot;
}

/** The targets recorded in a stored snapshot, read defensively. */
export function priorTargets(previous: unknown): Record<string, SnapshotTarget[]> {
  const context = (previous ?? {}) as { targets?: unknown };
  const raw = context.targets;
  if (!raw || typeof raw !== 'object') return {};

  const out: Record<string, SnapshotTarget[]> = {};
  for (const [groupId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[groupId] = value
      .filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
      )
      .map(entry => ({
        user_id: String(entry.user_id),
        name: String(entry.name ?? ''),
        login: (entry.login as string | null | undefined) ?? null,
        email: (entry.email as string | null | undefined) ?? null,
        removed: Boolean(entry.removed),
      }))
      .filter(entry => entry.user_id && entry.user_id !== 'undefined');
  }
  return out;
}

/**
 * The `resolved` context `buildResponseSchema` wants, from a resolution set
 * plus whatever this response's own snapshot already recorded.
 *
 * Live targets are REQUIRED keys (subject to `require_all_targets`); targets the
 * snapshot knows about and the resolver no longer returns are OPTIONAL ones.
 * The union is what makes a draft written before a teammate left still
 * submittable — and the fact that the optional half comes from a SERVER-WRITTEN
 * snapshot and never from the request body is what stops it from being a way to
 * post a review of somebody who was never a teammate.
 */
export function schemaContextFor({
  resolutions,
  previous,
}: {
  resolutions: Record<string, RepeatResolution>;
  previous?: unknown;
}): Record<string, ResolvedTargetRef[]> {
  const prior = priorTargets(previous);
  const resolved: Record<string, ResolvedTargetRef[]> = {};

  for (const [groupId, resolution] of Object.entries(resolutions)) {
    const live = resolution.targets.map(target => ({ user_id: target.user_id }));
    const liveIds = new Set(live.map(target => target.user_id));
    const departed = (prior[groupId] ?? [])
      .filter(target => !liveIds.has(target.user_id))
      .map(target => ({ user_id: target.user_id, optional: true }));
    resolved[groupId] = [...live, ...departed];
  }

  return resolved;
}

/**
 * Groups where the CURRENT resolution contains somebody the filler never saw.
 *
 * `rendered` is what the browser says it was showing. It is not trusted for
 * anything — the schema's allowed set is server-derived — and it is used only
 * here, to decide whether the person deserves a "your team changed" notice
 * rather than a validation error they cannot act on. A client that lies about
 * it only denies itself the notice, and then fails `require_all_targets` for
 * the teammate it claimed to know about and did not review.
 */
export function newTargetsSince(
  resolutions: Record<string, RepeatResolution>,
  rendered: Record<string, string[]> | undefined
): string[] {
  if (!rendered) return [];
  const changed: string[] = [];
  for (const [groupId, resolution] of Object.entries(resolutions)) {
    const seen = rendered[groupId];
    // A group the client said nothing about is not evidence of a change.
    if (!Array.isArray(seen)) continue;
    const known = new Set(seen.map(String));
    if (resolution.targets.some(target => !known.has(target.user_id))) changed.push(groupId);
  }
  return changed;
}
