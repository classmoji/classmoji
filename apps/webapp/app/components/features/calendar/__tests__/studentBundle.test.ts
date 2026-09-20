/**
 * The student calendar must not be able to reach `@dnd-kit`.
 *
 * Drag and drop is staff-only, and the library is ~45 KB that every student
 * page showing a calendar would otherwise download. The whole shape of this
 * folder — grids that take render props, one drag layer that supplies them —
 * exists to keep that true, and nothing about it is enforced by the type
 * system: a single convenience import of `CalendarDragLayer` from a shared grid
 * would undo it silently, and only a bundle inspection after a build would
 * notice.
 *
 * So the import graph is walked here instead, from source, in milliseconds.
 * It is deliberately crude: it reads every `from '…'` in the file, which is
 * broader than what actually ships (a type-only import costs nothing at
 * runtime). Broader is the right side to err on — a `import type { … } from
 * './CalendarDragLayer'` is still a sign the split has started to blur.
 */

import { readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const CALENDAR_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = join(CALENDAR_DIR, 'StudentCalendarView.tsx');

/** Every `from '…'` specifier in a file, import or re-export. */
const specifiersIn = (source: string): string[] =>
  [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Where `~/…` points: the webapp's `app` directory, as tsconfig maps it. */
const APP_DIR = resolve(CALENDAR_DIR, '..', '..', '..');

/** Whether a specifier is one the app resolves itself rather than a package. */
const isLocalSpecifier = (specifier: string): boolean =>
  specifier.startsWith('.') || specifier.startsWith('~/');

/**
 * A relative or aliased specifier as a path on disk, or null if it is a bare
 * package.
 *
 * `~/…` has to RESOLVE, not be waved through as a package. The calendar
 * reaches the page-peek components that way, and while the walk stopped at the
 * first alias, a `~/components/features/calendar/CalendarDragLayer` anywhere
 * downstream would have passed this file in silence.
 */
const resolveLocal = (fromFile: string, specifier: string): string | null => {
  if (!isLocalSpecifier(specifier)) return null;
  const base = specifier.startsWith('~/')
    ? resolve(APP_DIR, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find(isFile) ?? null;
};

/** Every local module reachable from `entry`, plus every bare package seen. */
const walk = (entry: string): { files: Set<string>; packages: Set<string> } => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);

    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      const local = resolveLocal(file, specifier);
      if (local) queue.push(local);
      // A specifier the app WOULD resolve and this walk could not is recorded
      // as it was written, so an unresolvable `~/…` cannot hide behind the
      // fact that nothing followed it.
      else packages.add(specifier);
    }
  }

  return { files, packages };
};

describe('the student calendar module graph', () => {
  const { files, packages } = walk(ENTRY);
  const named = [...files].map(file => relative(CALENDAR_DIR, file)).sort();
  const specifiers = [...packages];

  it('reaches the shared grids, so this test is actually walking something', () => {
    expect(named).toContain('StudentCalendarView.tsx');
    expect(named).toContain('WeekGrid.tsx');
    expect(named).toContain('MonthGrid.tsx');
    expect(named).toContain('AllDayStrip.tsx');
    expect(named).toContain('EventCard.tsx');
  });

  it('follows the ~ alias, so nothing hides behind it', () => {
    // The calendar reaches the page-peek components through `~/…`; while that
    // was treated as a bare package the walk stopped there, and anything the
    // peek drawer reached was outside this test's reach too.
    expect(named).toContain('../pages/index.ts');
    expect(named).toContain('../pages/PagePeekProvider.tsx');
    expect(specifiers.filter(name => name.startsWith('~/'))).toEqual([]);
  });

  it('never reaches the drag layer', () => {
    expect(named).not.toContain('CalendarDragLayer.tsx');
    // By any spelling: a `~/components/features/calendar/CalendarDragLayer`
    // that this walk could not resolve would show up here instead.
    expect(specifiers.filter(name => name.includes('CalendarDragLayer'))).toEqual([]);
    expect(named.filter(name => name.includes('CalendarDragLayer'))).toEqual([]);
  });

  it('never reaches @dnd-kit, by any path', () => {
    expect(specifiers.filter(name => name.includes('@dnd-kit'))).toEqual([]);
  });
});

describe('the staff calendar module graph', () => {
  // The other half of the claim: the split is only meaningful while the staff
  // calendar DOES reach the library. If this ever fails, drag and drop is gone
  // and the test above has become true for the wrong reason.
  const { packages } = walk(join(CALENDAR_DIR, 'CourseCalendar.tsx'));

  it('reaches @dnd-kit', () => {
    expect([...packages]).toContain('@dnd-kit/core');
  });
});
