import { useEffect, useState } from 'react';
import { useFetcher, useLoaderData, type SubmitTarget } from 'react-router';
import type { FormField } from '@classmoji/services/form-contract';

import { ClassmojiService } from '~/utils/db.server.ts';
import { checkOrigin, readCappedBody } from '~/utils/originCheck.server.ts';
import { dispatchVerifyEmail } from '~/utils/tasks.server.ts';
import {
  FormCanvas,
  FormHeader,
  FormNotice,
  type CanvasTheme,
} from '~/components/forms/FormCanvas.tsx';
import AnswerView from '~/components/forms/AnswerView.tsx';
import FormRenderer, { draftKeyFor } from '~/components/forms/FormRenderer.tsx';
import { extractIdentity } from '~/components/forms/answerCoerce.ts';
import { loadPublicForm, type PublicFormLoad } from './publicForm.server.ts';

/**
 * The public fill page — `/{classroomSlug}/forms/{slug}`.
 *
 * ── Anonymous by design ────────────────────────────────────────────────────
 * `root.tsx` exempts this path from the login redirect, so nothing upstream is
 * checking anything: `loadPublicForm` is the whole gate, on the read path AND
 * on the write path. Its check order is documented there and is a disclosure
 * decision, not a style choice.
 *
 * ── What a submission does ─────────────────────────────────────────────────
 * Nothing that counts. The action stores PENDING_VERIFICATION and mails a
 * single-use link; the response becomes real only when that link is clicked.
 *
 * Every outcome a caller can distinguish — a first submission, a second one
 * from an address that already responded, a cooldown, and a bot that filled the
 * honeypot — renders the IDENTICAL "check your email" view. Any difference
 * between them is a membership oracle: type an address, learn whether that
 * person applied. `beginPublicSubmission` returns a `mode` that says exactly
 * that, and this action deliberately drops it on the floor.
 */

/**
 * What the BROWSER gets. The classroom load carries a `server` block (the
 * session user id, the identity answers to inject) that exists for the action's
 * benefit; a loader's return value is shipped to the client, so it is dropped
 * here rather than being trusted not to matter. The action never reads it back
 * from the page — it calls `loadPublicForm` again and gets its own copy.
 */
export type ClientFormLoad =
  | Exclude<PublicFormLoad, { view: 'classroom-fill' }>
  | Omit<Extract<PublicFormLoad, { view: 'classroom-fill' }>, 'server'>;

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}): Promise<ClientFormLoad> => {
  const loaded = await loadPublicForm({
    classroomSlug: params.classroomSlug!,
    formSlug: params.formSlug!,
    request,
  });

  if (loaded.view === 'classroom-fill') {
    const { server: _server, ...clientSafe } = loaded;
    return clientSafe;
  }
  return loaded;
};

// ─── Action ─────────────────────────────────────────────────────────────────

/** What the action tells the page to render. Never carries `mode`. */
type ActionResult =
  | { state: 'check-email'; email: string }
  | { state: 'closed' }
  | { state: 'stale'; answers: Record<string, unknown>; email: string; name: string | null }
  | { state: 'error'; message: string }
  // ── Classroom outcomes ──────────────────────────────────────────────────
  /** A server-side autosave landed. `at` is only for the "Draft saved" line. */
  | { state: 'draft-saved'; at: string }
  /** An autosave the server declined to write. Silent on the page by design. */
  | { state: 'draft-skipped' }
  | { state: 'recorded' }
  /** A submit against a form this person has already answered, finally. */
  | { state: 'already-recorded' };

/** The submission envelope, before anything in it is believed. */
interface SubmissionBody {
  answers?: Record<string, unknown>;
  identity?: { email?: string; name?: string | null };
  revisionId?: string;
  trapped?: boolean;
  /** Classroom only. Absent means "submit". */
  intent?: 'autosave' | 'submit';
}

