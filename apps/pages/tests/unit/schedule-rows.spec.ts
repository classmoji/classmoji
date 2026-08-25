/**
 * Unit tests for the class-site schedule's row mapper.
 *
 * These run in the Playwright runner without a browser or the dev stack: the
 * mapper is a pure function of (items, link targets).
 *
 * What they exist to hold:
 *  - A redacted row NEVER carries the identity of the thing it stands for. The
 *    service already builds placeholders from three fields, but this is the
 *    layer that turns them into text, and text is what ships.
 *  - A placeholder never gets an href. "Locked but clickable" is a worse bug
 *    than the empty schedule this replaced.
 *  - Order survives. Where a redacted item sits is part of the structure the
 *    public schedule exists to show.
 *  - Dates format identically on every machine — the anonymous schedule is
 *    shared-cacheable, so one server's rendering is served to everyone.
 */

import { test, expect } from '@playwright/test';

import { toScheduleRows, toScheduleSections, type ScheduleItem } from '~/site/scheduleRows.ts';

const targets = {
  pagePath: (page: { slug: string | null; id: string }) => `/${page.slug || page.id}`,
  slidesUrl: 'https://slides.example',
  appBase: 'https://app.example/student/cs52',
};

const visiblePage = (id: string, title: string, slug: string | null = null): ScheduleItem => ({
  kind: 'visible',
  item_type: 'PAGE',
  page: { id, title, slug },
});

const placeholder = (
  id: string,
  item_type: ScheduleItem['item_type'],
  due_at: Date | string | null = null
): ScheduleItem => ({ kind: 'placeholder', id, item_type, due_at });

test.describe('visible rows', () => {
  test('a public page becomes an internal link at its slug', () => {
    const [row] = toScheduleRows([visiblePage('p1', 'Syllabus', 'syllabus')], targets);
    expect(row).toEqual({
      kind: 'link',
      label: 'Syllabus',
      href: '/syllabus',
      typeLabel: 'Page',
      external: false,
    });
  });

  test('a deck, a repo and a quiz keep the external links a member expects', () => {
    const rows = toScheduleRows(
      [
        { kind: 'visible', item_type: 'SLIDE', slide: { id: 's1', title: 'Lecture 1' } },
        {
          kind: 'visible',
          item_type: 'REPOSITORY',
          repository: { id: 'r1', title: 'hello-world' },
        },
        { kind: 'visible', item_type: 'QUIZ', quiz: { id: 'q1', name: 'Quiz 1' } },
      ],
      targets
    );

    expect(rows).toEqual([
      {
        kind: 'link',
        label: 'Lecture 1',
        href: 'https://slides.example/s1',
        typeLabel: 'Slides',
        external: true,
      },
      {
        kind: 'link',
        label: 'hello-world',
        href: 'https://app.example/student/cs52/repos',
        typeLabel: 'Assignment',
        external: true,
      },
      {
        kind: 'link',
        label: 'Quiz 1',
        href: 'https://app.example/student/cs52/quizzes',
        typeLabel: 'Quiz',
        external: true,
      },
    ]);
  });

  test('an untitled target still gets a label rather than an empty link', () => {
    const [row] = toScheduleRows([visiblePage('p1', '', null)], targets);
    expect(row).toMatchObject({ label: 'Untitled', href: '/p1' });
  });

  test('a visible item whose target row vanished is dropped, not locked', () => {
    // A placeholder promises something is there. Nothing is.
    const rows = toScheduleRows([{ kind: 'visible', item_type: 'PAGE', page: null }], targets);
    expect(rows).toEqual([]);
  });
});

