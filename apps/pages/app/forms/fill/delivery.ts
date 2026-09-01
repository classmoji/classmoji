import { prisma } from '~/utils/db.server.ts';
import { readFormWatchCookie } from '~/utils/formLinkCookie.server.ts';
import { clientIpFor, mayLearnDeliveryOutcome } from '~/utils/submissionRate.server.ts';
import type { DeliveryState, DeliveryStatus } from './deliveryState.ts';

export type { DeliveryState, DeliveryStatus };

/**
 * "Did the verification message I just caused bounce?" —
 * `GET /{classroomSlug}/forms/{formSlug}/delivery`.
 *
 * A resource route with no component: it answers JSON and has no business
 * rendering anything.
 *
 * ── WHY THIS IS NOT A MAILBOX ORACLE ───────────────────────────────────────
 * This is the one endpoint in the forms flow that could, done wrongly, answer
 * "is there a mailbox at this address?" for anybody who can type one — so the
 * shape of the question it accepts matters more than the answer it gives.
 *
 * IT TAKES NO ADDRESS. There is no query parameter, no body, and no way to name
 * a response: the only input is an HttpOnly cookie this server set, on the
 * response to the request that caused the send. Four properties follow, and
 * together they are the argument:
 *
 *  1. A caller can only ask about a send THEY THEMSELVES triggered, because the
 *     cookie is the only key and it is minted nowhere else. Learning the fate of
 *     a message you caused tells you nothing you could not have learned by
 *     sending it and watching your own screen.
 *  2. Asking about somebody else's send requires their cookie, which is their
 *     browser — at which point the attacker has the browser and this endpoint is
 *     the least of it.
 *  3. THE ANSWER IS ASYMMETRIC ON PURPOSE. Only bounced and delayed are ever
 *     reported. `DELIVERED` is deliberately flattened into `pending`, so a
 *     successful delivery is INDISTINGUISHABLE from a message still in flight,
 *     from a webhook that is not configured, and from an id that names nothing.
 *     Reporting delivery would turn this into an address-validity probe: type an
 *     address, watch for `delivered`, learn the mailbox exists. Bounced is safe
 *     to report for the same reason it is useful — it is the failure of the
 *     asker's own action, and it is what the person needs to be told.
 *  4. AN UNKNOWN ID IS `pending`, NEVER 404. The fill action always sets a watch
 *     cookie, substituting an opaque id when there was no real send (an address
 *     that has already responded is mailed nothing — see
 *     `beginAddressVerification`). If this route distinguished "no such send"
 *     from "send in flight", that substitution would leak straight back out and
 *     the presence of a real token would answer "has this person already
 *     responded?". Same-shape-for-every-outcome is the rule the whole flow is
 *     built on, and this is that rule applied to a GET.
 *
 * ── THE RESIDUAL ORACLE. READ THIS BEFORE SIMPLIFYING ANYTHING BELOW ───────
 * The cookie check above is NOT a complete defence, and treating it as one is
 * the mistake this paragraph exists to prevent.
 *
 * Cookie-scoping stops a third party asking about someone ELSE'S send. It does
 * nothing about the person who types an address they are merely curious about,
 * lets us mail it, and then polls THEIR OWN cookie to read the bounce. They
 * chose the address and they own the cookie, so every check here is satisfied —
 * and the form has become an email-existence oracle, one address at a time.
 *
 * That cannot be closed outright without throwing the feature away (the whole
 * point is telling a real person, at blur, that their real typo will not
 * receive mail). So it is BOUNDED instead, and every bound is load-bearing:
 *
 *  - EVERY PROBE SENDS A REAL EMAIL to the address being probed. The oracle is
 *    loud: it leaves branded mail in the mailbox of whoever is being tested.
 *    This is the strongest bound and it is structural — it cannot be optimised
 *    away without also removing the feature.
 *  - `ADDRESS_PROBE_LIMIT` caps DISTINCT addresses per client per window. This
 *    is the axis an enumeration sweep uses and the one nothing else covered.
 *    Past it, this endpoint answers `pending` forever — the form keeps working,
 *    only the courtesy warning stops.
 *  - `SUBMISSION_RATE_LIMIT` caps the request rate per client per form.
 *  - The per-mailbox send cooldown (`MAGIC_TOKEN_MAX_PER_WINDOW`) caps repeats
 *    against any single address.
 *  - Only FAILURE is ever reported (see (3) above), so the probe cannot be run
 *    in the confirming direction at all — a valid address is silent.
 *
 * The result is a costly, evidence-leaving oracle rather than a silent validity
 * API. That is an accepted trade, not an oversight. If you remove any of those
 * limits because "the cookie already scopes it", you will have turned it back
 * into the silent one.
 *
 * ── What it is NOT trying to be ────────────────────────────────────────────
 * A durable notification. Many bounces arrive in seconds (an SMTP-time
 * rejection), but plenty arrive minutes or hours later, long after the tab is
 * closed. The page polls for a bounded window and then stops; a bounce that
 * lands afterwards is surfaced to STAFF on the response row, which is the
 * surface that is still there tomorrow.
 */

