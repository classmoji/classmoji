/**
 * Client-side parser for a GitHub Classroom export bundle.
 *
 * The teacher runs the official `classroom-export-utility`
 * (https://github.com/github-education-resources/classroom-export-utility),
 * which writes a folder tree of JSON (+ grades.csv). They zip that folder and
 * upload it here; we parse it entirely in the browser (no server file handling)
 * and submit the normalized, JSON-safe structure to the import action.
 *
 * Bundle layout (root may be `classroom-export-<ts>/` or the bare contents):
 *   classrooms.json
 *   classroom-<id>/classroom.json          (carries `organization`)
 *   classroom-<id>/assignments.json
 *   classroom-<id>/assignment-<id>/assignment.json
 *   classroom-<id>/assignment-<id>/accepted-assignments.json
 *   classroom-<id>/assignment-<id>/grades.csv   (numeric points; parsed for notes)
 */

import JSZip from 'jszip';
import Papa from 'papaparse';

// Zip-safety caps (defends against malformed archives / zip bombs).
const MAX_ENTRIES = 50_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per entry
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB decompressed budget

export interface ParsedStudent {
  providerId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface ParsedRepoLink {
  providerId: string;
  name: string;
  fullName: string;
  htmlUrl: string | null;
  defaultBranch: string | null;
}

export interface ParsedAcceptance {
  type: 'individual' | 'group';
  students: ParsedStudent[];
  repo: ParsedRepoLink | null;
  // Extra per-submission info from accepted-assignments.json, kept for the
  // read-only GitRepo.metadata record.
  commitCount: number | null;
  submitted: boolean;
  passing: boolean;
  grade: string | null;
}

/** One row of a per-student, per-assignment imported score (kept only when real). */
export interface ParsedGradeRow {
  assignmentTitle: string;
  githubUsername: string;
  pointsAwarded: string;
  pointsAvailable: string;
  submissionTimestamp: string | null;
}

export interface ParsedAssignment {
  githubId: number;
  title: string;
  slug: string;
  type: 'individual' | 'group';
  deadline: string | null; // ISO datetime or null
  starterRepoFullName: string; // '' when no starter repo
  acceptances: ParsedAcceptance[];
}

export interface ParsedClassroom {
  githubId: number;
  name: string;
  archived: boolean;
  organization: {
    id: number;
    login: string;
    name: string | null;
    avatarUrl: string | null;
  };
  assignments: ParsedAssignment[];
  /** Aggregated across every assignment's grades.csv; only rows with a real score. */
  grades: ParsedGradeRow[];
  // Lightweight preview counters (avoid re-walking in the UI).
  studentCount: number;
  assignmentCount: number;
}

export interface ParsedBundle {
  rootName: string;
  classrooms: ParsedClassroom[];
  warnings: string[];
}

const emptyToNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return v == null ? null : String(v);
  const t = v.trim();
  return t.length ? t : null;
};

const isUnsafePath = (name: string): boolean =>
  name.split('/').some(seg => seg === '..') || name.startsWith('/');

/**
 * Parse and normalize an uploaded export `.zip`.
 * Throws only on unrecoverable problems (not a zip, no `classrooms.json`,
 * safety caps exceeded). Per-file problems are collected as warnings, not fatal.
 */
