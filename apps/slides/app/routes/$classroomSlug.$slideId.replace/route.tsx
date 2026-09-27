/**
 * Replace Slide File — `/{classroomSlug}/{slideId}/replace`
 *
 * Swaps the document behind a FILE slide while keeping the slide id, so every
 * link already published into a module, a calendar entry or a class site keeps
 * working. Structured and gated exactly like the delete screen next door: a
 * full page rather than a modal, `assertSlideAccess({ accessType: 'edit' })` on
 * BOTH the loader and the action, and a redirect back to the webapp's slides
 * list in the acting role's own tree.
 *
 * The service does the careful part — it commits the new file, points the row
 * at it, and only then removes the old one, so a failure anywhere leaves the
 * slide serving the document it was already serving. This route's own job is
 * the gate, the size limit, and saying no in a sentence a person can act on.
 */

import { useCallback, useRef, useState, type FormEvent } from 'react';
import {
  useLoaderData,
  useNavigation,
  useSubmit,
  Form,
  redirect,
  useActionData,
  data,
} from 'react-router';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { assertSlideAccess } from '@classmoji/auth/server';
import {
  SLIDE_FILE_EXTENSIONS,
  SLIDE_FILE_MAX_BYTES,
  SLIDE_FILE_MAX_LABEL,
  SlideKindError,
  slideFileService,
  validateSlideFile,
} from '@classmoji/services/slides';
import { assertSlideInClassroom, assertSlideKind } from '~/utils/slideRouteGuards';
import { webappClassUrl } from '~/utils/webappLinks';
import {
  UploadTooLargeError,
  readLimitedFormData,
  uploadBodyLimit,
} from '@classmoji/utils/upload-limit';
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_RETRY_AFTER_SECONDS,
  acquireUploadSlot,
  releaseUploadSlot,
} from '@classmoji/utils/upload-concurrency';
import {
  PendingCancelLink,
  PendingSubmitButton,
  UploadPendingPanel,
} from '~/components/FormPending';
import { isSubmissionPending } from '~/utils/pendingSubmission';
import { MediaUploadProgress } from '~/components/media/MediaUploadProgress';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import { formatGigabytes, slideFileTarget } from '~/utils/mediaUpload';

/** Load the slide, prove the caller may edit it, and prove it is a file slide. */
async function authorizeFileSlide(request: Request, classroomSlug: string, slideId: string) {
  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });
  if (!slide) throw new Response('Slide not found', { status: 404 });

  // Edit permission: owner/teacher, or an assistant on their own slide or one
  // with team editing on. The same call the delete screen makes.
  const { membership } = await assertSlideAccess({
    request,
    slideId,
    slide,
    accessType: 'edit',
  });

  // The slug in the URL must be the slide's own classroom, and the slide must
  // be one this screen can act on. Both live in `~/utils/slideRouteGuards`,
  // beside the edit-link screen's identical pair.
  assertSlideInClassroom(slide, classroomSlug);
  assertSlideKind(slide, 'FILE', 'This slide has no file to replace.');

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

  const { slide, membership } = await authorizeFileSlide(request, classroomSlug, slideId);

  // Where a new document goes — see the new-slide screen. Re-derived by the
  // action from the uploaded row; this is only what the form says.
  const uploadCapability = await ClassmojiService.media.uploadCapabilityFor(slide.classroom);

  return {
    classroomSlug,
    classroomId: slide.classroom_id,
    uploadCapability,
    slide: {
      id: slide.id,
      title: slide.title,
      filename: slide.source_filename,
      size: slide.source_size,
    },
    classroomName: slide.classroom?.name ?? null,
    slidesListUrl: webappClassUrl(
      process.env.WEBAPP_URL || 'http://localhost:3000',
      membership?.role,
      classroomSlug,
      'slides'
    ),
    // Policy for the form. The server re-checks all of it with
    // `validateSlideFile`; importing the deck-engine subpath into a component
    // is what this avoids.
    upload: {
      maxBytes: SLIDE_FILE_MAX_BYTES,
      maxLabel: uploadCapability.media
        ? formatGigabytes(uploadCapability.media.perFileMaxBytes)
        : SLIDE_FILE_MAX_LABEL,
      extensions: [...SLIDE_FILE_EXTENSIONS] as string[],
      accept: SLIDE_FILE_EXTENSIONS.map(ext => `.${ext}`).join(','),
    },
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

  // Its own authorization check, ahead of the body: the loader's gate is not a
  // mutation boundary, and a 35 MB upload should never be buffered for someone
  // who is not allowed to make it.
  const { membership } = await authorizeFileSlide(request, classroomSlug, slideId);

  // A document already in the classroom's media arrives as its id alone — a few
  // bytes of url-encoded form, which holds no upload slot.
  if (!isMultipartUpload(request)) {
    return replaceFromMedia({ request, classroomSlug, slideId, membership });
  }

  // Every multipart submission here carries a file, so it takes a slot. The cap
  // in `@classmoji/utils/upload-limit` bounds one upload; this bounds how many
  // of them the process is holding at the same moment.
  if (!acquireUploadSlot()) {
    return data(
      { error: UPLOAD_BUSY_MESSAGE },
      { status: 503, headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } }
    );
  }
  try {
    return await replaceFromForm({ request, classroomSlug, slideId, membership });
  } finally {
    releaseUploadSlot();
  }
};

