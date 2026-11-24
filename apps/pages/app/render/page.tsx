/**
 * `/_render/page/:pageId` — the page the MCP's `page_render` screenshots.
 *
 * The root renders render paths in `RenderDocument`: bare, not hydrated, no
 * login redirect, `<html data-render-pending>`. The loader
 * (pageView.server.ts) is the only gate — a short-lived view token in the
 * `cm_view` cookie — and builds the STAFF reader payload.
 *
 * The page is the shared reader (cover, title, document at the page's own
 * width), mounted in the browser by the reader island; the island raises
 * `data-render-ready` once it is on screen and settled, which the driver
 * (apps/mcp/src/render/pageRender.ts) waits for. `article` and `.site-article`
 * stay as the driver's measuring wrappers (the page's extent, and the boxes
 * it checks for hidden overflow). A meta blob names the version rendered.
 */
import type { HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { data, useLoaderData } from 'react-router';
import { VIEW_META_ELEMENT_ID } from '@classmoji/services/render-contract';
import { ReaderIsland } from '~/reader-island/ReaderIsland.tsx';
import {
  isRenderDataRequest,
  renderDataRequestRefusal,
  renderPageHeaders,
} from '~/render/headers.server.ts';
import { pageViewLoader } from '~/utils/pageView.server.ts';

export const loader = async (args: LoaderFunctionArgs) => {
  // Never hydrated: a data request is refused before the page is read.
  if (isRenderDataRequest(args.request)) throw renderDataRequestRefusal();
  const view = await pageViewLoader(args);
  // Scripts only from this origin's `/assets/` in a build; 'self' in dev,
  // where Vite serves modules from other paths. The origin is the one the
  // view token was checked against.
  const assetsOrigin = import.meta.env?.DEV ? null : new URL(args.request.url).origin;
  return data(view, { headers: renderPageHeaders({ assetsOrigin }) });
};

// The render's own headers (render/headers.server.ts): the loader's, or, for
// a refusal, the same set with 'self' scripts (that page loads none).
export const headers: HeadersFunction = ({ loaderHeaders }) =>
  loaderHeaders.has('Content-Security-Policy') ? loaderHeaders : renderPageHeaders();

export const meta = () => [{ title: 'Render' }, { name: 'robots', content: 'noindex' }];

export default function RenderPage() {
  const { island, assets, meta } = useLoaderData<typeof loader>();
  return (
    <article>
      <ReaderIsland assets={assets} data={island} className="site-article" />
      <script
        type="application/json"
        id={VIEW_META_ELEMENT_ID}
        dangerouslySetInnerHTML={{ __html: JSON.stringify(meta).replace(/</g, '\\u003c') }}
      />
    </article>
  );
}
