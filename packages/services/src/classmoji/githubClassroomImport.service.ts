/**
 * Import a GitHub Classroom export into a new Classmoji classroom.
 *
 * The teacher exports their GitHub Classroom data locally (via the official
 * classroom-export-utility), zips it, and uploads it. The webapp parses the
 * bundle client-side (apps/webapp/.../_user.import-classroom/utils.ts) and hands
 * us the normalized structure below. This service does the DB mapping.
 *
 * It makes no Github API calls of its own. Whether the importer administers
 * each Github organization is checked by the caller (the import route, with the
 * importer's own Github token) and handed in as `organizations`; a NEW
 * classroom is created only in an organization verified that way, and the
 * organization row's login only ever comes from that check. The importer's
 * Github sign-in sees an organization only where the Classmoji Github app is
 * installed, so a refusal for an organization with no installation known to
 * Classmoji asks for the app to be installed first. When Github does verify an
 * owner of an organization without the app, the classroom is created there with
 * a NULL `github_installation_id`, as `exampleClassroom.service.ts` does, and
 * every Github-touching view short-circuits on that null until the app is
 * installed.
 *
 * Grades are NOT pushed into the native emoji/issue pipeline (the export has no
 * GitHub issue ids, and fabricating them would duplicate on a later real sync).
 * Instead each student's scores plus other export info (commit count,
 * submitted/passing, original repo URL) are stored as read-only `GitRepo.metadata`
 * on their imported repo — for viewing only, never feeding live grading.
 *
 * Every write is an upsert on a natural key, so re-importing the same bundle is
 * idempotent (updates in place, never duplicates). The classroom itself is the
 * one exception to "upsert": it is matched on TWO keys, because a slug can be
 * suffixed on a global collision and so can no longer carry idempotency alone.
 * See `resolveImportedClassroom`.
 *
 * The bundle's keys also find rows the importer does not own: an existing
 * organization, existing people and their accounts, git repositories and
 * classrooms. Each is written only under its own rule. A re-import updates an
 * existing classroom only when the importer holds an accepted OWNER membership
 * in it; otherwise it creates a new classroom of their own, exactly as if
 * nothing had matched. A git repository linked to another classroom is left
 * where it is. An existing person's profile (and a placeholder account's
 * Github id) is written only when they have never signed in, are a member of
 * at least one classroom the importer owns, and of no other. An organization's
 * login is renamed only when the importer owns every classroom in it and the
 * Github App is not installed there. Otherwise those rows are left as they
 * are.
 *
 * A student who matches an existing person the import may not update, and who
 * is not already an accepted member of the classroom (a pending invite does
 * not count), is not enrolled at all: no
 * membership, team membership or repository link is written for them, and a
 * warning names them so the owner can add them from Students.
 */

import getPrisma from '@classmoji/database';
import { defaultContentRepoName, titleToIdentifier } from '@classmoji/utils';
import {
  classroomSlugCandidates,
  createWithUniqueClassroomSlug,
  slugify,
} from './classroomSlug.ts';
import { canCreateActive } from './classroomLifecycle.service.ts';

// ---------------------------------------------------------------------------
// Input shape (structural subset of the webapp parser's ParsedClassroom).
// ---------------------------------------------------------------------------

export interface ImportStudent {
  providerId: string;
  login: string;
  name: string | null;
  avatarUrl?: string | null;
}

export interface ImportRepoLink {
  providerId: string;
  name: string;
  htmlUrl?: string | null;
}

export interface ImportAcceptance {
  type: 'individual' | 'group';
  students: ImportStudent[];
  repo: ImportRepoLink | null;
  commitCount?: number | null;
  submitted?: boolean;
  passing?: boolean;
  grade?: string | null;
}

export interface ImportGradeRow {
  assignmentTitle: string;
  githubUsername: string;
  pointsAwarded: string;
  pointsAvailable: string;
  submissionTimestamp?: string | null;
}

export interface ImportAssignment {
  githubId: number;
  title: string;
  slug: string;
  type: 'individual' | 'group';
  deadline: string | null;
  starterRepoFullName: string;
  acceptances: ImportAcceptance[];
}

export interface ImportClassroom {
  githubId: number;
  name: string;
  archived: boolean;
  organization: { id: number; login: string };
  assignments: ImportAssignment[];
  grades: ImportGradeRow[];
}

export interface ImportClassroomInput {
  classroom: ImportClassroom;
  slug: string;
}

export interface ImportSummary {
  classroomId: string;
  classroomSlug: string;
  /** The import updated a classroom that already existed (a re-import), not a new one. */
  reimported: boolean;
  classroomName: string;
  organizationLogin: string;
  appInstalled: boolean;
  repositoriesImported: number;
  assignmentsImported: number;
  studentsEnrolled: number;
  reposLinked: number;
  gradesRecorded: number;
  teamsImported: number;
  teamMembershipsImported: number;
  groupReposLinked: number;
  /**
   * People of the roster left out because they are already on Classmoji, in a
   * way the import may not change (each also named in `warnings`).
   */
  existingAccountsNotEnrolled: number;
  warnings: string[];
}

/**
 * Why an organization was not verified, as the caller found it. The service
 * turns it into the sentence the importer reads.
 */
export type ImportOrganizationRefusal =
  /** The importer has no Github sign-in to check with. */
  | 'no_github'
  /** Github refused the importer's token. */
  | 'token_rejected'
  /** Github would not show the organization to the importer's token. */
  | 'no_access'
  /** Github did not answer. */
  | 'unreachable'
  /** Github answered: the importer is not an owner of the organization. */
  | 'not_admin'
  /** The organization Github has under that name is not the export's. */
  | 'mismatch';