/**
 * The classroom write path: autosave a draft, or submit.
 *
 * `loaded` is what `loadPublicForm` produced FOR THIS REQUEST, from the session
 * — not what the page was rendered with. Three things therefore come from the
 * server and cannot be influenced by the body:
 *
 *  - `server.userId`, which is the only key the response row is written under.
 *    A `responseId` or `userId` in the body is not rejected; it is never read.
 *  - `server.injected`, the identity answers, written OVER whatever the client
 *    sent for those fields.
 *  - the mode. An autosave is refused once a response is SUBMITTED, because
 *    `upsertDraft` writes `answers` onto the existing row: a debounced save
 *    firing while someone re-reads their submitted answers would quietly
 *    replace a real submission with a half-typed one.
 *
 * `revisionId` DOES come from the body, deliberately — it is what the browser
 * rendered against, and comparing it to the current revision is the staleness
 * check. Passing the current one would make that check unfalsifiable.
 */
async function classroomWrite(
  loaded: Extract<PublicFormLoad, { view: 'classroom-fill' }>,
  body: SubmissionBody
): Promise<ActionResult> {
  const answers = {
    ...((body.answers ?? {}) as Record<string, unknown>),
    ...loaded.server.injected,
  };
  const revisionId = String(body.revisionId ?? '');

  if (body.intent === 'autosave') {
    if (loaded.mode !== 'fill') return { state: 'draft-skipped' };
    if (revisionId !== loaded.revisionId) return { state: 'draft-skipped' };

    try {
      await ClassmojiService.formResponse.upsertDraft({
        formId: loaded.form.id,
        revisionId: loaded.revisionId,
        userId: loaded.server.userId,
        email: loaded.identity.email,
        name: loaded.identity.name || null,
        answers,
      });
      return { state: 'draft-saved', at: new Date().toISOString() };
    } catch (error) {
      // A draft is a convenience. An oversized one, or a lost race with the
      // partial unique index, must not become an error in front of someone who
      // is mid-sentence — the submit path validates for real.
      console.warn('[forms:fill] classroom draft not saved', {
        formId: loaded.form.id,
        code: (error as { code?: string }).code,
      });
      return { state: 'draft-skipped' };
    }
  }

  if (loaded.mode === 'recorded') {
    // Already answered, and this form does not take a replacement. NOT
    // `closed` — a single-response form that never closed would then be
    // explained with a sentence that is simply untrue. Unreachable from the UI
    // (the renderer is not mounted in this mode), so this only answers a
    // crafted request, which is all the more reason for it to be accurate.
    return { state: 'already-recorded' };
  }

  try {
    await ClassmojiService.formResponse.submitClassroom({
      formId: loaded.form.id,
      userId: loaded.server.userId,
      email: loaded.identity.email,
      name: loaded.identity.name || null,
      answers,
      revisionId,
    });
    return { state: 'recorded' };
  } catch (error) {
    const code = (error as { code?: string }).code;

    if (code === 'FORM_REVISION_STALE') {
      return {
        state: 'stale',
        answers,
        email: loaded.identity.email,
        name: loaded.identity.name || null,
      };
    }

    if (
      code === 'FORM_NOT_OPEN' ||
      code === 'FORM_CLOSED' ||
      code === 'FORM_CAP_REACHED' ||
      code === 'FORM_ALREADY_SUBMITTED'
    ) {
      return { state: 'closed' };
    }

    if (
      code === 'FORM_ANSWERS_INVALID' ||
      code === 'FORM_ANSWERS_TOO_LARGE' ||
      code === 'FORM_ACCESS_MISMATCH'
    ) {
      return { state: 'error', message: (error as Error).message };
    }

    throw error;
  }
}

