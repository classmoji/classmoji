import { useEffect, useState } from 'react';
import { Link, data, useFetcher, useLoaderData, type SubmitTarget } from 'react-router';
import { exceedsMaxDepth, type FormField } from '@classmoji/services/form-contract';

import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { checkOrigin, readCappedBody } from '~/utils/originCheck.server.ts';
import { FormCanvas, FormHeader, FormNotice } from '~/components/forms/FormCanvas.tsx';
import FormRenderer, { clearDraftsForForm } from '~/components/forms/FormRenderer.tsx';
import AnswerView from '~/components/forms/AnswerView.tsx';
import { formLinkCookie } from '~/utils/formLinkCookie.server.ts';
import { themeFor, type CanvasTheme } from './publicForm.server.ts';

/**
 * The magic-link review-and-confirm page —
 * `/{classroomSlug}/forms/{slug}/verify?token=…`.
 *
 * ── What the link proves ───────────────────────────────────────────────────
 * That whoever holds it can read the mailbox the response was submitted under.
 * That is the ENTIRE authentication for a public submission, which is why the
 * token is 256 bits and hashed at rest — and why this page has no other way
 * in. There is no "look up my response by email" form anywhere in the stack,
 * because that is the enumeration hole the link exists to close.
 *
 * ── Two clocks, not one lifetime ───────────────────────────────────────────
 * The token is MINTED with 48 hours on it, and that number is the deadline to
 * CLICK: an unconfirmed row only holds its place in the queue while its link
 * is live (`assertCapAvailable`). Confirming does not spend the token, it
 * EXTENDS it to the form's own life — from that point the link is the person's
 * handle on their response, which is the only handle there is.
 *
 * ── Nothing here consumes ──────────────────────────────────────────────────
 * The loader calls `verifyMagicToken`, which does not burn the token: reloading
 * the review page, or opening the link twice before deciding, must not cost the
 * person their response. Neither does confirming, any more — see
 * `editLinkExpiresAt` for why single-use was dropped.
 *
 * ── Editing ────────────────────────────────────────────────────────────────
 * "Edit answers" mounts the SAME renderer the fill page uses, prefilled, and
 * resubmits with the token — `confirmSubmission` replaces the answers. A
 * response that was already verified keeps its original `verified_at`, so
 * editing never costs a FIFO waitlist place.
 *
 * ── Cache ──────────────────────────────────────────────────────────────────
 * `no-store`, because this page serves one person's answers to a bearer-token
 * GET. Same posture the responses surface took in phase 3.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Re-emit the loader's `no-store` on the DOCUMENT response.
 *
 * `data(…, { headers })` only reaches the single-fetch `.data` response; a
 * document request drops it unless the route hands the loader's headers back
 * here. Same two-part arrangement `responses.tsx` uses — and the same reason:
 * the first load of a magic link IS a document request, so covering only the
 * `.data` path would leave the one response that actually carries the answers
 * cacheable.
 */
export const headers = ({ loaderHeaders }: { loaderHeaders: Headers }) => loaderHeaders;

type LinkProblem = 'missing' | 'invalid' | 'expired' | 'used';

export type VerifyLoad =
  | {
      view: 'problem';
      problem: LinkProblem;
      theme: CanvasTheme;
      classroomName: string;
      fillPath: string;
    }
  /**
   * The link was opened BEFORE the form was submitted — the state the early
   * send makes ordinary. The address is now proved; the answers are still
   * theirs to finish.
   */
  | {
      view: 'verified';
      theme: CanvasTheme;
      classroomName: string;
      fillPath: string;
      form: { id: string; title: string; description: string | null };
      identity: { email: string; name: string | null };
    }
  | {
      view: 'review';
      theme: CanvasTheme;
      classroomName: string;
      fillPath: string;
      form: { id: string; title: string; description: string | null };
      /** Already confirmed once — this link is an EDIT link, not a first confirm. */
      alreadyVerified: boolean;
      identity: { email: string; name: string | null };
      fields: unknown[];
      answers: Record<string, unknown>;
      resolvedContext: unknown;
    };

