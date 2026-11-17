/**
 * The webapp forms list, asserted against RENDERED MARKUP: a CLASSROOM form's
 * row links to its team sets on the pages app, and a PUBLIC form's row does
 * not (a public form's respondents are not a roster to make teams from).
 *
 * The teacher list is a re-export of this component, so the same assertion
 * covers `/teacher/:class/forms`; the last test pins that it is the same
 * component and not a copy.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useFetcher: () => ({ submit: vi.fn(), state: 'idle', data: undefined }),
}));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
// The real row actions; only the search box is stubbed, and the index module
// is skipped because it pulls in every shared component.
vi.mock('~/components', async () => ({
  SearchInput: () => null,
  TableActionButtons: (await import('~/components/ui/buttons/TableActionButtons')).default,
}));
vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: vi.fn(),
  assertClassroomAccess: vi.fn(),
  assertProTier: vi.fn(),
  formMutationBlocked: vi.fn(),
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { form: {} },
  publicFormUrlFor: vi.fn(),
}));

const route = await import('../admin.$class.forms/route.tsx');

const PAGES_URL = 'http://pages.test';
const CLASS_SLUG = 'intro-course';

const row = (slug: string, access: 'PUBLIC' | 'CLASSROOM', teamSets = access === 'CLASSROOM') => ({
  id: `id-${slug}`,
  title: `Form ${slug}`,
  slug,
  access,
  status: 'OPEN' as const,
  published: true,
  responses: 3,
  responseCap: null,
  closesAt: null,
  updatedAt: '2026-01-15T12:00:00.000Z',
  teamSets,
  publicUrl: `${PAGES_URL}/${CLASS_SLUG}/f/${slug}`,
});

const render = (forms: ReturnType<typeof row>[]) =>
  renderToStaticMarkup(
    <route.default
      {...({
        loaderData: { classSlug: CLASS_SLUG, pagesUrl: PAGES_URL, forms },
      } as unknown as Parameters<typeof route.default>[0])}
    />
  );

const teamsHref = (slug: string) => `href="${PAGES_URL}/${CLASS_SLUG}/forms/${slug}/teams"`;

describe('forms list Teams link', () => {
  it('links a CLASSROOM form to its team sets on the pages app', () => {
    const html = render([row('project-bids', 'CLASSROOM')]);
    expect(html).toContain(teamsHref('project-bids'));
    expect(html).toContain('>Teams</span>');
    // The row's other links are still there, so the Actions column rendered.
    expect(html).toContain(`href="${PAGES_URL}/${CLASS_SLUG}/forms/project-bids/edit"`);
  });

  it('shows no Teams link on a PUBLIC form', () => {
    const html = render([row('open-waitlist', 'PUBLIC')]);
    expect(html).toContain(`href="${PAGES_URL}/${CLASS_SLUG}/forms/open-waitlist/edit"`);
    expect(html).not.toContain('/teams"');
    expect(html).not.toContain('>Teams</span>');
  });

  it('shows no Teams link on a CLASSROOM form that takes several responses per person', () => {
    const html = render([row('weekly-checkin', 'CLASSROOM', false)]);
    expect(html).toContain(`href="${PAGES_URL}/${CLASS_SLUG}/forms/weekly-checkin/edit"`);
    expect(html).not.toContain('/teams"');
    expect(html).not.toContain('>Teams</span>');
  });

  it('marks a row for team sets from its access and responses per person', async () => {
    const { ClassmojiService } = await import('@classmoji/services');
    const helpers = await import('~/utils/helpers');
    vi.mocked(helpers.assertClassroomAccess).mockResolvedValue({
      classroom: { id: 'class-1' },
    } as never);
    const listRow = (access: string, responses_per_person: string) => ({
      id: `id-${access}-${responses_per_person}`,
      title: 'Form',
      slug: `slug-${access}-${responses_per_person}`.toLowerCase(),
      access,
      status: 'OPEN',
      current_revision_id: 'rev-1',
      responses_per_person,
      _count: { responses: 0 },
      response_cap: null,
      closes_at: null,
      updated_at: new Date('2026-01-15T12:00:00.000Z'),
    });
    (ClassmojiService.form as Record<string, unknown>).findByClassroomId = vi.fn(async () => [
      listRow('CLASSROOM', 'ONE'),
      listRow('CLASSROOM', 'REPLACE'),
      listRow('CLASSROOM', 'MANY'),
      listRow('PUBLIC', 'ONE'),
    ]);
    const services = await import('@classmoji/services');
    vi.mocked(services.publicFormUrlFor).mockResolvedValue(((slug: string) => slug) as never);

    const data = (await route.loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://webapp.test/admin/${CLASS_SLUG}/forms`),
    } as unknown as Parameters<typeof route.loader>[0])) as { forms: { teamSets: boolean }[] };
    expect(data.forms.map(form => form.teamSets)).toEqual([true, true, false, false]);
  });

  it('decides per row when both kinds are listed', () => {
    const html = render([row('open-waitlist', 'PUBLIC'), row('project-bids', 'CLASSROOM')]);
    expect(html).toContain(teamsHref('project-bids'));
    expect(html).not.toContain(teamsHref('open-waitlist'));
    expect(html.match(/>Teams<\/span>/g)).toHaveLength(1);
  });

  it('the teacher list renders the same component', async () => {
    const teacher = await import('../teacher.$class_.forms/route.tsx');
    expect(teacher.default).toBe(route.default);
  });
});
