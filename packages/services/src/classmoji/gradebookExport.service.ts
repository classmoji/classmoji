import {
  calculateAssignmentGrade,
  calculateStudentFinalGrade,
  finalStudentGrade,
  gradedItemValue,
} from '@classmoji/utils';
import type { GitRepo, GitRepoAssignment, OrganizationSettings } from '@classmoji/utils';

import { findRepositoriesPerStudent } from './user.service.ts';
import { findByClassroomId as findEmojiMappingsByClassroomId } from './emojiMapping.service.ts';
import { findByClassroomId as findLetterGradeMappingsByClassroomId } from './letterGradeMapping.service.ts';
import { findByClassroomId as findMembershipsByClassroomId } from './classroomMembership.service.ts';
import { listForClassroom } from './assignment.service.ts';
import { getClassroomSettingsForServer } from './classroom.service.ts';
import { quizzesVisibleOrThrow } from './entitlement.service.ts';
import { loadQuizGradeItems } from './quizGradeItems.service.ts';

/**
 * The gradebook as a CSV, for uploading to an LMS: one row per current
 * student, one column per published, graded assignment (repository and quiz;
 * forms carry no grade), then the course grade and the letter. Every value is
 * the number the gradebook computes with (late penalty on, emoji grades through
 * the classroom's scale, a quiz's counting attempt); ungraded is blank, never 0.
 *
 * Contact fields (email, school id) are included: the callers admit OWNER and
 * TEACHER only, the gradebook's own audience. Everything is scoped by the
 * classroom id the caller's gate resolved.
 */

const BASE_HEADERS = ['Name', 'Git Username', 'Email', 'School ID'] as const;

export interface GradebookExport {
  headers: string[];
  rows: (string | number | null)[][];
  studentCount: number;
  assignmentCount: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Repeated titles get a " (2)", " (3)" so every column can be told apart. */
const uniqueTitles = (titles: string[]) => {
  const seen = new Map<string, number>();
  return titles.map(title => {
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    return n === 1 ? title : `${title} (${n})`;
  });
};

const submissionFor = (repos: GitRepo[], assignmentId: string) => {
  for (const repo of repos) {
    const found = (repo.assignments ?? []).find(
      ra =>
        String(
          (ra as { assignment_id?: string }).assignment_id ??
            (ra.assignment as { id?: string } | undefined)?.id
        ) === assignmentId
    );
    if (found) return found;
  }
  return undefined;
};

export const buildGradebookExport = async (classroom: {
  id: string;
  slug: string;
}): Promise<GradebookExport> => {
  const quizzesVisible = await quizzesVisibleOrThrow(classroom.id);
  const [
    students,
    emojiMappings,
    letterGradeMappings,
    memberships,
    settingsRow,
    assignments,
    quizItems,
  ] = await Promise.all([
    findRepositoriesPerStudent(classroom),
    findEmojiMappingsByClassroomId(classroom.id) as Promise<Record<string, number>>,
    findLetterGradeMappingsByClassroomId(classroom.id),
    findMembershipsByClassroomId(classroom.id, 'STUDENT'),
    getClassroomSettingsForServer(classroom.id),
    listForClassroom(classroom.id, { publishedOnly: true }),
    loadQuizGradeItems({ classroomId: classroom.id, quizzesVisible }),
  ]);

  const settings: OrganizationSettings = {
    late_penalty_points_per_hour: Number(settingsRow?.late_penalty_points_per_hour ?? 0),
  } as OrganizationSettings;

  // The gradebook's columns, in its order: module position, then creation.
  const columns = assignments
    .filter(a => a.type === 'REPO' || (a.type === 'QUIZ' && quizzesVisible))
    .sort(
      (a, b) =>
        (a.module?.position ?? Infinity) - (b.module?.position ?? Infinity) ||
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

  // Current STUDENT members only: a team member who left the class is not a row.
  const overrideByUser = new Map(memberships.map(m => [m.user_id, m.letter_grade ?? null]));
  const roster = students
    .filter(s => overrideByUser.has(s.id))
    .sort((a, b) => (a.name ?? a.login ?? '').localeCompare(b.name ?? b.login ?? ''));

  const rows = roster.map(student => {
    const repos = (student.git_repos ?? []) as unknown as GitRepo[];
    const items = quizItems.get(student.id) ?? [];

    const grades = columns.map(assignment => {
      if (assignment.type === 'QUIZ') {
        const item = items.find(i => i.assignment_id === assignment.id);
        const value = item ? gradedItemValue(item) : null;
        return value === null ? null : round1(value);
      }
      const submission = submissionFor(repos, assignment.id);
      const value = submission
        ? calculateAssignmentGrade(submission as GitRepoAssignment, emojiMappings, settings)
        : null;
      return value === null ? null : round1(value);
    });

    const course = calculateStudentFinalGrade(repos, emojiMappings, settings, true, true, items);
    const letter = finalStudentGrade({
      submissions: repos.flatMap(repo => repo.assignments ?? []),
      items,
      emojiMappings,
      settings,
      letterGradeMappings,
      letterOverride: overrideByUser.get(student.id) ?? null,
    })?.letter;

    return [
      student.name ?? null,
      student.login ?? null,
      student.email ?? null,
      student.school_id ?? null,
      ...grades,
      course >= 0 ? round1(course) : null,
      letter ?? null,
    ];
  });

  return {
    headers: [
      ...BASE_HEADERS,
      ...uniqueTitles(columns.map(a => a.title)),
      'Course Grade',
      'Letter Grade',
    ],
    rows,
    studentCount: rows.length,
    assignmentCount: columns.length,
  };
};

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab,
 * carriage return) is prefixed with a quote; numbers are written as they are.
 */
export const csvCell = (value: string | number | null): string => {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The export as CSV text (CRLF line ends, as RFC 4180 and Excel expect). */
export const toCsv = ({ headers, rows }: Pick<GradebookExport, 'headers' | 'rows'>): string =>
  [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
