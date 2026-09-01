import { useEffect, useState } from 'react';
import { data, useFetcher, useLoaderData, useParams, type SubmitTarget } from 'react-router';
import { exceedsMaxDepth, type FormField } from '@classmoji/services/form-contract';

import { ClassmojiService } from '~/utils/db.server.ts';
import { checkOrigin, readCappedBody } from '~/utils/originCheck.server.ts';
import {
  clientIpFor,
  recordAddressProbe,
  recordSubmissionAttempt,
} from '~/utils/submissionRate.server.ts';
import {
  clearFormLinkCookie,
  formWatchCookie,
  readFormLinkCookie,
} from '~/utils/formLinkCookie.server.ts';
import { dispatchVerifyEmail } from '~/utils/tasks.server.ts';
import { checkMailDomain, domainOf, suggestDomain } from '~/utils/emailDomain.server.ts';
import {
  FormCanvas,
  FormHeader,
  FormNotice,
  type CanvasTheme,
} from '~/components/forms/FormCanvas.tsx';
import AnswerView from '~/components/forms/AnswerView.tsx';
import FormRenderer, { draftKeyFor } from '~/components/forms/FormRenderer.tsx';
import { extractIdentity, identityPlan } from '~/components/forms/answerCoerce.ts';
import { loadPublicForm, type PublicFormLoad } from './publicForm.server.ts';
/**
 * From the import-free leaf, NEVER from `delivery.ts` itself — that module
 * imports Prisma, and an edge to it from this page (which has a client bundle)
 * drags `@prisma/client` into the browser build and breaks hydration for the
 * routes around it. See `deliveryState.ts`.
 */
import type { DeliveryState } from './deliveryState.ts';

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
 * from an address that already responded, a cooldown, a submission whose link
 * was already in the inbox, and a bot that filled the honeypot — renders the
 * IDENTICAL "check your email" view. Any difference between them is a
 * membership oracle: type an address, learn whether that person applied.
 * `beginPublicSubmission` returns a `mode` and a `linkAlreadySentAt` that say
 * exactly that, and this action deliberately drops both on the floor.
 *
 * The check-email screen DOES say "we already sent this" when that is true —
 * but it says it from what THIS BROWSER did (it fired the blur send and knows
 * when), never from what the server found in the database. The distinction is
 * the whole difference between a helpful sentence and an oracle: the browser
 * only ever knows about its own sends.
 */

/**
 * What the BROWSER gets. The classroom load carries a `server` block (the
 * session user id, the identity answers to inject) that exists for the action's
 * benefit; a loader's return value is shipped to the client, so it is dropped
 * here rather than being trusted not to matter. The action never reads it back
 * from the page — it calls `loadPublicForm` again and gets its own copy.
 */
export type ClientFormLoad =
  | (Exclude<PublicFormLoad, { view: 'classroom-fill' }> & {
      /**
       * This BROWSER holds a verified link for this form.
       *
       * A boolean, and only ever this browser's own answer to a question about
       * itself: it is read from the form-scoped HttpOnly cookie the verify page
       * set, so it tells the person in front of the screen something they
       * already know and tells nobody else anything. It exists so the form can
       * say "your address is verified, Submit is the last step" rather than
       * leaving the one-round-trip path invisible until it happens.
       */
      linkVerified?: boolean;
    })
  | Omit<Extract<PublicFormLoad, { view: 'classroom-fill' }>, 'server'>;

/**
 * Never cached, on either transport.
 *
 * The `classroom-fill` view is one member's identity, their saved draft, their
 * submitted answers, and the names of their teammates — served under a session
 * cookie, from a URL every member of the course shares. A shared proxy or a
 * `bfcache`-adjacent disk hit that reused that response would show one student
 * another student's work. The public view is milder but not nothing: it is a
 * form whose OPEN/CLOSED state and cap are decided per request.
 *
 * Same two-part arrangement `verify.tsx` uses, and for the same reason: the
 * headers on `data(…)` reach only the single-fetch `.data` response, so a
 * DOCUMENT request — the first load, the one a person actually arrives on —
 * drops them unless the route hands the loader's headers back from `headers`.
 */
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * How long the check-email screen makes somebody wait before asking again.
 *
 * Short enough that a person who genuinely did not get the mail is not stuck
 * staring at a disabled button, long enough that a double-click and an
 * impatient triple-tap do not spend the server's three-per-hour budget in ten
 * seconds and leave them unable to try again when it would have helped.
 */
const RESEND_COOLDOWN_MS = 30_000;

/**
 * Compare two addresses the way the server files them — trimmed and lowercased.
 * Only ever used to decide which SENTENCE to render; the server does its own
 * normalizing for everything that matters.
 */
const normalizeAddress = (email: string): string => email.trim().toLowerCase();

/**
 * How long the page keeps asking whether its message bounced, and how often.
 *
 * ── Bounded on purpose ─────────────────────────────────────────────────────
 * Many bounces are SMTP-time rejections and land within seconds; plenty arrive
 * minutes or hours later, long after the tab is closed. Polling forever would
 * chase the second group and never catch them, so the page watches for as long
 * as somebody is plausibly still filling the form in and then stops. A bounce
 * that lands afterwards is surfaced to STAFF on the response row — the surface
 * that is still there tomorrow.
 */
const DELIVERY_POLL_MS = 4_000;
const DELIVERY_POLL_WINDOW_MS = 3 * 60_000;

/**
 * Watch for a bounce on the send this browser just caused.
 *
 * Keyed on `token` — a value that changes each time a send happens — so
 * re-typing an address restarts the watch rather than leaving it pinned to the
 * previous one. Passing `null` means "nothing outstanding" and the effect does
 * nothing at all.
 *
 * The endpoint takes NO address and is keyed only on an HttpOnly cookie this
 * server set; see `delivery.ts` for why that is what keeps it from being a
 * mailbox oracle. It reports `bounced` and `delayed` and flattens everything
 * else — delivered included — into `pending`.
 */
