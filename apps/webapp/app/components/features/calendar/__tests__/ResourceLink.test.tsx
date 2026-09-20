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

  it('sends staff to the repositories page, anchored at the repository', () => {
    // Deliberate: staff have no repo of their own in the class, so there is no
    // issue to deep-link them into.
    expect(resourceDestination(assignment, STAFF)).toEqual({
      kind: 'internal',
      to: '/admin/cs52-26f/repos#landing-page',
    });
  });

  it('falls back for a student who has not been assigned a repo yet', () => {
    expect(
      resourceDestination(assignment, { ...STUDENT, repoAssignmentsByAssignmentId: {} })
    ).toEqual({ kind: 'internal', to: '/student/cs52-26f/repos#landing-page' });
  });

  it('falls back when half the issue URL is missing', () => {
    const noOrg = { ...STUDENT, gitOrgLogin: null };
    expect(resourceDestination(assignment, noOrg).kind).toBe('internal');

    const noRepoName: ResourceLinkContext = {
      ...STUDENT,
      repoAssignmentsByAssignmentId: { 'a-1': { provider_issue_number: 7, git_repo: null } },
    };
    expect(resourceDestination(assignment, noRepoName).kind).toBe('internal');

    const noIssue: ResourceLinkContext = {
      ...STUDENT,
      repoAssignmentsByAssignmentId: { 'a-1': { git_repo: { name: 'landing-page-jane' } } },
    };
    expect(resourceDestination(assignment, noIssue).kind).toBe('internal');
  });

  it('defaults to the student prefix when a caller names no role', () => {
    expect(resourceDestination(assignment, { classSlug: 'cs52-26f' })).toMatchObject({
      to: '/student/cs52-26f/repos#landing-page',
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

  it('stars the featured resource only where a caller asks for it', () => {
    const featured = { ...deck, featured: true };
    expect(render(featured, STAFF, 'chip', true)).toContain('text-amber-500/90');
    expect(render(featured, STAFF, 'chip', false)).not.toContain('text-amber-500/90');
    expect(render(deck, STAFF, 'chip', true)).not.toContain('text-amber-500/90');
  });
});