/** Only the upload form posts multipart; the media form is its id alone. */
function isMultipartUpload(request: Request): boolean {
  return (request.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('multipart/form-data');
}

/**
 * Repoint the slide at a document the browser already put in the classroom's
 * media. The service checks everything about it from the row — this
 * classroom's, finished, a slide document, and one the storage router sends to
 * media — so nothing in the form is taken on trust but the id.
 */
async function replaceFromMedia({
  request,
  classroomSlug,
  slideId,
  membership,
}: {
  request: Request;
  classroomSlug: string;
  slideId: string;
  membership: { role?: string | null } | null | undefined;
}) {
  let formData: FormData;
  try {
    formData = await readLimitedFormData(request, 64 * 1024);
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) {
      return data({ error: 'That request is too large.' }, { status: 413 });
    }
    throw error;
  }

  const mediaId = formData.get('mediaId');
  if (typeof mediaId !== 'string' || !mediaId) {
    return data({ error: 'Choose a file to upload.' }, { status: 400 });
  }

  try {
    await slideFileService.replaceSlideFileWithMedia({ slideId, mediaId });
  } catch (error: unknown) {
    console.error('Failed to replace slide file from media:', error);
    const ours =
      error instanceof slideFileService.SlideSourceError || error instanceof SlideKindError;
    return data(
      { error: ours ? error.message : "Couldn't save the slide. Please try again." },
      { status: ours ? error.status : 500 }
    );
  }

  return redirect(
    webappClassUrl(
      process.env.WEBAPP_URL || 'http://localhost:3000',
      membership?.role,
      classroomSlug,
      'slides'
    )
  );
}

/** The upload itself, once the caller has been admitted and holds a slot. */
async function replaceFromForm({
  request,
  classroomSlug,
  slideId,
  membership,
}: {
  request: Request;
  classroomSlug: string;
  slideId: string;
  membership: { role?: string | null } | null | undefined;
}) {
  let formData: FormData;
  try {
    formData = await readLimitedFormData(request, uploadBodyLimit(SLIDE_FILE_MAX_BYTES));
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) {
      return data(
        { error: `That file is too large. The limit is ${SLIDE_FILE_MAX_LABEL}.` },
        { status: 413 }
      );
    }
    throw error;
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return data({ error: 'Choose a file to upload.' }, { status: 400 });
  }

  const validation = validateSlideFile({ filename: file.name, size: file.size });
  if (!validation.valid) {
    return data({ error: validation.error }, { status: 400 });
  }

  try {
    await slideFileService.replaceSlideFile({
      slideId,
      filename: file.name,
      // `Buffer.from(ArrayBuffer)` is a VIEW over the same memory, not a second
      // copy of it — `arrayBuffer()` above is the one allocation.
      file: Buffer.from(await file.arrayBuffer()),
    });
  } catch (error: unknown) {
    console.error('Failed to replace slide file:', error);
    // Only OUR refusals carry a sentence written for an instructor. Anything
    // else is an upstream fault — a GitHub 500, a dropped connection — whose
    // message is for the log above, not for the form: it names repos, API
    // paths and remedies (`git push`) that mean nothing on this screen.
    const ours =
      error instanceof slideFileService.SlideSourceError || error instanceof SlideKindError;
    return data(
      {
        error: ours
          ? error.message
          : "Couldn't save the file to the course repository. Please try again.",
      },
      { status: ours ? error.status : 500 }
    );
  }

  return redirect(
    webappClassUrl(
      process.env.WEBAPP_URL || 'http://localhost:3000',
      membership?.role,
      classroomSlug,
      'slides'
    )
  );
}

const FIELD_CLASS =
  'w-full rounded-[10px] border border-[var(--line-2)] bg-[var(--panel)] px-3 py-2 text-sm ' +
  'text-[var(--ink-0)] placeholder:text-[var(--ink-4)] outline-none transition-colors ' +
  'focus:border-[var(--accent)]';

