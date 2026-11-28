/**
 * Which Github organizations of an export the importer administers, asked of
 * Github with the importer's own token: the same check as "New classroom"
 * (`readOrganizationAdmin`), once per organization id.
 *
 * The answer is keyed by the export's organization id and counts only when the
 * organization Github answers with carries that same id. Github is asked first
 * by the export's login; when Github has no organization under that name, or
 * has another organization there, the organization with the export's id is
 * looked for among the importer's own organizations (`readViewerOrganizations`,
 * read at most once per request), which finds one renamed since the export. Its
 * login is Github's. Nothing in it comes from the request except the id and
 * login asked about. Every failure
 * (no Github sign-in, a refused token, an organization the token cannot see,
 * Github not answering) is an entry that is not verified, with the reason;
 * nothing here throws.
 */

import { ClassmojiService, GitHubProvider } from '@classmoji/services';
import {
  GithubOrgCheckTimeoutError,
  readOrganizationAdmin,
  readViewerOrganizations,
  type GithubOrganizationAdmin,
  type GraphqlClient,
} from '~/utils/githubOrgAdmin.server';

type ImportOptions = NonNullable<
  Parameters<typeof ClassmojiService.githubClassroomImport.importGithubClassrooms>[2]
>;
type Verifications = NonNullable<ImportOptions['organizations']>;
type Verification = Verifications extends ReadonlyMap<string, infer V> ? V : never;
type Refusal = NonNullable<Verification['reason']>;

/** At most this many organizations are checked per request; the rest are not verified. */
export const MAX_ORGANIZATIONS_PER_IMPORT = 20;

const errorTexts = (error: unknown): { type?: string; message?: string }[] => {
  const errors = (error as { errors?: unknown })?.errors;
  return Array.isArray(errors) ? (errors as { type?: string; message?: string }[]) : [];
};

/** What a failed check means for the importer. */
export function refusalForError(error: unknown): Refusal {
  if (error instanceof GithubOrgCheckTimeoutError) return 'unreachable';
  const status = (error as { status?: unknown })?.status;
  if (status === 401) return 'token_rejected';
  const message = error instanceof Error ? error.message : String(error ?? '');
  // SSO not authorized for the token, or the organization's OAuth app restrictions.
  const restricted = /SAML|access restrictions/i;
  const graphqlErrors = errorTexts(error);
  if (
    graphqlErrors.some(
      e => e.type === 'NOT_FOUND' || e.type === 'FORBIDDEN' || restricted.test(e.message ?? '')
    )
  ) {
    return 'no_access';
  }
  if (status === 403 && restricted.test(message)) return 'no_access';
  return 'unreachable';
}

const refused = (githubId: string, reason: Refusal): Verification => ({
  githubId,
  verifiedAdmin: false,
  login: null,
  reason,
});

/** Github has no organization under the login (and reported nothing else). */
const isNotFound = (error: unknown): boolean => {
  const graphqlErrors = errorTexts(error);
  return graphqlErrors.length > 0 && graphqlErrors.every(e => e.type === 'NOT_FOUND');
};

/**
 * The answer for the export's login, and whether to look for the export's id
 * among the importer's organizations: only when Github has no organization
 * under that name or another one, never when it refused to show one.
 */
interface ByLogin {
  verification: Verification;
  lookById: boolean;
}

const failed = (githubId: string, error: unknown): Verification => {
  const reason = refusalForError(error);
  console.warn(
    `[import-classroom] organization check for ${githubId} failed (${reason}):`,
    error instanceof Error ? error.message : error
  );
  return refused(githubId, reason);
};

/** The organization Github has with the export's id: is the token's user its owner? */
function verdict(githubId: string, organization: GithubOrganizationAdmin): Verification {
  if (!organization.viewerCanAdminister) return refused(githubId, 'not_admin');
  if (!ClassmojiService.githubClassroomImport.isGithubLogin(organization.login)) {
    return refused(githubId, 'unreachable');
  }
  return { githubId, verifiedAdmin: true, login: organization.login, reason: null };
}