/**
 * What Github said about one organization of the export, keyed (in
 * `ImportOrganizationVerifications`) by the export's organization id. Built by
 * the caller from Github's own answer, never from the request.
 */
export interface ImportOrganizationVerification {
  /** The organization id Github reported, which must be the key's. */
  githubId: string;
  /** The importer administers that organization. */
  verifiedAdmin: boolean;
  /** The organization's login as Github reports it (null when not verified). */
  login: string | null;
  reason?: ImportOrganizationRefusal | null;
}

export type ImportOrganizationVerifications = ReadonlyMap<string, ImportOrganizationVerification>;

export interface ImportOptions {
  /**
   * The organizations the importer administers, per export organization id.
   * Absent, or missing an organization: no new classroom is created in it.
   */
  organizations?: ImportOrganizationVerifications;
}

/** The import may not create this classroom: the organization was not verified. */
export class ImportOrganizationNotVerifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportOrganizationNotVerifiedError';
  }
}

const REFUSAL_HINTS: Partial<Record<ImportOrganizationRefusal, string>> = {
  no_github: 'Sign in with Github, then try again.',
  token_rejected: 'Sign out, sign in with Github again, then try again.',
  no_access:
    'If you are an owner, grant Classmoji access to the organization on Github, then try again.',
  unreachable: 'Classmoji could not reach Github; try again in a moment.',
};

/** A Github login as Github allows it: letters, digits and single inner dashes, at most 39. */
export const isGithubLogin = (login: unknown): login is string =>
  typeof login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login);

/** The export's organization login, as plain text for a message: no control characters, bounded. */
const loginAsText = (login: unknown): string =>
  Array.from(String(login ?? ''))
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join('')
    .trim()
    .slice(0, 100);

/** Reasons that say nothing about the organization: the check itself could not be made. */
const CHECK_NOT_MADE: ReadonlySet<ImportOrganizationRefusal> = new Set([
  'no_github',
  'unreachable',
]);

/**
 * The refusal the importer reads for a classroom whose organization was not
 * verified. `appInstalled`: Classmoji knows of a Classmoji Github app
 * installation on the organization. Without one, Github shows the organization
 * to the importer's sign-in only once the app is installed, so unless the
 * check could not be made at all, the importer is asked to install it first.
 */
export const organizationRefusalMessage = (
  bundleLogin: unknown,
  reason: ImportOrganizationRefusal | null | undefined,
  { appInstalled }: { appInstalled: boolean }
): string => {
  const login = loginAsText(bundleLogin);
  if (!appInstalled && !(reason && CHECK_NOT_MADE.has(reason))) {
    return login
      ? `Install the Classmoji Github app on ${login} first (an organization owner can), then import again.`
      : 'Install the Classmoji Github app on the Github organization of this classroom first (an organization owner can), then import again.';
  }
  const base = login
    ? `You need to be an owner of the Github organization ${login} to import this classroom.`
    : 'You need to be an owner of the Github organization of this classroom to import it.';
  const hint = reason ? REFUSAL_HINTS[reason] : undefined;
  return hint ? `${base} ${hint}` : base;
};

/**
 * Github's login for the export's organization when the importer is verified
 * as its administrator, else null. Only a real `Map` counts: a value that came
 * from JSON is not one.
 */
const verifiedOrganizationLogin = (
  organizations: ImportOrganizationVerifications | undefined,
  orgProviderId: string
): { login: string | null; reason: ImportOrganizationRefusal | null } => {
  const entry = organizations instanceof Map ? organizations.get(orgProviderId) : undefined;
  if (
    entry &&
    entry.verifiedAdmin === true &&
    entry.githubId === orgProviderId &&
    isGithubLogin(entry.login)
  ) {
    return { login: entry.login, reason: null };
  }
  return { login: null, reason: entry?.reason ?? null };
};

// ---------------------------------------------------------------------------
// Read-only GitRepo.metadata builder.
// ---------------------------------------------------------------------------

/**
 * Build the read-only `GitRepo.metadata` object for a student's imported repo:
 * GitHub Classroom points (when graded) plus other export info (commit count,
 * submitted/passing, original repo URL). Purely for viewing — never feeds the
 * live emoji/issue grading pipeline. Returns null when there's nothing to record.
 * Exported for unit testing.
 */
export const buildImportedMetadata = (
  acc: ImportAcceptance,
  grade: {
    pointsAwarded: string;
    pointsAvailable: string;
    submissionTimestamp?: string | null;
  } | null
): Record<string, string | number | boolean | null> | null => {
  const meta: Record<string, string | number | boolean | null> = { source: 'github_classroom' };
  if (grade) {
    meta.points_awarded = grade.pointsAwarded;
    meta.points_available = grade.pointsAvailable;
    if (grade.submissionTimestamp) meta.submission_timestamp = grade.submissionTimestamp;
  }
  if (acc.grade) meta.grade = acc.grade;
  if (acc.commitCount != null) meta.commit_count = acc.commitCount;
  if (acc.submitted != null) meta.submitted = acc.submitted;
  if (acc.passing != null) meta.passing = acc.passing;
  if (acc.repo?.htmlUrl) meta.original_url = acc.repo.htmlUrl;
  // Nothing beyond the bare source tag → not worth storing.
  return Object.keys(meta).length > 1 ? meta : null;
};

// ---------------------------------------------------------------------------
// Team identity for group assignments.
// ---------------------------------------------------------------------------

// Small deterministic string hash (djb2 → base36). Only used to keep a fallback
// team slug bounded; not security-sensitive.
const djb2 = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
};