/** Map a service error code to the state the page renders. */
const problemFor = (code: string | undefined): LinkProblem => {
  if (code === 'MAGIC_LINK_EXPIRED') return 'expired';
  if (code === 'MAGIC_LINK_USED') return 'used';
  return 'invalid';
};

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const classroomSlug = params.classroomSlug!;
  const formSlug = params.formSlug!;
  const fillPath = `/${classroomSlug}/forms/${formSlug}`;

  const classroom = await prisma.classroom.findFirst({
    where: { slug: classroomSlug },
    select: { id: true, name: true, settings: { select: { theme: true } } },
  });
  if (!classroom) throw new Response('Form not found', { status: 404 });

  const theme = themeFor(classroom.settings?.theme);
  const classroomName = classroom.name ?? classroomSlug;
  const problem = (kind: LinkProblem) =>
    data(
      { view: 'problem' as const, problem: kind, theme, classroomName, fillPath },
      { headers: NO_STORE }
    );

  const token = new URL(request.url).searchParams.get('token');
  if (!token) return problem('missing');

  let resolved;
  try {
    resolved = await ClassmojiService.formResponse.verifyMagicToken(token);
  } catch (error) {
    return problem(problemFor((error as { code?: string }).code));
  }

  // The token names a response, and the URL names a form. They must agree:
  // a valid link opened at another form's address must not render that form's
  // definition around someone else's answers.
  if (resolved.form.slug !== formSlug || resolved.form.classroom_id !== classroom.id) {
    return problem('invalid');
  }

  /**
   * ── The link, opened on the way through ──────────────────────────────────
   *
   * Since the verification mail now goes out when the ADDRESS is typed, the
   * common case is a link opened while the form is still half-filled. There is
   * no response to review — the row holds an address and `{}` — so this shows
   * what actually happened (the address is verified) and sends them back to
   * finish, rather than rendering an empty answer set as though it were a
   * submission.
   *
   * Two side effects, both deliberate on a GET:
   *
   *  - `verifyAddressByToken` stamps `verified_at`. It is idempotent and does
   *    NOT spend the token, which is what makes the page survive a reload and a
   *    corporate mail scanner opening the link ahead of the human.
   *  - the raw token is handed to this browser as an HttpOnly, form-scoped
   *    cookie, which is what lets the submit that follows land in one round
   *    trip. `verified_at` alone never admits a submission — see
   *    `submitVerifiedPublic`.
   */
  if (ClassmojiService.formResponse.isAddressPlaceholder(resolved.response)) {
    try {
      await ClassmojiService.formResponse.verifyAddressByToken(token);
    } catch (error) {
      return problem(problemFor((error as { code?: string }).code));
    }

    const headers = new Headers(NO_STORE);
    headers.append(
      'Set-Cookie',
      formLinkCookie({
        request,
        classroomSlug,
        formSlug,
        rawToken: token,
        maxAgeSeconds: Math.max(0, (resolved.expiresAt.getTime() - Date.now()) / 1000),
      })
    );

    return data(
      {
        view: 'verified' as const,
        theme,
        classroomName,
        fillPath,
        form: {
          id: resolved.form.id,
          title: resolved.form.title,
          description: resolved.form.description,
        },
        identity: { email: resolved.response.email, name: resolved.response.name },
      },
      { headers }
    );
  }

  return data(
    {
      view: 'review' as const,
      theme,
      classroomName,
      fillPath,
      form: {
        id: resolved.form.id,
        title: resolved.form.title,
        description: resolved.form.description,
      },
      alreadyVerified: resolved.response.verified_at !== null,
      identity: { email: resolved.response.email, name: resolved.response.name },
      fields: ClassmojiService.form.fieldsOf(resolved.revision.fields),
      answers: (resolved.response.answers ?? {}) as Record<string, unknown>,
      resolvedContext: resolved.response.resolved_context,
    },
    { headers: NO_STORE }
  );
};

// ─── Action ─────────────────────────────────────────────────────────────────

type ActionResult =
  /**
   * `formTitle` rides along rather than being read from the loader, because by
   * the time this renders the loader has revalidated and — the token now being
   * spent — has fallen back to the problem view, which carries no form.
   */
  | { state: 'confirmed'; formId: string; formTitle: string; edited: boolean }
  | { state: 'cap' }
  | { state: 'closed' }
  | { state: 'link'; problem: LinkProblem }
  /** A confirm for a row that has an address and no answers yet. */
  | { state: 'not-submitted' }
  | { state: 'error'; message: string };