function useDeliveryWatch(deliveryPath: string, token: string | number | null): DeliveryState {
  const [state, setState] = useState<DeliveryState>('pending');

  useEffect(() => {
    if (token === null) return;
    setState('pending');

    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const stop = () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };

    const poll = async () => {
      /**
       * A HIDDEN TAB IS NOT ASKING.
       *
       * Somebody who has navigated away, switched tabs, or closed the page is
       * not going to read the answer, and a background tab quietly requesting
       * every four seconds for three minutes is exactly the kind of thing that
       * should not outlive the attention it serves. The window keeps running,
       * so coming back mid-window resumes rather than restarting.
       */
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(poll, DELIVERY_POLL_MS);
        return;
      }

      try {
        const response = await fetch(deliveryPath, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (response.ok) {
          const body = (await response.json()) as { state?: DeliveryState };
          if (body.state === 'bounced' || body.state === 'delayed') {
            // Answered. Stop asking — the answer will not improve.
            setState(body.state);
            return;
          }
        }
      } catch {
        // A failed poll is not news. The whole feature is a courtesy; a network
        // blip must never turn into a message about somebody's address.
      }

      if (!stopped && Date.now() - startedAt < DELIVERY_POLL_WINDOW_MS) {
        timer = setTimeout(poll, DELIVERY_POLL_MS);
      }
    };

    timer = setTimeout(poll, DELIVERY_POLL_MS);
    // Belt beside the brace: a page being torn down stops asking immediately
    // rather than leaving one last request in flight against a dead document.
    window.addEventListener('pagehide', stop);

    return () => {
      stop();
      window.removeEventListener('pagehide', stop);
    };
  }, [deliveryPath, token]);

  return state;
}

/**
 * "just now" / "4 minutes ago" / "2 hours ago", for a link this browser sent.
 *
 * Deliberately coarse. The point of the line is "it is already in your inbox,
 * go and look" — a to-the-second timestamp invites someone to compare it
 * against what they can see and conclude something is wrong when the clocks
 * disagree by a few seconds.
 */
function sentAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * Loader headers, plus whatever the ACTION set on a document POST.
 *
 * Returning `loaderHeaders` alone (what `verify.tsx` can safely do, since its
 * action sets none) silently discards the action's own headers on a document
 * request — which threw away the `Retry-After` on a rate-limited submission,
 * leaving a 429 a client cannot act on. Merging keeps `no-store` on every
 * response and lets the action speak for itself when it has something to say.
 */
export const headers = ({
  loaderHeaders,
  actionHeaders,
}: {
  loaderHeaders: Headers;
  actionHeaders: Headers;
}) => {
  const merged = new Headers(loaderHeaders);
  actionHeaders.forEach((value, key) => merged.set(key, value));
  return merged;
};

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const loaded = await loadPublicForm({
    classroomSlug: params.classroomSlug!,
    formSlug: params.formSlug!,
    request,
  });

  if (loaded.view === 'classroom-fill') {
    const { server: _server, ...clientSafe } = loaded;
    return data(clientSafe satisfies ClientFormLoad, { headers: NO_STORE });
  }
  if (loaded.view === 'fill') {
    return data(
      {
        ...loaded,
        linkVerified: Boolean(readFormLinkCookie(request, params.formSlug!)),
      } satisfies ClientFormLoad,
      { headers: NO_STORE }
    );
  }
  return data(loaded satisfies ClientFormLoad, { headers: NO_STORE });
};

// ─── Action ─────────────────────────────────────────────────────────────────

/** What the action tells the page to render. Never carries `mode`. */
type ActionResult =
  | { state: 'check-email'; email: string }
  /**
   * A link went out (or, indistinguishably, did not need to) for an address the
   * respondent has just finished typing. Rendered as a quiet line beside the
   * form, NOT as the check-email takeover: they are still filling it in.
   */
  | { state: 'link-sent'; email: string; resent: boolean }
  /**
   * The early send was declined for a reason the respondent cannot act on and
   * must not be told about — a half-typed address, a form that has closed under
   * them, a stale revision. Renders nothing at all.
   */
  | { state: 'link-skipped' }
  /**
   * The DNS answer for the domain they just typed — the deliverability half of
   * the same blur that fires the link send.
   *
   * ONE state for every outcome, with `advice: null` meaning "nothing to say".
   * A trapped bot, a half-typed address, a resolver that timed out and a domain
   * that is simply fine all come back identically, so neither a person nor a
   * script can read anything out of the SHAPE of the reply — only out of advice
   * that is actually there.
   *
   * Never a gate: nothing on the submit path reads this. See
   * `emailDomain.server.ts` for why "no MX" is not "no mail".
   */
  | {
      state: 'domain-checked';
      advice: null | {
        /** The domain as typed, so the message can quote it back. */
        domain: string;
        /** DNS says nothing will accept mail here. Advisory. */
        noMailServer: boolean;
        /** A single near-miss correction, or null. Never applied for them. */
        suggestion: string | null;
      };
    }
  /**
   * Submitted under an address this browser had already verified. The response
   * is recorded; there is no second round trip.
   */
  | { state: 'recorded-public' }
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
  | { state: 'already-recorded' }
  /**
   * A teammate joined between the page rendering and the click. The answers
   * come back so nothing typed is lost, and React Router's post-action
   * revalidation re-runs the loader — which re-resolves the team, so the
   * re-render already carries the new person's card.
   */
  | { state: 'team-changed'; answers: Record<string, unknown> };

