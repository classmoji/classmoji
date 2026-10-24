import { data, useLoaderData } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { resolveSiteContext } from './tenant.server.ts';
import { formatAnswer } from '~/components/forms/answerFormat.ts';
import { ClassmojiService } from '~/utils/db.server.ts';

/**
 * `/projects/:responseId` — one approved project. A pending, hidden, unknown or
 * other-org id is the site's ordinary 404 ('no-page'), never a 403: the page
 * must not confirm that an unapproved response exists. Student text renders as
 * text (no dangerouslySetInnerHTML).
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request, params } = args;
  const { site, seoOrigin } = await resolveSiteContext(args);
  const orgId = site.classroom.git_organization?.id;
  const project = orgId
    ? await ClassmojiService.gallery.getForOrg(orgId, params.responseId!)
    : null;
  if (!project) {
    throw new Response('no-page', {
      status: 404,
      headers: siteHeaders({ request, cacheable: false, noindex: true }),
    });
  }

  const { extras, ...rest } = project;
  return data(
    {
      ...rest,
      courseName: site.classroom.name,
      extras: extras.map(({ field, value }) => ({
        label: String(field.label ?? ''),
        valueText: formatAnswer(field, value),
      })),
      canonical: seoOrigin ? `${seoOrigin}/projects/${project.id}` : null,
    },
    { headers: siteHeaders({ request, cacheable: true }) }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

/** The layout reads `title` for the `{course} › {project}` crumb. */
export const handle = { siteBreadcrumb: true };

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => {
  if (!loaderData) return [{ title: 'Project' }];
  const description = loaderData.tagline || loaderData.summary.slice(0, 160);
  return [
    { title: `${loaderData.title} — ${loaderData.courseName}` },
    { property: 'og:title', content: loaderData.title },
    { name: 'description', content: description },
    { property: 'og:description', content: description },
    ...(loaderData.canonical
      ? [{ tagName: 'link', rel: 'canonical', href: loaderData.canonical }]
      : []),
  ];
};

const PILL =
  'rounded-full border border-stone-300 px-3 py-1 text-sm text-gray-700 no-underline hover:bg-stone-50 dark:border-neutral-700 dark:text-gray-200 dark:hover:bg-neutral-800';
const SECTION_HEADING =
  'mb-2 text-sm font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400';
const PROSE = 'whitespace-pre-line text-gray-700 dark:text-gray-300';

const SiteProject = () => {
  const project = useLoaderData<typeof loader>();

  return (
    <article>
      {project.coverUrl ? (
        <img src={project.coverUrl} alt="" className="h-64 w-full object-cover sm:h-80" />
      ) : null}
      <div className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <div className={project.coverUrl ? 'pt-10' : 'pt-14'}>
          <a
            href="/projects"
            className="text-sm text-gray-600 underline hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ← All projects
          </a>
          {!project.coverUrl && project.icon ? (
            <div className="mt-6 text-6xl" aria-hidden="true">
              {project.icon}
            </div>
          ) : null}
          <h1 className="mt-4 mb-2 text-4xl font-bold text-gray-900 sm:text-5xl dark:text-white">
            {project.title}
          </h1>
          {project.tagline ? (
            <p className="text-lg text-gray-600 dark:text-gray-400">{project.tagline}</p>
          ) : null}
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {[project.term, project.team.join(', ')].filter(Boolean).join(' · ')}
          </p>
        </div>

        {project.links.length > 0 ? (
          <div className="mt-6 flex flex-wrap gap-2">
            {project.links.map(link => (
              <a key={link.url} href={link.url} rel="noopener noreferrer" className={PILL}>
                {`${link.label} ↗`}
              </a>
            ))}
          </div>
        ) : null}

        {project.tags.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {project.tags.map(tag => (
              <span
                key={tag}
                className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs text-gray-700 dark:bg-neutral-800 dark:text-gray-300"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        {project.videoUrl ? (
          <video
            src={project.videoUrl}
            controls
            preload="metadata"
            aria-label="Project demo video"
            className="mt-8 w-full rounded-xl"
          />
        ) : null}

        {project.summary ? <p className={`mt-8 text-lg ${PROSE}`}>{project.summary}</p> : null}

        {project.details.map(detail => (
          <section key={detail.heading} className="mt-8">
            <h2 className={SECTION_HEADING}>{detail.heading}</h2>
            <p className={PROSE}>{detail.body}</p>
          </section>
        ))}

        {project.extras.length > 0 ? (
          <section className="mt-10">
            <h2 className={SECTION_HEADING}>Details</h2>
            <dl className="divide-y divide-stone-200 rounded-xl border border-stone-200 dark:divide-neutral-800 dark:border-neutral-800">
              {project.extras.map(extra => (
                <div key={extra.label} className="grid gap-1 px-4 py-3 sm:grid-cols-3 sm:gap-4">
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    {extra.label}
                  </dt>
                  <dd className={`text-sm sm:col-span-2 ${PROSE}`}>{extra.valueText}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
    </article>
  );
};

export default SiteProject;