/** The organization Github has under the export's login, counted only when it has the export's id. */
async function verifyByLogin(
  octokit: GraphqlClient,
  githubId: string,
  bundleLogin: string,
  timeoutMs?: number
): Promise<ByLogin> {
  // Github has nothing under a name it would not allow; not worth asking.
  if (!ClassmojiService.githubClassroomImport.isGithubLogin(bundleLogin)) {
    return { verification: refused(githubId, 'no_access'), lookById: true };
  }
  try {
    const organization = await readOrganizationAdmin(octokit, bundleLogin, { timeoutMs });
    if (!organization) return { verification: refused(githubId, 'no_access'), lookById: true };
    // The organization Github has under that name must be the export's.
    if (organization.databaseId == null || String(organization.databaseId) !== githubId) {
      return { verification: refused(githubId, 'mismatch'), lookById: true };
    }
    return { verification: verdict(githubId, organization), lookById: false };
  } catch (error: unknown) {
    return { verification: failed(githubId, error), lookById: isNotFound(error) };
  }
}

/**
 * One organization: is the token's user an owner of the organization with this
 * id? By the export's login first, then by the id among the user's own
 * organizations.
 */
async function verifyOne(
  octokit: GraphqlClient,
  githubId: string,
  bundleLogin: string,
  viewerOrganizations: () => Promise<GithubOrganizationAdmin[]>,
  timeoutMs?: number
): Promise<Verification> {
  const byLogin = await verifyByLogin(octokit, githubId, bundleLogin, timeoutMs);
  if (!byLogin.lookById) return byLogin.verification;
  try {
    const organization = (await viewerOrganizations()).find(
      o => o.databaseId != null && String(o.databaseId) === githubId
    );
    // Not among theirs either: the answer the login gave stands.
    if (!organization) return byLogin.verification;
    return verdict(githubId, organization);
  } catch (error: unknown) {
    return failed(githubId, error);
  }
}

/**
 * The verification map the import service takes, for the classrooms of the
 * request. `token` is the importer's Github token from their session (null for
 * someone signed in without Github).
 */
export async function verifyImportOrganizations(
  token: string | null | undefined,
  classrooms: unknown,
  {
    octokitFor = (t: string): GraphqlClient => GitHubProvider.getImmediateUserOctokit(t),
    timeoutMs,
  }: { octokitFor?: (token: string) => GraphqlClient; timeoutMs?: number } = {}
): Promise<Map<string, Verification>> {
  const { organizationProviderId } = ClassmojiService.githubClassroomImport;

  // The first login the export gives for each organization id.
  const loginById = new Map<string, string>();
  for (const input of Array.isArray(classrooms) ? classrooms : []) {
    const organization = (input as { classroom?: { organization?: unknown } })?.classroom
      ?.organization as { id?: unknown; login?: unknown } | undefined;
    const id = organizationProviderId(organization?.id);
    if (!id || loginById.has(id)) continue;
    loginById.set(id, typeof organization?.login === 'string' ? organization.login : '');
  }

  const verifications = new Map<string, Verification>();
  const ids = [...loginById.keys()].slice(0, MAX_ORGANIZATIONS_PER_IMPORT);
  if (!token) {
    for (const id of ids) verifications.set(id, refused(id, 'no_github'));
    return verifications;
  }

  const octokit = octokitFor(token);
  // The importer's organizations, read once for every organization that needs them.
  let viewerOrganizations: Promise<GithubOrganizationAdmin[]> | undefined;
  const readViewerOnce = () =>
    (viewerOrganizations ??= readViewerOrganizations(octokit, { timeoutMs }));
  const answers = await Promise.all(
    ids.map(id => verifyOne(octokit, id, loginById.get(id)!, readViewerOnce, timeoutMs))
  );
  for (const answer of answers) verifications.set(answer.githubId, answer);
  return verifications;
}
