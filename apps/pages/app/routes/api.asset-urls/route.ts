import { ClassmojiService } from '~/utils/db.server.ts';
import { assertPageAccess } from '~/utils/auth.server.ts';
import { assetResolveContext, resolveDocumentAssets } from '~/utils/assetRefs.server.ts';
import { resolvableAssetRefs, ASSET_URLS_MAX_REFS } from '~/utils/liveAssets.ts';

/**
 * Display URLs for asset references a live editor has never seen.
 *
 * POST /api/asset-urls  `{ pageId, refs: string[] }`
 * → `{ assets: { ref: url }, srcSets: { ref: srcset } }`
 *
 * On a live page, images and files arrive from other editors, an agent, an
 * accepted preview or an outside push — references the loader never signed
 * for this browser. The editor asks here on a miss, in batches.
 *
 * Gated like the editor itself (edit access on the page) and signed on the
 * same `edit` tier and the same classroom context the page loader uses, so it
 * can sign nothing the editor's own load could not: a repo path resolves
 * inside this classroom's content repository, and a `media://` id is looked up
 * scoped to this classroom (another classroom's id resolves to the same
 * placeholder an unknown one does). Only references are accepted — absolute
 * URLs, `data:` and `blob:` are dropped — and a batch is capped.
 */
export const action = async ({ request }: { request: Request }) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  let body: { pageId?: unknown; refs?: unknown };
  try {
    body = (await request.json()) as { pageId?: unknown; refs?: unknown };
  } catch {
    return Response.json({ error: 'Expected JSON' }, { status: 400 });
  }
  const pageId = typeof body.pageId === 'string' ? body.pageId : null;
  const refs = resolvableAssetRefs(body.refs).slice(0, ASSET_URLS_MAX_REFS);
  if (!pageId) return Response.json({ error: 'A page is required.' }, { status: 400 });

  const page = await ClassmojiService.page.findById(pageId, { includeClassroom: true });
  if (!page) return Response.json({ error: 'Page not found' }, { status: 404 });

  await assertPageAccess({ request, page, accessType: 'edit' });

  if (refs.length === 0) return Response.json({ assets: {}, srcSets: {} });

  const ctx = assetResolveContext(
    page.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    ClassmojiService.contentDelivery.tierFor({ canEdit: true })
  );
  try {
    const { assets, srcSets } = await resolveDocumentAssets(ctx, [], refs);
    return Response.json({ assets, srcSets });
  } catch (error) {
    console.warn('[asset-urls] resolve failed:', error);
    return Response.json({ assets: {}, srcSets: {} });
  }
};

export const loader = () => Response.json({ error: 'Method not allowed' }, { status: 405 });