export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  // Origin FIRST — before the body is read, before a single query runs. A
  // cross-site post is refused on a header at no cost, and never becomes work
  // that someone else's page can make a visitor's browser pay for.
  const origin = checkOrigin(request);
  if (!origin.ok) {
    console.warn('[forms:fill] refused cross-site submission', {
      reason: origin.reason,
      origin: origin.origin,
      path: new URL(request.url).pathname,
    });
    return new Response('Cross-site submissions are not accepted.', { status: 403 });
  }

  const raw = await readCappedBody(request);
  if (raw === null) return new Response('That submission is too large.', { status: 413 });

  let body: SubmissionBody;
  try {
    body = JSON.parse(raw) as SubmissionBody;
  } catch {
    return new Response('Malformed submission.', { status: 400 });
  }

  const loaded = await loadPublicForm({
    classroomSlug: params.classroomSlug!,
    formSlug: params.formSlug!,
    request,
  });

  // The write path re-derives what the read path derived. A form that closed,
  // filled up, or went back to DRAFT since the page loaded is refused here,
  // whatever the page believed when it rendered.
  if (loaded.view === 'classroom-fill') {
    return classroomWrite(loaded, body);
  }

  if (loaded.view !== 'fill') {
    return { state: 'closed' } satisfies ActionResult;
  }

  const answers = (body.answers ?? {}) as Record<string, unknown>;
  const identity = extractIdentity(loaded.fields as FormField[], answers, {
    email: body.identity?.email,
    name: body.identity?.name,
  });

  /**
   * The honeypot, checked AFTER the identity is read and BEFORE anything is
   * written: no row, no token, no cooldown consumed. A bot gets the same page a
   * person gets — telling it that it failed is how a bot learns to leave the
   * field alone next time.
   */
  if (body.trapped) {
    return { state: 'check-email', email: identity.email } satisfies ActionResult;
  }

  if (!identity.email) {
    return {
      state: 'error',
      message: 'We need an email address so we can send you a confirmation link.',
    } satisfies ActionResult;
  }

  try {
    const result = await ClassmojiService.formResponse.beginPublicSubmission({
      formId: loaded.form.id,
      email: identity.email,
      name: identity.name,
      answers,
      // The revision the BROWSER rendered against, not the current one — sending
      // the current one would make the staleness check unfalsifiable.
      revisionId: String(body.revisionId ?? ''),
    });

    await dispatchVerifyEmail(result.emails, result.verifyUrl);

    return { state: 'check-email', email: identity.email } satisfies ActionResult;
  } catch (error) {
    const code = (error as { code?: string }).code;

    // The same view as success. A visible cooldown would answer "has this
    // address submitted recently?" — the same oracle by another name.
    if (code === 'MAGIC_LINK_COOLDOWN') {
      return { state: 'check-email', email: identity.email } satisfies ActionResult;
    }

    if (code === 'FORM_REVISION_STALE') {
      return {
        state: 'stale',
        answers,
        email: identity.email,
        name: identity.name,
      } satisfies ActionResult;
    }

    if (code === 'FORM_NOT_OPEN' || code === 'FORM_CLOSED' || code === 'FORM_CAP_REACHED') {
      return { state: 'closed' } satisfies ActionResult;
    }

    if (
      code === 'FORM_ANSWERS_INVALID' ||
      code === 'FORM_ANSWERS_TOO_LARGE' ||
      code === 'FORM_ACCESS_MISMATCH'
    ) {
      return { state: 'error', message: (error as Error).message } satisfies ActionResult;
    }

    throw error;
  }
};

// ─── View ───────────────────────────────────────────────────────────────────

function SignInInterstitial({
  theme,
  classroomName,
  loginUrl,
}: {
  theme: CanvasTheme;
  classroomName: string;
  loginUrl: string;
}) {
  return (
    <FormCanvas theme={theme}>
      <FormNotice icon="🔒" title={`This form is for members of ${classroomName}`}>
        <p>Sign in with the account you use for the course and we will bring you right back.</p>
        <a
          href={loginUrl}
          className="mt-5 inline-block rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-900"
        >
          Sign in →
        </a>
      </FormNotice>
    </FormCanvas>
  );
}

type ClassroomFillData = Extract<ClientFormLoad, { view: 'classroom-fill' }>;

/**
 * The classroom fill surface (Mockup 4).
 *
 * Its own component, not a branch of `FormFill`, because it owns hooks the
 * public path has no use for — a second fetcher for the autosave, and the
 * "Draft saved" line that fetcher drives.
 */
