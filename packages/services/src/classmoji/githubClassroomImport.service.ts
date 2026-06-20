/**
 * Import a GitHub Classroom export into a new Classmoji classroom.
 *
 * The teacher exports their GitHub Classroom data locally (via the official
 * classroom-export-utility), zips it, and uploads it. The webapp parses the
 * bundle client-side (apps/webapp/.../_user.import-classroom/utils.ts) and hands
 * us the normalized structure below. This service does the DB mapping.
 *
 * GitHub-free by design — it makes ZERO GitHub API calls. It mirrors
 * `exampleClassroom.service.ts`: the classroom lives under a GitOrganization
 * whose `github_installation_id` may be NULL, and every GitHub-touching view
 * already short-circuits on that null. Installing the Classmoji app later is a
 * just-in-time, non-blocking upsell that lights those views up — no re-import.
 *
 * Grades are NOT pushed into the native emoji/issue pipeline (the export has no
 * GitHub issue ids, and fabricating them would duplicate on a later real sync).
 * Instead each student's scores plus other export info (commit count,
 * submitted/passing, original repo URL) are stored as read-only `GitRepo.metadata`
 * on their imported repo — for viewing only, never feeding live grading.
 *
 * Every write is an upsert on a natural key, so re-importing the same bundle is
 * idempotent (updates in place, never duplicates).
 */

import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';

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
  warnings: string[];
}

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

