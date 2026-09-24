/**
 * One link to one thing an event is linked to — and the ONE place that decides
 * where each kind of thing goes.
 *
 * Three surfaces draw these links: the detail modal's list, the starred line
 * under a month chip, and the chips on a week block. They looked different and
 * were written three times, which is how the modal ended up building a
 * student's GitHub issue URL out of a field the loader does not send, while
 * the month line sent the same student to the repositories page instead. A
 * link that lands somewhere different depending on which grid you clicked it
 * from is worse than either destination on its own.
 *
 * So the destination is answered once, in `resourceDestination`, and the three
 * surfaces are three sets of classes over it.
 *
 * Every variant is a SIBLING of the event's button, never inside it: an anchor
 * nested in a button is not something a browser can render. Each one also stops
 * `pointerdown`, `mousedown` and `click` from travelling, so clicking a link
 * neither starts a drag (dnd-kit's PointerSensor listens on an ancestor in the
 * staff calendar, and a 3px wobble is enough to arm it) nor opens the modal.
 */

import { NavLink } from 'react-router';
import {
  IconClipboardList,
  IconExternalLink,
  IconFileText,
  IconPresentation,
  IconStarFilled,
} from '@tabler/icons-react';
import type { CalendarEventWithLinks, CalendarFeaturedResource } from './types';
import DraftPill from './DraftPill';
import { PageLink, usePagePeek } from '~/components/features/pages';

export type ResourceKind = CalendarFeaturedResource['kind'];

/** One linked resource, flattened out of an event's three link arrays. */
export interface CalendarResource {
  kind: ResourceKind;
  id: string;
  title: string;
  /**
   * Not published, and therefore staff-only. On an assignment it covers the
   * pair the link list has always marked together: an unpublished assignment,
   * or one in an unpublished repository.
   */
  is_draft: boolean;
  /** Assignments only: the anchor the repositories page scrolls to. */
  repoSlug?: string | null;
  /** The one the instructor starred, i.e. the one month view shows. */
  featured?: boolean;
}

/**
 * What a viewer's own repository assignment has to say for an assignment link
 * to become a GitHub issue link.
 *
 * `git_repo.name` is the GitHub repository — the name in the issue's URL. The
 * modal used to read `repository.name` here, which `gitRepoAssignment.findForUser`
 * does not return (a GitRepoAssignment has a `git_repo`, and the `repository`
 * relation hangs off THAT), so the check was never true and every student was
 * quietly sent to the repositories page instead. Every other GitHub issue URL
 * in the app is built from `git_repo.name`.
 */
export interface RepositoryAssignmentLinkInfo {
  provider_issue_number?: number | null;
  git_repo?: { name?: string | null } | null;
}

/**
 * Everything a link needs that is about the VIEWER rather than the resource.
 * Threaded from the route, because no grid knows which classroom or which role
 * is looking at it.
 *
 * The last two are the student's own repository assignments. Staff loaders do
 * not send them and should not: staff have no personal repo in the class, so
 * the repositories page IS the right destination for them.
 */
export interface ResourceLinkContext {
  classSlug?: string;
  rolePrefix?: string;
  pagesUrl?: string;
  slidesUrl?: string;
  gitOrgLogin?: string | null;
  repoAssignmentsByAssignmentId?: Record<string, RepositoryAssignmentLinkInfo | undefined>;
}

/** What the loaders fall back to when `PAGES_URL` is unset in development. */
export const PAGES_URL_FALLBACK = 'http://localhost:7100';

/** Where one resource goes, and in what kind of element. */
export type ResourceDestination =
  /** A classroom page: the peek drawer where it is mounted, a new tab where it is not. */
  | { kind: 'page'; pageId: string; href: string }
  /** Off-site or another app: a new tab. */
  | { kind: 'external'; href: string }
  /** Inside this app: a client-side navigation. */
  | { kind: 'internal'; to: string };

export const resourceDestination = (
  resource: CalendarResource,
  context: ResourceLinkContext = {}
): ResourceDestination => {
  const classSlug = context.classSlug ?? '';

  if (resource.kind === 'page') {
    return {
      kind: 'page',
      pageId: resource.id,
      href: `${context.pagesUrl ?? PAGES_URL_FALLBACK}/${classSlug}/${resource.id}`,
    };
  }

  if (resource.kind === 'slide') {
    return { kind: 'external', href: `${context.slidesUrl ?? ''}/${resource.id}` };
  }

  // A student with a repository of their own goes straight to it: the issue
  // for this assignment in ISSUE mode, the repo itself in REPO mode (a push
  // is the submission, there is no issue). Staff go to the assignment page,
  // where the roster and grading live; a student without a repo yet goes to
  // their Assignments page. There is no student repositories page any more.
  const repoAssignment = context.repoAssignmentsByAssignmentId?.[resource.id];
  const repoName = repoAssignment?.git_repo?.name;
  if (context.gitOrgLogin && repoName) {
    const repoUrl = `https://github.com/${context.gitOrgLogin}/${repoName}`;
    return {
      kind: 'external',
      href: repoAssignment?.provider_issue_number
        ? `${repoUrl}/issues/${repoAssignment.provider_issue_number}`
        : repoUrl,
    };
  }

  const rolePrefix = context.rolePrefix ?? 'student';
  return {
    kind: 'internal',
    to:
      rolePrefix === 'student'
        ? `/student/${classSlug}/assignments`
        : `/${rolePrefix}/${classSlug}/assignments/${resource.id}`,
  };
};