/** The submission envelope, before anything in it is believed. */
interface SubmissionBody {
  answers?: Record<string, unknown>;
  identity?: { email?: string; name?: string | null };
  revisionId?: string;
  /**
   * The RAW honeypot value, exactly as it came off the hidden input.
   *
   * Not a boolean the page computed. "Was the trap sprung?" is a decision about
   * whether to write a row and send mail, and a decision the CLIENT makes is one
   * a bot simply declines to make — posting `trapped: false` alongside a filled
   * trap used to be enough to walk straight past it. The page's only job is to
   * report what is in the field; this server decides what that means.
   */
  trap?: string;
  /**
   * Absent means "submit".
   *
   * `autosave` is classroom-only. `verify-email` is the public early send, fired
   * when the respondent leaves the email field. `resend` is the check-email
   * screen's button — the one place a link is minted for an address that has
   * already responded, because that is the person ASKING for it.
   *
   * `check-domain` rides the SAME blur as `verify-email` and is deliberately a
   * SEPARATE request rather than extra data on that one: a DNS lookup must never
   * be able to delay the mail, and two requests cannot wait on each other. It is
   * a peer of the others here so that everything guarding this action — the
   * origin check, the body cap, the honeypot, the per-client ceiling — guards it
   * too, without a line of it being written twice.
   */
  intent?: 'autosave' | 'submit' | 'verify-email' | 'resend' | 'check-domain';
  /**
   * Classroom only. Per repeat group, the review targets the BROWSER rendered.
   * Not trusted for anything — the server re-resolves the team under the form's
   * row lock — and read only to tell "your team changed" apart from a
   * validation error the filler could not have avoided.
   */
  renderedTargets?: Record<string, string[]>;
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
        // Makes the draft snapshot its Tier-2 targets. That snapshot is the
        // only server-written record that a teammate who later leaves was ever
        // a teammate, and therefore the only thing that lets their review
        // survive the split.
        classroomId: loaded.server.classroomId,
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
      renderedTargets: body.renderedTargets,
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

    if (code === 'FORM_TEAM_CHANGED') return { state: 'team-changed', answers };

