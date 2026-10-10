/**
 * `/_render/page/:pageId` — the page the MCP's `page_render` screenshots.
 *
 * The root treats `/_render/` like a class-site path: the bare, bundle-less
 * `SiteDocument`, no login redirect. The loader (pageView.server.ts) is the
 * only gate — a short-lived view token in the `cm_view` cookie.
 *
 * The markup mirrors the class site's page (site/page.tsx): cover, title,
 * then the statically serialized BlockNote document, at the page's own
 * authored width. A meta blob names the version actually rendered.
 */
import type { HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import { VIEW_HEADERS, VIEW_META_ELEMENT_ID } from '@classmoji/services/render-contract';
import { CoverImage } from '~/site/chrome.tsx';
import { contentSecurityPolicy } from '~/site/headers.server.ts';
import { SITE_STYLES } from '~/site/styles.ts';
import { pageViewLoader } from '~/utils/pageView.server.ts';

export const loader = (args: LoaderFunctionArgs) => pageViewLoader(args);

// The class site's own CSP too: whatever markup the static renderer let
// through, no script runs here but the site's two hashed scripts (dark mode,
// and the code blocks' Copy buttons and copy guard).
export const headers: HeadersFunction = () => ({
  ...VIEW_HEADERS,
  'Content-Security-Policy': contentSecurityPolicy(),
});

export const meta = () => [{ title: 'Render' }, { name: 'robots', content: 'noindex' }];

export default function RenderPage() {
  const { title, html, coverImage, widthClass, meta } = useLoaderData<typeof loader>();
  return (
    <article>
      <style dangerouslySetInnerHTML={{ __html: SITE_STYLES }} />
      <CoverImage coverImage={coverImage} />
      <div className={`mx-auto ${widthClass} px-4 pb-16 sm:px-6 site-article`}>
        <div className={coverImage?.url ? 'pt-10' : 'pt-14'}>
          <h1 className="mb-6 text-4xl font-bold text-gray-900 sm:text-5xl dark:text-white">
            {title}
          </h1>
        </div>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <script
        type="application/json"
        id={VIEW_META_ELEMENT_ID}
        dangerouslySetInnerHTML={{ __html: JSON.stringify(meta).replace(/</g, '\\u003c') }}
      />
    </article>
  );
}