function ClassroomFill({ data }: { data: ClassroomFillData }) {
  const submitter = useFetcher<ActionResult>();
  const autosave = useFetcher<ActionResult>();
  const result = submitter.data;

  /**
   * The mode the SERVER says the response is in. It updates on its own: React
   * Router revalidates the loader after the action, so a first submission turns
   * this page into the recorded/updatable one without the page tracking that
   * itself.
   */
  const { mode } = data;
  const recorded = mode !== 'fill';

  const post = (payload: Record<string, unknown>) =>
    submitter.submit(payload as SubmitTarget, { method: 'post', encType: 'application/json' });

  const stale = result?.state === 'stale' ? result : null;

  const draftLine =
    autosave.state !== 'idle'
      ? 'Saving…'
      : autosave.data?.state === 'draft-saved'
        ? 'Draft saved'
        : null;

  return (
    <FormCanvas theme={data.theme} classroomName={data.classroomName}>
      <FormHeader title={data.form.title} description={data.form.description} />

      <p className="-mt-4 mb-6 text-xs text-gray-500 dark:text-gray-400">
        Members of {data.classroomName} only · responses are confidential to the teaching team
      </p>

      {recorded ? (
        <div
          role="status"
          className="mb-6 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200"
        >
          <strong className="font-semibold">Response recorded.</strong>{' '}
          {mode === 'update'
            ? 'You can edit it until the form closes — change anything below and press Update.'
            : 'This form takes one response per person, so this one is final.'}
        </div>
      ) : null}

      {/* Republished after they answered. Their stored answers key to questions
          that no longer exist, so the page either shows them against the
          revision they belong to (final) or starts empty (fillable) — and
          either way says which, rather than looking like lost work. */}
      {data.revisionChanged ? (
        <div
          role="status"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {mode === 'recorded'
            ? 'This form has changed since you answered it. Below is what you submitted, shown against the version you filled in.'
            : 'This form has changed since you last opened it, so the questions below are the new ones — your earlier answers do not carry over.'}
        </div>
      ) : null}

      {stale ? (
        <div
          role="alert"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          This form was updated while you were filling it in. Your answers are still here — look
          them over and submit again.
        </div>
      ) : null}

      {result?.state === 'closed' ? (
        <div
          role="alert"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          This form stopped accepting responses while you were filling it in, so that one was not
          recorded.
        </div>
      ) : null}

      {/* The renderer's own "restored on this device" line is for the
          localStorage draft, which is off here. A server draft deserves the
          same courtesy for the opposite reason: answers appearing in a form the
          person does not remember filling in on THIS machine is the confusing
          case, so the notice says where they came from. */}
      {mode === 'fill' && data.restoredDraft ? (
        <p className="mb-5 rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          We brought back the answers you started. They are saved to your account, not to this
          browser.
        </p>
      ) : null}

      {mode === 'recorded' ? (
        /* Final: their answers, read-only. The same view the staff drawer uses,
           over the same revision — there is no second way to render an answer.
           The identity row is repeated here because this branch does not mount
           the renderer, and "whose response is this" is part of the answer. */
        <>
          <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
            Submitted as{' '}
            <span className="font-medium text-gray-900 dark:text-white">
              {data.identity.name || data.identity.email}
            </span>{' '}
            ({data.identity.email})
          </p>
          <AnswerView
            fields={data.fields as FormField[]}
            answers={(data.storedAnswers ?? {}) as Record<string, unknown>}
          />
        </>
      ) : (
        <FormRenderer
          key={data.revisionId}
          fields={data.fields as FormField[]}
          storedAnswers={stale?.answers ?? data.storedAnswers ?? null}
          lockedIdentity={data.identity}
          /* localStorage OFF. The draft belongs to an identified member and
             lives on the server, so it follows them to another machine — and
             a shared lab browser is not left holding their answers. */
          draftKey={null}
          onDraft={
            mode === 'fill'
              ? answers =>
                  autosave.submit(
                    {
                      intent: 'autosave',
                      answers,
                      revisionId: data.revisionId,
                    } as SubmitTarget,
                    { method: 'post', encType: 'application/json' }
                  )
              : null
          }
          submitLabel={mode === 'update' ? 'Update' : 'Submit'}
          busy={submitter.state !== 'idle'}
          error={result?.state === 'error' ? result.message : null}
          footnote={
            mode === 'fill' ? (
              <span data-testid="forms-draft-status">
                {draftLine ?? 'Your answers are saved as you go — no email verification needed.'}
              </span>
            ) : null
          }
          onSubmit={submission =>
            post({
              intent: 'submit',
              answers: submission.answers,
              revisionId: data.revisionId,
            })
          }
        />
      )}
    </FormCanvas>
  );
}

