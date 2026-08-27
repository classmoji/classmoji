/**
 * The navigation's role lists, and whether the routes behind them exist.
 *
 * Two failure modes this pins, both of which look like nothing until a user
 * hits them:
 *
 *  - A nav entry offered to a role whose prefix has no such route. The link
 *    renders, and clicking it 404s.
 *  - A nav entry whose role list drifts away from the gate on the route it
 *    points at. That is not a leak on its own — the route's own gate is what
 *    refuses — but it either shows a role a door it cannot open, or hides a
 *    door it can.
 *
 * Read as SOURCE TEXT rather than by importing the route modules: they pull in
 * antd, icons and the whole component tree, and the question here is only
 * which files exist.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { routes } from '../routes.ts';

const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../routes');

/**
 * How a role's classroom-scoped route id is spelled. /admin and /student nest
 * their children under the layout (`.$class.`); /teacher and /assistant use the
 * opt-out form (`.$class_.`) so the child renders outside the layout's own
 * chrome.
 */
const ROUTE_ID: Record<string, (segment: string) => string> = {
  OWNER: s => `admin.$class.${s}`,
  TEACHER: s => `teacher.$class_.${s}`,
  ASSISTANT: s => `assistant.$class_.${s}`,
  STUDENT: s => `student.$class.${s}`,
};

/** A route id resolves when there is a directory with a route file, or a flat module. */
const routeExists = (id: string): boolean => {
  const asDir = join(ROUTES_DIR, id);
  if (existsSync(asDir) && statSync(asDir).isDirectory()) {
    return ['route.tsx', 'route.jsx', 'route.ts', 'route.js'].some(f => existsSync(join(asDir, f)));
  }
  return ['.tsx', '.jsx', '.ts', '.js'].some(ext => existsSync(`${asDir}${ext}`));
};

interface NavEntry {
  link: string;
  roles?: string[];
}

const NAV = routes as unknown as Record<string, NavEntry>;

/**
 * Entries whose `link` is an identifier rather than a destination — they open
 * a modal in place, so there is deliberately no route behind them.
 */
const MODAL_ENTRIES: Record<string, string> = {
  support: 'opens the Help & Feedback modal (CommonLayout renders it as a button, not a Link)',
};

/** Classroom-scoped entries only: `/foo`, not `/admin` or an absolute URL. */
const classroomEntries = Object.entries(NAV).filter(
  ([name, entry]) =>
    entry.roles?.length && /^\/[a-z0-9-]+$/.test(entry.link) && !MODAL_ENTRIES[name]
);

describe('the classroom navigation', () => {
  it('has entries to check, so this file cannot pass by finding nothing', () => {
    expect(classroomEntries.length).toBeGreaterThanOrEqual(10);
  });

  it('names every modal exemption against an entry that actually exists', () => {
    // A stale exemption would silently excuse an entry from the check below.
    for (const name of Object.keys(MODAL_ENTRIES)) {
      expect(NAV[name], `MODAL_ENTRIES names ${name}, which is not a nav entry`).toBeDefined();
    }
  });

  it.each(classroomEntries.map(([name, entry]) => [name, entry] as const))(
    '%s points at a route under every prefix it offers',
    (name, entry) => {
      const segment = entry.link.slice(1);
      const missing = (entry.roles ?? [])
        .filter(role => ROUTE_ID[role])
        .map(role => ({ role, id: ROUTE_ID[role](segment) }))
        .filter(({ id }) => !routeExists(id));

      expect(
        missing.map(m => `${m.role} -> ${m.id}`),
        `The "${name}" nav entry is offered to a role with no route to land on. Either add ` +
          `the route under that prefix or remove the role from its list in constants/routes.ts.`
      ).toEqual([]);
    }
  );
});

/**
 * The two assessment entries this branch moved, called out by name rather than
 * left to the table above.
 *
 * They came apart on purpose: the gradebook holds every student's letter grade
 * and private performance comment, which is instructor work; the grading queue
 * lists what the viewer personally has to mark, which is what an assistant is
 * for. A single "assessment" role list would have to be one or the other.
 */
describe('the assessment split', () => {
  it('offers the gradebook to OWNER and TEACHER, and to no one else', () => {
    expect(NAV.grades.roles).toEqual(['OWNER', 'TEACHER']);
  });

  it('does not offer the gradebook to an ASSISTANT', () => {
    // Stated separately from the equality above so the intent survives the
    // list being reordered or extended.
    expect(NAV.grades.roles).not.toContain('ASSISTANT');
    expect(NAV.grades.roles).not.toContain('STUDENT');
  });

  it('has no gradebook route under the assistant prefix to reach anyway', () => {
    // The nav is a hint; this is the part that holds. There is no
    // /assistant/:class/grades at all.
    expect(routeExists('assistant.$class_.grades')).toBe(false);
    expect(routeExists('assistant.$class_.grades.$login')).toBe(false);
  });

  it('offers the grading queue to the roles that actually grade', () => {
    expect(NAV.grading.roles).toContain('ASSISTANT');
    expect(NAV.grading.roles).toContain('TEACHER');
  });

  it('offers quiz management to the whole teaching team', () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT']) {
      expect(NAV.quizzes.roles).toContain(role);
    }
  });
});