export const action = async ({ request }: { request: Request }) => {
  const origin = checkOrigin(request);
  if (!origin.ok) {
    console.warn('[forms:verify] refused cross-site confirmation', {
      reason: origin.reason,
      origin: origin.origin,
    });
    return new Response('Cross-site submissions are not accepted.', { status: 403 });
  }

  const raw = await readCappedBody(request);
  if (raw === null) return new Response('That submission is too large.', { status: 413 });

  let body: { token?: string; answers?: Record<string, unknown> };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return new Response('Malformed submission.', { status: 400 });
  }

  // The same shape guard the fill action runs, for the same reason: this
  // endpoint is reachable by anyone holding (or guessing at) a token, and a body
  // nested deeper than `JSON.stringify` can walk must be refused before it
  // reaches the contract's size probe. See the note in fill.tsx.
  if (exceedsMaxDepth(body)) {
    console.warn('[forms:verify] refused a pathologically nested submission', {
      bytes: raw.length,
    });
    return new Response('Malformed submission.', { status: 400 });
  }

  if (!body.token) return { state: 'link', problem: 'missing' } satisfies ActionResult;

  try {
    const { response } = await ClassmojiService.formResponse.confirmSubmission(body.token, {
      // `undefined` means "confirm what is stored"; an object means "replace
      // the answers with these". The distinction is the whole difference
      // between the Confirm button and the Edit flow.
      ...(body.answers === undefined ? {} : { answers: body.answers }),
    });
    const form = await prisma.form.findUnique({
      where: { id: response.form_id },
      select: { title: true },
    });

    return {
      state: 'confirmed',
      formId: response.form_id,
      formTitle: form?.title ?? 'this form',
      edited: body.answers !== undefined,
    } satisfies ActionResult;
  } catch (error) {
    const code = (error as { code?: string }).code;

    if (code === 'FORM_CAP_REACHED') return { state: 'cap' } satisfies ActionResult;

    // Unreachable from the UI — a placeholder renders the "go and finish"
    // state, which has no Confirm button — so this only answers a hand-made
    // POST. Answered accurately rather than as a generic error, because the
    // accurate answer is also the useful one.
    if (code === 'FORM_NOT_SUBMITTED_YET') return { state: 'not-submitted' } satisfies ActionResult;

    // A form that closed between the submission and the click. Honest, and the
    // same shape as the cap message: their answers are safe, but not counted.
    if (code === 'FORM_NOT_OPEN' || code === 'FORM_CLOSED') {
      return { state: 'closed' } satisfies ActionResult;
    }

    if (code && code.startsWith('MAGIC_LINK_')) {
      return { state: 'link', problem: problemFor(code) } satisfies ActionResult;
    }

    if (code === 'FORM_ANSWERS_INVALID' || code === 'FORM_ANSWERS_TOO_LARGE') {
      return { state: 'error', message: (error as Error).message } satisfies ActionResult;
    }

    throw error;
  }
};

// ─── View ───────────────────────────────────────────────────────────────────

const PROBLEM_COPY: Record<LinkProblem, { icon: string; title: string; body: string }> = {
  missing: {
    icon: '🔗',
    title: 'This link is incomplete',
    body: 'It is missing the part that identifies your response. Open the link from your email exactly as it was sent, or fill the form in again to get a new one.',
  },
  invalid: {
    icon: '🔗',
    title: 'This link is not valid',
    body: 'It may have been mistyped, or it may belong to a different form. Fill the form in again and we will send you a fresh link.',
  },
  expired: {
    icon: '⏳',
    title: 'This link has expired',
    // No number here any more. A link can reach this screen by two different
    // routes now — the 48-hour click deadline on a response that was never
    // confirmed, and a confirmed response whose FORM has since closed — and
    // "links last 48 hours" is plainly wrong for the second.
    body: 'Fill the form in again and we will send you a new one — if you already had a response saved, the new link will open it.',
  },
  // Deliberately NEUTRAL. A used token means the response was confirmed — but
  // saying so to whoever holds a spent link would confirm that the address
  // behind it responded, which is the oracle the whole flow avoids.
  used: {
    icon: '✅',
    title: 'This link has already been used',
    body: 'Each link works once. Fill the form in again to get a new one — it will open your response for editing rather than starting a second one.',
  },
};

