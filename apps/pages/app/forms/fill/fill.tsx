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

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  return loadPublicForm({
    classroomSlug: params.classroomSlug!,
    formSlug: params.formSlug!,
    request,
  });
};

// ─── Action ─────────────────────────────────────────────────────────────────

/** What the action tells the page to render. Never carries `mode`. */
type ActionResult =
  | { state: 'check-email'; email: string }
  | { state: 'closed' }
  | { state: 'stale'; answers: Record<string, unknown>; email: string; name: string | null }
  | { state: 'error'; message: string };

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

  let body: {
    answers?: Record<string, unknown>;
    identity?: { email?: string; name?: string | null };
    revisionId?: string;
    trapped?: boolean;
  };
  try {
    body = JSON.parse(raw) as typeof body;
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

export default function FormFill() {
  const data = useLoaderData() as PublicFormLoad;
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

  if (data.view === 'classroom-placeholder') {
    return (
      <FormCanvas theme={data.theme} classroomName={data.classroomName}>
        <FormHeader title={data.form.title} description={data.form.description} />
        <FormNotice icon="🚧" title="Not quite ready">
          <p>
            You are signed in and on the roster for this course, but classroom forms cannot be
            filled in yet. Your instructor will say when this one opens.
          </p>
        </FormNotice>
      </FormCanvas>
    );
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
