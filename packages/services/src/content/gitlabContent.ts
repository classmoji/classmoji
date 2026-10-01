/**
 * ContentService's Gitlab backend.
 *
 * Every function here answers in the shape the Github path of the same
 * ContentService method answers in, so callers (decks, pages, themes, the asset
 * map) never learn which provider holds the content project. The content
 * project lives in the classroom's own subgroup, `<class subgroup>/<content_repo>`,
 * next to its student projects (on Github it sits in the org). Callers keep
 * passing the org record; `owned` swaps in the class subgroup as the owner.
 *
 * Shas are git object ids on both providers: Gitlab's `blob_id` and tree ids are
 * the same values Github's Contents and Trees APIs report. Writes go through the
 * Commits API, which does not report blob ids, so a written file's sha is
 * computed here the way git computes it (`sha1("blob <len>\0" + bytes)`).
 *
 * Locking differs: Gitlab has no blob-sha precondition, only a per-file
 * `last_commit_id` one. A compare-and-swap is therefore "read the file's blob
 * id and last commit, check the blob id, then write with that last commit";
 * Gitlab refuses the write if the file changed in between.
 */

import { createHash } from 'node:crypto';
import getPrisma from '@classmoji/database';
import { getGitProvider } from '../git/index.ts';
import type { GitLabProvider } from '../git/GitLabProvider.ts';

export interface GitLabOrgRecord {
  id?: string;
  provider: string;
  login: string;
  provider_id?: string | null;
  gitlab_connection_id?: string | null;
  access_token?: string | null;
  /** The instance's host (a self-managed GitLab); null means the default. */
  base_url?: string | null;
}

type StatusError = Error & { status: number };

function statusError(status: number, message: string): StatusError {
  const error = new Error(message) as StatusError;
  error.status = status;
  return error;
}

/** The git blob id of these bytes. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// Which namespace a content project lives in, by org + content repo name (a
// content repo name is unique within an org). Cached; it only changes when a
// classroom is created or its project moves.
const ownerCache = new Map<string, { owner: string; expiresAt: number }>();

/**
 * The org record with `login` set to the content project's real namespace:
 * the classroom's subgroup. Falls back to the org login when no classroom
 * matches (and when `login` already names a subgroup, it is kept).
 */
