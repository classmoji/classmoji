import { asHtmlApp, isHtmlContentType } from './box.ts';
import { deliveryOptions, serveBlobBySha } from './blob.ts';
import { errorResponse } from './cache.ts';
import { contentTypeForPath } from './content-type.ts';
import type { Env } from './env.ts';
import { findEntry, loadTree } from './theme.ts';
import { cacheControlFor, nowSeconds, type FilesFolder, type FilesVerification } from './verify.ts';

/** The success half of the verification union. */
type VerifiedFiles = Extract<FilesVerification, { ok: true }>;

/**
 * Deck and page documents. The app renders these itself; they are never handed
 * out through a files grant, even when a granted folder would contain one.
 * Grants are minted so that they never do — this is the second check.
 */
const DOCUMENT_PATHS: readonly RegExp[] = [
  /^slides\/[^/]+\/(?:index\.html|deck\.json)$/i,
  /^pages\/[^/]+\/(?:content\.json|index\.html)$/i,
];

export function isDocumentPath(repoPath: string): boolean {
  return DOCUMENT_PATHS.some(pattern => pattern.test(repoPath));
}

/** The granted folder `repoPath` sits inside, matched on `folder + '/'`. */
export function grantedFolder(
  folders: readonly FilesFolder[],
  repoPath: string
): FilesFolder | undefined {
  return folders.find(folder => repoPath.startsWith(`${folder.path}/`));
}

/**
 * Serve one file under a verified files grant.
 *
 * `repoPath` was normalized by the verifier (decoded once, no dot segments),
 * so a prefix match on a granted folder is a real containment check. The file
 * is then found by exact path in that folder's tree listing — the same
 * immutable `trees/{sha}` cache the theme route uses — and served by its blob
 * sha exactly as a blob URL would be.
 *
 * HTML is served whole (no ranges: the shim insert changes every offset) and
 * boxed by `asHtmlApp`; everything else is untouched.
 */
export async function serveFiles(
  env: Env,
  ctx: ExecutionContext,
  verified: VerifiedFiles,
  request: Request
): Promise<Response> {
  const { repoPath } = verified;
  if (isDocumentPath(repoPath)) return errorResponse(404, 'not found');

  const folder = grantedFolder(verified.folders, repoPath);
  if (!folder) return errorResponse(404, 'not found');

  const entries = await loadTree(env, ctx, verified.classroomId, folder.treeSha, folder.path);
  const entry = findEntry(entries, repoPath.slice(folder.path.length + 1));
  if (!entry) return errorResponse(404, 'not found');

  const contentType = contentTypeForPath(repoPath);
  const html = isHtmlContentType(contentType);
  const delivery = deliveryOptions(request);

  const response = await serveBlobBySha(env, ctx, {
    classroomId: verified.classroomId,
    sha: entry.sha,
    contentType,
    cacheControl: cacheControlFor(verified.tier, verified.exp, nowSeconds()),
    ...delivery,
    ...(html ? { range: null, ifRange: null } : {}),
  });

  return html ? asHtmlApp(response, delivery.head === true) : response;
}
