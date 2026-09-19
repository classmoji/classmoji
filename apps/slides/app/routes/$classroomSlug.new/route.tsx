/**
 * New Slide Route — `/{classroomSlug}/new`
 *
 * One screen for every way a slide can start:
 *
 *   - **Start blank** — a reveal.js deck, created empty and opened in the
 *     editor. This is what the route used to be, and its behaviour is unchanged
 *     down to the redirect.
 *   - **Upload a file** — a PDF, PowerPoint or Keynote document committed into
 *     the classroom's content repo. Students download it under its original
 *     name; there is no viewer.
 *   - **Link a URL** — an external `https:` destination the slide redirects to.
 *   - **Slides.com export** — hands off to `/import`, which already owns the
 *     ZIP pipeline.
 *
 * ## Where each one lands
 *
 * A blank deck opens in the EDITOR, because an empty deck is useless until it
 * is written. A file or a link goes back to the webapp's slides list instead,
 * in the acting role's own tree: opening `/{slideId}` for a file would start a
 * download, and for a link would bounce the author onto somebody else's site —
 * neither is "I have finished creating this".
 *
 * ## Authorization, and why it runs first
 *
 * The gate is `requireClassroomTeachingTeam`, unchanged: owners, teachers and
 * assistants. It now runs BEFORE the request body is read, which it could not
 * do while the classroom was identified from a form field — it comes from the
 * URL, so a stranger's 35 MB upload is refused on the session, not after it has
 * been buffered. See `~/utils/uploadLimit` for the size gates themselves, and
 * `~/utils/uploadConcurrency.server` for how many uploads this process holds at
 * once (a cap on ONE upload says nothing about ten of them arriving together).
 *
 * ## Why the picker is links and a search param
 *
 * The four cards used to be `<button type="button">` driven by `useState`, so
 * until this route's JavaScript had loaded and hydrated they did nothing at all
 * — measured at about ten seconds on a cold staging machine, during which
 * "Upload a file" is a control that looks ready and is not. The selection lives
 * in `?source=` instead: the loader reads it, the cards are real anchors, and
 * the screen works before hydration and client-navigates after it. The forms,
 * their hidden `source` field and everything the action accepts are unchanged.
 */

import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  useLoaderData,
  useNavigation,
  Form,
  Link,
  redirect,
  useActionData,
  data,
} from 'react-router';
import getPrisma from '@classmoji/database';
import { requireClassroomTeachingTeam } from '@classmoji/auth/server';
import {
  SLIDE_FILE_EXTENSIONS,
  SLIDE_FILE_MAX_BYTES,
  SLIDE_FILE_MAX_LABEL,
  slideFileService,
  slideService,
  validateSlideFile,
  validateSlideLinkUrl,
} from '@classmoji/services/slides';
import { webappClassUrl } from '~/utils/webappLinks';
import { UploadTooLargeError, readLimitedFormData, uploadBodyLimit } from '~/utils/uploadLimit';
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_RETRY_AFTER_SECONDS,
  acquireUploadSlot,
  releaseUploadSlot,
} from '~/utils/uploadConcurrency.server';
import {
  PendingCancelLink,
  PendingSubmitButton,
  UploadPendingPanel,
} from '~/components/FormPending';
import { isSubmissionPending } from '~/utils/pendingSubmission';

/** The four things the picker offers. `import` is a link, not a form. */
type SlideSource = 'blank' | 'file' | 'link';

/** The three the FORM posts, named once so the action can refuse anything else. */
const SLIDE_SOURCES: readonly SlideSource[] = ['blank', 'file', 'link'];

/**
 * The `?source=` in the URL, or `blank`.
 *
 * Anything unrecognised falls back rather than erroring: the param is part of a
 * link anyone can type or bookmark, and a 400 for `?source=banana` would be a
 * worse screen than the default one. The value never reaches the action — the
 * forms post their own hidden field, which is validated there on its own.
 */