export default function ReplaceSlideFilePage() {
  const {
    slide,
    classroomName,
    classroomSlug,
    classroomId,
    uploadCapability,
    slidesListUrl,
    upload,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData() as { error?: string } | undefined;
  const [fileError, setFileError] = useState<string | null>(null);
  // Name and size for the status panel, captured when the file is chosen. The
  // input itself is disabled mid-flight and `files` is not readable from a
  // disabled control in every browser, so the values are kept here instead.
  const [chosenFile, setChosenFile] = useState<{ name: string; size: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // True for the whole round trip, not just the bytes going up — see
  // `~/utils/pendingSubmission`. An error settling flips it back to false,
  // which is what clears the panel and hands the form back.
  const submitting = isSubmissionPending(navigation);
  // A document bound for media goes up from the browser first, then the form
  // posts only its id — so "busy" is the upload AND the submission after it.
  const media = useMediaUpload(classroomId);
  const submit = useSubmit();
  const [viaMedia, setViaMedia] = useState(false);
  const isSubmitting = submitting || media.uploading;

  const checkFile = useCallback(
    (file: File | null | undefined): string | null => {
      if (!file) return 'Choose a file to upload.';
      const dot = file.name.lastIndexOf('.');
      const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
      if (!upload.extensions.includes(ext)) {
        return `Slide files must be one of: ${upload.extensions.map(e => `.${e}`).join(', ')}`;
      }
      if (file.size === 0) return 'That file is empty.';
      // Over the repository's cap: media on Pro, the router's refusal elsewhere.
      const target = slideFileTarget(uploadCapability, file);
      if (target.kind === 'refused') return target.message;
      return null;
    },
    [upload.extensions, uploadCapability]
  );

  /** Upload to media, then post the form with the uploaded object's id. */
  const submitViaMedia = async (file: File) => {
    setViaMedia(true);
    const result = await media.start(file);
    if (!result) {
      setViaMedia(false);
      return;
    }
    submit({ mediaId: result.mediaId }, { method: 'post' });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const file = fileInputRef.current?.files?.[0] ?? null;
    const problem = checkFile(file);
    setFileError(problem);
    if (problem || !file) {
      event.preventDefault();
      return;
    }
    if (slideFileTarget(uploadCapability, file).kind === 'media') {
      event.preventDefault();
      void submitViaMedia(file);
      return;
    }
    setViaMedia(false);
  };

  const formError = actionData?.error ?? media.state.error ?? null;

  return (
    <div className="min-h-screen bg-[var(--bg-page)] px-4 py-10">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-[var(--ink-0)]">Replace file</h1>
            <p className="mt-1 text-sm text-[var(--ink-3)]">
              {slide.title} · {classroomName || classroomSlug}
            </p>
          </div>
          <PendingCancelLink
            href={slidesListUrl}
            pending={isSubmitting}
            className="btn btn-ghost"
          />
        </div>

        <div className="card p-5 sm:p-6">
          {formError && (
            <div
              role="alert"
              className="mb-5 rounded-[10px] border border-[var(--rose-bord)] bg-[var(--rose-bg)] px-4 py-3 text-sm text-[var(--rose-ink)]"
            >
              {formError}
            </div>
          )}

          <div className="mb-5 rounded-[10px] border border-[var(--line)] bg-[var(--panel-tint)] px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)]">
              Current file
            </p>
            <p className="mt-1 break-all text-sm text-[var(--ink-0)]">
              {slide.filename || 'Unnamed file'}
            </p>
          </div>

          <Form method="post" encType="multipart/form-data" onSubmit={onSubmit}>
            <label className="block text-sm font-medium text-[var(--ink-1)] mb-1.5" htmlFor="file">
              New file <span className="text-[var(--rose-ink)]">*</span>
            </label>
            <input
              id="file"
              ref={fileInputRef}
              type="file"
              name="file"
              accept={upload.accept}
              disabled={isSubmitting}
              onChange={event => {
                const picked = event.target.files?.[0] ?? null;
                setChosenFile(picked ? { name: picked.name, size: picked.size } : null);
                setFileError(checkFile(picked));
                media.clearError();
              }}
              className={`${FIELD_CLASS} file:mr-3 file:rounded-md file:border-0 file:bg-[var(--accent-soft)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-60`}
            />
            {fileError && (
              <p role="alert" className="mt-2 text-xs font-medium text-[var(--rose-ink)]">
                {fileError}
              </p>
            )}
            <p className="mt-2 text-xs leading-relaxed text-[var(--ink-3)]">
              The slide keeps its link, so anything already pointing at it stays pointing at it.
              Students download the file under its original name. PDF, PowerPoint or Keynote, up to{' '}
              {upload.maxLabel}.
            </p>

            {media.uploading && media.state.file ? (
              <MediaUploadProgress
                file={media.state.file}
                sentBytes={media.state.sentBytes}
                onCancel={media.cancel}
              />
            ) : (
              isSubmitting && (
                <UploadPendingPanel
                  file={chosenFile}
                  {...(viaMedia ? { message: 'Saving the slide.' } : {})}
                />
              )
            )}

            <div className="mt-6 flex justify-end gap-2">
              <PendingCancelLink href={slidesListUrl} pending={isSubmitting} />
              <PendingSubmitButton pending={isSubmitting} pendingLabel="Uploading…">
                Replace file
              </PendingSubmitButton>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}
