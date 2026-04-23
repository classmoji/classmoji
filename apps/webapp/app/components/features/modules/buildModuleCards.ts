import dayjs from 'dayjs';
import type { ModuleCard, ModuleState } from './modulesTypes';

/**
 * Minimal shape needed from a Module row to build a ModuleCard. Callers pass
 * their raw Prisma results; extra fields are ignored.
 */
interface BuildInput {
  id: string;
  title: string;
  slug: string | null;
  updated_at?: Date | string | null;
  assignments?: Array<{
    id: string;
    student_deadline?: Date | string | null;
  }>;
  pages?: unknown[];
  slides?: unknown[];
}

interface BuildOptions {
  /** Function that returns true if an assignment is "done" for the viewer. */
  isAssignmentDone?: (assignmentId: string) => boolean;
  /** Role prefix used to build the detail href, e.g. "admin" or "student". */
  rolePrefix: 'admin' | 'student' | 'assistant';
  /** Classroom slug (used in the URL). */
  classSlug: string;
  /**
   * Optional classroom start date (ISO string or Date). Used to derive a
   * "weeks" range from assignment deadlines. Falls back to "—" when unknown.
   */
  classroomStart?: Date | string | null;
}

function weekIndex(date: Date, start: Date): number {
  const ms = date.getTime() - start.getTime();
  const week = Math.floor(ms / (7 * 24 * 60 * 60 * 1000)) + 1;
  return week < 1 ? 1 : week;
}

function formatWeeks(
  assignments: BuildInput['assignments'],
  start: Date | null
): string {
  if (!start || !assignments || assignments.length === 0) return '—';
  const weeks: number[] = [];
  for (const a of assignments) {
    if (!a.student_deadline) continue;
    const d = new Date(a.student_deadline);
    if (Number.isNaN(d.getTime())) continue;
    weeks.push(weekIndex(d, start));
  }
  if (weeks.length === 0) return '—';
  const lo = Math.min(...weeks);
  const hi = Math.max(...weeks);
  return lo === hi ? `Week ${lo}` : `Week ${lo}–${hi}`;
}

function formatRelative(ts: Date | string | null | undefined): string {
  if (!ts) return '';
  const d = dayjs(ts);
  if (!d.isValid()) return '';
  return d.fromNow();
}

export function buildModuleCards(
  modules: BuildInput[],
  options: BuildOptions
): ModuleCard[] {
  const start = options.classroomStart ? new Date(options.classroomStart) : null;
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null;

  return modules.map((m, idx) => {
    const assignments = m.assignments ?? [];
    const total = assignments.length;
    const done = options.isAssignmentDone
      ? assignments.filter(a => options.isAssignmentDone!(a.id)).length
      : 0;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const slug = m.slug ?? m.title;
    const itemCount = (m.pages?.length ?? 0) + (m.slides?.length ?? 0);

    let state: ModuleState;
    if (total > 0 && pct >= 100) state = 'done';
    else if (done > 0) state = 'prog';
    else if (total === 0 && itemCount === 0) state = 'lock';
    else state = 'prog';

    const subtitleParts: string[] = [];
    subtitleParts.push(`${total} assignment${total === 1 ? '' : 's'}`);
    if (itemCount > 0) subtitleParts.push(`${itemCount} item${itemCount === 1 ? '' : 's'}`);
    subtitleParts.push(`${pct}%`);
    const subtitle = subtitleParts.join(' · ');

    let meta: string;
    if (state === 'done') meta = 'All items complete';
    else if (state === 'lock') meta = 'No content yet';
    else if (done > 0) meta = `${done} of ${total} completed`;
    else meta = total > 0 ? `${total} item${total === 1 ? '' : 's'} to start` : 'Ready to start';

    const timestamp = formatRelative(m.updated_at);

    return {
      id: m.id,
      slug,
      number: idx + 1,
      name: m.title,
      weeks: formatWeeks(assignments, validStart),
      pct,
      done,
      total,
      subtitle,
      state,
      meta,
      timestamp,
      href: `/${options.rolePrefix}/${options.classSlug}/modules/${options.rolePrefix === 'admin' ? encodeURIComponent(m.title) : slug}`,
    };
  });
}
