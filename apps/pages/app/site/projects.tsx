import { data, useLoaderData } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { resolveSiteContext } from './tenant.server.ts';
import { ClassmojiService } from '~/utils/db.server.ts';

/**
 * `/projects` — the org's cross-term project gallery: APPROVED showcase
 * responses from every classroom in this site's GitHub org. The same for every
 * viewer, so cacheable. Site pages ship no JS, so the term filter is a link.
 * Links are root-relative so they stay on whichever host (subdomain or custom
 * domain) served the page.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request } = args;
  const { site, seoOrigin } = await resolveSiteContext(args);
  const orgId = site.classroom.git_organization?.id;
  const projects = orgId ? await ClassmojiService.gallery.listForOrg(orgId) : [];

  // listForOrg is newest term first, so first appearance keeps that order.
  const terms = [
    ...new Map(projects.map(project => [project.classroomSlug, project.term] as const)),
  ].map(([slug, name]) => ({ slug, name }));
  const term = new URL(request.url).searchParams.get('term');

  return data(
    {
      title: 'Projects',
      courseName: site.classroom.name,
      terms,
      term,
      projects: term ? projects.filter(project => project.classroomSlug === term) : projects,
      canonical: seoOrigin ? `${seoOrigin}/projects` : null,
    },
    { headers: siteHeaders({ request, cacheable: true }) }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

/** The layout reads `title` from this route's data for the `{course} › Projects` crumb. */
export const handle = { siteBreadcrumb: true };

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => {
  if (!loaderData) return [{ title: 'Projects' }];
  return [
    { title: `Projects — ${loaderData.courseName}` },
    { property: 'og:title', content: `Projects — ${loaderData.courseName}` },
    ...(loaderData.canonical
      ? [{ tagName: 'link', rel: 'canonical', href: loaderData.canonical }]
      : []),
  ];
};

const CHIP = 'rounded-full border px-3 py-1 text-sm no-underline';
const CHIP_OFF =
  'border-stone-300 text-gray-700 hover:bg-stone-50 dark:border-neutral-700 dark:text-gray-200 dark:hover:bg-neutral-800';
const CHIP_ON =
  'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900';

const SiteProjects = () => {
  const { terms, term, projects } = useLoaderData<typeof loader>();

  const groups = new Map<string, { name: string; items: typeof projects }>();
  for (const project of projects) {
    const group = groups.get(project.classroomSlug) ?? { name: project.term, items: [] };
    group.items.push(project);
    groups.set(project.classroomSlug, group);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="mb-6 text-3xl font-bold text-gray-900 dark:text-white">Projects</h1>

      {terms.length > 0 ? (
        <nav aria-label="Filter by term" className="mb-8 flex flex-wrap gap-2">
          <a href="/projects" className={`${CHIP} ${term ? CHIP_OFF : CHIP_ON}`}>
            All terms
          </a>
          {terms.map(option => (
            <a
              key={option.slug}
              href={`/projects?term=${encodeURIComponent(option.slug)}`}
              className={`${CHIP} ${term === option.slug ? CHIP_ON : CHIP_OFF}`}
            >
              {option.name}
            </a>
          ))}
        </nav>
      ) : null}

      {projects.length === 0 ? (
        <div className="py-12 text-center text-gray-500 dark:text-gray-400">
          <div className="font-medium">No projects yet</div>
          <div className="text-sm">Approved student projects will appear here.</div>
        </div>
      ) : (
        <div className="space-y-10">
          {[...groups].map(([slug, group]) => (
            <section key={slug}>
              <h2 className="mb-3 text-sm font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                {group.name}
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {group.items.map(project => (
                  <li key={project.id}>
                    <a
                      href={`/projects/${project.id}`}
                      className="block h-full overflow-hidden rounded-xl border border-stone-200 text-gray-900 no-underline hover:bg-stone-50 dark:border-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-900"
                    >
                      {project.coverUrl ? (
                        <img
                          src={project.coverUrl}
                          alt=""
                          loading="lazy"
                          className="h-36 w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-36 items-center justify-center bg-stone-100 text-5xl dark:bg-neutral-800">
                          {project.icon || project.title.slice(0, 1)}
                        </div>
                      )}
                      <div className="p-4">
                        <div className="font-semibold">{project.title}</div>
                        <p className="mt-1 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">
                          {project.tagline || project.summary.slice(0, 140)}
                        </p>
                        <span className="mt-3 inline-block rounded-full border border-stone-300 px-2 py-0.5 text-xs text-gray-600 dark:border-neutral-700 dark:text-gray-300">
                          {project.term}
                        </span>
                      </div>
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

export default SiteProjects;