/**
 * Recover a stable team slug for a group assignment.
 *
 * GitHub Classroom names group repos `<assignment-slug>-<team-slug>`, so stripping
 * the assignment-slug prefix from the repo name yields the real GitHub team slug —
 * stable across all of that team's assignments, which dedupes the team. The export
 * has no team id/name, so this is the only reliable identity.
 *
 * Fallback (renamed assignment, no repo, or a non-matching name): a deterministic
 * signature of the sorted member logins. This is a *uniqueness* key, not a
 * cross-assignment dedup key — a roster change legitimately yields a new team.
 *
 * Returns null only when there's nothing to key on (no repo name and no members).
 * Exported for unit testing.
 */
export const deriveTeamSlug = (
  repoName: string,
  assignmentSlug: string,
  memberLogins: string[]
): string | null => {
  const n = (repoName ?? '').trim().toLowerCase();
  const aSlug = (assignmentSlug ?? '').trim().toLowerCase();
  if (aSlug) {
    const prefix = `${aSlug}-`;
    // Strip exactly the leading prefix; the remainder is already a GitHub slug,
    // so return it verbatim (don't re-slugify).
    if (n.startsWith(prefix) && n.length > prefix.length) return n.slice(prefix.length);
  }

  // Fallback: sorted member logins (sorting is required for re-import idempotency).
  const sorted = memberLogins
    .map(l => l.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (sorted.length === 0) return n || null; // no members → use repo name if any, else null
  const base = titleToIdentifier(`team-${sorted.join('-')}`);
  if (base.length > 64) return `team-${djb2(sorted.join(','))}`;
  return base || null;
};

// ---------------------------------------------------------------------------
// Import a single classroom.
// ---------------------------------------------------------------------------

/** The transaction client handed to an interactive `prisma.$transaction`. */
type ImportTx = Parameters<Parameters<ReturnType<typeof getPrisma>['$transaction']>[0]>[0];

/** A classroom in which `userId` holds an accepted OWNER membership. */
const ownedBy = (userId: string) => ({
  memberships: { some: { user_id: userId, role: 'OWNER' as const, has_accepted_invite: true } },
});

/**
 * The bundle's Github organization id as the organization row's key: a
 * positive safe integer, given as a number or as its digits (no sign, no
 * leading zero, so one organization has one key). Null for anything else.
 */
export const organizationProviderId = (id: unknown): string | null => {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  if (typeof id === 'string' && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) {
    return id;
  }
  return null;
};

/** Above this many repositories linked to other classrooms, one warning gives the count. */
const MAX_SKIPPED_REPO_WARNINGS = 5;
/** Above this many people with an account of their own, one warning gives the count. */
const MAX_SKIPPED_PEOPLE_WARNINGS = 5;

export async function importGithubClassroom(
  ownerUserId: string,
  input: ImportClassroomInput,
  options: ImportOptions = {}
): Promise<ImportSummary> {
  const prisma = getPrisma();
  const { classroom: gh } = input;

  // Normalize the slug HERE rather than only in the HTTP action: the wizard's
  // slug field is free text that reaches the job verbatim, and a Trigger.dev
  // REPLAY re-enters at this function with the original payload. An input that
  // sanitizes away entirely falls back to the classroom name.
  const requestedSlug = slugify(input.slug) || slugify(gh.name);
  if (!requestedSlug) {
    throw new Error(`Classroom "${gh.name}" has no usable slug and can't be imported.`);
  }
  const orgProviderId = organizationProviderId(gh.organization?.id);
  if (!orgProviderId) {
    throw new Error(
      `Classroom "${gh.name}" has no valid Github organization id and can't be imported.`
    );
  }

  // Github's own login for the organization, when the importer is verified as
  // its administrator (by the caller, by id). Without it no new classroom is
  // made and the organization row is not written: only a classroom the
  // importer already owns there can be updated.
  const verified = verifiedOrganizationLogin(options.organizations, orgProviderId);

  // Org upsert lives OUTSIDE the transaction. github_installation_id is left
  // untouched: NULL on first import (GitHub-free), preserved if the teacher
  // already installed the app for another classroom in this org.
  //
  // Github's login renames an existing org only when the importer owns every
  // classroom in it and the app is not installed there (an installation keeps
  // the login current from Github itself). Otherwise the org keeps its login:
  // it is shared with classrooms that are not the importer's. The export's
  // login is never written.
  const orgKey = { provider: 'GITHUB' as const, provider_id: orgProviderId };
  const existingOrg = await prisma.gitOrganization.findUnique({
    where: { provider_provider_id: orgKey },
    select: {
      id: true,
      login: true,
      github_installation_id: true,
      classrooms: { where: { NOT: ownedBy(ownerUserId) }, select: { id: true }, take: 1 },
    },
  });
  const refusal = organizationRefusalMessage(gh.organization?.login, verified.reason, {
    appInstalled: Boolean(existingOrg?.github_installation_id),
  });
  if (!existingOrg && !verified.login) {
    // Nothing the importer owns can be in an organization with no row.
    throw new ImportOrganizationNotVerifiedError(refusal);
  }
  const mayRenameOrg =
    !existingOrg || (!existingOrg.github_installation_id && existingOrg.classrooms.length === 0);
  const org =
    verified.login && mayRenameOrg
      ? await prisma.gitOrganization.upsert({
          where: { provider_provider_id: orgKey },
          create: { ...orgKey, login: verified.login },
          update: { login: verified.login },
        })
      : existingOrg!;
  // The login slug candidates are built from: Github's, else the row's.
  const slugLogin = verified.login ?? org.login;

  // Index imported scores by (github_username, assignment) so each student's repo
  // can pick up its own grade for its own assignment. Read-only for the rest of
  // the import, so it is built once and survives a retried attempt untouched.
  const gradeByUserAssignment = new Map<string, ImportGradeRow>();
  const gradedLogins = new Set<string>();
  for (const row of gh.grades ?? []) {
    const login = row.githubUsername.toLowerCase();
    gradedLogins.add(login);
    gradeByUserAssignment.set(`${login}::${row.assignmentTitle}`, row);
  }

  // The retry wraps the WHOLE transaction. A P2002 raised inside an interactive
  // transaction aborts it (Postgres 25P02 — see `resolveImportedUser` below),
  // so a slug retry attempted from within would fail every remaining candidate
  // with "current transaction is aborted". Each attempt therefore builds its own
  // summary and warning list, so a replay counts the roster once, not twice.
  const { result: summary } = await createWithUniqueClassroomSlug(
    { slug: requestedSlug, orgLogin: slugLogin },
    candidateSlug =>
      importClassroomAttempt({
        ownerUserId,
        gh,
        gitOrgId: org.id,
        slugLogin,
        storedOrgLogin: org.login,
        mayCreateClassroom: Boolean(verified.login),
        refusal,
        // The login the organization row has now, which a skipped rename leaves as it was.
        organizationLogin: org.login,
        appInstalled: Boolean(org.github_installation_id),
        requestedSlug,
        candidateSlug,
        gradeByUserAssignment,
        gradedLogins,
      })
  );

  return summary;
}

/**
 * Find (or create) the Classmoji classroom this GitHub Classroom course maps to.
 *
 * TWO keys, in order, because the slug alone can no longer carry idempotency —
 * a global collision suffixes it, and a suffixed slug never matches the default
 * one a re-import asks for:
 *
 *  1. `github_classroom_id` — the GitHub Classroom course id, the stable key.
 *     Its slug is deliberately NOT touched: it may carry a collision suffix and
 *     it is a live URL.
 *  2. `(git_org_id, slug)` on a row that carries NO `github_classroom_id` —
 *     LEGACY rows imported before that column existed. The null predicate is
 *     load-bearing, not decoration: two courses in one org whose names slugify
 *     identically ("CS 52: Full-Stack" and "CS 52 Full Stack" both give `cs-52`)
 *     are both auto-selected by the wizard, and without it the second import
 *     would match the first one's row by slug and overwrite its name and course
 *     id — one classroom holding both rosters, the first course id lost.
 *     Matched on the REQUESTED slug, never the retry candidate: a candidate such
 *     as `cs101-2` can belong to an unrelated classroom in this org, and
 *     updating that would pour this roster into someone else's course. The
 *     course id is stamped on as a side effect, so the row self-heals and the
 *     next re-import matches on step 1 instead.
 *  3. Otherwise create, on the candidate slug the retry wrapper supplied. An
 *     already-imported row holding the requested slug falls through to here,
 *     where the globally unique slug raises P2002 and the retry wrapper moves
 *     on to the next candidate — a correctly suffixed second classroom.
 *
 * Steps 1 and 2 match only a classroom in which the importer holds an accepted
 * OWNER membership. Any other classroom found by those keys is left exactly as
 * it is, and the import creates a new classroom of the importer's own (step 3).
 * That classroom carries the course id only while no other classroom holds it:
 * the column is unique, and a failed statement would abort the transaction.
 *
 * So when another classroom holds the course id, the importer's own classroom
 * for the course carries none, and may sit on a suffixed slug. Between steps 2
 * and 3, and only then, a re-import therefore also matches a classroom in this
 * organization that the importer created and owns, with no course id, on one
 * of the slugs the retry wrapper tries for the requested one (the earliest in
 * that order wins). Without it each re-import would create another classroom.
 *
 * Step 3 runs only when the importer was verified as an administrator of the
 * organization (`mayCreateClassroom`); otherwise it throws
 * `ImportOrganizationNotVerifiedError` before any write, and the transaction
 * the caller opened writes nothing.
 *
 * Every lookup is attempt-invariant, which is what makes a retried attempt
 * take the same branch as the first one.
 *
 * Exported for tests only; the importer is its sole caller.
 */
export async function resolveImportedClassroom(
  tx: ImportTx,
  args: {
    gitOrgId: string;
    githubClassroomId: number | null;
    requestedSlug: string;
    candidateSlug: string;
    /** The organization login the retry wrapper builds its slug candidates from. */
    orgLogin: string;
    /**
     * The organization row's login, when it differs from `orgLogin`: the
     * slug-candidate match also tries the candidates built from it, so a
     * classroom made under the row's login is still found.
     */
    storedOrgLogin?: string;
    name: string;
    /**
     * Whether step 3 may create a classroom: the importer was verified as an
     * administrator of the organization. Default: no.
     */
    mayCreateClassroom?: boolean;
    /** The message step 3 refuses with when it may not create. */
    refusal?: string;
    /** The importing user: creator and plan owner of a NEW classroom only. */
    ownerUserId: string;
    /**
     * Whether a NEW classroom may be ACTIVE: the Free plan's one-active-class
     * rule, under the importer's plan-owner lock. Without room it is created
     * LOCKED (`onCreatedLocked` is told) rather than failing the import.
     * Injectable for tests.
     */
    mayCreateActive?: (tx: ImportTx) => Promise<boolean>;
    onCreatedLocked?: () => void;
    /** Told when the course matched a classroom the importer owns (anything but step 3). */
    onReimported?: () => void;
  }
) {
  const {
    gitOrgId,
    githubClassroomId,
    requestedSlug,
    candidateSlug,
    orgLogin,
    storedOrgLogin,
    name,
    ownerUserId,
    mayCreateClassroom = false,
    refusal = 'You need to be an owner of the Github organization of this classroom to import it.',
    mayCreateActive = (db: ImportTx) => canCreateActive(db, ownerUserId),
    onCreatedLocked,
    onReimported,
  } = args;

  // The course id this classroom may carry: the bundle's, unless another
  // classroom already holds it (the column is unique). Decided once, before
  // any write, so no statement below can fail on it.
  let courseId = githubClassroomId;
  let heldByAnother = false;
  if (githubClassroomId != null) {
    const byCourse = await tx.classroom.findUnique({
      where: { github_classroom_id: githubClassroomId },
      select: {
        id: true,
        memberships: {
          where: { user_id: ownerUserId, role: 'OWNER', has_accepted_invite: true },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (byCourse && byCourse.memberships.length > 0) {
      onReimported?.();
      return tx.classroom.update({
        where: { id: byCourse.id },
        data: { name },
        include: { settings: true },
      });
    }
    if (byCourse) {
      courseId = null;
      heldByAnother = true;
    }
  }

  // `findFirst`, not `findUnique`: the compound unique cannot carry the
  // `github_classroom_id` predicate. It is still a single-row lookup — the
  // `@@unique([git_org_id, slug])` index caps the match at one — so no ordering
  // is needed to make the result deterministic.
  const legacy = await tx.classroom.findFirst({
    where: {
      git_org_id: gitOrgId,
      slug: requestedSlug,
      github_classroom_id: null,
      ...ownedBy(ownerUserId),
    },
    select: { id: true },
  });
  if (legacy) {
    onReimported?.();
    return tx.classroom.update({
      where: { id: legacy.id },
      data: {
        name,
        ...(courseId != null ? { github_classroom_id: courseId } : {}),
      },
      include: { settings: true },
    });
  }

  if (heldByAnother) {
    const slugs = [
      ...new Set([
        ...classroomSlugCandidates(requestedSlug, orgLogin),
        ...(storedOrgLogin ? classroomSlugCandidates(requestedSlug, storedOrgLogin) : []),
      ]),
    ];
    const own = await tx.classroom.findMany({
      where: {
        git_org_id: gitOrgId,
        slug: { in: slugs },
        github_classroom_id: null,
        created_by: ownerUserId,
        ...ownedBy(ownerUserId),
      },
      select: { id: true, slug: true },
    });
    const earliest = own.sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug))[0];
    if (earliest) {
      onReimported?.();
      return tx.classroom.update({
        where: { id: earliest.id },
        data: { name },
        include: { settings: true },
      });
    }
  }

  if (!mayCreateClassroom) throw new ImportOrganizationNotVerifiedError(refusal);

  const active = await mayCreateActive(tx);
  if (!active) onCreatedLocked?.();

  return tx.classroom.create({
    data: {
      git_org_id: gitOrgId,
      slug: candidateSlug,
      status: active ? 'ACTIVE' : 'LOCKED',
      name,
      content_namespace: candidateSlug,
      content_repo: defaultContentRepoName(candidateSlug),
      github_classroom_id: courseId,
      // Only here: a re-import (the updates above) keeps who created the
      // classroom and whose plan it counts against.
      created_by: ownerUserId,
      plan_owner_id: ownerUserId,
      settings: { create: { quizzes_enabled: true } },
    },
    include: { settings: true },
  });
}

/**
 * One import attempt against one candidate slug.
 *
 * Everything mutable lives here rather than in the caller, so the slug retry can
 * replay it from a clean slate: the transaction rolls back completely, and the
 * counters and warnings roll back with it.
 */
async function importClassroomAttempt(args: {
  ownerUserId: string;
  gh: ImportClassroom;
  gitOrgId: string;
  /** The login the retry wrapper builds slug candidates from (Github's, else the row's). */
  slugLogin: string;
  storedOrgLogin: string;
  mayCreateClassroom: boolean;
  refusal: string;
  organizationLogin: string;
  appInstalled: boolean;
  requestedSlug: string;
  candidateSlug: string;
  gradeByUserAssignment: Map<string, ImportGradeRow>;
  gradedLogins: Set<string>;
}): Promise<ImportSummary> {
  const prisma = getPrisma();
  const {
    ownerUserId,
    gh,
    gitOrgId,
    slugLogin,
    storedOrgLogin,
    mayCreateClassroom,
    refusal,
    organizationLogin,
    appInstalled,
    requestedSlug,
    candidateSlug,
    gradeByUserAssignment,
    gradedLogins,
  } = args;
  const warnings: string[] = [];
  // Repositories left in another classroom; reported once the roster is done.
  const skippedRepos: string[] = [];

  // The GitHub Classroom course id, when the source actually carried one.
  const githubClassroomId = Number.isInteger(gh.githubId) && gh.githubId > 0 ? gh.githubId : null;

  const summary: ImportSummary = {
    classroomId: '',
    classroomSlug: candidateSlug,
    reimported: false,
    classroomName: gh.name,
    organizationLogin,
    appInstalled,
    repositoriesImported: 0,
    assignmentsImported: 0,
    studentsEnrolled: 0,
    reposLinked: 0,
    gradesRecorded: 0,
    teamsImported: 0,
    teamMembershipsImported: 0,
    groupReposLinked: 0,
    existingAccountsNotEnrolled: 0,
    warnings,
  };

  // All DB writes in one interactive transaction: all-or-nothing per classroom.
  // Timeout is raised because large rosters mean many sequential upserts.
  await prisma.$transaction(
    async tx => {
      const classroom = await resolveImportedClassroom(tx, {
        gitOrgId,
        githubClassroomId,
        requestedSlug,
        candidateSlug,
        orgLogin: slugLogin,
        storedOrgLogin: storedOrgLogin !== slugLogin ? storedOrgLogin : undefined,
        name: gh.name,
        ownerUserId,
        mayCreateClassroom,
        refusal,
        onReimported: () => {
          summary.reimported = true;
        },
        onCreatedLocked: () =>
          warnings.push(
            `"${gh.name}" was imported locked: the Free plan includes one active class at a ` +
              'time. Archive your current class and set this one to Active in Class Settings, ' +
              'or upgrade to Pro.'
          ),
      });
      summary.classroomId = classroom.id;
      // A re-import matched by course id may update a classroom the importer
      // owns in another organization than the bundle names: the summary (and
      // the audit row built from it) describes the classroom's own.
      if (classroom.git_org_id !== gitOrgId) {
        const own = await tx.gitOrganization.findUniqueOrThrow({
          where: { id: classroom.git_org_id },
          select: { login: true, github_installation_id: true },
        });
        summary.organizationLogin = own.login;
        summary.appInstalled = Boolean(own.github_installation_id);
      }
      // The PERSISTED slug, not the candidate: a re-import updates a row in
      // place, and that row may already carry a collision suffix. This is what
      // the wizard's "Go to classroom" link is built from.
      summary.classroomSlug = classroom.slug;

      // A re-import onto an existing classroom may predate settings; ensure they exist.
      if (!classroom.settings) {
        await tx.classroomSettings.create({
          data: {
            classroom_id: classroom.id,
            quizzes_enabled: true,
          },
        });
      }

      await tx.classroomMembership.upsert({
        where: {
          classroom_id_user_id_role: {
            classroom_id: classroom.id,
            user_id: ownerUserId,
            role: 'OWNER',
          },
        },
        create: {
          classroom_id: classroom.id,
          user_id: ownerUserId,
          role: 'OWNER',
          has_accepted_invite: true,
        },
        update: {},
      });

      // Every repository lives in a module. An import lands everything in one
      // published module the teacher can split up afterwards.
      const importModule = await tx.module.upsert({
        where: {
          classroom_id_title: { classroom_id: classroom.id, title: 'GitHub Classroom import' },
        },
        create: {
          classroom_id: classroom.id,
          title: 'GitHub Classroom import',
          slug: 'github-classroom-import',
          is_published: true,
        },
        update: {},
      });

      // Repositories + assignments. Keep a map from the GitHub assignment id to the
      // Classmoji repository id so student repos can be linked back to it.
      const repoIdByAssignment = new Map<number, string>();
      for (const a of gh.assignments) {
        const type = a.type === 'group' ? 'GROUP' : 'INDIVIDUAL';
        const repository = await tx.repository.upsert({
          where: { classroom_id_title: { classroom_id: classroom.id, title: a.title } },
          create: {
            classroom_id: classroom.id,
            title: a.title,
            slug: a.slug || null,
            template: a.starterRepoFullName,
            type,
            // Imported assignments are published on arrival: the student repos
            // already exist on Github, so there is nothing to provision and no
            // reason to hide them as drafts.
            is_published: true,
          },
          // Don't clobber teacher edits on re-import.
          update: {},
        });
        repoIdByAssignment.set(a.githubId, repository.id);
        summary.repositoriesImported += 1;

        const existingAssignment = await tx.assignment.findFirst({
          where: { repository_id: repository.id, title: a.title },
          select: { id: true },
        });
        if (!existingAssignment) {
          await tx.assignment.create({
            data: {
              module_id: importModule.id,
              type: 'REPO',
              repository_id: repository.id,
              title: a.title,
              slug: a.slug || null,
              student_deadline: a.deadline ? new Date(a.deadline) : null,
              // Published on arrival, same as the repository above (repos exist).
              is_published: true,
              // GitHub Classroom never had Classmoji issues: students pushed to
              // their repo, and that push is the submission here too.
              submission_mode: 'REPO',
              // Imported assignments start unweighted; the teacher sets grading
              // weights when they configure the gradebook.
              weight: 0,
            },
          });
        }
        summary.assignmentsImported += 1;
      }

      // Enroll students (deduped across assignments) and link their repos.
      const userIdByProvider = new Map<string, string>();
      const enrolledLogins = new Set<string>();
      // People with an account the import may not enroll (see
      // `resolveImportedUser`): nothing is written for them.
      const skippedProviders = new Set<string>();
      const skippedPeople: string[] = [];
      const skippedLogins = new Set<string>();
      // Group state, deduped across assignments (a team is reused for every
      // assignment it did; its slug is recovered from the repo name).
      const teamIdBySlug = new Map<string, string>();
      const seenTeamMembers = new Set<string>();

      for (const a of gh.assignments) {
        const repositoryId = repoIdByAssignment.get(a.githubId)!;

        for (const acc of a.acceptances) {
          for (const s of acc.students) {
            if (userIdByProvider.has(s.providerId) || skippedProviders.has(s.providerId)) continue;

            const user = await resolveImportedUser(tx, s, ownerUserId, classroom.id, warnings);
            if (!user) {
              skippedProviders.add(s.providerId);
              skippedPeople.push(loginAsText(s.login) || `Github user ${s.providerId}`);
              skippedLogins.add(s.login.toLowerCase());
              continue;
            }
            const userId = user.id;
            userIdByProvider.set(s.providerId, userId);
            summary.studentsEnrolled += 1;

            await tx.classroomMembership.upsert({
              where: {
                classroom_id_user_id_role: {
                  classroom_id: classroom.id,
                  user_id: userId,
                  role: 'STUDENT',
                },
              },
              create: {
                classroom_id: classroom.id,
                user_id: userId,
                role: 'STUDENT',
                // These students already accepted in GitHub Classroom (they have
                // repos), so they're active members here — not pending invites.
                has_accepted_invite: true,
              },
              update: {},
            });
            enrolledLogins.add(s.login.toLowerCase());
          }

          // Only the students enrolled above take part in this acceptance.
          const enrolled = acc.students.filter(s => userIdByProvider.has(s.providerId));

          // Link the student's repo (individual) and stash the imported GitHub
          // Classroom data on it as read-only metadata.
          if (
            acc.type === 'individual' &&
            acc.repo &&
            acc.students.length === 1 &&
            enrolled.length === 1
          ) {
            const student = enrolled[0];
            const studentId = userIdByProvider.get(student.providerId)!;
            const grade =
              gradeByUserAssignment.get(`${student.login.toLowerCase()}::${a.title}`) ?? null;
            const metadata = buildImportedMetadata(acc, grade);

            const linked = await linkImportedRepo(tx, {
              repo: acc.repo,
              classroomId: classroom.id,
              data: {
                repository_id: repositoryId,
                student_id: studentId,
                metadata: metadata ?? undefined,
              },
              skippedRepos,
            });
            if (linked) {
              if (grade) summary.gradesRecorded += 1;
              summary.reposLinked += 1;
            }
          } else if (acc.type === 'group' && enrolled.length > 0) {
            // Recover the team (deduped across assignments), enroll its members
            // into the team, and link the team's shared repo. A group none of
            // whose members were enrolled is passed over, as an empty one is.
            // The team's identity comes from the whole group, so it stays the
            // same whoever of it was enrolled.
            const slug = deriveTeamSlug(
              acc.repo?.name ?? '',
              a.slug,
              acc.students.map(s => s.login)
            );
            if (!slug) {
              warnings.push(`Skipped a group on "${a.title}" (no team identity in the export).`);
              continue;
            }

            let teamId = teamIdBySlug.get(slug);
            if (!teamId) {
              const team = await tx.team.upsert({
                where: { classroom_id_slug: { classroom_id: classroom.id, slug } },
                create: {
                  classroom_id: classroom.id,
                  name: slug,
                  slug,
                  // No GitHub team id in the export → provider-less (adoptable later).
                  provider: null,
                  provider_id: null,
                  is_visible: true,
                },
                update: {},
              });
              teamId = team.id;
              teamIdBySlug.set(slug, teamId);
              summary.teamsImported += 1;
            }

            for (const s of enrolled) {
              const uid = userIdByProvider.get(s.providerId)!;
              const key = `${teamId}::${uid}`;
              if (seenTeamMembers.has(key)) continue;
              await tx.teamMembership.upsert({
                where: { team_id_user_id: { team_id: teamId, user_id: uid } },
                create: { team_id: teamId, user_id: uid },
                update: {},
              });
              seenTeamMembers.add(key);
              summary.teamMembershipsImported += 1;
            }

            if (acc.repo) {
              // All members of a group share one grade; use the first enrolled
              // member that actually has a grade row.
              let grade: ImportGradeRow | null = null;
              for (const s of enrolled) {
                const g = gradeByUserAssignment.get(`${s.login.toLowerCase()}::${a.title}`);
                if (g) {
                  grade = g;
                  break;
                }
              }
              const metadata = buildImportedMetadata(acc, grade);

              const linked = await linkImportedRepo(tx, {
                repo: acc.repo,
                classroomId: classroom.id,
                data: {
                  repository_id: repositoryId,
                  team_id: teamId,
                  student_id: null,
                  metadata: metadata ?? undefined,
                },
                skippedRepos,
              });
              if (linked) {
                if (grade) summary.gradesRecorded += 1;
                summary.groupReposLinked += 1;
              }
            }
          }
        }
      }

      if (skippedRepos.length > MAX_SKIPPED_REPO_WARNINGS) {
        warnings.push(
          `Skipped ${skippedRepos.length} repositories (they belong to other classrooms).`
        );
      } else {
        for (const name of skippedRepos) {
          warnings.push(`Skipped repository "${name}" (it belongs to another classroom).`);
        }
      }

      summary.existingAccountsNotEnrolled = skippedPeople.length;
      if (skippedPeople.length > MAX_SKIPPED_PEOPLE_WARNINGS) {
        warnings.push(
          `${skippedPeople.length} people are already on Classmoji; add them by email from Students.`
        );
      } else {
        for (const login of skippedPeople) {
          warnings.push(`@${login} is already on Classmoji; add them by email from Students.`);
        }
      }

      // Warn about graded students who never accepted (no repo to attach to).
      // People passed over above have their own warning.
      for (const login of gradedLogins) {
        if (!enrolledLogins.has(login) && !skippedLogins.has(login)) {
          warnings.push(`Grades for "${login}" were skipped (not enrolled in this classroom).`);
        }
      }
    },
    { timeout: 120_000 }
  );

  return summary;
}

/**
 * Link a student's or team's imported Github repo to this classroom, keyed on
 * the repo's provider id. A repo already linked to ANOTHER classroom stays
 * where it is (its name goes on `skippedRepos`, for the summary's warnings);
 * only a new repo or one already in this classroom is written. Answers whether
 * it was linked.
 */
async function linkImportedRepo(
  tx: ImportTx,
  args: {
    repo: ImportRepoLink;
    classroomId: string;
    data: {
      repository_id: string;
      student_id: string | null;
      team_id?: string | null;
      metadata?: Record<string, string | number | boolean | null>;
    };
    skippedRepos: string[];
  }
): Promise<boolean> {
  const { repo, classroomId, data, skippedRepos } = args;
  const key = { provider: 'GITHUB' as const, provider_id: repo.providerId };
  const existing = await tx.gitRepo.findUnique({
    where: { provider_provider_id: key },
    select: { classroom_id: true },
  });
  if (existing && existing.classroom_id !== classroomId) {
    skippedRepos.push(repo.name);
    return false;
  }
  await tx.gitRepo.upsert({
    where: { provider_provider_id: key },
    create: { ...key, name: repo.name, classroom_id: classroomId, ...data },
    update: { name: repo.name, classroom_id: classroomId, ...data },
  });
  return true;
}

/**
 * Whether the import may refresh an existing person's profile (name, avatar,
 * Github username) or give their placeholder account its Github id: only a
 * person who has never signed in, is a member of at least one classroom the
 * importer owns, and of no other classroom. Everyone else, a person with no
 * membership at all included, keeps their profile as it is; a real sign-in
 * keeps theirs current from Github itself.
 */
async function mayUpdateImportedPerson(tx: ImportTx, userId: string, ownerUserId: string) {
  const person = await tx.user.findFirst({
    where: {
      id: userId,
      first_sign_in_at: null,
      sessions: { none: {} },
      accounts: { every: { access_token: null, password: null } },
      classroom_memberships: {
        some: { classroom: ownedBy(ownerUserId) },
        every: { classroom: ownedBy(ownerUserId) },
      },
    },
    select: { id: true },
  });
  return person != null;
}

/**
 * Whether the person holds an accepted membership (any role) in this
 * classroom. A pending invite does not count: its person is left out like
 * anyone else the import may not update.
 */
async function isClassroomMember(tx: ImportTx, userId: string, classroomId: string) {
  const membership = await tx.classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: userId, has_accepted_invite: true },
    select: { id: true },
  });
  return membership != null;
}

