/**
 * Why joining a Github classroom from the picker failed, in words the student
 * can act on.
 *
 * Every Github call on the join path (class team, membership check, user
 * lookup, org invitation) throws an Octokit `RequestError` on failure. Left
 * uncaught it reaches the root error boundary, which in production shows only
 * "Unexpected Server Error". The action catches it and returns `message` as a
 * toast; `status` and `githubMessage` go to the audit row so staff can see the
 * real cause.
 *
 * Pure on purpose: no imports, so it is tested without Github or a database.
 */

/** Guard against storing a whole Octokit dump in an audit row. */
const MAX_DETAIL_LENGTH = 200;

export interface InviteFailure {
  /** Github's HTTP status, or null when the error never reached Github. */
  status: number | null;
  /** Github's own explanation, as it sent it. */
  githubMessage: string | null;
  /** What the student reads. */
  message: string;
}

type GithubErrorLike = {
  status?: unknown;
  message?: unknown;
  response?: { data?: { message?: unknown; errors?: unknown } };
};

const githubDetail = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  const e = error as GithubErrorLike;
  const parts: string[] = [];
  const top = e.response?.data?.message ?? e.message;
  if (typeof top === 'string' && top.trim()) parts.push(top.trim());
  // A 422 names its reason in `errors`, e.g. "Invitee is already a part of this organization".
  if (Array.isArray(e.response?.data?.errors)) {
    for (const item of e.response.data.errors as unknown[]) {
      const text =
        typeof item === 'string'
          ? item
          : item &&
              typeof item === 'object' &&
              typeof (item as { message?: unknown }).message === 'string'
            ? (item as { message: string }).message
            : null;
      if (text && !parts.includes(text)) parts.push(text);
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join(': ');
  return joined.length > MAX_DETAIL_LENGTH ? `${joined.slice(0, MAX_DETAIL_LENGTH)}…` : joined;
};

export const describeInviteFailure = (error: unknown, org: string): InviteFailure => {
  const rawStatus = (error as GithubErrorLike | null)?.status;
  const status = typeof rawStatus === 'number' ? rawStatus : null;
  const githubMessage = githubDetail(error);
  const detail = githubMessage ?? '';

  const result = (message: string): InviteFailure => ({ status, githubMessage, message });

  if (/invitation rate limit|invitations? limit/i.test(detail)) {
    return result(
      `The ${org} organization has reached Github's daily limit on invitations. Try again tomorrow, or ask your instructor.`
    );
  }
  if (/already a (part|member)/i.test(detail)) {
    return result(`You are already in ${org} on Github. Click Accept again to finish joining.`);
  }
  if (/already (been )?invited|pending invitation/i.test(detail)) {
    return result(
      `You already have a pending invite to ${org}. Accept it at github.com/orgs/${org}/invitation, or check your email.`
    );
  }
  if (status === 429 || /rate limit/i.test(detail)) {
    return result('Github is limiting requests right now. Try again in a few minutes.');
  }
  if (status === 401) {
    return result(
      `Classmoji could not sign in to Github for ${org}. Ask your instructor to reinstall the Classmoji Github App.`
    );
  }
  if (status === 403) {
    return result(
      `Classmoji's Github App is not allowed to invite members to ${org}. Ask your instructor to check the app's permissions.`
    );
  }
  if (status === 404) {
    return result(
      `Github could not find your account or the ${org} organization. If you renamed your Github account, reconnect it in Settings; otherwise ask your instructor.`
    );
  }
  return result(
    githubMessage
      ? `Could not send your Github invite: ${githubMessage}`
      : 'Could not send your Github invite. Try again, or ask your instructor.'
  );
};
