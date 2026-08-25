import { data, useLoaderData } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { isMember, resolveSiteContext, rolePrefix, sitePagePath } from './tenant.server.ts';
import { slidesUrl, webappUrl } from './env.server.ts';
import { toScheduleSections } from './scheduleRows.ts';
import { ClassmojiService } from '~/utils/db.server.ts';

/**
 * `/schedule` — the course's modules as a reading list.
 *
 * Gated on `site.show_schedule`: an instructor who has not opted in gets a
 * 404, not an empty page, because "there is no schedule here" and "the
 * schedule is empty this week" should not look the same from the outside.
 *
 * Item visibility is entirely the service's decision
 * (`listPublicModulesForViewer`), and this route never re-filters — one
 * visibility rule, in one place. Members get every published item with its
 * title and link. Anonymous visitors get public pages and decks as links, and
 * everything else as a PLACEHOLDER: its type, its deadline if it has one, and
 * nothing else. The structure of the course is public; its contents are not.
 */

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
  // tree. An anonymous visitor never gets one of these hrefs — those items come
  // back from the service as placeholders, which carry no link at all.
  const prefix = rolePrefix(viewer.role) ?? 'student';
  const appBase = `${webappUrl()}/${prefix}/${site.classroom.slug}`;

  const sections = toScheduleSections(modules, {
    pagePath: sitePagePath,
    slidesUrl: slidesUrl(),
    appBase,
    // The COURSE's zone, not the server's and not the reader's. This page ships
    // no JavaScript, so whatever is formatted here is final — there is no
    // client pass to re-render dates the way every member-facing view gets for
    // free. Null (no zone chosen) renders in UTC and says so.
    timezone: site.timezone,
  });

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
      // the session-cookie check). Placeholders do not change that calculus:
      // a placeholder is derived from the item's type and its deadline, both
      // properties of the course, so every anonymous visitor gets a byte-
      // identical page and there is nothing personalized to leak into a cache.
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

/**
 * The padlock on a redacted row.
 *
 * Inline SVG rather than an icon package or an emoji: this document ships no
 * JavaScript and no icon dependency, `currentColor` inherits the row's muted
 * tone in both themes, and unlike an emoji it renders identically everywhere
 * instead of as whatever the visitor's platform decided a lock looks like.
 */
const LockGlyph = () => (
  <svg
    viewBox="0 0 16 16"
    className="h-3.5 w-3.5 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
  </svg>
);

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
              {/* A module whose every item is still to come renders as its
                  title alone — deliberately no empty bordered box, which reads
                  as a broken list rather than as a unit that has not started. */}
              {section.rows.length > 0 && (
                <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 dark:divide-neutral-800 dark:border-neutral-800">
                  {section.rows.map(row =>
                    row.kind === 'link' ? (
                      <li key={`link-${row.typeLabel}-${row.href}-${row.label}`}>
                        <a
                          href={row.href}
                          {...(row.external ? { rel: 'noopener noreferrer' } : {})}
                          className="flex items-center justify-between gap-4 px-4 py-3 text-gray-900 no-underline hover:bg-stone-50 dark:text-gray-100 dark:hover:bg-neutral-900"
                        >
                          <span className="truncate">{row.label}</span>
                          <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                            {row.typeLabel}
                            {row.external ? ' ↗' : ''}
                          </span>
                        </a>
                      </li>
                    ) : (
                      <li
                        key={`placeholder-${row.id}`}
                        className="flex items-center justify-between gap-4 px-4 py-3 text-gray-500 dark:text-gray-400"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <LockGlyph />
                          {/* One expression, not two adjacent children: a
                              script-less document should not carry React's
                              text-node separator comments in view-source. */}
                          <span className="truncate">
                            {row.due
                              ? `For enrolled students · due ${row.due}`
                              : 'For enrolled students'}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs">{row.typeLabel}</span>
                      </li>
                    )
                  )}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default SiteSchedule;