/**
 * Never cached: it is a per-browser answer keyed on a cookie, and a cached
 * `pending` would outlive the bounce it is meant to report.
 */
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

/**
 * A plain `Response`, not React Router's `data()`.
 *
 * This is a resource route fetched directly by the page's poll, not through the
 * single-fetch protocol — so it has to be an ordinary JSON response that a bare
 * `fetch().json()` can read.
 */
const answer = (state: DeliveryState): Response =>
  new Response(JSON.stringify({ state } satisfies DeliveryStatus), { headers: NO_STORE });

const pending = () => answer('pending');

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const watchId = readFormWatchCookie(request, params.formSlug!);
  if (!watchId) return pending();

  /**
   * The distinct-address ceiling, checked BEFORE the lookup.
   *
   * This is the bound on self-probing described at the top of this module: a
   * client that has caused sends to more distinct addresses than any real
   * person needs stops being told outcomes. Address-blind by construction —
   * this route holds a cookie, never an address — so it asks only about the
   * client's budget as a whole.
   *
   * `pending`, not 429. A refusal that looked different from silence would tell
   * the sweeper exactly where the ceiling is and that they had hit it; this way
   * the answers simply stop distinguishing anything, which is the same thing a
   * perfectly deliverable address looks like.
   */
  const formKey = `${params.classroomSlug}/${params.formSlug}`;
  if (!mayLearnDeliveryOutcome(clientIpFor(request), formKey)) return pending();

  /**
   * The id came from a cookie, so it is caller-influenced in principle. It is
   * only ever used as an equality lookup on a primary key — no interpolation,
   * no pattern — and a value naming nothing produces the same `pending` a
   * genuine in-flight send does.
   */
  const token = await prisma.formMagicToken.findUnique({
    where: { id: watchId },
    select: {
      delivery_state: true,
      response: {
        select: { form: { select: { slug: true, classroom: { select: { slug: true } } } } },
      },
    },
  });

  if (!token) return pending();

  /**
   * The cookie is scoped by name and path, but a cookie arriving somewhere it
   * does not belong must cost a failed lookup rather than an answer. Checked
   * against the URL's own form, so a watch id for one form cannot be read
   * through another form's endpoint.
   */
  if (
    token.response.form.slug !== params.formSlug ||
    token.response.form.classroom.slug !== params.classroomSlug
  ) {
    return pending();
  }

  if (token.delivery_state === 'BOUNCED') return answer('bounced');
  if (token.delivery_state === 'DELAYED') return answer('delayed');

  // SENT, DELIVERED, COMPLAINED, null, or a state this build has never heard
  // of. All of them are "nothing to say" — see (3) above for why DELIVERED in
  // particular must land here.
  return pending();
};
