import getPrisma from '@classmoji/database';
import { gitTerms, resolveTemplateRef, titleToIdentifier } from '@classmoji/utils';
import type { RepositoryType, Prisma } from '@classmoji/database/client';
import { getGitProvider } from '../git/index.ts';
import * as notificationService from './notification.service.ts';
import {
  NO_SERVICE_AUDIT,
  recordForActor,
  type AuditActor,
  type ServiceAudit,
} from './audit.service.ts';

interface RepositoryQueryOptions {
  includeAssignments?: boolean;
  includePages?: boolean;
  includeSlides?: boolean;
  includeQuizzes?: boolean;
}

type RepositoryCreateInput = Prisma.RepositoryUncheckedCreateInput;

type RepositoryUpdateValues = {
  id: string;
  tag?: string | null;
  team_formation_deadline?: Date | string | null;
  type?: RepositoryType;
  [key: string]: unknown;
};

/**
 * Find a Repository by ID
 * @param {string} id - UUID of the Repository
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().repository.findUnique({
    where: { id },
    include: {
      assignments: true,
      classroom: true,
      tag: true,
    },
  });
};

/**
 * Find a Repository of one classroom by id.
 *
 * Returns null — without querying — when either id is not a non-empty string;
 * see `assertScopedIds` below for why an unchecked value cannot stand in the
 * `where`. Unlike `findById` it does not include the classroom row.
 *
 * @param {unknown} id - UUID of the Repository (may come from a request)
 * @param {string} classroomId - UUID of the authorized Classroom
 */
export const findByIdInClassroom = async (id: unknown, classroomId: string) => {
  if (typeof id !== 'string' || !id) return null;
  if (typeof classroomId !== 'string' || !classroomId) return null;

  return getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    include: {
      assignments: true,
      tag: true,
    },
  });
};

/**
 * Find a Repository by classroom and title
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} title - Repository title
 * @returns {Promise<Object|null>}
 */
export const findByClassroomAndTitle = async (classroomId: string, title: string) => {
  return getPrisma().repository.findUnique({
    where: {
      classroom_id_title: {
        classroom_id: classroomId,
        title,
      },
    },
    include: {
      assignments: true,
      tag: true,
    },
  });
};

/**
 * Find a Repository by classroom slug and title
 * @param {string} classroomSlug - Classroom slug
 * @param {string} title - Repository title
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object|null>}
 */
export const findBySlugAndTitle = async (
  classroomSlug: string,
  title: string,
  options: RepositoryQueryOptions = {}
) => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return null;

  return getPrisma().repository.findUnique({
    where: {
      classroom_id_title: {
        classroom_id: classroom.id,
        title,
      },
    },
    include: {
      assignments:
        options.includeAssignments !== false
          ? {
              include: {
                pages: options.includePages === true ? { include: { page: true } } : false,
                slides: options.includeSlides === true ? { include: { slide: true } } : false,
              },
            }
          : false,
      tag: true,
      quizzes: options.includeQuizzes === true,
      pages: options.includePages === true ? { include: { page: true } } : false,
      slides: options.includeSlides === true ? { include: { slide: true } } : false,
    },
  });
};

/**
 * Find a Repository by classroom slug and repository slug
 * @param {string} classroomSlug - Classroom slug
 * @param {string} repositorySlug - Repository slug
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object|null>}
 */
export const findByClassroomSlugAndModuleSlug = async (
  classroomSlug: string,
  repositorySlug: string,
  options: RepositoryQueryOptions = {}
) => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return null;

  return getPrisma().repository.findFirst({
    where: {
      classroom_id: classroom.id,
      slug: repositorySlug,
    },
    include: {
      assignments:
        options.includeAssignments !== false
          ? {
              include: {
                pages: options.includePages === true ? { include: { page: true } } : false,
                slides: options.includeSlides === true ? { include: { slide: true } } : false,
              },
            }
          : false,
      tag: true,
      quizzes: options.includeQuizzes === true,
      pages: options.includePages === true ? { include: { page: true } } : false,
      slides: options.includeSlides === true ? { include: { slide: true } } : false,
    },
  });
};

