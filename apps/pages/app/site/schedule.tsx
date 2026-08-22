import { data, useLoaderData } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { isMember, resolveSiteContext, rolePrefix, sitePagePath } from './tenant.server.ts';
import { slidesUrl, webappUrl } from './env.server.ts';
import { ClassmojiService } from '~/utils/db.server.ts';

/**
 * `/schedule` — the course's published modules as a reading list.
 *
 * Gated on `site.show_schedule`: an instructor who has not opted in gets a
 * 404, not an empty page, because "there is no schedule here" and "the
 * schedule is empty this week" should not look the same from the outside.
 *
 * Item visibility is entirely the service's decision
 * (`listPublicModulesForViewer`): anonymous visitors see published-and-public
 * pages and slides only, members additionally see repositories and quizzes.
 * This route never re-filters — one visibility rule, in one place.
 */

type ScheduleLink = { label: string; href: string; kind: string; external: boolean };

export const loader = async (args: LoaderFunctionArgs) => {
  const { request } = args;
  const { site, viewer, seoOrigin } = await resolveSiteContext(args);

  if (!site.show_schedule) {
    throw new Response('missing', {
      status: 404,
      headers: siteHeaders({ request, cacheable: false, noindex: true }),
    });
  }

  const modules = await ClassmojiService.site.listPublicModulesForViewer(
    site.classroom_id,
    viewer.role
  );

  // Members get in-app links for coursework; the role prefix decides which
  // tree. Anonymous visitors never reach this branch — those item types are
  // already gone by the time the service returns.
  const prefix = rolePrefix(viewer.role) ?? 'student';
  const appBase = `${webappUrl()}/${prefix}/${site.classroom.slug}`;

  const sections = modules.map(module => ({
    id: module.id,
    title: module.title,
    items: module.items
      .map((item): ScheduleLink | null => {
        if (item.item_type === 'PAGE' && item.page) {
          return {
            label: item.page.title || 'Untitled',
            href: sitePagePath(item.page),
            kind: 'Page',
            external: false,
          };
        }
        if (item.item_type === 'SLIDE' && item.slide) {
          return {
            label: item.slide.title || 'Untitled',
            href: `${slidesUrl()}/${item.slide.id}`,
            kind: 'Slides',
            external: true,
          };
        }
        if (item.item_type === 'REPOSITORY' && item.repository) {
          return {
            label: item.repository.title || 'Untitled',
            href: `${appBase}/repos`,
            kind: 'Assignment',
            external: true,
          };
        }
        if (item.item_type === 'QUIZ' && item.quiz) {
          return {
            label: item.quiz.name || 'Untitled',
            href: `${appBase}/quizzes`,
            kind: 'Quiz',
            external: true,
          };
        }
        return null;
      })
      .filter((item): item is ScheduleLink => item !== null),
  }));

  return data(
    {
      courseName: site.classroom.name,
      sections,
      // `seoOrigin`, not the subdomain: when a verified custom domain is live,
      // both hostnames name it, so the signal consolidates on one address.
      canonical: seoOrigin ? `${seoOrigin}/schedule` : null,
    },
    {
      // A member's schedule contains members-only titles; only the anonymous
      // rendering is ever shared-cacheable (siteHeaders enforces that too, via
      // the session-cookie check).
      headers: siteHeaders({ request, cacheable: !isMember(viewer), noindex: false }),
    }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => {
  if (!loaderData) return [{ title: 'Schedule' }];
  return [
    { title: `Schedule — ${loaderData.courseName}` },
    { property: 'og:title', content: `Schedule — ${loaderData.courseName}` },
    ...(loaderData.canonical
      ? [{ tagName: 'link', rel: 'canonical', href: loaderData.canonical }]
      : []),
  ];
};

const SiteSchedule = () => {
  const { sections } = useLoaderData<typeof loader>();

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-3xl font-bold text-gray-900 dark:text-white">Schedule</h1>

      {sections.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400">Nothing has been published yet.</p>
      ) : (
        <div className="space-y-8">
          {sections.map(section => (
            <section key={section.id}>
              <h2 className="mb-3 text-sm font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                {section.title}
              </h2>
              <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 dark:divide-neutral-800 dark:border-neutral-800">
                {section.items.map(item => (
                  <li key={`${item.kind}-${item.href}-${item.label}`}>
                    <a
                      href={item.href}
                      {...(item.external ? { rel: 'noopener noreferrer' } : {})}
                      className="flex items-center justify-between gap-4 px-4 py-3 text-gray-900 no-underline hover:bg-stone-50 dark:text-gray-100 dark:hover:bg-neutral-900"
                    >
                      <span className="truncate">{item.label}</span>
                      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                        {item.kind}
                        {item.external ? ' ↗' : ''}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default SiteSchedule;
