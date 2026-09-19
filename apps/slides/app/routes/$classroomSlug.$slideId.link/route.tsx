/**
 * Edit Slide Link — `/{classroomSlug}/{slideId}/link`
 *
 * Points a LINK slide at a different destination. Same id, same Classmoji URL,
 * so every module item and calendar entry that already links to this slide
 * follows it to the new place.
 *
 * Gated and structured like the delete and replace screens beside it:
 * `assertSlideAccess({ accessType: 'edit' })` on the loader AND on the action,
 * the classroom in the URL checked against the slide's own, and a redirect back
 * to the webapp's slides list in the acting role's tree.
 */

import { useState, type FormEvent } from 'react';
import { useLoaderData, useNavigation, Form, redirect, useActionData, data } from 'react-router';
import getPrisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import { SlideKindError, slideFileService, validateSlideLinkUrl } from '@classmoji/services/slides';
import { assertSlideInClassroom, assertSlideKind } from '~/utils/slideRouteGuards';
import { webappClassUrl } from '~/utils/webappLinks';

/** Load the slide, prove the caller may edit it, and prove it is a link slide. */
async function authorizeLinkSlide(request: Request, classroomSlug: string, slideId: string) {
  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });
  if (!slide) throw new Response('Slide not found', { status: 404 });

  const { membership } = await assertSlideAccess({
    request,
    slideId,
    slide,
    accessType: 'edit',
  });

  // The same two checks the replace screen makes, from the same module.
  assertSlideInClassroom(slide, classroomSlug);
  assertSlideKind(slide, 'LINK', 'This slide has no link to edit.');

  return { slide, membership };
}

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { classroomSlug, slideId } = params;
  if (!classroomSlug || !slideId) throw new Response('Missing parameters', { status: 400 });

  const { slide, membership } = await authorizeLinkSlide(request, classroomSlug, slideId);

  return {
    classroomSlug,
    classroomName: slide.classroom?.name ?? null,
    slide: { id: slide.id, title: slide.title, url: slide.source_url },
    slidesListUrl: webappClassUrl(
      process.env.WEBAPP_URL || 'http://localhost:3000',
      membership?.role,
      classroomSlug,
      'slides'
    ),
  };
};

export const action = async ({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string | undefined>;
}) => {
  const { classroomSlug, slideId } = params;
  if (!classroomSlug || !slideId) {
    return data({ error: 'Missing parameters' }, { status: 400 });
  }

  // Its own gate. The loader's is not a mutation boundary.
  const { membership } = await authorizeLinkSlide(request, classroomSlug, slideId);

  const formData = await request.formData();
  const link = validateSlideLinkUrl(String(formData.get('url') ?? ''));
  if (!link.ok) {
    return data({ error: link.error }, { status: 400 });
  }

  try {
    await slideFileService.updateSlideLink({ slideId, url: link.url });
  } catch (error: unknown) {
    console.error('Failed to update slide link:', error);
    const status =
      error instanceof slideFileService.SlideSourceError || error instanceof SlideKindError
        ? error.status
        : 500;
    const message = error instanceof Error ? error.message : 'Failed to update the link';
    return data({ error: message }, { status });
  }

  return redirect(
    webappClassUrl(
      process.env.WEBAPP_URL || 'http://localhost:3000',
      membership?.role,
      classroomSlug,
      'slides'
    )
  );
};

const FIELD_CLASS =
  'w-full rounded-[10px] border border-[var(--line-2)] bg-[var(--panel)] px-3 py-2 text-sm ' +
  'text-[var(--ink-0)] placeholder:text-[var(--ink-4)] outline-none transition-colors ' +
  'focus:border-[var(--accent)]';

export default function EditSlideLinkPage() {
  const { slide, classroomName, classroomSlug, slidesListUrl } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData() as { error?: string } | undefined;
  const [linkError, setLinkError] = useState<string | null>(null);

  const isSubmitting = navigation.state === 'submitting';

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const raw = String(new FormData(event.currentTarget).get('url') ?? '').trim();
    let problem: string | null = null;
    if (!raw) {
      problem = 'Enter a link.';
    } else if (!/^https:\/\//i.test(raw)) {
      problem = 'Links must start with https://';
    }
    setLinkError(problem);
    if (problem) event.preventDefault();
  };

  return (
    <div className="min-h-screen bg-[var(--bg-page)] px-4 py-10">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-[var(--ink-0)]">Edit link</h1>
            <p className="mt-1 text-sm text-[var(--ink-3)]">
              {slide.title} · {classroomName || classroomSlug}
            </p>
          </div>
          <a href={slidesListUrl} className="btn btn-ghost">
            Cancel
          </a>
        </div>

        <div className="card p-5 sm:p-6">
          {actionData?.error && (
            <div
              role="alert"
              className="mb-5 rounded-[10px] border border-[var(--rose-bord)] bg-[var(--rose-bg)] px-4 py-3 text-sm text-[var(--rose-ink)]"
            >
              {actionData.error}
            </div>
          )}

          <Form method="post" onSubmit={onSubmit}>
            <label className="block text-sm font-medium text-[var(--ink-1)] mb-1.5" htmlFor="url">
              Link <span className="text-[var(--rose-ink)]">*</span>
            </label>
            <input
              id="url"
              type="url"
              name="url"
              required
              inputMode="url"
              defaultValue={slide.url ?? ''}
              placeholder="https://example.com/slides"
              onChange={() => setLinkError(null)}
              className={FIELD_CLASS}
            />
            {linkError && (
              <p role="alert" className="mt-2 text-xs font-medium text-[var(--rose-ink)]">
                {linkError}
              </p>
            )}
            <p className="mt-2 text-xs leading-relaxed text-[var(--ink-3)]">
              Classmoji controls who sees the link, not who can open the destination. Whoever the
              sharing settings on the other end let in can open it, so set those there.
            </p>

            <div className="mt-6 flex justify-end gap-2">
              <a href={slidesListUrl} className="btn">
                Cancel
              </a>
              <button type="submit" disabled={isSubmitting} className="btn btn-primary">
                {isSubmitting ? 'Saving…' : 'Save link'}
              </button>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}
