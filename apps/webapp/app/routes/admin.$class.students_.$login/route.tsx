import { Button, Input, Select, Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { IconChevronLeft } from '@tabler/icons-react';
import { Link, useFetcher, useLocation, useNavigate } from 'react-router';
import { useEffect, useMemo, useState } from 'react';

import { ClassmojiService } from '@classmoji/services';
import {
  calculateAssignmentGrade,
  calculateGrades,
  calculateLetterGrade,
  type LetterGradeMappingEntry,
  type OrganizationSettings,
} from '@classmoji/utils';
import { LateOverrideButton } from '~/components';
import GradeBadges from '~/components/features/grading/GradeBadges';
import { ASSIGNMENT_TYPE_META } from '~/components/features/assignments/AssignmentsTable';
import { addAuditLog, addClassroomAuditLog } from '~/utils/helpers';
import { requireClassroomStaff, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { normalizeSchoolId } from '~/utils/schoolId';
import type { Route } from './+types/route';

/**
 * One student, every assignment: the report a grade appeal or an office-hours
 * visit needs on one page. Replaces the old student drawer's grade table and
 * the grade-comment modal. Grading itself stays on the assignment page; this
 * page links there and only owns the letter override, the staff note and the
 * school id.
 */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const login = params.login!;

  const { classroom, membership: viewer } = await requireClassroomStaff(request, classSlug, {
    resourceType: 'STUDENT_GRADES_SCREEN',
    action: 'view_student_report',
  });

  // Classroom-scoped, role-pinned, projected: never the global user graph.
  const enrollment = await ClassmojiService.classroomMembership.findStudentByLoginInClassroom(
    classroom.id,
    login
  );
  if (!enrollment) throw new Response('Student not found', { status: 404 });
  const studentId = enrollment.user.id;

  const [
    assignments,
    repoAssignments,
    emojiMappings,
    settingsRow,
    letterGradeMappings,
    tokenBalance,
  ] = await Promise.all([
    ClassmojiService.assignment.listForClassroom(classroom.id, { publishedOnly: true }),
    ClassmojiService.gitRepoAssignment.findAllForStudent(studentId, classSlug),
    ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
    ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id),
    ClassmojiService.letterGradeMapping.findByClassroomId(classroom.id),
    ClassmojiService.token.getBalance(classroom.id, studentId),
  ]);

  // Quiz attempts and form responses for this student, one lookup each.
  const quizStatus: Record<
    string,
    { attempted: boolean; completed: boolean; score: number | null }
  > = {};
  const formStatus: Record<string, { responded: boolean; draft: boolean }> = {};
  await Promise.all(
    assignments.map(async a => {
      if (a.type === 'QUIZ' && a.quiz) {
        const attempt = await ClassmojiService.quizAttempt.getUserAttemptForQuiz(
          a.quiz.id,
          studentId
        );
        quizStatus[a.id] = {
          attempted: Boolean(attempt),
          completed: Boolean(attempt?.completed_at),
          score: attempt?.score ?? null,
        };
      } else if (a.type === 'FORM' && a.form) {
        const response = await ClassmojiService.formResponse.findOwnResponse(a.form.id, studentId);
        const submitted = Boolean(
          (response as { submitted_at?: Date | null } | null)?.submitted_at
        );
        formStatus[a.id] = { responded: submitted, draft: Boolean(response) && !submitted };
      }
    })
  );

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'STUDENT_GRADES_SCREEN',
    resourceId: String(studentId),
  });

  return {
    rolePrefix: new URL(request.url).pathname.split('/')[1] || 'admin',
    isOwner: viewer!.role === 'OWNER',
    classroom: {
      slug: classroom.slug,
      gitOrgLogin: classroom.git_organization?.login ?? null,
    },
    student: {
      id: studentId,
      name: enrollment.user.name,
      login: enrollment.user.login,
      school_id: enrollment.user.school_id,
      image: enrollment.user.image,
    },
    membership: {
      id: enrollment.id,
      comment: enrollment.comment,
      letter_grade: enrollment.letter_grade,
    },
    assignments,
    repoAssignments,
    quizStatus,
    formStatus,
    emojiMappings,
    settings: { late_penalty_points_per_hour: settingsRow?.late_penalty_points_per_hour ?? 0 },
    letterGradeMappings,
    tokenBalance,
  };
};