test.describe('placeholder rows', () => {
  test('carries only a type label and a date — never a label or an href', () => {
    const rows = toScheduleRows([placeholder('i1', 'REPOSITORY', '2026-09-12T12:00:00')], targets);

    expect(rows).toEqual([
      { kind: 'placeholder', id: 'i1', typeLabel: 'Assignment', due: 'Sep 12, 2026' },
    ]);
    expect(rows[0]).not.toHaveProperty('href');
    expect(rows[0]).not.toHaveProperty('label');
  });

  test('names each item type the way the course does', () => {
    const rows = toScheduleRows(
      [
        placeholder('a', 'REPOSITORY'),
        placeholder('b', 'QUIZ'),
        placeholder('c', 'PAGE'),
        placeholder('d', 'SLIDE'),
      ],
      targets
    );
    expect(rows.map(row => 'typeLabel' in row && row.typeLabel)).toEqual([
      'Assignment',
      'Quiz',
      'Page',
      'Slides',
    ]);
  });

  test('an item with no deadline gets no date rather than an invented one', () => {
    const [row] = toScheduleRows([placeholder('i1', 'PAGE', null)], targets);
    expect(row).toMatchObject({ due: null });
  });

  test('a Date and its serialized form format identically', () => {
    // Loader data crosses a serialization boundary; both sides must read alike.
    const asDate = toScheduleRows([placeholder('i1', 'QUIZ', new Date(2026, 8, 12, 12))], targets);
    const asString = toScheduleRows([placeholder('i1', 'QUIZ', '2026-09-12T12:00:00')], targets);
    expect(asDate).toEqual(asString);
    expect(asDate[0]).toMatchObject({ due: 'Sep 12, 2026' });
  });

  test('an unparseable date degrades to no date instead of "Invalid Date"', () => {
    const [row] = toScheduleRows([placeholder('i1', 'QUIZ', 'not-a-date')], targets);
    expect(row).toMatchObject({ due: null });
  });
});

test.describe('sections', () => {
  test('placeholders interleave with links at their authored positions', () => {
    const [section] = toScheduleSections(
      [
        {
          id: 'mod-1',
          title: 'Week 1',
          items: [
            visiblePage('p1', 'Reading', 'reading'),
            placeholder('i2', 'REPOSITORY', '2026-09-12T12:00:00'),
            visiblePage('p2', 'Notes', 'notes'),
            placeholder('i4', 'QUIZ'),
          ],
        },
      ],
      targets
    );

    expect(section.rows.map(row => row.kind)).toEqual([
      'link',
      'placeholder',
      'link',
      'placeholder',
    ]);
  });

  test("Tim's Welcome module: a title plus two locked rows, one dated", () => {
    // The case this exists for. Published + public module, a repository with a
    // deadline and a members-only page — the schedule used to render nothing.
    const [section] = toScheduleSections(
      [
        {
          id: 'mod-welcome',
          title: 'Welcome',
          items: [
            placeholder('item-repo', 'REPOSITORY', '2026-09-12T12:00:00'),
            placeholder('item-page', 'PAGE'),
          ],
        },
      ],
      targets
    );

    expect(section.title).toBe('Welcome');
    expect(section.rows).toEqual([
      { kind: 'placeholder', id: 'item-repo', typeLabel: 'Assignment', due: 'Sep 12, 2026' },
      { kind: 'placeholder', id: 'item-page', typeLabel: 'Page', due: null },
    ]);
  });

  test('a module with nothing to show survives as a bare title', () => {
    const sections = toScheduleSections([{ id: 'mod-4', title: 'Week 3', items: [] }], targets);
    expect(sections).toEqual([{ id: 'mod-4', title: 'Week 3', rows: [] }]);
  });

  test('no placeholder anywhere mentions a title, slug or template', () => {
    // The guarantee, stated over the rendered output rather than the shape:
    // whatever the mapper emits for a redacted item, none of it is content.
    const sections = toScheduleSections(
      [
        {
          id: 'mod-1',
          title: 'Week 1',
          items: [
            placeholder('i1', 'REPOSITORY', '2026-09-12T12:00:00'),
            placeholder('i2', 'PAGE'),
            placeholder('i3', 'SLIDE'),
            placeholder('i4', 'QUIZ'),
          ],
        },
      ],
      targets
    );

    for (const row of sections[0].rows) {
      expect(Object.keys(row).sort()).toEqual(['due', 'id', 'kind', 'typeLabel']);
    }
  });
});