/**
 * Everything an event links to, for the viewer whose payload this is, starred
 * one first.
 *
 * The service has already filtered these for the viewer: a student's payload
 * carries no draft page, no draft deck and no link to an unpublished
 * assignment, so "show all" here means all of what they were sent.
 *
 * The sort is stable, so within each group the service's order survives — and
 * putting the starred one first is what makes the week view agree with the
 * month view about which resource matters most.
 *
 * Deduped by kind and id, because the same resource can arrive twice: a link
 * written against a non-recurring event's NULL-date bucket and a link written
 * against one of its dates both surface for the same occurrence. Left alone
 * that is a duplicated React key, a chip drawn twice, and a `+N` counting
 * something the reader can already see.
 */
export const resourcesForEvent = (event: CalendarEventWithLinks): CalendarResource[] => {
  const featured = event.featured_resource ?? null;
  const isFeatured = (kind: ResourceKind, id: string) =>
    featured !== null && featured.kind === kind && featured.id === id;

  const resources: CalendarResource[] = [
    ...(event.pages ?? []).map(({ page }) => ({
      kind: 'page' as const,
      id: page.id,
      title: page.title,
      is_draft: page.is_draft,
      featured: isFeatured('page', page.id),
    })),
    ...(event.slides ?? []).map(({ slide }) => ({
      kind: 'slide' as const,
      id: slide.id,
      title: slide.title,
      is_draft: slide.is_draft,
      featured: isFeatured('slide', slide.id),
    })),
    ...(event.assignments ?? []).map(({ assignment, repository }) => ({
      kind: 'assignment' as const,
      id: assignment.id,
      title: assignment.title,
      is_draft: assignment.is_published === false || repository?.is_published === false,
      repoSlug: repository?.slug ?? null,
      featured: isFeatured('assignment', assignment.id),
    })),
  ];

  const seen = new Set<string>();
  const unique = resources.filter(resource => {
    const key = resourceKey(resource);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.sort((a, b) => Number(b.featured) - Number(a.featured));
};

/** The one identity a resource has, for React keys and for deduping. */
export const resourceKey = (resource: Pick<CalendarResource, 'kind' | 'id'>): string =>
  `${resource.kind}-${resource.id}`;

/**
 * The starred resource as a `CalendarResource`. It carries no repository slug
 * of its own — that is the anchor the repositories page scrolls to, and it
 * lives on the event's assignment list.
 */
export const featuredResource = (
  featured: CalendarFeaturedResource,
  event: CalendarEventWithLinks
): CalendarResource => ({
  ...featured,
  featured: true,
  repoSlug:
    featured.kind === 'assignment'
      ? ((event.assignments ?? []).find(a => a.assignment.id === featured.id)?.repository?.slug ??
        null)
      : null,
});

/**
 * One icon per kind. Exported because a block too short for chips shows the
 * same icons as a cluster, and two icon sets for one kind would be two
 * different answers to "what is this?".
 */
export const RESOURCE_ICONS = {
  page: IconFileText,
  slide: IconPresentation,
  assignment: IconClipboardList,
} as const;

const ICONS = RESOURCE_ICONS;

/** What the accessible name calls each kind, so three links are tellable apart. */
export const KIND_NOUN = {
  page: 'page',
  slide: 'slide deck',
  assignment: 'assignment',
} as const;

/**
 * Where this link is being drawn.
 *
 * - `list` — the detail modal, which has room for a full row per link.
 * - `row`  — the starred line under a month chip: one muted line, truncated.
 * - `chip` — a week block, in a column about 107px wide.
 */
export type ResourceLinkVariant = 'list' | 'row' | 'chip';

/**
 * ── WHY SOME COLOURS CARRY `!` ──────────────────────────────────────────────
 * antd's `genLinkStyle` injects a bare `a { color: colorLink; text-decoration:
 * … }` into the document, and `colorLink` is this app's accent green. It is
 * UNLAYERED, while Tailwind v4 puts its utilities in `@layer utilities` — and
 * unlayered CSS beats layered CSS whatever the specificity, so a plain
 * `text-ink-2` on an `<a>` loses to a bare type selector. The `!` modifier is
 * what climbs back out of the layer.
 *
 * Only the anchor branches are under that rule, but the marker stays on the
 * shared class: branches that have to look identical should not be styled two
 * different ways, and nothing competes for these properties on a `<button>`.
 *
 * The modal's list needs it as much as the other two: a page link is a
 * `<button>` there (the peek drawer) while a deck and an assignment are
 * anchors, so the three rows of one list read as two different colours.
 */
export const LIST_LINK_CLASS =
  'flex items-center gap-2 text-sm text-blue-600! hover:text-blue-800! ' +
  'dark:text-blue-400! dark:hover:text-blue-300!';

const VARIANT_CLASS: Record<ResourceLinkVariant, string> = {
  list: LIST_LINK_CLASS,
  row:
    'flex items-center gap-1 pl-2 pr-1 w-full min-w-0 text-xs text-ink-2! no-underline! rounded ' +
    'hover:text-ink-0! hover:underline! transition-colors ' +
    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
  // `pointer-events-auto` is load-bearing: a week block hands its whole area
  // to the event's button and makes the column over it transparent to the
  // pointer, so a chip is only pressable because it asks to be.
  chip:
    'pointer-events-auto inline-flex items-center gap-1 min-w-0 max-w-full rounded px-1 py-px ' +
    'leading-none text-[0.6875rem] text-ink-2! no-underline! bg-white/70 dark:bg-neutral-900/40 ' +
    'hover:text-ink-0! hover:bg-white dark:hover:bg-neutral-900/80 transition-colors ' +
    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
};

const ICON_SIZE: Record<ResourceLinkVariant, number> = { list: 18, row: 12, chip: 12 };

/**
 * `PageLink` takes no event handlers of its own — it decides between a button
 * and an anchor — so a page link stops propagation from a wrapper instead.
 * The wrapper has to lay out like whatever it holds, or a chip stops sizing
 * itself to its column.
 */
const WRAPPER_CLASS: Record<ResourceLinkVariant, string> = {
  list: 'block min-w-0',
  row: 'block min-w-0',
  // Pointer-active for the same reason the chip itself is: the wrapper is what
  // carries the stop-propagation handlers, so it has to be hit first.
  chip: 'pointer-events-auto inline-flex min-w-0 max-w-full',
};

export interface ResourceLinkProps {
  resource: CalendarResource;
  context?: ResourceLinkContext;
  variant: ResourceLinkVariant;
  /**
   * Mark the starred one with a filled star, so a week block says the same
   * thing about it that the month cell does. Off in the modal, where the star
   * is an editable control rather than a label.
   */
  showStar?: boolean;
}

const ResourceLink = ({ resource, context = {}, variant, showStar = false }: ResourceLinkProps) => {
  const Icon = ICONS[resource.kind];
  // Null wherever the peek drawer is not mounted (the /admin shell) — which is
  // also where a page opens in a new tab, so the ↗ follows the BEHAVIOUR
  // rather than the kind.
  const peek = usePagePeek();
  const destination = resourceDestination(resource, context);

  /**
   * "Open page Logistics": a truncated title beside an icon names nothing.
   * A draft says so in the name as well as in its pill — only staff are ever
   * handed one, and "your class cannot see this yet" is the whole point of it.
   */
  const label = `Open ${KIND_NOUN[resource.kind]} ${resource.title}${
    resource.is_draft ? ' (draft)' : ''
  }`;
  const className = VARIANT_CLASS[variant];
  const size = ICON_SIZE[variant];

  const body = (newTab: boolean) => (
    <>
      <Icon size={size} className={variant === 'list' ? 'text-ink-3' : 'shrink-0'} />
      {showStar && resource.featured && (
        <IconStarFilled
          size={variant === 'list' ? 12 : 9}
          aria-hidden
          className="shrink-0 text-amber-500/90"
        />
      )}
      <span className={variant === 'list' ? 'underline' : 'truncate'}>{resource.title}</span>
      {resource.is_draft && <DraftPill />}
      {newTab && (
        <IconExternalLink size={variant === 'list' ? 14 : 11} className="shrink-0 text-ink-3" />
      )}
    </>
  );

  // React's synthetic handlers are what dnd-kit's listeners are too, so
  // stopping propagation here is enough to keep a press off the drag layer.
  // `mousedown` as well as `pointerdown`: the grid's own drag-to-select
  // listens for the mouse event, and a chip is drawn over a droppable cell.
  const stop = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  if (destination.kind === 'page') {
    return (
      <span {...stop} className={WRAPPER_CLASS[variant]}>
        <PageLink
          pageId={destination.pageId}
          title={resource.title}
          href={destination.href}
          className={className}
          ariaLabel={label}
        >
          {body(!peek)}
        </PageLink>
      </span>
    );
  }

  if (destination.kind === 'external') {
    return (
      <a
        {...stop}
        href={destination.href}
        target="_blank"
        rel="noopener noreferrer"
        title={resource.title}
        aria-label={label}
        className={className}
      >
        {body(true)}
      </a>
    );
  }

  return (
    <NavLink
      {...stop}
      to={destination.to}
      title={resource.title}
      aria-label={label}
      className={className}
    >
      {body(false)}
    </NavLink>
  );
};

export default ResourceLink;