    // The loader renders an explanation instead of the form for every
    // unresolvable team, so this only answers a crafted request. Reported as an
    // error rather than as `closed`, which would be untrue.
    if (code === 'FORM_TEAM_UNRESOLVED') {
      return { state: 'error', message: (error as Error).message };
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

  /**
   * Shape, checked with the size and the origin — before any query.
   *
   * `JSON.parse` accepts nesting that `JSON.stringify` cannot walk, so a 40KB
   * anonymous body of `[[[[…]]]]` used to sail through every cap here, reach
   * the contract's size probe, and blow the stack: a RangeError carries no
   * `code`, so it missed every branch below and answered 500 — an unauthenticated
   * denial of service that costs the attacker forty kilobytes.
   *
   * The contract refuses the same shape on its own account (`parseAnswers`),
   * which is what protects the classroom and MCP paths. This check is here so
   * the ANONYMOUS path never gets as far as a database connection.
   */
  if (exceedsMaxDepth(body)) {
    console.warn('[forms:fill] refused a pathologically nested submission', {
      path: new URL(request.url).pathname,
      bytes: raw.length,
    });
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

  const linkIntent = body.intent === 'verify-email' || body.intent === 'resend';
  const domainIntent = body.intent === 'check-domain';

  /** The "nothing to say" reply. The ONLY shape a caller can be refused with. */
  const noAdvice = { state: 'domain-checked', advice: null } satisfies ActionResult;

  /**
   * ── The watch cookie, on EVERY reply an early send can produce ───────────
   *
   * The page polls `/delivery` with this to learn whether the message it just
   * caused bounced. What matters more than the polling is that the `Set-Cookie`
   * header is IDENTICAL IN SHAPE whatever happened on the server.
   *
   * Four outcomes here send no mail at all: a sprung honeypot, an address that
   * has already verified, an address a live link already covers, and a send the
   * per-address cooldown swallowed. Every one of them renders the same line as a
   * real send, deliberately — that sameness is what stops this endpoint
   * answering "has this person already applied?", and it is what stops a bot
   * learning that the trap sprang. A cookie present only when mail actually went
   * out would put both answers back on the wire, in a response header, for
   * anybody willing to look.
   *
   * So there is ALWAYS a cookie, and when there is no real send to point at it
   * carries a fresh random id. `/delivery` answers `pending` for an id it cannot
   * find — the same thing it says for a send in flight and for one that arrived
   * — so the substitution is not observable from outside.
   */
  const withWatch = (result: ActionResult, watchTokenId: string | null) =>
    data(result, {
      headers: {
        'Set-Cookie': formWatchCookie({
          request,
          classroomSlug: params.classroomSlug!,
          formSlug: params.formSlug!,
          // Null means "no real send to point at" — `formWatchCookie` mints the
          // indistinguishable stand-in, in the server-only module where the
          // randomness belongs.
          watchId: watchTokenId,
        }),
      },
    });

  /**
   * The honeypot, checked AFTER the identity is read and BEFORE anything is
   * written: no row, no token, no cooldown consumed. A bot gets the same page a
   * person gets — telling it that it failed is how a bot learns to leave the
   * field alone next time.
   *
   * Decided HERE, from the raw field value. The page used to send a boolean it
   * had computed itself, which meant the check ran on the attacker's side of the
   * wire: fill the trap, post `trapped: false`, and the trap was not there.
   *
   * It guards the EARLY SEND too, and that matters more than it did: leaving the
   * email field is a cheaper way to make the product send mail than filling in a
   * whole form, so a bot that skipped the trap on submit but sprang it on blur
   * would otherwise have found the softer door.
   */
  if (typeof body.trap === 'string' && body.trap.trim() !== '') {
    // The domain check answers with its own "nothing to say" rather than a link
    // state — a bot must not be able to tell the trap sprang by noticing that
    // the reply changed shape.
    if (domainIntent) return noAdvice;
    // A trapped bot gets the watch cookie a real send would have got. Without
    // it, the ABSENCE of Set-Cookie would tell the bot the trap had sprung —
    // which is precisely how a bot learns to leave the field alone next time.
    if (linkIntent) {
      return withWatch(
        {
          state: 'link-sent',
          email: identity.email,
          resent: body.intent === 'resend',
        } satisfies ActionResult,
        null
      );
    }
    return { state: 'check-email', email: identity.email } satisfies ActionResult;
  }

  if (!identity.email) {
    if (domainIntent) return noAdvice;
    // Nothing to say on the early send — the address is simply not finished.
    if (linkIntent) return { state: 'link-skipped' } satisfies ActionResult;
    return {
      state: 'error',
      message: 'We need an email address so we can send you a confirmation link.',
    } satisfies ActionResult;
  }

  /**
   * The per-sender ceiling, immediately before the only calls that can send mail.
   *
   * The service's own cooldown counts per (form, email) — the unit a mail bomb
   * aimed at ONE mailbox would use — so varying the address evades it entirely
   * and one anonymous caller can mail unlimited strangers under a course's name.
   * Counting per (client, form) closes the direction the cooldown cannot see.
   *
   * Placed after the honeypot and the identity check on purpose: a trapped bot
   * and a submission with no address never reach a mailer, so spending budget on
   * them would let a bot exhaust a real visitor's headroom for free. See
   * `submissionRate.server.ts` for the single-machine caveat and for why an
   * unattributable request is not counted.
   *
   * EVERY public write is counted, the early send included. The blur endpoint is
   * now the cheapest way to make this product send mail, so it is metered by the
   * same budget as the submit rather than by a softer one of its own.
   */
  const rate = recordSubmissionAttempt(clientIpFor(request), loaded.form.id);
  if (!rate.allowed) {
    console.warn('[forms:fill] rate-limited an anonymous submission', {
      formId: loaded.form.id,
      intent: body.intent ?? 'submit',
      path: new URL(request.url).pathname,
    });
    return new Response('Too many submissions from this address. Try again shortly.', {
      status: 429,
      headers: { 'Retry-After': String(rate.retryAfterSeconds) },
    });
  }

  /**
   * ── Can that domain receive mail? ────────────────────────────────────────
   *
   * Placed AFTER the per-client ceiling deliberately. A DNS lookup for an
   * arbitrary caller-supplied domain is exactly the kind of thing that becomes
   * somebody's free resolver if it is not bounded, and this endpoint is public
   * and anonymous. Two bounds apply and they cover different directions: the
   * ceiling above limits how often ONE client may ask, and the module's cache
   * limits how often ANY number of clients cause a real lookup for the SAME
   * domain. Neither alone is enough — the first lets a botnet through, the
   * second lets one client walk a dictionary.
   *
   * The result is advice and only ever advice; nothing downstream reads it.
   */
  if (domainIntent) {
    const domain = domainOf(identity.email);
    if (!domain) return noAdvice;

    /**
     * The restriction the instructor configured, if any — the single most
     * valuable "did you mean" candidate there is. Read through `identityPlan`
     * so it is the domain of THE SAME FIELD the blur reported, rather than of
     * whichever email field happens to be first by some other reckoning.
     */
    const fields = loaded.fields as FormField[];
    const plan = identityPlan(fields);
    const configured = plan.emailFieldId
      ? ((fields.find(field => field.id === plan.emailFieldId) as { domain?: string } | undefined)
          ?.domain ?? null)
      : null;

    const verdict = await checkMailDomain(domain);
    const suggestion = suggestDomain(domain, configured);

    /**
     * Silence unless there is something a person can act on. `unknown` is a
     * statement about the resolver, not the address, and rendering it would
     * turn a network blip into "your email is wrong".
     */
    if (verdict !== 'no-mail-server' && !suggestion) return noAdvice;

    return {
      state: 'domain-checked',
      advice: { domain, noMailServer: verdict === 'no-mail-server', suggestion },
    } satisfies ActionResult;
  }

  const revisionId = String(body.revisionId ?? '');

  /**
   * Map a write failure onto something the page can render. Shared by all three
   * public write paths so a form that closes mid-flight is explained the same
   * way whichever door the request came through.
   */
  const publicFailure = (error: unknown): ActionResult => {
    const code = (error as { code?: string }).code;

    if (code === 'FORM_REVISION_STALE') {
      return { state: 'stale', answers, email: identity.email, name: identity.name };
    }
    if (code === 'FORM_NOT_OPEN' || code === 'FORM_CLOSED' || code === 'FORM_CAP_REACHED') {
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
  };

  // ── The early send ──────────────────────────────────────────────────────
  //
  // Fired when the respondent leaves the email field, and by the check-email
  // screen's resend button. `force` is the difference between them and it is
  // the whole of the difference: an address that has already responded is NOT
  // mailed just because somebody typed it, but IS mailed when the person on the
  // screen asks for it. Every outcome renders identically — see the note on
  // `beginAddressVerification`.
  if (linkIntent) {
    /**
     * Count this address against the client's DISTINCT-ADDRESS budget.
     *
     * Cookie-scoping the status endpoint stops a stranger asking about somebody
     * else's send; it does NOT stop the person who types an address they are
     * curious about, lets us mail it, and reads their own bounce. That is a real
     * oracle and this is what bounds it — see `ADDRESS_PROBE_LIMIT`.
     *
     * The return value is deliberately DROPPED here. Exceeding the budget must
     * not change what this endpoint says or does: the mail still goes, the form
     * still works, and the same line renders. All that changes is that
     * `/delivery` stops reporting outcomes to this client — which is the state
     * everything was in before this feature existed.
     */
    recordAddressProbe(
      clientIpFor(request),
      `${params.classroomSlug}/${params.formSlug}`,
      identity.email
    );

    const sentState = {
      state: 'link-sent',
      email: identity.email,
      resent: body.intent === 'resend',
    } satisfies ActionResult;

    try {
      const result = await ClassmojiService.formResponse.beginAddressVerification({
        formId: loaded.form.id,
        email: identity.email,
        name: identity.name,
        revisionId,
        force: body.intent === 'resend',
      });

      await dispatchVerifyEmail(result.emails, result.verifyUrl ?? '');

      return withWatch(sentState, result.watchTokenId);
    } catch (error) {
      const code = (error as { code?: string }).code;

      // Indistinguishable from a send, for the same reason the submit path
      // makes it indistinguishable: a visible cooldown answers "has this
      // address asked for a link recently?"
      if (code === 'MAGIC_LINK_COOLDOWN') {
        return withWatch(sentState, null);
      }

      // A form that closed, or a page rendered against a revision that has
      // since been republished. Neither is worth interrupting a half-filled
      // form over — the submit will say so properly.
      if (
        code === 'FORM_REVISION_STALE' ||
        code === 'FORM_NOT_OPEN' ||
        code === 'FORM_CLOSED' ||
        code === 'FORM_ACCESS_MISMATCH'
      ) {
        return { state: 'link-skipped' } satisfies ActionResult;
      }

      throw error;
    }
  }

  /**
   * ── The one-round-trip submit ────────────────────────────────────────────
   *
   * If this browser holds the link for this form (set when the emailed link was
   * opened here), the address behind it is already proved and the response can
   * be recorded now — no second trip to the inbox.
   *
   * The cookie is a HINT, never a claim. `submitVerifiedPublic` resolves it to
   * a response row and requires that row's address to equal the one being
   * submitted; anything that does not line up throws MAGIC_LINK_NOT_BOUND and
   * this falls through to the ordinary flow below. That is what keeps the early
   * send an optimisation rather than a dependency — a cleared cookie, a
   * different device, or a spent token costs a round trip and nothing else.
   */
  const linkToken = readFormLinkCookie(request, params.formSlug!);
  if (linkToken) {
    try {
      await ClassmojiService.formResponse.submitVerifiedPublic({
        rawToken: linkToken,
        formId: loaded.form.id,
        email: identity.email,
        name: identity.name,
        answers,
        revisionId,
      });

      return data({ state: 'recorded-public' } satisfies ActionResult, {
        // The token is spent. Leaving the cookie behind would make the next
        // submit offer a dead credential — harmless, since it falls back, but
        // it would look like the shortcut had broken.
        headers: {
          'Set-Cookie': clearFormLinkCookie({
            request,
            classroomSlug: params.classroomSlug!,
            formSlug: params.formSlug!,
          }),
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'MAGIC_LINK_NOT_BOUND') {
        return publicFailure(error);
      }
      // Not bound. Fall through: this is an ordinary unverified submission.
    }
  }

  try {
    const result = await ClassmojiService.formResponse.beginPublicSubmission({
      formId: loaded.form.id,
      email: identity.email,
      name: identity.name,
      answers,
      // The revision the BROWSER rendered against, not the current one — sending
      // the current one would make the staleness check unfalsifiable.
      revisionId,
    });

    /**
     * An EMPTY `emails` means a live link already covers this address — the one
     * minted when they typed it — and dispatching nothing is the correct
     * outcome, not a swallowed failure. The service only returns empty when it
     * has confirmed an unspent, unexpired, young token exists, so "no mail" is
     * never "no link".
     */
    await dispatchVerifyEmail(result.emails, result.verifyUrl ?? '');

    return { state: 'check-email', email: identity.email } satisfies ActionResult;
  } catch (error) {
    // The same view as success. A visible cooldown would answer "has this
    // address submitted recently?" — the same oracle by another name.
    if ((error as { code?: string }).code === 'MAGIC_LINK_COOLDOWN') {
      return { state: 'check-email', email: identity.email } satisfies ActionResult;
    }
    return publicFailure(error);
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
type ReviewGroup = ClassroomFillData['reviewGroups'][number];

/**
 * What to tell someone whose review block could not be resolved.
 *
 * Three states, three genuinely different fixes — and each names the person who
 * can apply it. "Something went wrong" would send every one of them to the same
 * (wrong) place, which is the whole reason the resolver answers with a state
 * instead of an empty list.
 */
function reviewBlockedNotice(group: ReviewGroup): { title: string; body: React.ReactNode } {
  if (group.state === 'NO_TEAM') {
    return {
      title: 'You are not on a team for this form yet',
      body: (
        <p>
          This form asks you to review your teammates, and you are not on a team in this course yet.
          Once the teaching team puts you on one, come back and the review will be here.
        </p>
      ),
    };
  }

  if (group.state === 'AMBIGUOUS_TEAM') {
    return {
      title: 'You are on more than one team',
      body: (
        <>
          <p>
            This form does not say which of your teams to review
            {group.teamNames?.length ? ` — you are on ${group.teamNames.join(' and ')}` : ''}. Ask
            the teaching team to point the review at one team set; we will not guess.
          </p>
        </>
      ),
    };
  }

  return {
    title: 'This review is not pointed at your team',
    body: (
      <>
        <p>
          {group.detail === 'no-team-with-tag'
            ? 'You are on a team, but it is not part of the team set this review covers.'
            : 'The team set this review is pointed at cannot be found in this course.'}
        </p>
        <p className="mt-3 text-gray-500 dark:text-gray-400">
          That is something the teaching team fixes on the form — send them this page.
        </p>
      </>
    ),
  };
}

/**
 * The classroom fill surface (Mockup 4).
 *
 * Its own component, not a branch of `FormFill`, because it owns hooks the
 * public path has no use for — a second fetcher for the autosave, and the
 * "Draft saved" line that fetcher drives.
 */
/** `{ [groupId]: userIds }` — the review targets this page actually drew. */
const renderedTargets = (data: ClassroomFillData): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(data.reviewTargets).map(([groupId, targets]) => [
      groupId,
      targets.filter(target => !target.optional).map(target => target.user_id),
    ])
  );

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

  /**
   * A review block whose team could not be resolved replaces the whole form.
   *
   * Not a field-level error: half of a peer review is not a partial answer, and
   * offering a Submit button under an explanation of why the review cannot be
   * filled in would only produce a response with an empty review in it.
   */
  const blocked = data.reviewBlocked;
  const blockedNotice = blocked ? reviewBlockedNotice(blocked) : null;

  const post = (payload: Record<string, unknown>) =>
    submitter.submit(payload as SubmitTarget, { method: 'post', encType: 'application/json' });

  const stale = result?.state === 'stale' ? result : null;
  const teamChanged = result?.state === 'team-changed' ? result : null;

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

      {blocked ? (
        <FormNotice icon="👥" title={blockedNotice!.title}>
          {blockedNotice!.body}
        </FormNotice>
      ) : null}

      {!blocked && recorded ? (
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

      {/* Somebody joined the team mid-fill. The loader has already re-resolved
          by the time this renders (React Router revalidates after an action),
          so the card for the new person is on the page below this line. */}
      {teamChanged ? (
        <div
          role="alert"
          data-testid="forms-team-changed"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Your team changed while you were filling this in. Everything you wrote is still here —
          there is someone new to review below.
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

      {blocked ? null : mode === 'recorded' ? (
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
            resolvedContext={data.resolvedContext}
          />
        </>
      ) : (
        <FormRenderer
          key={data.revisionId}
          fields={data.fields as FormField[]}
          reviewTargets={data.reviewTargets}
          storedAnswers={teamChanged?.answers ?? stale?.answers ?? data.storedAnswers ?? null}
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
              // What this page was showing. The server re-resolves the team
              // regardless; this only lets it tell "your team changed" apart
              // from an answer set that was wrong to begin with.
              renderedTargets: renderedTargets(data),
            })
          }
        />
      )}
    </FormCanvas>
  );
}

export default function FormFill() {
  const data = useLoaderData() as ClientFormLoad;
  const params = useParams();
  const fetcher = useFetcher<ActionResult>();
  const result = fetcher.data;

  /**
   * A SECOND fetcher, for the link sends.
   *
   * Not the submit fetcher: a blur-time send landing while a submission is in
   * flight would replace the submit's result with its own, and the person would
   * watch "check your email" turn back into a quiet hint. Two fetchers means the
   * two conversations cannot overwrite each other's answers.
   */
  const linkFetcher = useFetcher<ActionResult>();
  const linkResult = linkFetcher.data;

  /**
   * A THIRD fetcher, for the deliverability check.
   *
   * Not folded into the link send, and this is the whole reason the check is a
   * separate request: a DNS lookup can take two seconds, and the send must not
   * wait for it — the link going out promptly is the feature, the warning is the
   * courtesy. Two fetchers means the slow one cannot hold the fast one up, and
   * a resolver that never answers costs the respondent nothing at all.
   */
  const domainFetcher = useFetcher<ActionResult>();
  const domainAdvice =
    domainFetcher.data?.state === 'domain-checked' ? domainFetcher.data.advice : null;

  /**
   * Dismissed by domain, not by a bare boolean.
   *
   * Somebody who waves away the warning for `dartmuoth.edu` and then types
   * `gmial.com` is making a NEW mistake, and a dismissal that outlived the
   * address it was about would hide it.
   */
  const [dismissedDomain, setDismissedDomain] = useState<string | null>(null);

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

  /**
   * What was typed, kept across the check-email screen.
   *
   * "Wrong address? Change it" has to come back to a form that still has every
   * answer in it. The localStorage draft would usually manage that on its own,
   * but usually is not good enough for the one path whose entire purpose is not
   * losing somebody's work: private mode, a full quota, and a form whose draft
   * has not yet been debounced to disk are all ordinary. So the answers are held
   * here, in memory, from the moment they are handed to the submit.
   */
  const [kept, setKept] = useState<{
    answers: Record<string, unknown>;
    email: string;
    name: string | null;
  } | null>(null);
  /** Set by "wrong address", cleared by the next send. Suppresses check-email. */
  const [correcting, setCorrecting] = useState(false);
  useEffect(() => {
    if (result?.state === 'check-email') setCorrecting(false);
  }, [result]);

  /**
   * The resend throttle, counted HERE rather than reported by the server.
   *
   * The server's cooldown is per (form, address); surfacing it would tell
   * whoever typed the address how many links that mailbox has had this hour,
   * which is the membership oracle wearing a helpful face. This countdown is a
   * fact about this browser instead — honest about the wait, silent about the
   * mailbox — and the server's real limit sits behind it either way.
   */
  const [resendReadyAt, setResendReadyAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (result?.state === 'check-email') setResendReadyAt(Date.now() + RESEND_COOLDOWN_MS);
  }, [result]);
  useEffect(() => {
    if (linkResult?.state === 'link-sent' && linkResult.resent) {
      setResendReadyAt(Date.now() + RESEND_COOLDOWN_MS);
    }
  }, [linkResult]);
  useEffect(() => {
    if (resendReadyAt === null) return;
    setClock(Date.now());
    const handle = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(handle);
  }, [resendReadyAt]);

  const resendIn =
    resendReadyAt === null ? 0 : Math.max(0, Math.ceil((resendReadyAt - clock) / 1000));
  const resendReady = resendIn === 0;

  /**
   * The address THIS BROWSER has already had a link sent for, and when.
   *
   * Why the browser and not the server: the submit no longer mails when a live
   * link already covers the address, so "check your email" would otherwise
   * promise a message that was never sent. The honest fix is to say the link
   * went out earlier — but the SERVER'S version of that fact is "this mailbox
   * has a live link", which is the membership oracle the whole flow is built to
   * avoid. What the browser saw itself do is a fact about the person reading
   * the screen, exactly as the resend countdown is.
   *
   * Keyed by address, because "wrong address? change it" is a supported path
   * and a link sent for the typo says nothing about the corrected one.
   */
  const [linkSentFor, setLinkSentFor] = useState<{ email: string; at: number } | null>(null);
  useEffect(() => {
    if (linkResult?.state === 'link-sent') {
      setLinkSentFor({ email: linkResult.email, at: Date.now() });
    }
  }, [linkResult]);

  /**
   * ── Did the message bounce? ──────────────────────────────────────────────
   *
   * Started by the send itself and keyed on WHEN it happened, so each new
   * address restarts the watch instead of inheriting the previous answer. The
   * server is asked over a cookie it set on that very response — there is no
   * address in the request and none could be put there.
   *
   * The answer only ever moves in the alarming direction: `bounced` and
   * `delayed` are reported, everything else stays `pending`. A successful
   * delivery is therefore indistinguishable from a message still in flight,
   * which is exactly what stops this being a way to test whether an address
   * exists.
   */
  const deliveryPath = `/${params.classroomSlug}/forms/${params.formSlug}/delivery`;
  const delivery = useDeliveryWatch(deliveryPath, linkSentFor?.at ?? null);
  const bounced = delivery === 'bounced';

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

  /**
   * Recorded in one round trip, because the link had already been opened in
   * this browser. Deliberately the SAME "You're in" the verify page shows: the
   * person did the same thing and got the same outcome, and the fact that it
   * took one fewer email is not news they need.
   */
  if (result?.state === 'recorded-public') {
    return (
      <FormCanvas theme={data.theme} classroomName={data.classroomName}>
        <FormNotice icon="🎉" title="You're in">
          <p>
            Your response to <strong className="font-semibold">{data.form.title}</strong> is
            recorded. We have your answers and the teaching team can see them.
          </p>
          <p className="mt-3 text-gray-500 dark:text-gray-400">
            Nothing else is needed from you. If you want to change something later, fill the form in
            again with the same address and we will email you a link to your response.
          </p>
        </FormNotice>
      </FormCanvas>
    );
  }

  const checkEmail = correcting ? null : result?.state === 'check-email' ? result.email : sentTo;

  if (checkEmail) {
    const resent = linkResult?.state === 'link-sent' && linkResult.resent;

    /**
     * IT BOUNCED, AND THEY ARE STILL HERE.
     *
     * The reassuring copy is replaced rather than added to. "We sent a link —
     * check your inbox" is now known to be false, and leaving it on screen
     * beside a warning would send somebody off to search a mailbox that never
     * received anything. Both existing doors — resend, and change the address —
     * are kept, because they are exactly the two things that can help.
     */
    if (bounced) {
      return (
        <FormCanvas theme={data.theme} classroomName={data.classroomName}>
          <FormNotice icon="⚠️" title="That email did not go through">
            {/* The outcome, not the cause — see the note on the in-form banner.
                Naming WHY delivery failed would tell anyone who typed an
                address more about that mailbox than they should learn, and it
                changes nothing about what this person should do next. */}
            <p data-testid="forms-bounced">
              We could not deliver to <strong className="font-semibold">{checkEmail}</strong>.
              Nothing is recorded yet, and your answers are still here.
            </p>
            <p className="mt-3 text-gray-500 dark:text-gray-400">
              The usual cause is a typo in the address. Change it below and we will send a new link
              straight away.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="forms-wrong-address"
                onClick={() => {
                  setCorrecting(true);
                  setSentTo(null);
                }}
                className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-900"
              >
                Use a different address →
              </button>
              <button
                type="button"
                data-testid="forms-resend"
                disabled={!resendReady || linkFetcher.state !== 'idle'}
                onClick={() =>
                  linkFetcher.submit(
                    {
                      intent: 'resend',
                      identity: { email: checkEmail, name: kept?.name ?? null },
                      revisionId: data.revisionId,
                      trap: '',
                    } as SubmitTarget,
                    { method: 'post', encType: 'application/json' }
                  )
                }
                className="text-sm font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
              >
                {resendReady ? 'Try that address again' : `Try again in ${resendIn}s`}
              </button>
            </div>
          </FormNotice>
        </FormCanvas>
      );
    }

    /**
     * The link went out EARLIER — when they typed the address — and submitting
     * did not send a second one.
     *
     * One state, one screen, one adapted sentence: a separate "you already have
     * a link" view would make the same moment look like two different outcomes
     * depending on how the person got here, and both of them still end at the
     * same inbox and the same resend button.
     */
    const alreadySent =
      linkSentFor && normalizeAddress(linkSentFor.email) === normalizeAddress(checkEmail)
        ? linkSentFor
        : null;

    return (
      <FormCanvas theme={data.theme} classroomName={data.classroomName}>
        <FormNotice icon="📧" title="Check your email">
          {alreadySent ? (
            <p data-testid="forms-already-sent">
              We already sent a link to <strong className="font-semibold">{checkEmail}</strong> —
              sent {sentAgo(Math.max(0, clock - alreadySent.at))}. Check your inbox and click it to
              review your answers and lock in your spot.
            </p>
          ) : (
            <p>
              We sent a link to <strong className="font-semibold">{checkEmail}</strong> — click it
              to review your answers and lock in your spot.
            </p>
          )}
          <p className="mt-3 text-gray-500 dark:text-gray-400">
            {alreadySent ? (
              <>
                Nothing is recorded until you click it. That link is still the one to use, and it
                also lets you change your answers later.
              </>
            ) : (
              <>
                Nothing is recorded until you click it. The link works for 48 hours, and the same
                link lets you change your answers later.
              </>
            )}
          </p>

          {/* The two things that actually go wrong at this screen: the mail did
              not arrive, and the address was wrong. Both used to be dead ends —
              the only way out was to fill the whole form in again. */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="forms-resend"
              disabled={!resendReady || linkFetcher.state !== 'idle'}
              onClick={() =>
                linkFetcher.submit(
                  {
                    intent: 'resend',
                    identity: { email: checkEmail, name: kept?.name ?? null },
                    revisionId: data.revisionId,
                    trap: '',
                  } as SubmitTarget,
                  { method: 'post', encType: 'application/json' }
                )
              }
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
            >
              {linkFetcher.state !== 'idle'
                ? 'Sending…'
                : resendReady
                  ? 'Send it again'
                  : `Send it again in ${resendIn}s`}
            </button>
            <button
              type="button"
              data-testid="forms-wrong-address"
              onClick={() => {
                setCorrecting(true);
                setSentTo(null);
              }}
              className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Wrong address? Change it
            </button>
          </div>

          {/* Honest about the throttle, and honest about nothing else. The
              countdown is this page's own — it says how long until THIS
              browser may ask again, which is a fact about the person reading
              it. A server-side "that address has had three links this hour"
              would be a fact about the MAILBOX, and answering it for anyone who
              can type an address is the membership oracle by another name. */}
          {resent ? (
            <p role="status" className="mt-3 text-sm text-green-700 dark:text-green-400">
              Sent again. If it still does not arrive, check your spam folder — or change the
              address above.
            </p>
          ) : null}
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
  const linkSent = linkResult?.state === 'link-sent' ? linkResult : null;
  /** Verified in this browser, so Submit is genuinely the last step. */
  const verifiedHere = Boolean(data.linkVerified);

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

      {/* Came back from the link. Said plainly, because "I clicked the thing in
          my email and landed on the form again" is otherwise indistinguishable
          from nothing having happened. */}
      {verifiedHere ? (
        <div
          role="status"
          data-testid="forms-verified-here"
          className="mb-6 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200"
        >
          <strong className="font-semibold">Your email is verified.</strong> Finish your answers and
          press Submit — that is the last step.
        </div>
      ) : null}

      {/* The early send, reported once the address has been typed.
          DELIBERATELY THE SAME LINE whatever happened on the server: a first
          link, a link for an address that already responded, a send the
          cooldown swallowed. Any difference between them answers "has this
          person already applied?" for anybody who can type an address. */}
      {/* THE BOUNCE, WHILE THEY ARE STILL TYPING.
          This is the whole point of sending on blur: the message has already
          failed and they have not finished the form, so the correction costs
          them nothing. It REPLACES the reassuring line rather than sitting
          under it — telling somebody to check an inbox that rejected the mail
          is worse than saying nothing. */}
      {!verifiedHere && bounced && linkSent ? (
        <div
          role="alert"
          data-testid="forms-bounced"
          className="mb-6 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {/* Deliberately ONE sentence about the outcome and nothing about the
              cause. The webhook knows whether the mailbox is missing, the
              domain refused us, or the recipient is suppressed — and repeating
              any of that here would widen the very oracle the rate limits are
              holding shut, in exchange for nothing the person can act on. The
              action is the same in every case: check the address. */}
          <strong className="font-semibold">We couldn&rsquo;t deliver to {linkSent.email}.</strong>{' '}
          Check the address above — fix it and we will send a new link. Nothing you have typed is
          lost.
        </div>
      ) : null}

      {!verifiedHere && !bounced && linkSent ? (
        <div
          role="status"
          data-testid="forms-link-sent"
          className="mb-6 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
        >
          Check <strong className="font-semibold">{linkSent.email}</strong> for a verification link.
          Clicking it now means you are done as soon as you submit — and it is also how you open
          your answers later to change them.
        </div>
      ) : null}

      {/* The deliverability warning.
          ADVISORY, and it says so: no Submit button is disabled, no field is
          marked invalid, and the copy is "check the spelling", never "that
          address is wrong". DNS is not authoritative about mail acceptance
          (see `emailDomain.server.ts`), so the one thing this must never do is
          stand between somebody and a form they filled in correctly. */}
      {domainAdvice && dismissedDomain !== domainAdvice.domain ? (
        <div
          role="status"
          data-testid="forms-domain-warning"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              {domainAdvice.noMailServer ? (
                <p>
                  We can&rsquo;t find a mail server for{' '}
                  <strong className="font-semibold">{domainAdvice.domain}</strong> — check the
                  spelling.
                </p>
              ) : (
                <p>
                  Just checking <strong className="font-semibold">{domainAdvice.domain}</strong> is
                  the address you meant.
                </p>
              )}

              {/* A suggestion, not a correction. Nothing here writes into the
                  field: an auto-correct that guesses wrong files the response
                  under an address the person does not own, and they would have
                  no way of knowing. */}
              {domainAdvice.suggestion ? (
                <p className="mt-1" data-testid="forms-domain-suggestion">
                  Did you mean <strong className="font-semibold">{domainAdvice.suggestion}</strong>?
                </p>
              ) : null}

              <p className="mt-1 text-amber-800 dark:text-amber-300">
                You can submit anyway — we just won&rsquo;t be able to reach you if it&rsquo;s
                wrong.
              </p>
            </div>

            <button
              type="button"
              data-testid="forms-domain-dismiss"
              onClick={() => setDismissedDomain(domainAdvice.domain)}
              aria-label="Dismiss the email address warning"
              className="shrink-0 rounded px-1.5 text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      <FormRenderer
        /* Keyed on the revision: a stale submission comes back with the NEW
           questions and the person's OLD answers, which means the form state
           has to be rebuilt from the new definition rather than patched. */
        key={data.revisionId}
        fields={data.fields as FormField[]}
        /* `kept` is the "wrong address, take me back" path: everything typed,
           held in memory across the check-email screen. */
        storedAnswers={stale?.answers ?? (correcting ? (kept?.answers ?? null) : null)}
        identityDefaults={
          stale
            ? { email: stale.email, name: stale.name }
            : correcting && kept
              ? { email: kept.email, name: kept.name }
              : undefined
        }
        draftKey={draftKeyFor(data.form.id, data.revisionId)}
        submitLabel="Submit"
        busy={fetcher.state !== 'idle'}
        error={result?.state === 'error' ? result.message : null}
        /**
         * The early send. Fired when they leave the email field having typed a
         * valid address, so the link is in their inbox before they have
         * finished the form — and if they open it on the way, the submit is a
         * single round trip.
         */
        onIdentityEmail={submission => {
          linkFetcher.submit(
            {
              intent: 'verify-email',
              identity: { email: submission.email, name: submission.name },
              revisionId: data.revisionId,
              trap: submission.trap,
            } as SubmitTarget,
            { method: 'post', encType: 'application/json' }
          );
          // Fired alongside, never before or after: they are two independent
          // questions about the same address and neither waits on the other.
          domainFetcher.submit(
            {
              intent: 'check-domain',
              identity: { email: submission.email, name: submission.name },
              revisionId: data.revisionId,
              trap: submission.trap,
            } as SubmitTarget,
            { method: 'post', encType: 'application/json' }
          );
        }}
        footnote={
          verifiedHere ? (
            <>
              Your answers are kept in this browser as you type. Your email is already verified, so
              submitting is the last thing this form needs.
            </>
          ) : (
            <>
              Your answers are kept in this browser as you type. Nothing reaches{' '}
              {data.classroomName} until you submit and verify your email.
            </>
          )
        }
        onSubmit={submission => {
          // Held BEFORE the request goes out, so "wrong address" has something
          // to come back to even if the round trip never completes.
          setKept({
            answers: submission.answers,
            email: submission.identity.email,
            name: submission.identity.name,
          });
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
              // The raw honeypot value. The action decides what it means.
              trap: submission.trap,
            } as SubmitTarget,
            { method: 'post', encType: 'application/json' }
          );
        }}
      />
    </FormCanvas>
  );
}