export async function importGithubClassroom(
  ownerUserId: string,
  input: ImportClassroomInput
): Promise<ImportSummary> {
  const prisma = getPrisma();
  const { classroom: gh, slug } = input;
  const warnings: string[] = [];

  // Org upsert lives OUTSIDE the transaction. github_installation_id is left
  // untouched: NULL on first import (GitHub-free), preserved if the teacher
  // already installed the app for another classroom in this org.
  const org = await prisma.gitOrganization.upsert({
    where: {
      provider_provider_id: { provider: 'GITHUB', provider_id: String(gh.organization.id) },
    },
    create: {
      provider: 'GITHUB',
      provider_id: String(gh.organization.id),
      login: gh.organization.login,
    },
    update: { login: gh.organization.login },
  });

  // Index imported scores by (github_username, assignment) so each student's repo
  // can pick up its own grade for its own assignment.
  const gradeByUserAssignment = new Map<string, ImportGradeRow>();
  const gradedLogins = new Set<string>();
  for (const row of gh.grades ?? []) {
    const login = row.githubUsername.toLowerCase();
    gradedLogins.add(login);
    gradeByUserAssignment.set(`${login}::${row.assignmentTitle}`, row);
  }

  const summary: ImportSummary = {
    classroomId: '',
    classroomSlug: slug,
    classroomName: gh.name,
    organizationLogin: gh.organization.login,
    appInstalled: Boolean(org.github_installation_id),
    repositoriesImported: 0,
    assignmentsImported: 0,
    studentsEnrolled: 0,
    reposLinked: 0,
    gradesRecorded: 0,
    teamsImported: 0,
    teamMembershipsImported: 0,
    groupReposLinked: 0,
    warnings,
  };

  // All DB writes in one interactive transaction: all-or-nothing per classroom.
  // Timeout is raised because large rosters mean many sequential upserts.
  await prisma.$transaction(
    async tx => {
      const classroom = await tx.classroom.upsert({
        where: { git_org_id_slug: { git_org_id: org.id, slug } },
        create: {
          git_org_id: org.id,
          slug,
          name: gh.name,
          content_namespace: slug,
          settings: { create: { show_grades_to_students: true, quizzes_enabled: true } },
        },
        update: { name: gh.name },
        include: { settings: true },
      });
      summary.classroomId = classroom.id;

      // A re-import onto an existing classroom may predate settings; ensure they exist.
      if (!classroom.settings) {
        await tx.classroomSettings.create({
          data: {
            classroom_id: classroom.id,
            show_grades_to_students: true,
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
            is_published: false,
            // Imported assignments start unweighted; the teacher sets grading
            // weights when they configure the gradebook.
            weight: 0,
          },
          // Don't clobber teacher edits on re-import.
          update: {},
        });
        repoIdByAssignment.set(a.githubId, repository.id);
        summary.repositoriesImported += 1;

        await tx.assignment.upsert({
          where: { repository_id_title: { repository_id: repository.id, title: a.title } },
          create: {
            repository_id: repository.id,
            title: a.title,
            slug: a.slug || null,
            student_deadline: a.deadline ? new Date(a.deadline) : null,
            is_published: false,
          },
          update: {},
        });
        summary.assignmentsImported += 1;
      }

      // Enroll students (deduped across assignments) and link their repos.
      const userIdByProvider = new Map<string, string>();
      const enrolledLogins = new Set<string>();
      // Group state, deduped across assignments (a team is reused for every
      // assignment it did; its slug is recovered from the repo name).
      const teamIdBySlug = new Map<string, string>();
      const seenTeamMembers = new Set<string>();

      for (const a of gh.assignments) {
        const repositoryId = repoIdByAssignment.get(a.githubId)!;

        for (const acc of a.acceptances) {
          for (const s of acc.students) {
            let userId = userIdByProvider.get(s.providerId);

            if (!userId) {
              const user = await resolveImportedUser(tx, s, warnings);
              userId = user.id;
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
          }

          // Link the student's repo (individual) and stash the imported GitHub
          // Classroom data on it as read-only metadata.
          if (acc.type === 'individual' && acc.repo && acc.students.length === 1) {
            const student = acc.students[0];
            const studentId = userIdByProvider.get(student.providerId)!;
            const grade =
              gradeByUserAssignment.get(`${student.login.toLowerCase()}::${a.title}`) ?? null;
            const metadata = buildImportedMetadata(acc, grade);
            if (grade) summary.gradesRecorded += 1;

            await tx.gitRepo.upsert({
              where: {
                provider_provider_id: { provider: 'GITHUB', provider_id: acc.repo.providerId },
              },
              create: {
                provider: 'GITHUB',
                provider_id: acc.repo.providerId,
                name: acc.repo.name,
                classroom_id: classroom.id,
                repository_id: repositoryId,
                student_id: studentId,
                metadata: metadata ?? undefined,
              },
              update: {
                name: acc.repo.name,
                classroom_id: classroom.id,
                repository_id: repositoryId,
                student_id: studentId,
                metadata: metadata ?? undefined,
              },
            });
            summary.reposLinked += 1;
          } else if (acc.type === 'group' && acc.students.length > 0) {
            // Recover the team (deduped across assignments), enroll its members
            // into the team, and link the team's shared repo.
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

            for (const s of acc.students) {
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
              // All members of a group share one grade; use the first member that
              // actually has a grade row.
              let grade: ImportGradeRow | null = null;
              for (const s of acc.students) {
                const g = gradeByUserAssignment.get(`${s.login.toLowerCase()}::${a.title}`);
                if (g) {
                  grade = g;
                  break;
                }
              }
              const metadata = buildImportedMetadata(acc, grade);
              if (grade) summary.gradesRecorded += 1;

              await tx.gitRepo.upsert({
                where: {
                  provider_provider_id: { provider: 'GITHUB', provider_id: acc.repo.providerId },
                },
                create: {
                  provider: 'GITHUB',
                  provider_id: acc.repo.providerId,
                  name: acc.repo.name,
                  classroom_id: classroom.id,
                  repository_id: repositoryId,
                  team_id: teamId,
                  student_id: null,
                  metadata: metadata ?? undefined,
                },
                update: {
                  name: acc.repo.name,
                  classroom_id: classroom.id,
                  repository_id: repositoryId,
                  team_id: teamId,
                  student_id: null,
                  metadata: metadata ?? undefined,
                },
              });
              summary.groupReposLinked += 1;
            }
          }
        }
      }

      // Warn about graded students who never accepted (no repo to attach to).
      for (const login of gradedLogins) {
        if (!enrolledLogins.has(login)) {
          warnings.push(`Grades for "${login}" were skipped (not enrolled in this classroom).`);
        }
      }
    },
    { timeout: 120_000 }
  );

  return summary;
}

/**
 * Resolve (find or create) a student User by GitHub identity WITHOUT ever issuing
 * a write that could violate a unique constraint.
 *
 * This runs inside an interactive transaction, where a single failed statement
 * aborts the WHOLE transaction (Postgres 25P02) and rolls back the import — so we
 * can't "try the write and recover." Instead: look up by GitHub user id, then by
 * `login` (handling GitHub-login reuse), and only `create` when neither exists.
 * The one mutable unique field, `login`, is only changed when the target is free.
 * Never writes `email` (unique and absent from the export).
 */
async function resolveImportedUser(
  tx: Parameters<Parameters<ReturnType<typeof getPrisma>['$transaction']>[0]>[0],
  s: ImportStudent,
  warnings: string[]
) {
  // 1) Canonical match: the GitHub user id.
  const byProvider = await tx.user.findUnique({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: s.providerId } },
  });
  if (byProvider) {
    const data: { name: string | null; image: string | null; login?: string } = {
      name: s.name,
      image: s.avatarUrl ?? null,
    };
    // Only update `login` when the new value is free, so we never trip the unique
    // `login` constraint mid-transaction.
    if (s.login && s.login !== byProvider.login) {
      const taken = await tx.user.findUnique({ where: { login: s.login }, select: { id: true } });
      if (!taken) data.login = s.login;
    }
    return tx.user.update({ where: { id: byProvider.id }, data });
  }

  // 2) GitHub login already used by a different account row → reuse it.
  if (s.login) {
    const byLogin = await tx.user.findUnique({ where: { login: s.login } });
    if (byLogin) {
      warnings.push(`Reused existing account for @${s.login} (GitHub login already in use).`);
      return byLogin;
    }
  }

  // 3) Brand-new user — neither the GitHub id nor the login exists yet.
  return tx.user.create({
    data: {
      provider: 'GITHUB',
      provider_id: s.providerId,
      login: s.login || null,
      name: s.name,
      image: s.avatarUrl ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Import several selected classrooms; each is independent.
// ---------------------------------------------------------------------------

export async function importGithubClassrooms(
  ownerUserId: string,
  inputs: ImportClassroomInput[]
): Promise<{ results: ImportSummary[]; errors: { classroomName: string; message: string }[] }> {
  const results: ImportSummary[] = [];
  const errors: { classroomName: string; message: string }[] = [];

  for (const input of inputs) {
    try {
      results.push(await importGithubClassroom(ownerUserId, input));
    } catch (err: unknown) {
      errors.push({
        classroomName: input.classroom?.name ?? input.slug,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { results, errors };
}
