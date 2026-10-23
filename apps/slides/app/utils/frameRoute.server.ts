/**
 * frameRoute.server.ts — `/:slideId/frame/*`, the editor's frame source.
 *
 * The editor never holds a signed URL (a signature that reached a save would
 * be committed into the deck). It shows a frame of ours as
 * `/<slideId>/frame/<repoPath><query>` instead, and this route answers that
 * with a 302 to a freshly signed files URL on the content service.
 *
 * What it serves is decided entirely on the server:
 *   - the deck is the slide row named in the URL, and the caller must be able
 *     to VIEW it (`assertSlideAccess`, the gate every deck surface uses);
 *   - the repo is that deck's classroom's content repo — the URL carries a
 *     path, never a repo or a classroom;
 *   - the path goes through the same folder rules as every other frame
 *     signature (`contentDelivery.createFrameSigner`): no deck or page
 *     documents, no reserved folders, no folder of another slide or page.
 *
 * Anything that cannot be signed is a 404; nothing here is cached.
 */

import getPrisma from '@classmoji/database';
import { isDeckSlide } from '@classmoji/services/slides';
import { parseEditorFrameUrl } from '@classmoji/services/slides/frame-refs';
import { deckDeliveryContext, type DeckDeliveryResolvers } from './deckDelivery.server.ts';
import { ClassmojiService } from '@classmoji/services';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The one refusal for a frame that cannot be shown. */
export function frameNotFound(): Response {
  return new Response('Not found', { status: 404, headers: NO_STORE });
}

/** The slide row the route reads: with its classroom and git organization. */
type FrameSlide = NonNullable<Awaited<ReturnType<typeof findFrameSlide>>>;

function findFrameSlide(slideId: string) {
  return getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });
}

export interface FrameRouteDeps {
  findSlide(slideId: string): Promise<FrameSlide | null>;
  /** Throws (a Response) when the caller may not view this deck. */
  assertView(request: Request, slide: FrameSlide): Promise<unknown>;
  frameSigner?: DeckDeliveryResolvers['frameSigner'];
}

const defaultDeps: FrameRouteDeps = {
  findSlide: findFrameSlide,
  async assertView(request, slide) {
    // Loaded on use: the auth module builds its session store on import.
    const { assertSlideAccess } = await import('@classmoji/auth/server');
    return assertSlideAccess({ request, slideId: slide.id, slide, accessType: 'view' });
  },
};

export async function frameRedirect(
  { params, request }: { params: Record<string, string | undefined>; request: Request },
  deps: FrameRouteDeps = defaultDeps
): Promise<Response> {
  const { slideId } = params;
  if (!slideId) return frameNotFound();

  const slide = await deps.findSlide(slideId);
  if (!slide) return frameNotFound();

  // The view gate first: nothing below answers a question about a deck the
  // caller could not already see.
  await deps.assertView(request, slide);
  if (!isDeckSlide(slide)) return frameNotFound();

  // Read from the raw request path, decoded once, against THIS slide's id;
  // `cm-rev` (the editor's reload key) is dropped here.
  const url = new URL(request.url);
  const target = parseEditorFrameUrl(`${url.pathname}${url.search}`, { slideId: slide.id });
  if (!target) return frameNotFound();

  const gitOrgLogin = slide.classroom?.git_organization?.login;
  const repo = slide.classroom?.content_repo;
  if (!gitOrgLogin || !repo) return frameNotFound();

  const ctx = deckDeliveryContext(slide, gitOrgLogin, repo, {
    canEdit: false,
    isPublic: Boolean(slide.is_public),
  });
  if (!ctx?.frames) return frameNotFound();

  const signer = deps.frameSigner
    ? deps.frameSigner(ctx, ctx.frames)
    : ClassmojiService.contentDelivery.createFrameSigner({
        classroom: ctx.classroom,
        deckFolder: ctx.frames.deckFolder,
        isPublic: ctx.frames.isPublic,
      });
  const signed = await signer.sign(target.repoPath, target.query);
  if (!signed) return frameNotFound();

  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: signed } });
}