/**
 * Resolve (find or create) a student User by GitHub identity WITHOUT ever issuing
 * a write that could violate a unique constraint.
 *
 * This runs inside an interactive transaction, where a single failed statement
 * aborts the WHOLE transaction (Postgres 25P02) and rolls back the import — so we
 * can't "try the write and recover." Instead: look up the Github account by user
 * id, then by username (handling Github-login reuse), and only `create` when
 * neither exists. The account's unique `username` is only changed when the
 * target is free. Never writes `email` (absent from the export). An existing
 * person is written only when `mayUpdateImportedPerson` allows it.
 *
 * Answers null for an existing person the import may not enroll: one that
 * `mayUpdateImportedPerson` does not allow and who is not already an accepted
 * member of this classroom. They are already on Classmoji, and the owner adds
 * them from Students.
 */
async function resolveImportedUser(
  tx: ImportTx,
  s: ImportStudent,
  ownerUserId: string,
  classroomId: string,
  warnings: string[]
) {
  // 1) Canonical match: the GitHub user id.
  const byProvider = await tx.account.findUnique({
    where: { provider_id_account_id: { provider_id: 'github', account_id: s.providerId } },
    select: { id: true, username: true, user_id: true },
  });
  if (byProvider) {
    if (!(await mayUpdateImportedPerson(tx, byProvider.user_id, ownerUserId))) {
      if (!(await isClassroomMember(tx, byProvider.user_id, classroomId))) return null;
      return tx.user.findUniqueOrThrow({ where: { id: byProvider.user_id } });
    }
    const accountData: { image: string | null; username?: string } = {
      image: s.avatarUrl ?? null,
    };
    // Only update `username` when the new value is free, so we never trip the
    // unique (provider_id, username) constraint mid-transaction.
    if (s.login && s.login !== byProvider.username) {
      const taken = await tx.account.findUnique({
        where: {
          provider_id_gitlab_instance_id_username: {
            provider_id: 'github',
            gitlab_instance_id: '',
            username: s.login,
          },
        },
        select: { id: true },
      });
      if (!taken) accountData.username = s.login;
    }
    await tx.account.update({ where: { id: byProvider.id }, data: accountData });
    return tx.user.update({
      where: { id: byProvider.user_id },
      data: { name: s.name, image: s.avatarUrl ?? null },
    });
  }

  // 2) GitHub login already used by a different account row → reuse it.
  if (s.login) {
    const byLogin = await tx.account.findFirst({
      where: { provider_id: 'github', username: { equals: s.login, mode: 'insensitive' } },
      select: { id: true, account_id: true, user: true },
    });
    if (byLogin) {
      const mayUpdate = await mayUpdateImportedPerson(tx, byLogin.user.id, ownerUserId);
      if (!mayUpdate && !(await isClassroomMember(tx, byLogin.user.id, classroomId))) {
        return null;
      }
      // A placeholder account known only by username takes the real id now,
      // when it is one the import may update. Otherwise it stays a placeholder,
      // which the person's own Github sign-in claims by username.
      if (byLogin.account_id.startsWith('unresolved:')) {
        if (mayUpdate) {
          await tx.account.update({
            where: { id: byLogin.id },
            data: { account_id: s.providerId, image: s.avatarUrl ?? null },
          });
        }
      } else {
        warnings.push(`Reused existing account for @${s.login} (GitHub login already in use).`);
      }
      return byLogin.user;
    }
  }

  // 3) Brand-new user — neither the GitHub id nor the login exists yet.
  return tx.user.create({
    data: {
      name: s.name,
      image: s.avatarUrl ?? null,
      accounts: {
        create: {
          provider_id: 'github',
          account_id: s.providerId,
          username: s.login || null,
          image: s.avatarUrl ?? null,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Import several selected classrooms; each is independent.
// ---------------------------------------------------------------------------

/**
 * `options.organizations` says which organizations the importer administers
 * (see `ImportOptions`); without it no new classroom is created. Each classroom
 * is imported or refused on its own.
 */
export async function importGithubClassrooms(
  ownerUserId: string,
  inputs: ImportClassroomInput[],
  options: ImportOptions = {}
): Promise<{ results: ImportSummary[]; errors: { classroomName: string; message: string }[] }> {
  const results: ImportSummary[] = [];
  const errors: { classroomName: string; message: string }[] = [];

  for (const input of inputs) {
    try {
      results.push(await importGithubClassroom(ownerUserId, input, options));
    } catch (err: unknown) {
      errors.push({
        classroomName: input.classroom?.name ?? input.slug,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { results, errors };
}