/**
 * The three things this page owns: the staff note and the letter override
 * (owner and teacher), and the school id (owner only; it lives on the User
 * row, so it is the student's id in every classroom).
 */
export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const login = params.login!;

  const { userId, classroom, membership } = await requireClassroomStaff(request, classSlug, {
    resourceType: 'STUDENT_GRADES_SCREEN',
    action: 'update_student_report',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const body = (await request.json()) as {
    intent?: string;
    comment?: unknown;
    letter_grade?: unknown;
    school_id?: unknown;
  };

  const enrollment = await ClassmojiService.classroomMembership.findStudentByLoginInClassroom(
    classroom.id,
    login
  );
  if (!enrollment) throw new Response('Student not found', { status: 404 });

  const audit = (resourceType: string, metadata: Record<string, unknown>) =>
    addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action: 'UPDATE',
      resourceType,
      resourceId: enrollment.id,
      metadata,
    });

  switch (body.intent) {
    case 'update-comment': {
      // An empty comment clears the note, so the type is checked, not truthiness.
      if (typeof body.comment !== 'string') return { error: 'Invalid request.' };
      const updated = await ClassmojiService.classroomMembership.updateInClassroom(
        enrollment.id,
        classroom.id,
        { comment: body.comment }
      );
      if (!updated) return { error: 'Student not found.' };
      // The note's text is private; the audit says who changed it and when.
      await audit('GRADES', { tool: 'web:student.update_comment', cleared: body.comment === '' });
      return { ok: true, intent: body.intent };
    }
    case 'update-letter-grade': {
      const raw = body.letter_grade;
      if (raw !== null && raw !== undefined && typeof raw !== 'string') {
        return { error: 'Invalid request.' };
      }
      const letter = raw ? String(raw) : null;
      const updated = await ClassmojiService.classroomMembership.updateInClassroom(
        enrollment.id,
        classroom.id,
        { letter_grade: letter }
      );
      if (!updated) return { error: 'Student not found.' };
      await audit('GRADES', { tool: 'web:student.update_letter_grade', letter_grade: letter });
      return { ok: true, intent: body.intent };
    }
    case 'update-school-id': {
      if (membership!.role !== 'OWNER') {
        throw new Response('Only the owner can change a school id', { status: 403 });
      }
      const schoolId = normalizeSchoolId(body.school_id);
      if (schoolId === undefined) return { error: 'School ID must be 64 characters or fewer.' };
      await ClassmojiService.user.update(enrollment.user.id, { school_id: schoolId });
      addAuditLog({
        request,
        params,
        action: 'UPDATE',
        resourceType: 'STUDENT_ROSTER',
        resourceId: String(enrollment.user.id),
        metadata: { field: 'school_id' },
      });
      return { ok: true, intent: body.intent };
    }
    default:
      return { error: 'Unknown action.' };
  }
};

type LoaderData = Route.ComponentProps['loaderData'];
/**
 * A submission row plus the fields the Prisma client extension computes at
 * read time (late hours, missing-after-deadline), which the generated type
 * does not carry.
 */
type RepoAssignment = LoaderData['repoAssignments'][number] & {
  is_late?: boolean;
  is_late_override: boolean;
  num_late_hours?: number;
  extension_hours?: number;
  should_be_zero?: boolean;
};
type Assignment = LoaderData['assignments'][number];

const fmt = (value: string | Date | null | undefined, withTime = false) =>
  value ? dayjs(value).format(withTime ? 'MMM D, h:mm A' : 'MMM D') : null;