function LinkProblemView({
  problem,
  theme,
  classroomName,
  fillPath,
}: {
  problem: LinkProblem;
  theme: CanvasTheme;
  classroomName: string;
  fillPath: string;
}) {
  const copy = PROBLEM_COPY[problem];
  return (
    <FormCanvas theme={theme} classroomName={classroomName}>
      <FormNotice icon={copy.icon} title={copy.title}>
        <p>{copy.body}</p>
        <Link
          to={fillPath}
          className="mt-5 inline-block rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-900"
        >
          Request a new link
        </Link>
      </FormNotice>
    </FormCanvas>
  );
}

export default function FormVerify() {
  const loaded = useLoaderData() as VerifyLoad;
  const fetcher = useFetcher<ActionResult>();
  const result = fetcher.data;
  const [editing, setEditing] = useState(false);

  /**
   * The confirmed response is the moment the browser draft has served its
   * purpose. Clearing it HERE rather than on the fill page's check-email state
   * is deliberate: the fill page cannot know whether a submission was a first
   * one or an edit (telling it would be the membership oracle), and an edit
   * whose link is never clicked should still find its draft waiting.
   */
  useEffect(() => {
    if (result?.state === 'confirmed') clearDraftsForForm(result.formId);
  }, [result]);

  /**
   * THE ACTION'S RESULT IS READ BEFORE THE LOADER'S VIEW, and that order is
   * load-bearing.
   *
   * Confirming consumes the token, and React Router revalidates every loaded
   * route after an action — so the loader immediately re-runs, `verifyMagicToken`
   * now throws MAGIC_LINK_USED, and `loaded` comes back as the "already used"
   * problem view. Rendering the loader first would therefore greet everyone who
   * successfully confirmed with "this link has already been used", which is
   * both alarming and, for the one person it is wrong about, false: they used
   * it, just now, and it worked.
   *
   * The action knows what actually happened. It wins.
   */
  if (result?.state === 'confirmed') {
    return (
      <FormCanvas theme={loaded.theme} classroomName={loaded.classroomName}>
        <FormNotice icon="🎉" title="You're in">
          <p>
            Your response to <strong className="font-semibold">{result.formTitle}</strong> is
            recorded{result.edited ? ' with your changes' : ''}. We have your answers and the
            teaching team can see them.
          </p>
          {/* Points at the link they already have, NOT back at the form.
              "Fill it in again with the same address and we will email you"
              was never true for somebody who has verified: that address is
              deliberately sent nothing, so the instruction led to a blank form
              and mail that was never coming. The link in their inbox is the way
              back, and since a submission stopped spending it, saying so is
              finally honest. */}
          <p className="mt-3 text-gray-500 dark:text-gray-400">
            Nothing else is needed from you. Keep the email we sent you — that link brings you back
            to this response for as long as the form is open.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  if (result?.state === 'cap' || result?.state === 'closed') {
    const filledUp = result.state === 'cap';
    return (
      <FormCanvas theme={loaded.theme} classroomName={loaded.classroomName}>
        <FormNotice icon="🚪" title={filledUp ? 'The form filled up' : 'The form closed'}>
          <p>
            {filledUp
              ? 'It reached its limit before you confirmed, so this response could not be recorded.'
              : 'It stopped accepting responses before you confirmed, so this response could not be recorded.'}{' '}
            Your answers were not lost — they were just never counted. Get in touch with the course
            staff if you think you should have made it.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  if (result?.state === 'not-submitted') {
    return (
      <FormCanvas theme={loaded.theme} classroomName={loaded.classroomName}>
        <FormNotice icon="✍️" title="There is nothing to confirm yet">
          <p>
            This link belongs to an address, not to a response — the form has not been submitted
            under it. Go back and finish your answers; your address is already verified, so pressing
            Submit is the last step.
          </p>
          <Link
            to={loaded.fillPath}
            className="mt-5 inline-block rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-900"
          >
            Back to the form
          </Link>
        </FormNotice>
      </FormCanvas>
    );
  }

  // A link that was already dead when the action ran, and one that was dead
  // when the page loaded. Both land on the same explanation.
  if (result?.state === 'link') {
    return (
      <LinkProblemView
        problem={result.problem}
        theme={loaded.theme}
        classroomName={loaded.classroomName}
        fillPath={loaded.fillPath}
      />
    );
  }

  if (loaded.view === 'problem') {
    return (
      <LinkProblemView
        problem={loaded.problem}
        theme={loaded.theme}
        classroomName={loaded.classroomName}
        fillPath={loaded.fillPath}
      />
    );
  }

  /**
   * The address is proved and the form is not finished — the ordinary shape of
   * this page now that the mail goes out early.
   *
   * It says three things in order, because each one answers the question the
   * previous one raises: the address is verified, that is not the same as
   * having applied, and here is the way back. The button is the primary action
   * for the same reason — the only useful thing to do from here is go and
   * finish.
   */
  if (loaded.view === 'verified') {
    return (
      <FormCanvas theme={loaded.theme} classroomName={loaded.classroomName}>
        <FormNotice icon="✅" title="Your email is verified">
          <p>
            <strong className="font-semibold">{loaded.identity.email}</strong> is confirmed for{' '}
            <strong className="font-semibold">{loaded.form.title}</strong>. Nothing has been
            recorded yet — go back and finish your answers, and this time Submit is the last step.
          </p>
          <Link
            to={loaded.fillPath}
            data-testid="forms-go-finish"
            className="mt-5 inline-block rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-900"
          >
            Finish your answers →
          </Link>
          <p className="mt-4 text-gray-500 dark:text-gray-400">
            Keep this email — the same link opens your response later if you want to change it.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  const fields = loaded.fields as FormField[];

  return (
    <FormCanvas theme={loaded.theme} classroomName={loaded.classroomName}>
      <FormHeader title={loaded.form.title} description={loaded.form.description} />

      <div className="mb-6 rounded-md bg-gray-50 px-3 py-2.5 text-sm dark:bg-gray-800">
        <div className="font-medium text-gray-800 dark:text-gray-100">
          {loaded.identity.name ?? 'Your response'}
        </div>
        <div className="text-gray-500 dark:text-gray-400">{loaded.identity.email}</div>
      </div>

      {editing ? (
        <>
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Edit your answers
            </h2>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Cancel
            </button>
          </div>
          <FormRenderer
            fields={fields}
            storedAnswers={loaded.answers}
            identityDefaults={loaded.identity}
            /* No draft key: this IS the stored response, and an autosave here
               would seed the public fill page with an edit that was abandoned. */
            draftKey={null}
            submitLabel="Save and confirm"
            busy={fetcher.state !== 'idle'}
            error={result?.state === 'error' ? result.message : null}
            onSubmit={submission =>
              fetcher.submit(
                // Same cast as the fill page: an answer set's shape is
                // per-field-type and structurally undescribable, and the action
                // re-parses it through the contract anyway.
                { token: tokenFromLocation(), answers: submission.answers } as SubmitTarget,
                { method: 'post', encType: 'application/json' }
              )
            }
          />
        </>
      ) : (
        <>
          <div className="mb-2 text-sm text-gray-600 dark:text-gray-300">
            {loaded.alreadyVerified
              ? 'This is the response we already have for you. Confirm it as it stands, or change it first.'
              : 'Here is what you sent. Confirm it and your response is recorded.'}
          </div>

          <div className="mb-7 border-t border-gray-200 pt-5 dark:border-gray-700">
            <AnswerView
              fields={fields}
              answers={loaded.answers}
              resolvedContext={loaded.resolvedContext}
            />
          </div>

          {result?.state === 'error' ? (
            <div
              role="alert"
              className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {result.message}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={fetcher.state !== 'idle'}
              onClick={() =>
                fetcher.submit(
                  { token: tokenFromLocation() },
                  { method: 'post', encType: 'application/json' }
                )
              }
              className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              {fetcher.state !== 'idle' ? 'Confirming…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200"
            >
              Edit answers
            </button>
          </div>
        </>
      )}
    </FormCanvas>
  );
}

/**
 * The token, read from the address bar at submit time.
 *
 * It is deliberately NOT round-tripped through the loader's data: putting it in
 * the payload React Router serializes into the document would write the one
 * credential that opens this response into the page source, where an extension,
 * a bug reporter's HTML dump, or a screenshot of "view source" would carry it.
 * The URL already holds it, and the URL is where a magic link lives.
 */
function tokenFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('token') ?? '';
}