export async function parseExportBundle(file: File | Blob): Promise<ParsedBundle> {
  const warnings: string[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('That file is not a valid .zip archive.');
  }

  const entries = Object.values(zip.files).filter(f => !f.dir);
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Archive has too many files (${entries.length}). Is this the right export?`);
  }

  // Locate the bundle root: the shallowest `classrooms.json`.
  const rootEntry = entries
    .filter(f => f.name.split('/').pop() === 'classrooms.json' && !isUnsafePath(f.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];

  if (!rootEntry) {
    throw new Error(
      'No classrooms.json found. Upload the folder produced by the export utility (zipped).'
    );
  }

  const rootPrefix = rootEntry.name.slice(0, rootEntry.name.length - 'classrooms.json'.length);
  const rootName = rootPrefix.replace(/\/$/, '').split('/').pop() || 'classroom-export';

  let totalBytes = 0;
  const readText = async (relPath: string): Promise<string | null> => {
    const entry = zip.file(rootPrefix + relPath);
    if (!entry) return null;
    if (isUnsafePath(entry.name)) return null;
    const text = await entry.async('string');
    totalBytes += text.length;
    if (text.length > MAX_FILE_BYTES) throw new Error(`File ${relPath} is unexpectedly large.`);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Archive is too large to process.');
    return text;
  };

  const readJson = async <T>(relPath: string): Promise<T | null> => {
    const text = await readText(relPath);
    if (text == null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      warnings.push(`Skipped malformed JSON: ${relPath}`);
      return null;
    }
  };

  type RawClassroomRef = { id: number; name: string; archived?: boolean };
  const classroomRefs = (await readJson<RawClassroomRef[]>('classrooms.json')) ?? [];
  if (!Array.isArray(classroomRefs)) {
    throw new Error('classrooms.json is not in the expected format.');
  }

  const classrooms: ParsedClassroom[] = [];

  for (const ref of classroomRefs) {
    const dir = `classroom-${ref.id}/`;

    type RawOrg = { id: number; login: string; name: string | null; avatar_url?: string };
    const detail = await readJson<{ name?: string; archived?: boolean; organization?: RawOrg }>(
      `${dir}classroom.json`
    );
    const org = detail?.organization;
    if (!org) {
      warnings.push(`Classroom ${ref.id} ("${ref.name}") has no organization info; skipped.`);
      continue;
    }

    type RawAssignment = {
      id: number;
      title: string;
      slug?: string;
      type?: string;
      deadline?: string | null;
      starter_code_repository?: { full_name?: string } | null;
    };
    const assignmentRefs = (await readJson<RawAssignment[]>(`${dir}assignments.json`)) ?? [];

    const assignments: ParsedAssignment[] = [];
    const grades: ParsedGradeRow[] = [];
    const studentIds = new Set<string>();

    for (const aRef of Array.isArray(assignmentRefs) ? assignmentRefs : []) {
      const aDir = `${dir}assignment-${aRef.id}/`;
      const aDetail = (await readJson<RawAssignment>(`${aDir}assignment.json`)) ?? aRef;

      const rawType = String(aDetail.type ?? aRef.type ?? 'individual').toLowerCase();
      const type: 'individual' | 'group' = rawType === 'group' ? 'group' : 'individual';

      type RawAcceptance = {
        students?: Array<{ id: number; login: string; name: string | null; avatar_url?: string }>;
        commit_count?: number;
        submitted?: boolean;
        passing?: boolean;
        grade?: string | null;
        repository?: {
          id: number;
          name: string;
          full_name?: string;
          html_url?: string;
          default_branch?: string;
        } | null;
      };
      const accepted = (await readJson<RawAcceptance[]>(`${aDir}accepted-assignments.json`)) ?? [];

      const acceptances: ParsedAcceptance[] = (Array.isArray(accepted) ? accepted : []).map(acc => {
        const students: ParsedStudent[] = (acc.students ?? []).map(s => {
          const providerId = String(s.id);
          studentIds.add(providerId);
          return {
            providerId,
            login: s.login,
            name: emptyToNull(s.name),
            avatarUrl: emptyToNull(s.avatar_url),
          };
        });
        const repo: ParsedRepoLink | null = acc.repository
          ? {
              providerId: String(acc.repository.id),
              name: acc.repository.name,
              fullName: acc.repository.full_name ?? acc.repository.name,
              htmlUrl: emptyToNull(acc.repository.html_url),
              defaultBranch: emptyToNull(acc.repository.default_branch),
            }
          : null;
        return {
          type,
          students,
          repo,
          commitCount: typeof acc.commit_count === 'number' ? acc.commit_count : null,
          submitted: Boolean(acc.submitted),
          passing: Boolean(acc.passing),
          grade: emptyToNull(acc.grade ?? null),
        };
      });

      assignments.push({
        githubId: aRef.id,
        title: aDetail.title ?? aRef.title,
        slug: aDetail.slug ?? aRef.slug ?? '',
        type,
        deadline: emptyToNull(aDetail.deadline ?? aRef.deadline ?? null),
        starterRepoFullName: aDetail.starter_code_repository?.full_name ?? '',
        acceptances,
      });

      // grades.csv -> keep every student row (points are stored as-is, even 0/0,
      // since they're preserved as read-only GitRepo metadata for viewing).
      const csv = await readText(`${aDir}grades.csv`);
      if (csv) {
        const parsed = Papa.parse<Record<string, string>>(csv, {
          header: true,
          skipEmptyLines: true,
        });
        for (const row of parsed.data) {
          const username = (row.github_username ?? '').trim();
          if (!username) continue;
          grades.push({
            assignmentTitle: (row.assignment_name ?? aDetail.title ?? aRef.title ?? '').trim(),
            githubUsername: username,
            pointsAwarded: (row.points_awarded ?? '').trim() || '0',
            pointsAvailable: (row.points_available ?? '').trim() || '0',
            submissionTimestamp: emptyToNull(row.submission_timestamp),
          });
        }
      }
    }

    classrooms.push({
      githubId: ref.id,
      name: detail?.name ?? ref.name,
      archived: Boolean(detail?.archived ?? ref.archived ?? false),
      organization: {
        id: org.id,
        login: org.login,
        name: emptyToNull(org.name),
        avatarUrl: emptyToNull(org.avatar_url),
      },
      assignments,
      grades,
      studentCount: studentIds.size,
      assignmentCount: assignments.length,
    });
  }

  return { rootName, classrooms, warnings };
}

/** Slugify a classroom name. Mirrors `_user.create-classroom/utils.ts` so slugs
 * are identical across the create and import flows (the availability check relies
 * on that equivalence). */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