const Tile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="rounded-2xl bg-panel ring-1 ring-line px-4 py-3 flex flex-col gap-1">
    <span className="text-xs font-medium text-ink-3">{label}</span>
    <div className="text-xl font-bold text-ink-1 tabular-nums">{children}</div>
  </div>
);

const Pill = ({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey';
  children: React.ReactNode;
}) => {
  const cls = {
    green: 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    red: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    blue: 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
    grey: 'bg-stone-100 text-stone-600 dark:bg-neutral-800 dark:text-neutral-300',
  }[tone];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold whitespace-nowrap ${cls}`}
    >
      {children}
    </span>
  );
};

/** School id, editable in place by the owner. */
const SchoolIdField = ({ value, editable }: { value: string | null; editable: boolean }) => {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.ok) setEditing(false);
  }, [fetcher.state, fetcher.data]);
  const save = () =>
    fetcher.submit(
      { intent: 'update-school-id', school_id: draft },
      { method: 'POST', encType: 'application/json' }
    );
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>{value ? `ID ${value}` : 'No school ID'}</span>
        {editable && (
          <button
            type="button"
            onClick={() => {
              setDraft(value ?? '');
              setEditing(true);
            }}
            className="text-xs font-medium text-sky-600 hover:underline"
          >
            Edit
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        size="small"
        autoFocus
        maxLength={64}
        placeholder="School ID"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onPressEnter={save}
        status={fetcher.data?.error ? 'error' : undefined}
        className="w-40"
      />
      <Button size="small" type="primary" onClick={save} loading={fetcher.state !== 'idle'}>
        Save
      </Button>
      <Button size="small" type="text" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {fetcher.data?.error && <span className="text-xs text-red-500">{fetcher.data.error}</span>}
    </span>
  );
};

const StudentReport = ({ loaderData }: Route.ComponentProps) => {
  const {
    rolePrefix,
    isOwner,
    classroom,
    student,
    membership,
    assignments,
    repoAssignments: repoAssignmentRows,
    quizStatus,
    formStatus,
    emojiMappings,
    settings,
    letterGradeMappings,
    tokenBalance,
  } = loaderData;
  const repoAssignments = repoAssignmentRows as RepoAssignment[];
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const noteFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const letterFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [note, setNote] = useState(membership.comment ?? '');

  const mappings = emojiMappings as Record<string, number>;
  const orgSettings = settings as OrganizationSettings;
  const letters = letterGradeMappings as LetterGradeMappingEntry[];
  const base = `/${rolePrefix}/${classroom.slug}`;

  // Repo submissions keyed by assignment; grouped by git repo for the totals.
  const byAssignment = useMemo(() => {
    const map: Record<string, RepoAssignment> = {};
    for (const ra of repoAssignments) map[ra.assignment_id] = ra;
    return map;
  }, [repoAssignments]);

  const totals = useMemo(() => {
    const repos: Record<string, { repository: { type?: string }; assignments: RepoAssignment[] }> =
      {};
    for (const ra of repoAssignments) {
      const key = ra.git_repo.id;
      repos[key] ??= { repository: { type: ra.git_repo.repository?.type }, assignments: [] };
      repos[key].assignments.push(ra);
    }
    return calculateGrades(
      Object.values(repos) as Parameters<typeof calculateGrades>[0],
      mappings,
      orgSettings,
      letters
    );
  }, [repoAssignments, mappings, orgSettings, letters]);

  const gradedWeight = repoAssignments
    .filter(ra => (ra.grades?.length ?? 0) > 0 && !ra.assignment.is_extra_credit)
    .reduce((sum, ra) => sum + ra.assignment.weight, 0);
  const gradedCount = repoAssignments.filter(ra => (ra.grades?.length ?? 0) > 0).length;
  const lateRows = repoAssignments.filter(ra => ra.is_late && !ra.is_late_override);
  const lateHours = lateRows.reduce((sum, ra) => sum + (ra.num_late_hours ?? 0), 0);
  const latePenalty = lateHours * orgSettings.late_penalty_points_per_hour;

  const computedLetter =
    totals.finalNumericGrade >= 0 ? calculateLetterGrade(totals.finalNumericGrade, letters) : null;
  // No letter cutoffs configured means no letter to show, not an F.
  const shownLetter = letters.length > 0 ? (membership.letter_grade ?? computedLetter) : null;

  // Grouped by module, in the course's module order, so the report reads the
  // way the course is organised rather than by what kind of thing each
  // assignment is. Inside a module, items come in the order they were created.
  const sections = useMemo(() => {
    const byCreated = (x: Assignment, y: Assignment) =>
      new Date(x.created_at).getTime() - new Date(y.created_at).getTime() ||
      x.title.localeCompare(y.title);
    const groups = new Map<
      string,
      { key: string; title: string; position: number; items: Assignment[] }
    >();
    for (const a of assignments) {
      const group = groups.get(a.module.id) ?? {
        key: a.module.id,
        title: a.module.title,
        position: a.module.position ?? 0,
        items: [],
      };
      group.items.push(a);
      groups.set(a.module.id, group);
    }
    return [...groups.values()]
      .sort((g, h) => g.position - h.position || g.title.localeCompare(h.title))
      .map(g => ({ ...g, items: [...g.items].sort(byCreated) }));
  }, [assignments]);

  const saveNote = () =>
    noteFetcher.submit(
      { intent: 'update-comment', comment: note },
      { method: 'POST', encType: 'application/json' }
    );
  const saveLetter = (value: string) =>
    letterFetcher.submit(
      { intent: 'update-letter-grade', letter_grade: value === '' ? null : value },
      { method: 'POST', encType: 'application/json' }
    );

  const renderLine = (a: Assignment) => {
    const meta = ASSIGNMENT_TYPE_META[a.type];
    const Icon = meta?.icon;
    const due = fmt(a.student_deadline);
    const parts: string[] = [];
    if (a.type === 'REPO') parts.push(a.submission_mode === 'REPO' ? 'push' : 'issue');
    parts.push(`${a.weight}%${a.is_extra_credit ? ' extra credit' : ''}`);
    if (due) parts.push(`due ${due}`);

    let status: React.ReactNode = null;
    let actions: React.ReactNode = null;
    let grade: React.ReactNode = <span className="text-sm text-ink-3">–</span>;
    let view: React.ReactNode = null;
    let href = `${base}/assignments/${a.id}`;

    if (a.type === 'REPO') {
      const ra = byAssignment[a.id];
      if (!ra) {
        status = <Pill tone="grey">Not released to this student</Pill>;
      } else {
        const submitted = ra.status === 'CLOSED';
        const graded = (ra.grades?.length ?? 0) > 0;
        const late = ra.is_late && !ra.is_late_override;
        if (!submitted)
          status = (
            <Pill tone={ra.should_be_zero ? 'red' : 'grey'}>
              {ra.should_be_zero ? 'Missing' : 'Not submitted'}
            </Pill>
          );
        else if (late)
          status = (
            <Pill tone="amber">
              Late {ra.num_late_hours}h · −
              {(ra.num_late_hours ?? 0) * orgSettings.late_penalty_points_per_hour} pts
            </Pill>
          );
        else if (ra.is_late_override) status = <Pill tone="grey">Late waived</Pill>;
        else status = <Pill tone="green">Submitted {fmt(ra.closed_at) ?? ''}</Pill>;
        if (submitted && !graded)
          status = (
            <span className="inline-flex gap-1.5">
              {status}
              <Pill tone="blue">To grade</Pill>
            </span>
          );

        const numeric = calculateAssignmentGrade(ra, mappings, orgSettings);
        const raw = calculateAssignmentGrade(ra, mappings, orgSettings, false);
        grade = (
          <div className="flex items-center gap-3">
            <GradeBadges
              grades={ra.grades}
              emojiMappings={emojiMappings as Record<string, unknown>}
            />
            {numeric !== null && (
              <Tooltip
                title={
                  raw !== null && raw !== numeric ? `${raw} before the late penalty` : undefined
                }
              >
                <span className="inline-flex items-center justify-center min-w-9 h-8 px-2 rounded-lg bg-[#6c8fae] text-white text-sm font-bold tabular-nums">
                  {Math.round(numeric * 10) / 10}
                </span>
              </Tooltip>
            )}
          </div>
        );
        const repoUrl = classroom.gitOrgLogin
          ? `https://github.com/${classroom.gitOrgLogin}/${ra.git_repo.name}${ra.provider_issue_number ? `/issues/${ra.provider_issue_number}` : ''}`
          : null;
        actions = (
          <div className="flex items-center gap-2">
            {(ra.is_late || ra.is_late_override) && (
              <LateOverrideButton
                repositoryAssignment={
                  ra as unknown as Parameters<typeof LateOverrideButton>[0]['repositoryAssignment']
                }
              />
            )}
            {submitted && !graded && (
              <Link
                to={`${base}/assignments/${a.id}`}
                className="text-xs font-medium text-sky-600 hover:underline"
              >
                Grade now
              </Link>
            )}
          </div>
        );
        view = repoUrl ? (
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center h-7 px-2.5 rounded-md ring-1 ring-line bg-panel text-xs font-medium text-ink-2 hover:text-ink-1 hover:bg-stone-50 dark:hover:bg-neutral-800"
          >
            View
          </a>
        ) : null;
      }
    } else if (a.type === 'QUIZ') {
      const q = quizStatus[a.id];
      href = a.quiz ? `${base}/quizzes/${a.quiz.id}` : href;
      status = !q?.attempted ? (
        <Pill tone="grey">Not attempted</Pill>
      ) : q.completed ? (
        <Pill tone="green">Completed</Pill>
      ) : (
        <Pill tone="blue">In progress</Pill>
      );
      if (q?.score !== null && q?.score !== undefined)
        grade = <span className="text-sm font-semibold tabular-nums">{q.score}</span>;
    } else if (a.type === 'FORM') {
      const f = formStatus[a.id];
      href = `${base}/forms${a.form?.slug ? `/${encodeURIComponent(a.form.slug)}` : ''}`;
      status = f?.responded ? (
        <Pill tone="green">Responded</Pill>
      ) : f?.draft ? (
        <Pill tone="blue">Draft</Pill>
      ) : (
        <Pill tone="grey">No response</Pill>
      );
    }

    return (
      <li
        key={a.id}
        // Fixed grid tracks so the status, grade and view columns sit at the
        // same x on every row; in a flex row the title column shrank by however
        // much the right side needed, and the pills drifted.
        className="grid grid-cols-[18px_minmax(0,1fr)_16rem_auto_10rem_3.5rem] items-center gap-4 px-4 py-3 rounded-xl bg-panel ring-1 ring-line"
      >
        {Icon ? <Icon size={18} className="text-gray-400" /> : <span />}
        <div className="flex flex-col gap-0.5 min-w-0">
          <Link
            to={href}
            className="font-semibold text-ink-1 truncate hover:underline underline-offset-2"
          >
            {a.title}
          </Link>
          <span className="text-xs text-ink-3 truncate">{parts.join(' · ')}</span>
        </div>
        <div>{status}</div>
        <div className="flex justify-end">{actions}</div>
        <div className="flex justify-end">{grade}</div>
        <div className="flex justify-end">{view}</div>
      </li>
    );
  };

  return (
    <div className="min-h-full relative">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 mt-2 mb-3 text-sm text-ink-2">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="hover:text-ink-1"
          aria-label="Back"
        >
          <IconChevronLeft size={18} />
        </button>
        <Link to={`${base}/grades`} className="hover:text-ink-1">
          Grades
        </Link>
        <span className="text-ink-3">/</span>
        <span className="font-semibold text-ink-1">{student.name ?? student.login}</span>
      </nav>

      <div className="flex items-center gap-4 mb-4 flex-wrap">
        {student.image ? (
          <img
            src={student.image}
            alt=""
            className="h-12 w-12 rounded-full object-cover ring-1 ring-line"
          />
        ) : (
          <span className="h-12 w-12 rounded-full bg-stone-200 dark:bg-neutral-700" />
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-ink-1 truncate">
            {student.name ?? student.login}
          </h1>
          <div className="flex items-center gap-2 text-sm text-ink-3 flex-wrap">
            <span>@{student.login}</span>
            <span>·</span>
            <SchoolIdField value={student.school_id ?? null} editable={isOwner} />
            <span>·</span>
            <span>
              {tokenBalance} tokens
              {tokenBalance < 10 && <span className="ml-1 text-red-500">(low)</span>}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Tile label="Total">
          {totals.finalNumericGrade >= 0 ? (
            <>
              {Math.round(totals.finalNumericGrade * 10) / 10}
              {shownLetter && (
                <Tag color="green" className="align-middle m-0 ml-2.5 font-bold">
                  {shownLetter}
                </Tag>
              )}
            </>
          ) : (
            <span className="text-ink-3">No grades yet</span>
          )}
          {totals.rawNumericGrade >= 0 && totals.rawNumericGrade !== totals.finalNumericGrade && (
            <div className="text-xs font-medium text-ink-3">
              {Math.round(totals.rawNumericGrade * 10) / 10} before late penalties
            </div>
          )}
        </Tile>
        <Tile label="Graded so far">
          {gradedCount}{' '}
          <span className="text-sm font-medium text-ink-3">
            of {assignments.filter(a => a.type === 'REPO').length} · {Math.round(gradedWeight)}%
            weight
          </span>
        </Tile>
        <Tile label="Late">
          <span className={lateRows.length ? 'text-amber-600' : undefined}>{lateRows.length}</span>{' '}
          {lateRows.length > 0 && (
            <span className="text-sm font-medium text-ink-3">
              · {lateHours}h, −{latePenalty} pts
            </span>
          )}
        </Tile>
        <div className="rounded-2xl bg-panel ring-1 ring-line px-4 py-3 flex flex-col gap-1">
          <label htmlFor="letter-override" className="text-xs font-medium text-ink-3">
            Final letter override
          </label>
          <Select
            id="letter-override"
            size="small"
            value={membership.letter_grade ?? ''}
            onChange={saveLetter}
            loading={letterFetcher.state !== 'idle'}
            options={[
              {
                value: '',
                label:
                  letters.length > 0 && computedLetter
                    ? `Computed (${computedLetter})`
                    : 'Computed',
              },
              ...letters.map(l => ({ value: l.letter_grade, label: l.letter_grade })),
            ]}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 mb-5">
        {sections.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No published assignments yet</div>
          </div>
        )}
        {sections.map(section => (
          <div key={section.key} className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 pt-3 pb-1">
              {section.title}
            </h2>
            <ul className="flex flex-col gap-2">{section.items.map(renderLine)}</ul>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line px-4 py-3 flex flex-col gap-2">
        <label htmlFor="staff-note" className="text-xs font-semibold text-ink-3">
          Private note (staff only)
        </label>
        <Input.TextArea
          id="staff-note"
          rows={3}
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Extensions agreed, conversations had, anything the next grader should know."
        />
        <div className="flex items-center gap-3">
          <Button
            type="primary"
            size="small"
            onClick={saveNote}
            loading={noteFetcher.state !== 'idle'}
            disabled={note === (membership.comment ?? '')}
          >
            Save note
          </Button>
          {noteFetcher.data?.ok && noteFetcher.state === 'idle' && (
            <span className="text-xs text-ink-3">Saved</span>
          )}
          {noteFetcher.data?.error && (
            <span className="text-xs text-red-500">{noteFetcher.data.error}</span>
          )}
          <span className="flex-1" />
          <span className="text-xs text-ink-3">
            {pathname.startsWith('/teacher')
              ? 'Teachers and the owner see this.'
              : 'Only owners and teachers see this.'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default StudentReport;