export async function owned(org: GitLabOrgRecord, repo: string): Promise<GitLabOrgRecord> {
  // The login is part of the key: a template read passes its own group path
  // as `login`, and must not be answered with (or poison) a content lookup.
  const key = `${org.id ?? ''}:${org.login}/${repo}`;
  const cached = ownerCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return { ...org, login: cached.owner };
  const classroom = await getPrisma().classroom.findFirst({
    where: {
      content_repo: repo,
      git_namespace: { not: null },
      OR: [
        { git_organization: org.id ? { id: org.id } : { provider: 'GITLAB', login: org.login } },
        { git_namespace: org.login },
      ],
    },
    select: { git_namespace: true },
  });
  const owner = classroom?.git_namespace || org.login;
  ownerCache.set(key, { owner, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { ...org, login: owner };
}

function provider(org: GitLabOrgRecord): GitLabProvider {
  return getGitProvider(org) as GitLabProvider;
}

function projectApi(org: GitLabOrgRecord, repo: string): string {
  return `/api/v4/projects/${encodeURIComponent(`${org.login}/${repo}`)}`;
}

function fileApi(org: GitLabOrgRecord, repo: string, path: string): string {
  return `${projectApi(org, repo)}/repository/files/${encodeURIComponent(path)}`;
}

// Default branches barely ever change; one lookup per project per 5 minutes.
const defaultBranchCache = new Map<string, { branch: string; expiresAt: number }>();

async function defaultBranch(org: GitLabOrgRecord, repo: string): Promise<string> {
  const key = `${org.login}/${repo}`;
  const cached = defaultBranchCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.branch;
  const branch = await provider(org).getDefaultBranch(org.login, repo);
  defaultBranchCache.set(key, { branch, expiresAt: Date.now() + 5 * 60 * 1000 });
  return branch;
}

const refOr = async (org: GitLabOrgRecord, repo: string, ref?: string) =>
  ref || (await defaultBranch(org, repo));

/** Blob id, size and last commit of a file at `ref`, from a HEAD (no bytes). */
async function headFile(
  org: GitLabOrgRecord,
  repo: string,
  path: string,
  ref?: string
): Promise<{ sha: string; size: number; lastCommit: string } | null> {
  const at = await refOr(org, repo, ref);
  const res = await provider(org).fetchRaw(
    `${fileApi(org, repo, path)}?ref=${encodeURIComponent(at)}`,
    { method: 'HEAD' }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw statusError(res.status, `Gitlab file HEAD ${path} failed (${res.status})`);
  return {
    sha: res.headers.get('x-gitlab-blob-id') ?? '',
    size: Number(res.headers.get('x-gitlab-size') ?? 0),
    lastCommit: res.headers.get('x-gitlab-last-commit-id') ?? '',
  };
}

export async function getMeta(
  org: GitLabOrgRecord,
  repo: string,
  path: string,
  ref?: string
): Promise<{ sha: string; size: number } | null> {
  org = await owned(org, repo);
  const file = await headFile(org, repo, path, ref);
  return file ? { sha: file.sha, size: file.size } : null;
}

/** File content as base64 plus its blob id. */
export async function getFile(
  org: GitLabOrgRecord,
  repo: string,
  path: string,
  ref?: string
): Promise<{ content: string; sha: string } | null> {
  org = await owned(org, repo);
  const at = await refOr(org, repo, ref);
  const { ok, status, body } = await provider(org).request(
    `${fileApi(org, repo, path)}?ref=${encodeURIComponent(at)}`
  );
  if (status === 404) return null;
  if (!ok) throw statusError(status, `Gitlab file read ${path} failed (${status})`);
  const file = body as { content: string; blob_id: string };
  return { content: file.content, sha: file.blob_id };
}

/** A blob's raw bytes by id, or null when the project has no such blob. */
export async function getBlob(
  org: GitLabOrgRecord,
  repo: string,
  sha: string
): Promise<Buffer | null> {
  org = await owned(org, repo);
  const res = await provider(org).fetchRaw(
    `${projectApi(org, repo)}/repository/blobs/${encodeURIComponent(sha)}/raw`
  );
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw statusError(res.status, `Gitlab blob ${sha} failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function listFolder(
  org: GitLabOrgRecord,
  repo: string,
  path: string,
  ref?: string,
  recursive = false
): Promise<Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }>> {
  org = await owned(org, repo);
  const at = await refOr(org, repo, ref);
  const params = new URLSearchParams({
    ref: at,
    per_page: '100',
    pagination: 'keyset',
    ...(path ? { path } : {}),
    ...(recursive ? { recursive: 'true' } : {}),
  });
  try {
    const items = await provider(org).paginate<{
      id: string;
      name: string;
      path: string;
      type: string;
    }>(`${projectApi(org, repo)}/repository/tree?${params.toString()}`);
    return items
      .filter(item => item.type === 'blob' || item.type === 'tree')
      .map(item => ({
        name: item.name,
        path: item.path,
        type: item.type === 'tree' ? 'dir' : 'file',
        sha: item.id,
      }));
  } catch (error: unknown) {
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
}

type CommitAction = {
  action: 'create' | 'update' | 'delete' | 'move';
  file_path: string;
  previous_path?: string;
  content?: string;
  encoding?: 'base64';
  last_commit_id?: string;
};

const CHANGED_SINCE = /changed since|has been updated|last_commit_id/i;
const ALREADY_EXISTS = /already exists/i;
const DOES_NOT_EXIST = /doesn't exist|does not exist|not found/i;

/**
 * One commit of `actions` onto `branch`. A refusal is re-thrown with a status
 * the Github path uses for the same condition: 409 for a lock that no longer
 * holds, 422 for a create onto an existing file.
 */
export async function commit(
  org: GitLabOrgRecord,
  repo: string,
  branch: string,
  message: string,
  actions: CommitAction[]
): Promise<string> {
  org = await owned(org, repo);
  const { ok, status, body } = await provider(org).request(
    `${projectApi(org, repo)}/repository/commits`,
    { method: 'POST', body: { branch, commit_message: message, actions } }
  );
  if (ok) return (body as { id: string }).id;
  const text =
    body && typeof body === 'object' && 'message' in body
      ? String((body as { message: unknown }).message)
      : String(body ?? '');
  if (status === 400 && CHANGED_SINCE.test(text)) {
    throw statusError(409, `File was modified by someone else: ${text}`);
  }
  if (status === 400 && ALREADY_EXISTS.test(text)) {
    throw statusError(422, `File already exists: ${text}`);
  }
  if (status === 400 && DOES_NOT_EXIST.test(text)) {
    throw statusError(404, `File not found: ${text}`);
  }
  throw statusError(status, `Gitlab commit to ${org.login}/${repo} failed (${status}): ${text}`);
}

/**
 * Upsert actions for `files` against `ref`: `update` pinned to each file's last
 * commit when it exists there, `create` when it does not. Pinning every update
 * is what makes a batch a compare-and-swap: Gitlab refuses it if any of those
 * files moved after this read.
 */
export async function upsertActions(
  org: GitLabOrgRecord,
  repo: string,
  ref: string,
  files: Array<{ path: string; bytes: Buffer }>
): Promise<CommitAction[]> {
  org = await owned(org, repo);
  const heads = await mapLimit(files, 8, file => headFile(org, repo, file.path, ref));
  return files.map((file, i) => {
    const head = heads[i];
    return {
      action: head ? 'update' : 'create',
      file_path: file.path,
      content: file.bytes.toString('base64'),
      encoding: 'base64',
      ...(head ? { last_commit_id: head.lastCommit } : {}),
    };
  });
}

export async function headFileAt(org: GitLabOrgRecord, repo: string, path: string, ref: string) {
  org = await owned(org, repo);
  return headFile(org, repo, path, ref);
}

export async function branchHead(
  org: GitLabOrgRecord,
  repo: string,
  branch: string
): Promise<string | null> {
  org = await owned(org, repo);
  const { ok, status, body } = await provider(org).request(
    `${projectApi(org, repo)}/repository/branches/${encodeURIComponent(branch)}`
  );
  if (status === 404) return null;
  if (!ok) throw statusError(status, `Gitlab branch ${branch} failed (${status})`);
  return (body as { commit: { id: string } }).commit.id;
}

export async function createBranch(
  org: GitLabOrgRecord,
  repo: string,
  branch: string,
  fromSha: string
): Promise<{ ref: string; sha: string }> {
  org = await owned(org, repo);
  const created = (await provider(org).api(`${projectApi(org, repo)}/repository/branches`, {
    method: 'POST',
    body: { branch, ref: fromSha },
  })) as { commit: { id: string } };
  return { ref: `refs/heads/${branch}`, sha: created.commit.id };
}

export async function deleteBranch(org: GitLabOrgRecord, repo: string, branch: string) {
  org = await owned(org, repo);
  await provider(org).api(
    `${projectApi(org, repo)}/repository/branches/${encodeURIComponent(branch)}`,
    { method: 'DELETE' }
  );
}

interface CompareResult {
  commits: Array<{ id: string; committed_date?: string; authored_date?: string }>;
  diffs: Array<{
    old_path: string;
    new_path: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
  }>;
}

async function compare(
  org: GitLabOrgRecord,
  repo: string,
  from: string,
  to: string
): Promise<CompareResult> {
  const params = new URLSearchParams({ from, to, straight: 'false' });
  return (await provider(org).api(
    `${projectApi(org, repo)}/repository/compare?${params.toString()}`
  )) as CompareResult;
}

/** @see ContentService.compareBranches */
export async function compareBranches(
  org: GitLabOrgRecord,
  repo: string,
  base: string,
  head: string
) {
  org = await owned(org, repo);
  const [baseSha, headSha] = await Promise.all([
    branchHead(org, repo, base),
    branchHead(org, repo, head),
  ]);
  if (!baseSha || !headSha) return null;

  const params = new URLSearchParams();
  params.append('refs[]', baseSha);
  params.append('refs[]', headSha);
  const [mergeBase, ahead, behind] = await Promise.all([
    provider(org)
      .api(`${projectApi(org, repo)}/repository/merge_base?${params.toString()}`)
      .then(body => (body as { id: string }).id)
      .catch(() => null),
    compare(org, repo, baseSha, headSha),
    compare(org, repo, headSha, baseSha),
  ]);

  // Oldest first, like Github's compare; the head commit comes last.
  const commits = [...ahead.commits];
  if (commits.length > 1 && commits[0]!.id === headSha) commits.reverse();

  return {
    ahead_by: ahead.commits.length,
    behind_by: behind.commits.length,
    base_sha: baseSha,
    head_sha: headSha,
    merge_base_sha: mergeBase,
    commits: commits.map(c => ({ sha: c.id, date: c.committed_date ?? c.authored_date ?? null })),
  };
}

/** Merge statuses Gitlab reports while it is still working out mergeability. */
const MERGE_STATUS_PENDING = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing']);

interface MergeRequest {
  iid: number;
  sha?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
}

/**
 * Merge `head` into `base`, as a real git merge: Gitlab's API only merges
 * through a merge request, so one is opened and merged immediately. That keeps
 * git's line-level merge and, just as important, makes the head's commits part
 * of `base`'s history, which is what "is the preview fully merged?" checks
 * (compareBranches' `ahead_by`) rely on.
 *
 * Same answers as the Github path: `{ merged: true, sha }`, `{ merged: true }`
 * when `base` already has everything, `{ merged: false, conflict: true }` when
 * git cannot merge the two (the merge request is closed again).
 */
export async function mergeBranch(
  org: GitLabOrgRecord,
  repo: string,
  base: string,
  head: string,
  message?: string
): Promise<{ merged: boolean; sha?: string; conflict?: boolean }> {
  org = await owned(org, repo);
  const [baseSha, headSha] = await Promise.all([
    branchHead(org, repo, base),
    branchHead(org, repo, head),
  ]);
  if (!baseSha) throw statusError(404, `Branch not found: ${base}`);
  if (!headSha) throw statusError(404, `Branch not found: ${head}`);

  const incoming = await compare(org, repo, baseSha, headSha);
  if (incoming.commits.length === 0) return { merged: true };

  const api = provider(org);
  const mrApi = `${projectApi(org, repo)}/merge_requests`;
  const title = message || `Merge ${head} into ${base}`;

  const opened = await api.request(mrApi, {
    method: 'POST',
    body: { source_branch: head, target_branch: base, title, remove_source_branch: false },
  });
  let mr: MergeRequest;
  if (opened.ok) {
    mr = opened.body as MergeRequest;
  } else if (opened.status === 409) {
    // One is already open for this pair (an earlier accept that died midway).
    const params = new URLSearchParams({
      source_branch: head,
      target_branch: base,
      state: 'opened',
    });
    const existing = (await api.api(`${mrApi}?${params.toString()}`)) as MergeRequest[];
    if (!existing[0]) throw statusError(409, `Could not open a pull request for ${head}`);
    mr = existing[0];
  } else {
    throw statusError(opened.status, `Gitlab pull request for ${head} failed (${opened.status})`);
  }

  const close = () =>
    api.request(`${mrApi}/${mr.iid}`, { method: 'PUT', body: { state_event: 'close' } });

  // Mergeability is computed asynchronously after the request is opened.
  for (let i = 0; i < 40; i++) {
    const status = mr.detailed_merge_status ?? mr.merge_status ?? 'unchecked';
    if (!MERGE_STATUS_PENDING.has(status)) break;
    await new Promise(r => setTimeout(r, 250 + i * 50));
    mr = (await api.api(`${mrApi}/${mr.iid}?with_merge_status_recheck=true`)) as MergeRequest;
  }
  if (mr.has_conflicts || mr.detailed_merge_status === 'conflict') {
    await close();
    return { merged: false, conflict: true };
  }

  const merged = await api.request(`${mrApi}/${mr.iid}/merge`, {
    method: 'PUT',
    body: {
      merge_commit_message: title,
      should_remove_source_branch: false,
      // Merge exactly what was compared; a later push to the head is not ours.
      sha: headSha,
    },
  });
  if (merged.ok) {
    const done = merged.body as MergeRequest;
    return { merged: true, sha: done.merge_commit_sha ?? done.squash_commit_sha ?? undefined };
  }
  // 405/406: not mergeable (a conflict); 409: the head moved since the compare.
  if (merged.status === 405 || merged.status === 406 || merged.status === 409) {
    await close();
    return { merged: false, conflict: true };
  }
  throw statusError(
    merged.status,
    `Gitlab merge of ${head} into ${base} failed (${merged.status})`
  );
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export { defaultBranch as gitlabDefaultBranch, mapLimit };