function sourceFromParams(params: URLSearchParams): SlideSource {
  const raw = params.get('source');
  return SLIDE_SOURCES.includes(raw as SlideSource) ? (raw as SlideSource) : 'blank';
}

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { classroomSlug } = params;
  if (!classroomSlug) throw new Response('Missing classroomSlug', { status: 400 });

  // Authorization: require OWNER, TEACHER, or ASSISTANT role to create slides
  const { membership } = await requireClassroomTeachingTeam(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
  });

  // Get classroom with git_organization
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    include: { git_organization: true },
  });

  if (!classroom) {
    throw new Response(`Classroom not found: ${classroomSlug}`, { status: 404 });
  }

  // Get git org login for GitHub API calls
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured for this classroom', { status: 400 });
  }

  // Slides land in the classroom's STORED content repo (user-editable, never
  // re-derived); creation is impossible without it. A LINK slide commits
  // nothing, but it still takes a `slides/<slug>` content path, so the repo has
  // to be configured for it too.
  if (!classroom.content_repo) {
    throw new Response('Classroom content repo not configured', { status: 400 });
  }

  return {
    classroomSlug,
    classroomName: classroom.name,
    contentNamespace: classroom.content_namespace,
    // Which card is chosen, resolved on the server so the right form is in the
    // HTML the browser gets — no JavaScript involved. The webapp's "New Slide"
    // button links here without the param and lands on `blank`, as it always did.
    source: sourceFromParams(new URL(request.url).searchParams),
    // Where "Cancel" goes. Built from the role the server resolved, because
    // each webapp role tree is gated to its own role — the /admin tree is
    // OWNER-only, so a teacher sent there gets a 403.
    slidesListUrl: webappClassUrl(
      process.env.WEBAPP_URL || 'http://localhost:3000',
      membership?.role,
      classroomSlug,
      'slides'
    ),
    importUrl: `/import?class=${encodeURIComponent(classroomSlug)}`,
    // The upload policy, handed to the client rather than imported there:
    // `@classmoji/services/slides` is the deck engine (and cheerio with it), and
    // it must never be reachable from a component. The server still re-checks
    // everything below with `validateSlideFile` — this is only what the form
    // needs to say "no" early and politely.
    upload: {
      maxBytes: SLIDE_FILE_MAX_BYTES,
      maxLabel: SLIDE_FILE_MAX_LABEL,
      extensions: [...SLIDE_FILE_EXTENSIONS] as string[],
      accept: SLIDE_FILE_EXTENSIONS.map(ext => `.${ext}`).join(','),
    },
  };
};

/** Every failure this action reports, in the shape the form re-renders from. */
function failure(error: string, source: SlideSource, status = 400) {
  return data({ error, source }, { status });
}

/**
 * The sentence a service refusal turns into.
 *
 * Only the two refusals this codebase WROTE are shown: a policy rejection and a
 * slug collision, both of which say what to do next. Everything else — a GitHub
 * 5xx, a dropped socket, a Prisma error — keeps its message in the server log
 * and gets `fallback` on the form. An upstream message reads like a leak even
 * when it is harmless, and at its most helpful it tells an instructor to push
 * from a local clone of a repository they have never seen.
 */
function messageFor(error: unknown, fallback: string): string {
  if (error instanceof slideFileService.SlideSourceError) return error.message;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'SLIDE_CONTENT_PATH_CONFLICT' && error instanceof Error) return error.message;
  }
  return fallback;
}

/**
 * Does this submission carry a file?
 *
 * Only the upload form posts multipart; the blank-deck and link forms are a
 * few hundred bytes of url-encoded fields. The distinction decides whether the
 * request has to take an upload slot, and a small form should not be refused
 * because two big uploads are in flight.
 */
function isMultipartUpload(request: Request): boolean {
  return (request.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('multipart/form-data');
}

export const action = async ({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string | undefined>;
}) => {
  const { classroomSlug } = params;
  if (!classroomSlug) return failure('Missing classroomSlug', 'blank');

  // Authorization FIRST — before a byte of the body is read. The classroom is
  // in the URL, so this costs nothing to move ahead of the upload.
  const { userId, membership } = await requireClassroomTeachingTeam(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
  });

  if (!isMultipartUpload(request)) {
    return createFromForm({ request, classroomSlug, userId, membership });
  }

  // One slot per upload in flight, given back in the `finally` below. The size
  // cap bounds one upload; this bounds how many of them this process is holding
  // at once. See `~/utils/uploadConcurrency.server`.
  if (!acquireUploadSlot()) {
    return data(
      { error: UPLOAD_BUSY_MESSAGE, source: 'file' as SlideSource },
      { status: 503, headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } }
    );
  }
  try {
    return await createFromForm({ request, classroomSlug, userId, membership });
  } finally {
    releaseUploadSlot();
  }
};