/**
 * Find all Modules for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().repository.findMany({
    where: { classroom_id: classroomId },
    include: {
      assignments: true,
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * Find all Modules for a classroom by slug
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<Object[]>}
 */
export const findByClassroomSlug = async (
  classroomSlug: string,
  _options?: { includeAssignments?: boolean }
) => {
  return getPrisma().repository.findMany({
    where: {
      classroom: { slug: classroomSlug },
    },
    include: {
      assignments: true,
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * Find published Modules for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findPublished = async (classroomId: string) => {
  return getPrisma().repository.findMany({
    where: {
      classroom_id: classroomId,
      is_published: true,
    },
    include: {
      assignments: {
        where: { is_published: true },
      },
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * Create a Repository with assignments
 * @param {Object} data - Repository data
 * @param {string} data.classroom_id - UUID of the Classroom
 * @param {string} data.title - Repository title
 * @param {string} data.template - Template repo name
 * @param {string} data.type - INDIVIDUAL or GROUP
 * @param {string} [data.tag_id] - Tag UUID
 * @param actor - who the create is recorded for: REPOSITORIES / CREATE on the
 *   new repository, with its `title` and `type` (`null`: no row)
 */
export const create = async (data: RepositoryCreateInput, actor: AuditActor | null) => {
  // Generate slug from title (set once, never updated)
  const slug = titleToIdentifier(data.title);

  const repository = await getPrisma().repository.create({
    data: { ...data, slug },
    include: { assignments: true, tag: true },
  });
  const audit = await recordForActor(actor, {
    classroomId: repository.classroom_id,
    resourceType: 'REPOSITORIES',
    resourceId: repository.id,
    action: 'CREATE',
    data: { title: repository.title, type: repository.type },
  });
  return { repository, audit };
};

/**
 * The columns of a repository an edit's audit row compares: the form's
 * columns, the MCP's patch fields and the tag. `description` is owner text:
 * the row names it and gives its length, never its value.
 */
const RECORDED_REPOSITORY_FIELDS = [
  'title',
  'type',
  'template',
  'description',
  'tag_id',
  'team_formation_mode',
  'team_formation_deadline',
  'max_team_size',
  'project_template_id',
  'project_template_title',
] as const;

const recordedValue = (value: unknown): string | number | boolean | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;

/**
 * An edit's audit `data`, or null when no recorded column changed: `fields`
 * (the changed columns), `values` / `previous` (their new and old values,
 * dates as ISO strings, the description left out) and `value` (a digest of
 * `values`, as repo_update wrote it); `description_length` when the
 * description changed.
 */
const repositoryChange = (
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, unknown> | null => {
  const fields = RECORDED_REPOSITORY_FIELDS.filter(
    field => recordedValue(before[field]) !== recordedValue(after[field])
  );
  if (fields.length === 0) return null;
  const values: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === 'description') continue;
    values[field] = recordedValue(after[field]);
    previous[field] = recordedValue(before[field]);
  }
  const description = after.description;
  return {
    fields,
    values,
    previous,
    value: JSON.stringify(values),
    ...(fields.includes('description')
      ? { description_length: typeof description === 'string' ? description.length : null }
      : {}),
  };
};

/** The recorded columns of a repository, for `repositoryChange`. */
const RECORDED_SELECT = Object.fromEntries(
  RECORDED_REPOSITORY_FIELDS.map(field => [field, true])
) as Record<(typeof RECORDED_REPOSITORY_FIELDS)[number], true>;

/**
 * Write a repository edit in one transaction that locks the row and reads the
 * values it replaces first, so the audit row compares against exactly what
 * this write replaced. Answers the row as it is after the write.
 */
const updateRecorded = async (
  id: string,
  classroomId: string,
  data: Prisma.RepositoryUncheckedUpdateManyInput,
  actor: AuditActor | null
) => {
  const { before, after } = await getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM repositories WHERE id = ${id} AND classroom_id = ${classroomId} FOR UPDATE`;
    const before = await tx.repository.findFirst({
      where: { id, classroom_id: classroomId },
      select: RECORDED_SELECT,
    });
    const { count } = await tx.repository.updateMany({
      where: { id, classroom_id: classroomId },
      data,
    });
    if (count !== 1) throw new Error('Repository not found in classroom');
    const after = await tx.repository.findFirst({
      where: { id, classroom_id: classroomId },
      select: RECORDED_SELECT,
    });
    return { before, after };
  });
  const change = before && after ? repositoryChange(before, after) : null;
  const audit = change
    ? await recordForActor(actor, {
        classroomId,
        resourceType: 'REPOSITORIES',
        resourceId: id,
        action: 'UPDATE',
        data: change,
      })
    : NO_SERVICE_AUDIT;
  // Read after the commit, as before: a delete landing in between answers null.
  const repository = await getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    include: { assignments: true, tag: true },
  });
  return { repository, audit };
};

/**
 * Reject ids that cannot safely stand in a scoped `where` clause.
 *
 * The scoped writes below pair the repository id with `classroom_id` so the
 * write itself can only touch the authorized classroom, but that pairing only
 * holds while both values are real strings. Prisma drops an `undefined` value
 * from a `where` instead of rejecting it, and these id fields also accept a
 * `StringFilter` object — so `undefined` or `{ not: '' }` would leave a
 * `deleteMany`/`updateMany` matching EVERY row in the classroom. Ids reach these
 * functions from untyped request bodies, so the check has to be a runtime one.
 */
const assertScopedIds = (id: unknown, classroomId: unknown): void => {
  if (typeof id !== 'string' || !id) throw new Error('Invalid repository id');
  if (typeof classroomId !== 'string' || !classroomId) throw new Error('Invalid classroom id');
};

/** Columns `update` never writes, whatever the caller passes. */
const IMMUTABLE_REPOSITORY_FIELDS = ['id', 'classroom_id', 'slug', 'title'] as const;

/**
 * Update a Repository.
 *
 * `classroomId` is REQUIRED and scopes the write — see `deleteById` below.
 *
 * Recorded for `actor` when a column changed: REPOSITORIES / UPDATE with the
 * changed `fields`, their `values` and `previous` values (the description by
 * name and `description_length`), and `value`, a digest of `values`. A write
 * that changes nothing, or `actor: null`: no row.
 *
 * @param {string} id - UUID of the Repository
 * @param {Object} updates - Fields to update
 * @param {string} classroomId - UUID of the authorized Classroom
 */
export const update = async (
  id: string,
  // Unchecked so the tag_id FK scalar is writable.
  updates: Omit<
    Prisma.RepositoryUncheckedUpdateManyInput,
    (typeof IMMUTABLE_REPOSITORY_FIELDS)[number]
  >,
  classroomId: string,
  actor: AuditActor | null
) => {
  assertScopedIds(id, classroomId);

  // Stripped at RUNTIME as well as by the type: a JS caller or a cast would
  // otherwise move the row to another classroom or rename it (the slug and the
  // title are what provisioned git repo names derive from).
  const data: Record<string, unknown> = { ...updates };
  for (const field of IMMUTABLE_REPOSITORY_FIELDS) delete data[field];

  return updateRecorded(id, classroomId, data as Prisma.RepositoryUncheckedUpdateManyInput, actor);
};

/**
 * The Repository columns the repository form (admin.$class.repos_.form) edits,
 * and so the only ones `createFromFormData` / `updateFromForm` will write. They
 * are exactly the form schema's fields (schema.ts) minus the ones the route
 * handles itself: `id` (the target), `tag` (becomes tag_id, checked against the
 * classroom) and `organization` (display only). Anything else in a submitted
 * body — classroom_id, slug, is_published, … — is ignored.
 *
 * `title` is editable in the form and stays editable; `slug` is set once on
 * create and never follows it.
 */
export const REPOSITORY_FORM_FIELDS = [
  'title',
  'type',
  'template',
  'description',
  'team_formation_mode',
  'team_formation_deadline',
  'max_team_size',
  'project_template_id',
  'project_template_title',
] as const;

/**
 * The form-owned columns of a submitted form body, ready for Prisma: absent
 * fields are left out, and the team formation deadline (sent as an ISO string)
 * becomes a Date.
 */
export const pickRepositoryFormFields = (
  values: Record<string, unknown>
): Record<string, unknown> => {
  const data: Record<string, unknown> = {};
  for (const field of REPOSITORY_FORM_FIELDS) {
    if (values[field] !== undefined) data[field] = values[field];
  }
  const deadline = data.team_formation_deadline;
  if (deadline && !(deadline instanceof Date)) {
    data.team_formation_deadline = new Date(deadline as string);
  }
  return data;
};

/**
 * Create-data for a Repository from a repository-form body: the form-owned
 * columns only, in the given classroom, with the given tag. The caller has
 * already checked that the tag belongs to that classroom.
 */
export const createFromFormData = (
  values: Record<string, unknown>,
  classroomId: string,
  tagId: string | null
): RepositoryCreateInput =>
  ({
    ...pickRepositoryFormFields(values),
    classroom_id: classroomId,
    tag_id: tagId,
  }) as RepositoryCreateInput;

/**
 * Update a Repository from the repository form. Assignments are managed on
 * the module page, not here.
 *
 * Scoped to `classroomId` like `update`: the write is an `updateMany` on
 * (id, classroom_id), so a repository of another classroom is never touched —
 * a count other than 1 throws 'Repository not found in classroom'. Only the
 * form-owned columns (REPOSITORY_FORM_FIELDS) are written. As before, the tag
 * is applied only to a GROUP repository, and only when one is given; it must
 * be a tag of this classroom ('Tag not found in classroom' otherwise).
 *
 * Recorded for `actor` as `update` records an edit (only when a column
 * changed).
 *
 * @param {Object} values - The form body: id, the form fields, and tag
 * @param {string} classroomId - UUID of the authorized Classroom
 */
export const updateFromForm = async (
  values: RepositoryUpdateValues,
  classroomId: string,
  actor: AuditActor | null
) => {
  const { id, tag } = values;
  assertScopedIds(id, classroomId);

  const applyTag = values.type === 'GROUP' && Boolean(tag);
  if (applyTag) {
    const owned = await getPrisma().tag.findFirst({
      where: { id: String(tag), classroom_id: classroomId },
      select: { id: true },
    });
    if (!owned) throw new Error('Tag not found in classroom');
  }

  const data = {
    ...pickRepositoryFormFields(values),
    ...(applyTag ? { tag_id: String(tag) } : {}),
  } as Prisma.RepositoryUncheckedUpdateManyInput;

  return updateRecorded(id, classroomId, data, actor);
};

/**
 * Delete a Repository.
 *
 * `classroomId` is REQUIRED and is part of the write itself rather than a check
 * performed beforehand: `delete({ where: { id } })` would destroy any repository
 * whose id a caller can name, in any classroom. `deleteMany` accepts the
 * non-unique compound.
 *
 * `assertScopedIds` runs FIRST because the compound only narrows the write while
 * both halves are real strings — see its docblock. Past that guard `id` is the
 * primary key, so the compound matches at most one row: a count other than 1
 * means zero rows matched, the id did not belong to the authorized classroom,
 * and nothing was written — which throws rather than passing as a silent no-op.
 *
 * @param {string} id - UUID of the Repository
 * @param {string} classroomId - UUID of the authorized Classroom
 * @returns {Promise<Object>}
 */
export const deleteById = async (id: string, classroomId: string) => {
  assertScopedIds(id, classroomId);

  const { count } = await getPrisma().repository.deleteMany({
    where: { id, classroom_id: classroomId },
  });
  if (count !== 1) throw new Error('Repository not found in classroom');
  return { id };
};

/**
 * Delete a Repository ONLY if it is still unpublished and nothing has been
 * provisioned from it — the conditions are part of the DELETE itself, so a
 * publish or a provisioned GitRepo landing between a caller's checks and this
 * write cannot slip through. Scoped exactly like `deleteById`.
 *
 * Never throws for a refused delete; it reports why, re-reading the row only
 * when nothing was deleted:
 *   - `deleted`     — the row is gone (and its cascade with it);
 *   - `not_found`   — no such repository in this classroom (any more);
 *   - `published`   — it is published;
 *   - `provisioned` — student/team git repos exist (`gitRepos` of them).
 *
 * A delete is recorded for `actor` after the commit, as repo_delete recorded
 * it: REPOSITORIES / DELETE with the `title`, `slug`, the
 * `assignments_deleted` (id and title) and the counts of what the cascade
 * took, read under a lock on the row in the delete's own transaction. A
 * refused delete, or `actor: null`: no row.
 */
export const deleteIfUnprovisioned = async (
  id: string,
  classroomId: string,
  actor: AuditActor | null
): Promise<
  (
    | { status: 'deleted' | 'not_found' | 'published' }
    | { status: 'provisioned'; gitRepos: number }
  ) & { audit: ServiceAudit }
> => {
  assertScopedIds(id, classroomId);

  const { count, doomed } = await getPrisma().$transaction(async tx => {
    // The row lock waits for a publish or a provisioned GitRepo (which takes a
    // key-share lock on the row) in flight, so what is read here is what the
    // delete takes.
    await tx.$queryRaw`SELECT id FROM repositories WHERE id = ${id} AND classroom_id = ${classroomId} FOR UPDATE`;
    const doomed = await tx.repository.findFirst({
      where: { id, classroom_id: classroomId },
      select: {
        title: true,
        slug: true,
        assignments: {
          select: {
            id: true,
            title: true,
            _count: { select: { pages: true, slides: true, calendarEventLinks: true } },
          },
          orderBy: { title: 'asc' },
        },
        _count: {
          select: {
            module_items: true,
            pages: true,
            slides: true,
            quizzes: true,
            autograding_tests: true,
          },
        },
      },
    });
    const { count } = await tx.repository.deleteMany({
      where: { id, classroom_id: classroomId, is_published: false, git_repos: { none: {} } },
    });
    return { count, doomed };
  });
  if (count === 1) {
    const sumOver = (key: 'pages' | 'slides' | 'calendarEventLinks') =>
      (doomed?.assignments ?? []).reduce((total, a) => total + a._count[key], 0);
    const audit = await recordForActor(actor, {
      classroomId,
      resourceType: 'REPOSITORIES',
      resourceId: id,
      action: 'DELETE',
      data: {
        title: doomed?.title ?? null,
        slug: doomed?.slug ?? null,
        assignments_deleted: (doomed?.assignments ?? []).map(a => ({ id: a.id, title: a.title })),
        module_items_removed: doomed?._count.module_items ?? 0,
        page_links_removed: doomed?._count.pages ?? 0,
        slide_links_removed: doomed?._count.slides ?? 0,
        assignment_page_links_removed: sumOver('pages'),
        assignment_slide_links_removed: sumOver('slides'),
        calendar_event_links_removed: sumOver('calendarEventLinks'),
        autograding_tests_deleted: doomed?._count.autograding_tests ?? 0,
        quizzes_unlinked: doomed?._count.quizzes ?? 0,
      },
    });
    return { status: 'deleted', audit };
  }

  const row = await getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    select: { is_published: true, _count: { select: { git_repos: true } } },
  });
  if (!row) return { status: 'not_found', audit: NO_SERVICE_AUDIT };
  if (row.is_published) return { status: 'published', audit: NO_SERVICE_AUDIT };
  return { status: 'provisioned', gitRepos: row._count.git_repos, audit: NO_SERVICE_AUDIT };
};

/**
 * Publish or unpublish a Repository.
 *
 * `classroomId` is REQUIRED and scopes the write — see `deleteById` above.
 *
 * @param {string} id - UUID of the Repository
 * @param {boolean} isPublished - Whether to publish
 * @param {string} classroomId - UUID of the authorized Classroom
 * @returns {Promise<Object>}
 */
/**
 * Whether the classroom has a published repository that no published
 * assignment submits through: one handed out as it is. Its copies appear on no
 * Assignments row, so the student Repositories page is the only place that
 * lists them, and the student nav shows that entry only when this is true.
 */
export const hasStandalonePublished = async (classroomId: string) =>
  (await getPrisma().repository.count({
    where: {
      classroom_id: classroomId,
      is_published: true,
      assignments: { none: { is_published: true } },
    },
  })) > 0;

export const setPublished = async (id: string, isPublished: boolean, classroomId: string) => {
  // Before the read as well as the write: an unusable id would make the lookup
  // below return an arbitrary repository in the classroom, and the notification
  // would then be decided by one row while another was flipped.
  assertScopedIds(id, classroomId);

  const previous = await getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    select: { is_published: true },
  });

  const { count } = await getPrisma().repository.updateMany({
    where: { id, classroom_id: classroomId },
    data: { is_published: isPublished },
  });
  if (count !== 1) throw new Error('Repository not found in classroom');

  // `updateMany` returns a count, not the row, and the notification below needs
  // the record. The scoped write above has already proven it exists.
  const mod = await getPrisma().repository.findUniqueOrThrow({
    where: { id },
  });

  if (previous && previous.is_published !== isPublished) {
    await notificationService.runSafely('repository publish notification', async () => {
      const studentIds = await notificationService.getStudentsInClassroom(mod.classroom_id);
      // "Project" on Gitlab, "Repository" on Github (also the email subject).
      const org = await getPrisma().gitOrganization.findFirst({
        where: { classrooms: { some: { id: mod.classroom_id } } },
        select: { provider: true },
      });
      const { Repo } = gitTerms(org?.provider === 'GITLAB');
      // Where the notice leads: the assignment submitted through this
      // repository (a published one first), on the student's Assignments
      // page. A repository handed out without an assignment has none, and the
      // notice leads to their repositories instead.
      const assignment = isPublished
        ? await getPrisma().assignment.findFirst({
            where: { repository_id: mod.id },
            orderBy: [{ is_published: 'desc' }, { created_at: 'asc' }],
            select: { id: true },
          })
        : null;
      await notificationService.createNotifications({
        type: isPublished ? 'REPOSITORY_PUBLISHED' : 'REPOSITORY_UNPUBLISHED',
        classroomId: mod.classroom_id,
        recipientUserIds: studentIds,
        resourceType: 'repository',
        resourceId: mod.id,
        ...(assignment ? { metadata: { assignment_id: assignment.id } } : {}),
        title: isPublished
          ? `${Repo} published: ${mod.title}`
          : `${Repo} unpublished: ${mod.title}`,
      });
    });
  }

  return mod;
};

/**
 * Get Repositories with gitRepo status for a student
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} studentId - UUID of the student
 * @returns {Promise<Object[]>}
 */
export const findWithStudentStatus = async (classroomId: string, studentId: string) => {
  return getPrisma().repository.findMany({
    where: {
      classroom_id: classroomId,
      is_published: true,
    },
    include: {
      assignments: {
        where: { is_published: true },
      },
      git_repos: {
        where: { student_id: studentId },
        include: {
          assignments: {
            include: {
              grades: true,
            },
          },
        },
      },
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * What hangs off a repository, read inside the authorized classroom: its
 * assignments (id + title) and counts of every dependent row. Returns null when
 * the id is not a repository of `classroomId`.
 *
 * `git_repos` > 0 means student/team copies were provisioned from it, which is
 * what freezes its structural fields and blocks a delete. The other counts are
 * the blast radius of a delete: assignments, module items, page/slide links and
 * autograding tests cascade with the repository; quizzes are unlinked (SET NULL).
 * Each assignment carries its own link counts (page/slide links and calendar
 * event links), which cascade with the assignment. A link row targets a
 * repository OR an assignment, never both (resourceLink.service), so the
 * repository-level and assignment-level counts do not overlap.
 *
 * `classroomId` is REQUIRED and part of the query — see `deleteById`.
 */
export const findDependents = async (id: string, classroomId: string) => {
  assertScopedIds(id, classroomId);

  return getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    select: {
      id: true,
      assignments: {
        select: {
          id: true,
          title: true,
          _count: { select: { pages: true, slides: true, calendarEventLinks: true } },
        },
        orderBy: { title: 'asc' },
      },
      _count: {
        select: {
          git_repos: true,
          module_items: true,
          pages: true,
          slides: true,
          quizzes: true,
          autograding_tests: true,
        },
      },
    },
  });
};

/** Prove a repository belongs to the classroom, or throw. */
export const assertInClassroom = async (repositoryId: string, classroomId: string) => {
  assertScopedIds(repositoryId, classroomId);
  const repository = await getPrisma().repository.findFirst({
    where: { id: repositoryId, classroom_id: classroomId },
    select: { id: true },
  });
  if (!repository) throw new Error('Repository not found in classroom');
  return repository;
};

export type TemplateCheck =
  | { ok: true }
  | { ok: false; reason: 'TEMPLATE_EMPTY' | 'TEMPLATE_UNREACHABLE'; error: string };

/**
 * Whether a repository's template can be used to provision student copies,
 * checked when the instructor publishes (or picks a template) rather than once
 * per student later, in background runs nobody watches.
 *
 * Refused: no template at all (provisioning cannot name a repository to clone),
 * and, on Github, a template the classroom's app installation cannot see (404:
 * deleted, renamed away, or private to an account the app cannot read). One
 * `GET /repos` with the installation token, through `repositoryExists`.
 *
 * A template that exists but has no commits is fine: provisioning seeds it from
 * the shared empty template. Gitlab has no repository read yet (and no template
 * provisioning), so only the empty case is checked there. Any other failure
 * (rate limit, outage, a missing installation) is logged and lets the publish
 * through: this check catches a bad template, it does not make publishing
 * depend on Github being up.
 */
export const checkTemplate = async (
  template: string | null | undefined,
  classroomId: string
): Promise<TemplateCheck> => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: {
      git_organization: {
        select: {
          provider: true,
          login: true,
          github_installation_id: true,
          access_token: true,
          base_url: true,
        },
      },
    },
  });
  const gitOrg = classroom?.git_organization ?? null;

  // Same resolution provisioning uses: a bare name lives in the classroom org.
  const ref = resolveTemplateRef(template, gitOrg?.login);
  if (!ref) {
    return {
      ok: false,
      reason: 'TEMPLATE_EMPTY',
      error: 'This repository has no template repository. Choose one before publishing.',
    };
  }

  if (!gitOrg || gitOrg.provider !== 'GITHUB') return { ok: true };

  let exists: boolean;
  try {
    exists = await getGitProvider(gitOrg).repositoryExists(ref.owner, ref.repo);
  } catch (error: unknown) {
    console.warn(`[repository] could not check template ${ref.owner}/${ref.repo}:`, error);
    return { ok: true };
  }
  if (exists) return { ok: true };

  return {
    ok: false,
    reason: 'TEMPLATE_UNREACHABLE',
    error:
      `The template repository ${ref.owner}/${ref.repo} can't be found on Github. ` +
      "It may have been deleted or renamed, or the Classmoji Github app can't access it. " +
      'Choose another template repository.',
  };
};
