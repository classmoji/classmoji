/**
 * Where a linked resource goes, asserted once — because three surfaces now ask
 * the same function, and the bug this replaces was exactly two of them
 * answering differently.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import ResourceLink, {
  PAGES_URL_FALLBACK,
  featuredResource,
  resourceDestination,
  resourceKey,
  resourcesForEvent,
} from '../ResourceLink';
import type { CalendarResource, ResourceLinkContext } from '../ResourceLink';
import type { CalendarEventWithLinks } from '../types';

const page: CalendarResource = { kind: 'page', id: 'p-1', title: 'Logistics', is_draft: false };
const deck: CalendarResource = { kind: 'slide', id: 's-1', title: 'Lecture 1', is_draft: false };
const assignment: CalendarResource = {
  kind: 'assignment',
  id: 'a-1',
  title: 'Landing Page Part 1',
  is_draft: false,
  repoSlug: 'landing-page',
};

const STUDENT: ResourceLinkContext = {
  classSlug: 'cs52-26f',
  rolePrefix: 'student',
  pagesUrl: 'https://pages.test',
  slidesUrl: 'https://slides.test',
  gitOrgLogin: 'cs52',
  repoAssignmentsByAssignmentId: {
    'a-1': { provider_issue_number: 7, git_repo: { name: 'landing-page-jane' } },
  },
};

const STAFF: ResourceLinkContext = {
  classSlug: 'cs52-26f',
  rolePrefix: 'admin',
  pagesUrl: 'https://pages.test',
  slidesUrl: 'https://slides.test',
};

const TEACHER: ResourceLinkContext = { ...STAFF, rolePrefix: 'teacher' };
const ASSISTANT: ResourceLinkContext = { ...STAFF, rolePrefix: 'assistant' };

const formAssignment: CalendarResource = {
  kind: 'assignment',
  id: 'a-form',
  title: 'Exit ticket',
  is_draft: false,
  repoSlug: null,
  assignmentType: 'FORM',
};
const quizAssignment: CalendarResource = {
  ...formAssignment,
  id: 'a-quiz',
  title: 'Recursion quiz',
  assignmentType: 'QUIZ',
};

describe('resourceDestination', () => {
  it('sends a page to the pages app, under the classroom', () => {
    expect(resourceDestination(page, STAFF)).toEqual({
      kind: 'page',
      pageId: 'p-1',
      href: 'https://pages.test/cs52-26f/p-1',
    });
  });

  it('falls back to the dev pages origin the loaders use', () => {
    expect(resourceDestination(page, { classSlug: 'cs52-26f' })).toMatchObject({
      href: `${PAGES_URL_FALLBACK}/cs52-26f/p-1`,
    });
  });

  it('sends a deck to the slides viewer', () => {
    expect(resourceDestination(deck, STAFF)).toEqual({
      kind: 'external',
      href: 'https://slides.test/s-1',
    });
  });

  it('sends a student with a repo to their OWN GitHub issue', () => {
    // Built from `git_repo.name`, which is what the loader sends and what
    // every other GitHub issue URL in the app is built from. The modal used to
    // read `repository.name` — a field a GitRepoAssignment does not have — so
    // this branch was dead and every student got the fallback below.
    expect(resourceDestination(assignment, STUDENT)).toEqual({
      kind: 'external',
      href: 'https://github.com/cs52/landing-page-jane/issues/7',
    });
  });

  it('sends staff to the assignment page, where the roster and grading live', () => {
    // Deliberate: staff have no repo of their own in the class, so there is no
    // issue to deep-link them into.
    expect(resourceDestination(assignment, STAFF)).toEqual({
      kind: 'internal',
      to: '/admin/cs52-26f/assignments/a-1',
    });
  });

  it('sends a student with a push-mode repo (no issue) to the repo itself', () => {
    const pushMode: ResourceLinkContext = {
      ...STUDENT,
      repoAssignmentsByAssignmentId: { 'a-1': { git_repo: { name: 'landing-page-jane' } } },
    };
    expect(resourceDestination(assignment, pushMode)).toEqual({
      kind: 'external',
      href: 'https://github.com/cs52/landing-page-jane',
    });
  });

  it('falls back to the Assignments page for a student who has no repo yet', () => {
    expect(
      resourceDestination(assignment, { ...STUDENT, repoAssignmentsByAssignmentId: {} })
    ).toEqual({ kind: 'internal', to: '/student/cs52-26f/assignments' });
  });

  it('falls back when half the issue URL is missing', () => {
    const noOrg = { ...STUDENT, gitOrgLogin: null };
    expect(resourceDestination(assignment, noOrg).kind).toBe('internal');

    const noRepoName: ResourceLinkContext = {
      ...STUDENT,
      repoAssignmentsByAssignmentId: { 'a-1': { provider_issue_number: 7, git_repo: null } },
    };
    expect(resourceDestination(assignment, noRepoName).kind).toBe('internal');

  });

  it('defaults to the student prefix when a caller names no role', () => {
    expect(resourceDestination(assignment, { classSlug: 'cs52-26f' })).toMatchObject({
      to: '/student/cs52-26f/assignments',
    });
  });

  it('sends an owner or a teacher to a form assignment’s page, which hands on to the form', () => {
    expect(resourceDestination(formAssignment, STAFF)).toEqual({
      kind: 'internal',
      to: '/admin/cs52-26f/assignments/a-form',
    });
    expect(resourceDestination(formAssignment, TEACHER)).toEqual({
      kind: 'internal',
      to: '/teacher/cs52-26f/assignments/a-form',
    });
  });

  it('sends an assistant nowhere for a form assignment, since /assistant has no forms screen', () => {
    // The assignment page 404s a form assignment under /assistant; a link
    // there would only lead to that.
    expect(resourceDestination(formAssignment, ASSISTANT)).toEqual({ kind: 'none' });
  });

  it('still links an assistant to a quiz assignment, which /assistant does serve', () => {
    expect(resourceDestination(quizAssignment, ASSISTANT)).toEqual({
      kind: 'internal',
      to: '/assistant/cs52-26f/assignments/a-quiz',
    });
  });
});

describe('resourcesForEvent', () => {
  const event: CalendarEventWithLinks = {
    start_time: new Date(2026, 8, 22, 10).toISOString(),
    end_time: new Date(2026, 8, 22, 12).toISOString(),
    event_type: 'LECTURE',
    pages: [
      { page: { id: 'p-1', title: 'Logistics', is_draft: false } },
      { page: { id: 'p-2', title: 'Notes', is_draft: true } },
    ],
    slides: [{ slide: { id: 's-1', title: 'Lecture 1', is_draft: false } }],
    assignments: [
      {
        assignment: { id: 'a-1', title: 'Landing Page Part 1', is_published: true },
        repository: { slug: 'landing-page', is_published: true },
      },
    ],
  };

  it('flattens all three kinds, in the order the service sent them', () => {
    expect(resourcesForEvent(event).map(r => r.id)).toEqual(['p-1', 'p-2', 's-1', 'a-1']);
  });

  it('puts the starred resource first, and leaves the rest in order', () => {
    const starred = {
      ...event,
      featured_resource: { kind: 'slide' as const, id: 's-1', title: 'Lecture 1', is_draft: false },
    };
    const resources = resourcesForEvent(starred);

    expect(resources.map(r => r.id)).toEqual(['s-1', 'p-1', 'p-2', 'a-1']);
    expect(resources[0].featured).toBe(true);
    expect(resources[1].featured).toBe(false);
  });

  it('marks a draft page and an unpublished assignment the same way', () => {
    const withUnpublished: CalendarEventWithLinks = {
      ...event,
      assignments: [
        {
          assignment: { id: 'a-1', title: 'Landing Page Part 1', is_published: true },
          // Published assignment, unpublished repository: the link list has
          // always marked that pair together.
          repository: { slug: 'landing-page', is_published: false },
        },
      ],
    };
    const byId = Object.fromEntries(
      resourcesForEvent(withUnpublished).map(r => [r.id, r.is_draft])
    );

    expect(byId['p-1']).toBe(false);
    expect(byId['p-2']).toBe(true);
    expect(byId['a-1']).toBe(true);
  });

  it('shows the same resource once, however many buckets it arrives in', () => {
    // A non-recurring event can carry a link written against its NULL-date
    // bucket AND one written against one of its dates; both surface for the
    // same occurrence. Twice over that is a duplicated React key, a chip drawn
    // twice, and a `+N` counting something already on screen.
    const doubled: CalendarEventWithLinks = {
      ...event,
      pages: [
        { page: { id: 'p-1', title: 'Logistics', is_draft: false } },
        { page: { id: 'p-1', title: 'Logistics', is_draft: false } },
      ],
      slides: [],
      assignments: [],
    };

    expect(resourcesForEvent(doubled).map(r => r.id)).toEqual(['p-1']);
  });

  it('does not confuse a page and a deck that happen to share an id', () => {
    const sameId: CalendarEventWithLinks = {
      ...event,
      pages: [{ page: { id: 'shared', title: 'A page', is_draft: false } }],
      slides: [{ slide: { id: 'shared', title: 'A deck', is_draft: false } }],
      assignments: [],
    };

    expect(resourcesForEvent(sameId).map(resourceKey)).toEqual(['page-shared', 'slide-shared']);
  });

  it('keeps the star when the duplicate is the starred one', () => {
    const doubled: CalendarEventWithLinks = {
      ...event,
      pages: [
        { page: { id: 'p-1', title: 'Logistics', is_draft: false } },
        { page: { id: 'p-1', title: 'Logistics', is_draft: false } },
      ],
      slides: [{ slide: { id: 's-1', title: 'Lecture 1', is_draft: false } }],
      assignments: [],
      featured_resource: { kind: 'page', id: 'p-1', title: 'Logistics', is_draft: false },
    };
    const resources = resourcesForEvent(doubled);

    expect(resources.map(r => r.id)).toEqual(['p-1', 's-1']);
    expect(resources[0].featured).toBe(true);
  });

  it('carries an assignment’s type, on the list and on the starred line alike', () => {
    const withForm: CalendarEventWithLinks = {
      ...event,
      assignments: [
        {
          assignment: { id: 'a-form', title: 'Exit ticket', is_published: true, type: 'FORM' },
          repository: null,
        },
      ],
    };
    const star = { kind: 'assignment' as const, id: 'a-form', title: 'Exit ticket', is_draft: false };

    expect(resourcesForEvent(withForm).find(r => r.id === 'a-form')?.assignmentType).toBe('FORM');
    expect(featuredResource(star, withForm).assignmentType).toBe('FORM');
  });

  it('is empty for an event with nothing linked to it', () => {
    expect(resourcesForEvent({ ...event, pages: null, slides: null, assignments: null })).toEqual(
      []
    );
  });
});

describe('ResourceLink', () => {
  const render = (
    resource: CalendarResource,
    context: ResourceLinkContext,
    variant: 'list' | 'row' | 'chip',
    showStar = false
  ) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <ResourceLink resource={resource} context={context} variant={variant} showStar={showStar} />
      </MemoryRouter>
    );

  it('names the kind as well as the title, in every variant', () => {
    for (const variant of ['list', 'row', 'chip'] as const) {
      expect(render(page, STAFF, variant)).toContain('aria-label="Open page Logistics"');
    }
  });

  it('renders the same destination whichever variant draws it', () => {
    for (const variant of ['list', 'row', 'chip'] as const) {
      expect(render(deck, STAFF, variant)).toContain('href="https://slides.test/s-1"');
      expect(render(assignment, STUDENT, variant)).toContain(
        'href="https://github.com/cs52/landing-page-jane/issues/7"'
      );
    }
  });

  it('keeps the whole title as a tooltip, because a chip truncates', () => {
    const html = render({ ...deck, title: 'A very long deck name' }, STAFF, 'chip');
    expect(html).toContain('title="A very long deck name"');
    expect(html).toContain('truncate');
  });

  it('makes a chip pointer-active, in every branch', () => {
    // A week block hands its whole area to the event's button and makes the
    // column over it transparent to the pointer, so a chip is pressable only
    // because it asks to be. Without this the chips render, and nothing
    // happens when you click one.
    for (const resource of [page, deck, assignment]) {
      expect(render(resource, STAFF, 'chip')).toContain('pointer-events-auto');
    }
  });

  it('climbs out of the utility layer for a chip’s colour, as the month line does', () => {
    // antd injects an UNLAYERED `a { color: … }`, which beats a layered
    // Tailwind utility whatever the specificity.
    const html = render(deck, STAFF, 'chip');
    expect(html).toContain('text-ink-2!');
    expect(html).toContain('hover:text-ink-0!');
  });

  it('marks a draft for staff, in the pill and in the name', () => {
    const draft = render({ ...page, is_draft: true }, STAFF, 'chip');
    expect(draft).toContain('Draft');
    // The pill is a visual; the name is what a screen reader gets, and "your
    // class cannot see this yet" is the whole point of marking it.
    expect(draft).toContain('aria-label="Open page Logistics (draft)"');

    const published = render(page, STAFF, 'chip');
    expect(published).not.toContain('Draft');
    expect(published).toContain('aria-label="Open page Logistics"');
  });

  it('reads one colour down the modal list, whatever element each row is', () => {
    // A page is a <button> there (the peek drawer) while a deck and an
    // assignment are anchors — and antd's unlayered `a { color }` beats a
    // layered utility, so the three rows read as two colours without the `!`.
    for (const resource of [page, deck, assignment]) {
      const html = render(resource, STAFF, 'list');
      expect(html).toContain('text-blue-600!');
      expect(html).toContain('dark:text-blue-400!');
    }
  });

  it('draws a form assignment as a label for an assistant, in every variant', () => {
    for (const variant of ['list', 'row', 'chip'] as const) {
      const html = render(formAssignment, ASSISTANT, variant);
      expect(html).not.toContain('<a');
      expect(html).not.toContain('href=');
      // A label is not a control, so it is not named as one.
      expect(html).not.toContain('aria-label="Open');
      expect(html).toContain('Exit ticket');
      expect(html).toContain('title="Exit ticket"');
      // The plain text colour, and no link colour, underline or hover on it.
      expect(html).toContain('text-ink-2');
      expect(html).not.toContain('text-blue-600');
      expect(html).not.toContain('underline');
      expect(html).not.toContain('hover:');
    }
    // Still pressable on a week block, so its truncated title shows on hover.
    expect(render(formAssignment, ASSISTANT, 'chip')).toContain('pointer-events-auto');
  });

  it('links a form assignment for an owner and a teacher as before', () => {
    expect(render(formAssignment, STAFF, 'chip')).toContain(
      'href="/admin/cs52-26f/assignments/a-form"'
    );
    expect(render(formAssignment, TEACHER, 'chip')).toContain(
      'href="/teacher/cs52-26f/assignments/a-form"'
    );
    expect(render(formAssignment, TEACHER, 'chip')).toContain(
      'aria-label="Open assignment Exit ticket"'
    );
  });

  it('stars the featured resource only where a caller asks for it', () => {
    const featured = { ...deck, featured: true };
    expect(render(featured, STAFF, 'chip', true)).toContain('text-amber-500/90');
    expect(render(featured, STAFF, 'chip', false)).not.toContain('text-amber-500/90');
    expect(render(deck, STAFF, 'chip', true)).not.toContain('text-amber-500/90');
  });
});