/** Everything the action does once it has a caller who is allowed to do it. */
async function createFromForm({
  request,
  classroomSlug,
  userId,
  membership,
}: {
  request: Request;
  classroomSlug: string;
  userId: string;
  membership: { role?: string | null } | null | undefined;
}) {
  // `Content-Length` is checked before the body is touched, and the bytes are
  // counted as they arrive, so a lying or absent header cannot get past it.
  let formData: FormData;
  try {
    formData = await readLimitedFormData(request, uploadBodyLimit(SLIDE_FILE_MAX_BYTES));
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) {
      return failure(`That file is too large. The limit is ${SLIDE_FILE_MAX_LABEL}.`, 'file', 413);
    }
    throw error;
  }

  // The picker's choice, and it has to BE one of the three. An unrecognised
  // value used to fall through to "blank", so a submission that meant to upload
  // a file — or one whose field never arrived — quietly created an empty deck
  // instead and reported success. Every form on this screen posts the field, so
  // anything else is a submission we cannot honour and should say so about.
  const rawSource = formData.get('source');
  if (typeof rawSource !== 'string' || !SLIDE_SOURCES.includes(rawSource as SlideSource)) {
    return failure('Choose how these slides should start.', 'blank');
  }
  const source = rawSource as SlideSource;
  const title = (formData.get('title') as string | null)?.trim();

  if (!title) {
    return failure('Please enter a title for these slides', source);
  }

  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    include: { git_organization: true },
  });

  if (!classroom) {
    return failure(`Classroom not found: ${classroomSlug}`, source, 404);
  }
  if (!classroom.git_organization?.login) {
    return failure('Git organization not configured for this classroom', source);
  }
  if (!classroom.content_repo) {
    return failure('Classroom content repo not configured', source);
  }

  // Where a FILE or a LINK goes afterwards: the webapp's slides list, in the
  // acting role's own tree. NOT `/{slideId}` — for those two kinds that URL is
  // a download and an offsite redirect.
  const slidesListUrl = webappClassUrl(
    process.env.WEBAPP_URL || 'http://localhost:3000',
    membership?.role,
    classroomSlug,
    'slides'
  );

  if (source === 'file') {
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return failure('Choose a file to upload.', 'file');
    }

    // The authoritative policy check: extension and size, from the one module
    // that owns both. The client form checks the same things for a faster no.
    const validation = validateSlideFile({ filename: file.name, size: file.size });
    if (!validation.valid) {
      return failure(validation.error, 'file');
    }

    try {
      await slideFileService.createFileSlide({
        classroomId: classroom.id,
        title,
        createdBy: userId,
        filename: file.name,
        // `Buffer.from(ArrayBuffer)` is a VIEW over the same memory, not a
        // second copy of it — `arrayBuffer()` above is the one allocation.
        file: Buffer.from(await file.arrayBuffer()),
      });
      return redirect(slidesListUrl);
    } catch (error: unknown) {
      console.error('Failed to create file slide:', error);
      return failure(
        messageFor(error, "Couldn't save the file to the course repository. Please try again."),
        'file'
      );
    }
  }

  if (source === 'link') {
    const url = String(formData.get('url') ?? '');
    const link = validateSlideLinkUrl(url);
    if (!link.ok) {
      return failure(link.error, 'link');
    }

    try {
      await slideFileService.createLinkSlide({
        classroomId: classroom.id,
        title,
        createdBy: userId,
        url: link.url,
      });
      return redirect(slidesListUrl);
    } catch (error: unknown) {
      console.error('Failed to create link slide:', error);
      return failure(
        messageFor(error, "Couldn't save the linked slide. Please try again."),
        'link'
      );
    }
  }

  try {
    // Orchestrated creation (content-tools plan §5.3): repo ensure → canonical
    // starter deck via saveDeck (deck.json + index.html in one commit) → DB
    // row → manifest refresh.
    const { slide } = await slideService.createSlide({
      classroomId: classroom.id,
      title,
      createdBy: userId,
    });

    // Redirect to the new slide in edit mode
    return redirect(`/${slide.id}?mode=edit`);
  } catch (error: unknown) {
    console.error('Failed to create slide:', error);
    return failure(messageFor(error, "Couldn't create the deck. Please try again."), 'blank');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared field styling, on design-system tokens so both themes come free.
 *
 * `tokens.css` redefines every one of these under `html.dark`, which the root
 * document toggles from the OS preference — so there is no `dark:` variant to
 * write here, and no second palette to keep in step.
 */
const FIELD_CLASS =
  'w-full rounded-[10px] border border-[var(--line-2)] bg-[var(--panel)] px-3 py-2 text-sm ' +
  'text-[var(--ink-0)] placeholder:text-[var(--ink-4)] outline-none transition-colors ' +
  'focus:border-[var(--accent)]';

const LABEL_CLASS = 'block text-sm font-medium text-[var(--ink-1)] mb-1.5';
const HELP_CLASS = 'mt-2 text-xs leading-relaxed text-[var(--ink-3)]';

/**
 * One card in the picker. Always an anchor, never a button.
 *
 * `source` gives a picker choice, which links to this same screen with a
 * different `?source=` — so it works with no JavaScript at all and becomes a
 * client-side navigation once hydrated. `href` gives the one card that leaves
 * (the slides.com import). The selected state is `aria-current` rather than
 * `aria-pressed` because the URL, not a toggle, is what holds it.
 *
 * While a submission is in flight every card is inert in the same three ways
 * the Cancel links are: not clickable, out of the tab order, announced as
 * disabled. `<a>` has no `disabled`, which is why it takes three things.
 */
function SourceOption({
  title,
  description,
  selected,
  source,
  href,
  disabled,
}: {
  title: string;
  description: string;
  selected?: boolean;
  /** A picker choice: navigates to `?source=…` on this same route. */
  source?: SlideSource;
  /** A card that goes somewhere else entirely. */
  href?: string;
  /** Frozen while a submission is in flight, so the form cannot change under it. */
  disabled?: boolean;
}) {
  const base =
    'block w-full text-left rounded-xl border px-4 py-3 transition-colors cursor-pointer ' +
    'focus:outline-none focus-visible:border-[var(--accent)]';
  const tone = selected
    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
    : 'border-[var(--line)] bg-[var(--panel)] hover:border-[var(--line-strong)]';
  const className = `${base} ${tone}${disabled ? ' pointer-events-none opacity-50' : ''}`;
  const inert = {
    'aria-disabled': disabled || undefined,
    tabIndex: disabled ? -1 : undefined,
    onClick: disabled
      ? (event: { preventDefault: () => void }) => event.preventDefault()
      : undefined,
  };
  const body = (
    <>
      <span
        className={`block text-sm font-semibold ${
          selected ? 'text-[var(--accent-ink)]' : 'text-[var(--ink-0)]'
        }`}
      >
        {title}
      </span>
      <span className="mt-0.5 block text-xs text-[var(--ink-3)]">{description}</span>
    </>
  );

  if (href) {
    return (
      <a href={href} className={className} {...inert}>
        {body}
      </a>
    );
  }

  return (
    // `replace`, because picking between the four cards is one decision and not
    // four history entries to back out of; `preventScrollReset`, because the
    // picker is at the top and the form below it should not jump.
    <Link
      to={`?source=${source}`}
      replace
      preventScrollReset
      aria-current={selected ? 'page' : undefined}
      className={className}
      {...inert}
    >
      {body}
    </Link>
  );
}

export default function NewSlidePage() {
  const {
    classroomSlug,
    classroomName,
    contentNamespace,
    source,
    slidesListUrl,
    importUrl,
    upload,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData() as { error?: string; source?: SlideSource } | undefined;

  // The title survives a switch between the cards, which after hydration is a
  // client navigation that never remounts this component. A pre-hydration
  // switch is a full page load and starts empty, which is the honest cost of a
  // picker that works before the JavaScript arrives.
  const [title, setTitle] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Name and size for the upload panel, captured when the file is chosen: the
  // input is disabled mid-flight, and `files` is not readable from a disabled
  // control in every browser.
  const [chosenFile, setChosenFile] = useState<{ name: string; size: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // True for the whole round trip, not just the bytes going up — see
  // `~/utils/pendingSubmission`. Only one of the three forms is mounted at a
  // time, so this is unambiguously about the one on screen; an error settling
  // flips it back to false, which is what hands the form back.
  const isSubmitting = isSubmissionPending(navigation);
  // No need to match the error against the card on screen any more. A `<Form>`
  // with no `action` posts to the CURRENT url, `?source=` included, and any
  // navigation clears `useActionData` — so an error that is here was produced
  // by the form that is here.
  const serverError = actionData?.error ?? null;

  const extensionList = useMemo(
    () => upload.extensions.map(ext => `.${ext}`).join(', '),
    [upload.extensions]
  );

  /**
   * The same two rules the server enforces, checked here so the author is told
   * before 35 MB go over the wire. Never the ONLY check — `validateSlideFile`
   * runs again in the action, because a form is not a gate.
   */
  const checkFile = useCallback(
    (file: File | null | undefined): string | null => {
      if (!file) return 'Choose a file to upload.';
      const dot = file.name.lastIndexOf('.');
      const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
      if (!upload.extensions.includes(ext)) {
        return `Slide files must be one of: ${extensionList}`;
      }
      if (file.size === 0) return 'That file is empty.';
      if (file.size > upload.maxBytes) {
        return `That file is too large. The limit is ${upload.maxLabel}.`;
      }
      return null;
    },
    [extensionList, upload.extensions, upload.maxBytes, upload.maxLabel]
  );

  const onFileSubmit = (event: FormEvent<HTMLFormElement>) => {
    const problem = checkFile(fileInputRef.current?.files?.[0] ?? null);
    setFileError(problem);
    if (problem) event.preventDefault();
  };

  const onLinkSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const raw = String(new FormData(form).get('url') ?? '').trim();
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
      <div className="mx-auto w-full max-w-2xl">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-[var(--ink-0)]">New Slide</h1>
            <p className="mt-1 text-sm text-[var(--ink-3)]">
              Add slides to {classroomName || classroomSlug}
            </p>
          </div>
          <PendingCancelLink
            href={slidesListUrl}
            pending={isSubmitting}
            className="btn btn-ghost"
          />
        </div>

        {/* Source picker */}
        <div className="card p-4 sm:p-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)]">
            Where do these slides come from?
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <SourceOption
              title="Start blank"
              description="A new deck you write in the editor"
              selected={source === 'blank'}
              source="blank"
              disabled={isSubmitting}
            />
            <SourceOption
              title="Upload a file"
              description={`PDF, PowerPoint or Keynote, up to ${upload.maxLabel}`}
              selected={source === 'file'}
              source="file"
              disabled={isSubmitting}
            />
            <SourceOption
              title="Link a URL"
              description="Point at slides that live somewhere else"
              selected={source === 'link'}
              source="link"
              disabled={isSubmitting}
            />
            <SourceOption
              title="Slides.com export"
              description="Import a .zip exported from slides.com"
              href={importUrl}
              disabled={isSubmitting}
            />
          </div>
        </div>

        {/* The chosen form */}
        <div className="card mt-4 p-5 sm:p-6">
          {serverError && (
            <div
              role="alert"
              className="mb-5 rounded-[10px] border border-[var(--rose-bord)] bg-[var(--rose-bg)] px-4 py-3 text-sm text-[var(--rose-ink)]"
            >
              {serverError}
            </div>
          )}

          {source === 'blank' && (
            <Form method="post">
              <input type="hidden" name="source" value="blank" />

              <div className="mb-5">
                <label className={LABEL_CLASS} htmlFor="blank-title">
                  Title <span className="text-[var(--rose-ink)]">*</span>
                </label>
                <input
                  id="blank-title"
                  type="text"
                  name="title"
                  required
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  placeholder="e.g., Introduction to JavaScript"
                  disabled={isSubmitting}
                  className={`${FIELD_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
                />
              </div>

              <div className="mb-5">
                <label className={LABEL_CLASS} htmlFor="blank-namespace">
                  Content namespace
                </label>
                <input
                  id="blank-namespace"
                  type="text"
                  value={contentNamespace ?? ''}
                  disabled
                  className={`${FIELD_CLASS} cursor-not-allowed bg-[var(--panel-tint)] text-[var(--ink-3)]`}
                />
                <p className={HELP_CLASS}>Determined by your classroom settings.</p>
              </div>

              <div className="flex justify-end gap-2">
                <PendingCancelLink href={slidesListUrl} pending={isSubmitting} />
                <PendingSubmitButton pending={isSubmitting} pendingLabel="Creating…">
                  Create deck
                </PendingSubmitButton>
              </div>
            </Form>
          )}

          {source === 'file' && (
            <Form method="post" encType="multipart/form-data" onSubmit={onFileSubmit}>
              <input type="hidden" name="source" value="file" />

              <div className="mb-5">
                <label className={LABEL_CLASS} htmlFor="file-title">
                  Title <span className="text-[var(--rose-ink)]">*</span>
                </label>
                <input
                  id="file-title"
                  type="text"
                  name="title"
                  required
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  placeholder="e.g., Week 3 Lecture"
                  disabled={isSubmitting}
                  className={`${FIELD_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
                />
              </div>

              <div className="mb-5">
                <label className={LABEL_CLASS} htmlFor="file-input">
                  File <span className="text-[var(--rose-ink)]">*</span>
                </label>
                <input
                  id="file-input"
                  ref={fileInputRef}
                  type="file"
                  name="file"
                  accept={upload.accept}
                  disabled={isSubmitting}
                  onChange={event => {
                    const picked = event.target.files?.[0] ?? null;
                    setChosenFile(picked ? { name: picked.name, size: picked.size } : null);
                    setFileError(checkFile(picked));
                  }}
                  className={`${FIELD_CLASS} file:mr-3 file:rounded-md file:border-0 file:bg-[var(--accent-soft)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-60`}
                />
                {fileError && (
                  <p role="alert" className="mt-2 text-xs font-medium text-[var(--rose-ink)]">
                    {fileError}
                  </p>
                )}
                <p className={HELP_CLASS}>
                  Students download the file under its original name. PDF, PowerPoint or Keynote, up
                  to {upload.maxLabel}.
                </p>

                {isSubmitting && <UploadPendingPanel file={chosenFile} />}
              </div>

              <div className="flex justify-end gap-2">
                <PendingCancelLink href={slidesListUrl} pending={isSubmitting} />
                <PendingSubmitButton pending={isSubmitting} pendingLabel="Uploading…">
                  Upload file
                </PendingSubmitButton>
              </div>
            </Form>
          )}

          {source === 'link' && (
            <Form method="post" onSubmit={onLinkSubmit}>
              <input type="hidden" name="source" value="link" />

              <div className="mb-5">
                <label className={LABEL_CLASS} htmlFor="link-title">
                  Title <span className="text-[var(--rose-ink)]">*</span>
                </label>
                <input
                  id="link-title"
                  type="text"
                  name="title"
                  required
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  placeholder="e.g., Guest Lecture Slides"
                  disabled={isSubmitting}
                  className={`${FIELD_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
                />
              </div>

              <div className="mb-5">
                <label className={LABEL_CLASS} htmlFor="link-url">
                  Link <span className="text-[var(--rose-ink)]">*</span>
                </label>
                <input
                  id="link-url"
                  type="url"
                  name="url"
                  required
                  inputMode="url"
                  placeholder="https://example.com/slides"
                  onChange={() => setLinkError(null)}
                  disabled={isSubmitting}
                  className={`${FIELD_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
                />
                {linkError && (
                  <p role="alert" className="mt-2 text-xs font-medium text-[var(--rose-ink)]">
                    {linkError}
                  </p>
                )}
                <p className={HELP_CLASS}>
                  Classmoji controls who sees the link, not who can open the destination. Whoever
                  the sharing settings on the other end let in can open it, so set those there.
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <PendingCancelLink href={slidesListUrl} pending={isSubmitting} />
                <PendingSubmitButton pending={isSubmitting} pendingLabel="Saving…">
                  Add link
                </PendingSubmitButton>
              </div>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}