export default function FormFill() {
  const data = useLoaderData() as ClientFormLoad;
  const fetcher = useFetcher<ActionResult>();
  const result = fetcher.data;

  /**
   * The address the check-email state names.
   *
   * Held in state rather than read straight off the fetcher because React
   * Router revalidates after an action and a later navigation clears
   * `fetcher.data` — the confirmation must not blink out from under someone who
   * is still reading it.
   */
  const [sentTo, setSentTo] = useState<string | null>(null);
  useEffect(() => {
    if (result?.state === 'check-email') setSentTo(result.email);
  }, [result]);

  if (data.view === 'signin') {
    return (
      <SignInInterstitial
        theme={data.theme}
        classroomName={data.classroomName}
        loginUrl={data.loginUrl}
      />
    );
  }

  if (data.view === 'not-member') {
    return (
      <FormCanvas theme={data.theme}>
        <FormNotice icon="🔒" title={`This form is for members of ${data.classroomName}`}>
          <p>
            You are signed in as <strong className="font-semibold">{data.signedInAs}</strong>, and
            that account is not on this course. If you have another one, sign in with it.
          </p>
          <a
            href={data.loginUrl}
            className="mt-5 inline-block rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-900"
          >
            Switch account →
          </a>
        </FormNotice>
      </FormCanvas>
    );
  }

  if (data.view === 'no-account-email') {
    return (
      <FormCanvas theme={data.theme} classroomName={data.classroomName}>
        <FormNotice icon="✉️" title="Your account has no email address">
          <p>
            A response is filed under the email on your account, and yours does not have one yet.
            Add one in your Classmoji profile and come back.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  if (data.view === 'classroom-fill') {
    return <ClassroomFill data={data} />;
  }

  if (data.view === 'closed') {
    return (
      <FormCanvas theme={data.theme} classroomName={data.classroomName}>
        <FormHeader title={data.form.title} description={data.form.description} />
        <FormNotice icon="🚪" title="This form is closed">
          <p>
            It is no longer accepting responses. If you think that is a mistake, get in touch with
            the course staff.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  const checkEmail = result?.state === 'check-email' ? result.email : sentTo;

  if (checkEmail) {
    return (
      <FormCanvas theme={data.theme} classroomName={data.classroomName}>
        <FormNotice icon="📧" title="Check your email">
          <p>
            We sent a link to <strong className="font-semibold">{checkEmail}</strong> — click it to
            review your answers and lock in your spot.
          </p>
          <p className="mt-3 text-gray-500 dark:text-gray-400">
            Nothing is recorded until you click it. The link works for 48 hours, and the same link
            lets you change your answers later.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  // The form shut between the page load and the submit.
  if (result?.state === 'closed') {
    return (
      <FormCanvas theme={data.theme} classroomName={data.classroomName}>
        <FormHeader title={data.form.title} description={data.form.description} />
        <FormNotice icon="🚪" title="This form just closed">
          <p>
            It stopped accepting responses while you were filling it in, so this one was not
            recorded. Sorry — that is genuinely bad timing.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  const stale = result?.state === 'stale' ? result : null;

  return (
    <FormCanvas theme={data.theme} classroomName={data.classroomName}>
      <FormHeader title={data.form.title} description={data.form.description} />

      {stale ? (
        <div
          role="alert"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          This form was updated while you were filling it in. Your answers are still here — look
          them over and submit again.
        </div>
      ) : null}

      <FormRenderer
        /* Keyed on the revision: a stale submission comes back with the NEW
           questions and the person's OLD answers, which means the form state
           has to be rebuilt from the new definition rather than patched. */
        key={data.revisionId}
        fields={data.fields as FormField[]}
        storedAnswers={stale?.answers ?? null}
        identityDefaults={stale ? { email: stale.email, name: stale.name } : undefined}
        draftKey={draftKeyFor(data.form.id, data.revisionId)}
        submitLabel="Submit"
        busy={fetcher.state !== 'idle'}
        error={result?.state === 'error' ? result.message : null}
        footnote={
          <>
            Your answers are kept in this browser as you type. Nothing reaches {data.classroomName}{' '}
            until you submit and click the link we email you.
          </>
        }
        onSubmit={submission =>
          fetcher.submit(
            // One cast, the same one the builder needs: an answer set is
            // `Record<string, unknown>` by design (its shape is per field type),
            // which `SubmitTarget`'s structural JSON type cannot describe. The
            // action re-parses everything through the contract regardless, so
            // the type here would buy nothing the validator does not.
            {
              answers: submission.answers,
              identity: submission.identity,
              revisionId: data.revisionId,
              trapped: submission.trapped,
            } as SubmitTarget,
            { method: 'post', encType: 'application/json' }
          )
        }
      />
    </FormCanvas>
  );
}
