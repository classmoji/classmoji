import getPrisma from '@classmoji/database';
import { getGitProvider } from '../git/index.ts';
import { owned, type GitLabOrgRecord } from '../content/gitlabContent.ts';

/**
 * The path → git object map for a classroom's content repo.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 * Rendering a page means turning repo paths ("images/lecture-1.png") into
 * content-addressed, signed URLs. Content-addressed means the URL names the
 * git SHA, not the path, which is what lets the edge cache an asset forever
 * and still serve the new bytes the moment a file changes. Resolving a path to
 * its SHA through the GitHub API would be one API call per image per render;
 * this table makes it one indexed read.
 *
 * ── This is a CACHE ────────────────────────────────────────────────────────
 * Every row is derivable from the repo. Nothing here is authoritative and
 * nothing here is worth repairing by hand — if it is wrong, re-sync. Two
 * consequences shape the code below:
 *
 *   - A classroom with NO rows is a normal state, not a broken one. It is what
 *     every classroom looks like before its first sync, and `ensureContentAssets`
 *     is what makes the first render fix it rather than fail on it.
 *   - A sync must be able to DELETE. A file removed from the repo whose row
 *     survives is a path the renderer will happily sign a URL for, and the
 *     Worker will 404 on it. The tree sync's path-set delete below is how rows
 *     for vanished paths go away.
 */

export interface SyncContentAssetsOptions {
  /**
   * Read the tree even when the branch head is the commit the map was last
   * brought level with. The push path leaves this off (a redelivered or
   * already-applied push costs two small API calls, not a tree read); the
   * daily refresh and manual runs set it, because they are the backstop for a
   * map that drifted without the repo moving.
   */
  force?: boolean;
}

export interface SyncContentAssetsResult {
  /** `skipped`: the head was the commit the map is level with; nothing read. */
  mode: 'full' | 'skipped';
  /**
   * Rows this run actually CHANGED — new paths and paths whose sha or type
   * moved. An unchanged row is not rewritten, and a row a newer write-through
   * already holds is skipped (see `upsertChangedOp`).
   */
  upserted: number;
  deleted: number;
  truncated: boolean;
}

export interface ContentAssetRecord {
  sha: string;
  type: string;
  size: number;
}

interface ResolvedClassroom {
  id: string;
  content_repo: string;
  org: string;
  /** The commit the map was last brought level with; null = never synced. */
  syncedCommit: string | null;
  gitOrganization: NonNullable<Awaited<ReturnType<typeof loadClassroomRaw>>>['git_organization'];
}

async function loadClassroomRaw(classroomId: string) {
  return getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
}

type ClassroomRecord = Awaited<ReturnType<typeof loadClassroomRaw>>;

/**
 * The classroom plus what a sync needs from it: which org, which repo, and the
 * commit the map was last brought level with.
 *
 * Throws rather than returning null. Every caller here is already committed to
 * syncing, so "this classroom has no git organization" is a programming or
 * configuration error at that point, not a branch worth threading through four
 * call sites.
 */
function toResolvedClassroom(classroom: ClassroomRecord, classroomId: string): ResolvedClassroom {
  if (!classroom) {
    throw new Error(`[contentAssets] No such classroom: ${classroomId}`);
  }
  if (!classroom.git_organization?.login) {
    throw new Error(`[contentAssets] Classroom ${classroomId} has no git organization`);
  }
  if (!classroom.content_repo) {
    throw new Error(`[contentAssets] Classroom ${classroomId} has no content repo`);
  }

  return {
    id: classroom.id,
    content_repo: classroom.content_repo,
    org: classroom.git_organization.login,
    syncedCommit: classroom.content_assets_synced_commit ?? null,
    gitOrganization: classroom.git_organization,
  };
}

async function resolveClassroom(classroomId: string): Promise<ResolvedClassroom> {
  return toResolvedClassroom(await loadClassroomRaw(classroomId), classroomId);
}

/**
 * Can the delivery layer serve this classroom at all?
 *
 * GitHub-only for now: `getTree` and `getInstallationToken` are implemented on
 * GitHubProvider, and the base-class stubs throw. A predicate over an
 * already-loaded row rather than its own query, so a caller reads the classroom
 * once and both this and `toResolvedClassroom` work from that one read.
 *
 * `github_installation_id` is part of the question, not a detail of it. Without
 * one, `getGitProvider` throws "GitHub provider requires github_installation_id"
 * before a single byte is read, so a sync could only ever fail — and it is not
 * a rare shape: a GitHub Classroom import leaves the id null, and
 * `exampleClassroom.service.ts` creates its shared mock org with a null id ON
 * PURPOSE. Checking it here is free (the row is already loaded, installation id
 * included) and it is what lets `ensureContentAssets` report an untrustworthy
 * map instead of spending three doomed API calls to discover the same thing.
 */
function isDeliverable(classroom: ClassroomRecord): classroom is NonNullable<ClassroomRecord> {
  return isDeliverableClassroom(classroom);
}

/**
 * The fields the answer is made of — nothing more.
 *
 * Structural rather than the Prisma row, because the callers that most need to
 * ask are not holding a whole one. A route that selected a narrow slice of the
 * classroom for its own reasons still gets the same rule, and a caller that
 * FORGOT to select the installation id reads as not deliverable — the direction
 * that degrades to a legacy URL rather than the one that asserts a `/missing/`
 * placeholder.
 */
export interface DeliverableClassroom {
  content_repo?: string | null;
  git_organization?: {
    login?: string | null;
    provider?: string | null;
    github_installation_id?: string | null;
    gitlab_connection_id?: string | null;
  } | null;
}

/**
 * `isDeliverable` for callers outside this module. @see isDeliverable
 *
 * Exported because `content_delivery_enabled` stopped meaning "signable" the
 * moment it began defaulting to true: a classroom can be gated ON and still be
 * one this layer cannot serve. Any caller branching on the flag to decide
 * whether a reference is going to come back SIGNED has to ask this too, or it
 * plans a render around URLs the resolvers will never mint.
 */
export function isDeliverableClassroom(
  classroom: DeliverableClassroom | null | undefined
): boolean {
  return Boolean(
    classroom?.content_repo &&
    classroom.git_organization?.login &&
    ((classroom.git_organization.provider === 'GITHUB' &&
      classroom.git_organization.github_installation_id) ||
      (classroom.git_organization.provider === 'GITLAB' &&
        classroom.git_organization.gitlab_connection_id))
  );
}

interface TreeEntry {
  path: string;
  sha: string;
  type: string;
  size?: number;
}

/** The branch a content repo serves — see `content/contentBranch.ts`. */
export { resolveContentBranch } from '../content/contentBranch.ts';

/** The provider and the owner the content repo lives under. */
async function repoAccess(classroom: ResolvedClassroom) {
  const provider = getGitProvider(classroom.gitOrganization);
  // GitLab: the content project lives in the classroom's subgroup.
  const owner =
    classroom.gitOrganization.provider === 'GITLAB'
      ? (await owned(classroom.gitOrganization as GitLabOrgRecord, classroom.content_repo)).login
      : classroom.org;
  return { provider, owner };
}

/**
 * The default branch's head commit.
 *
 * The tree is then read AT this commit rather than at the branch name, so the
 * commit a sync records describes exactly the entries it read. Reading a
 * moving branch and asking for its head separately could record a commit
 * whose tree was never read, and the next push would then skip as "level".
 */
async function readHead(classroom: ResolvedClassroom) {
  const { provider, owner } = await repoAccess(classroom);
  const branch = await provider.getDefaultBranch(owner, classroom.content_repo);
  const commit = await provider.getLatestCommitSHA(owner, classroom.content_repo, branch);
  return { provider, owner, commit };
}

/**
 * Every row of a tree read that is NEW or CHANGED, in ONE statement, never
 * moving a row backwards — and nothing at all unless the classroom still
 * holds this run's stamp (the `EXISTS`; see `treeSync`).
 *
 * `content_assets.synced_at < EXCLUDED.synced_at`: the run's stamp is taken
 * BEFORE the head is read, so a row stamped at or after it was written by
 * something newer than this snapshot — a save's write-through, or a later
 * run — and keeps what it has. Without this a save that landed while the tree
 * read was in flight would get its sha replaced by the pre-save one.
 *
 * `(sha, type) IS DISTINCT FROM`: an unchanged row is left alone, stamp
 * included, so a push that touched one file rewrites one row (plus the trees
 * above it), not the whole repo. Size is not compared: GitLab's listing has
 * none, and nothing reads it to decide anything.
 *
 * Deliberately NOT a Prisma upsert with an extra `where`: Prisma has no
 * conditional-update upsert, and the shapes that look like one degrade to
 * read-then-create, which inside `$transaction` surfaces as a P2002.
 *
 * Returns null for an empty batch.
 */
function upsertChangedOp(classroomId: string, entries: TreeEntry[], syncedAt: Date) {
  if (entries.length === 0) return null;

  return getPrisma().$executeRaw`
    INSERT INTO content_assets (classroom_id, path, sha, type, size, synced_at)
    SELECT ${classroomId}, entry.path, entry.sha, entry.type, entry.size, ${syncedAt}
    FROM UNNEST(
      ${entries.map(entry => entry.path)}::text[],
      ${entries.map(entry => entry.sha)}::text[],
      ${entries.map(entry => entry.type)}::text[],
      ${entries.map(entry => entry.size ?? 0)}::int[]
    ) AS entry(path, sha, type, size)
    WHERE EXISTS (
      SELECT 1 FROM classrooms
      WHERE id = ${classroomId} AND content_assets_synced_at = ${syncedAt}
    )
    ON CONFLICT (classroom_id, path) DO UPDATE
      SET sha = EXCLUDED.sha,
          type = EXCLUDED.type,
          size = EXCLUDED.size,
          synced_at = EXCLUDED.synced_at
      WHERE content_assets.synced_at < EXCLUDED.synced_at
        AND (content_assets.sha, content_assets.type) IS DISTINCT FROM (EXCLUDED.sha, EXCLUDED.type)
  `;
}

/**
 * Write-through tree rows a writer just learned from its own commit, with one
 * stamp. Same backwards guard as `upsertChangedOp`; no change filter, because
 * these rows are the newest word on their paths and the fresh stamp is what
 * keeps a slower, older sync run from overwriting or sweeping them.
 *
 * `fill`: only rows the map does not have are added, and an existing row is
 * left exactly as it is (see `recordFolderTreesAfterCommit`).
 */
function upsertTreesOp(
  classroomId: string,
  entries: TreeEntry[],
  syncedAt: Date,
  { fill = false }: { fill?: boolean } = {}
) {
  if (fill) {
    return getPrisma().$executeRaw`
      INSERT INTO content_assets (classroom_id, path, sha, type, size, synced_at)
      SELECT ${classroomId}, entry.path, entry.sha, 'tree', 0, ${syncedAt}
      FROM UNNEST(
        ${entries.map(entry => entry.path)}::text[],
        ${entries.map(entry => entry.sha)}::text[]
      ) AS entry(path, sha)
      ON CONFLICT (classroom_id, path) DO NOTHING
    `;
  }
  return getPrisma().$executeRaw`
    INSERT INTO content_assets (classroom_id, path, sha, type, size, synced_at)
    SELECT ${classroomId}, entry.path, entry.sha, 'tree', 0, ${syncedAt}
    FROM UNNEST(
      ${entries.map(entry => entry.path)}::text[],
      ${entries.map(entry => entry.sha)}::text[]
    ) AS entry(path, sha)
    ON CONFLICT (classroom_id, path) DO UPDATE
      SET sha = EXCLUDED.sha,
          type = EXCLUDED.type,
          size = EXCLUDED.size,
          synced_at = EXCLUDED.synced_at
      WHERE content_assets.synced_at < EXCLUDED.synced_at
  `;
}

/**
 * `upsertOp` for a writer that may not know the file's SIZE.
 *
 * A tree read always carries one, so `upsertChangedOp` above writes it
 * unconditionally. A write-through often cannot: an accept learns its sha by
 * reading a file's metadata rather than its bytes, and `size ?? 0` would then
 * ZERO a real size an earlier sync had measured. On an update the column is
 * left alone; a new row starts at 0.
 */
function upsertKnownOp(classroomId: string, entry: TreeEntry, syncedAt: Date) {
  const changed = {
    sha: entry.sha,
    type: entry.type,
    synced_at: syncedAt,
    ...(entry.size === undefined ? {} : { size: entry.size }),
  };

  return getPrisma().contentAsset.upsert({
    where: { classroom_id_path: { classroom_id: classroomId, path: entry.path } },
    create: { classroom_id: classroomId, path: entry.path, size: 0, ...changed },
    update: changed,
  });
}

/**
 * Bring the map level with the branch head: one whole-tree read, diffed.
 *
 * stamp → head → (skip if level) → recursive tree → record the stamp and the
 * commit → upsert what changed → delete what left, the last three in ONE
 * transaction so a failure leaves the previous map intact (stale is
 * recoverable; half-applied is not distinguishable from good).
 *
 * The whole tree, every time, rather than the paths a push names: a folder is
 * served by its TREE sha, and editing one file changes the tree sha of every
 * folder above it, which no per-file update can produce. One recursive call
 * (GitHub) or one paged listing (GitLab) answers all of it.
 *
 * The stamp is taken BEFORE the head is read. Everything else leans on that:
 *
 *   - the classroom stamp only moves forward, and the transaction writes it
 *     FIRST. The upsert and the delete then write only if the classroom still
 *     holds THIS run's stamp (their `EXISTS`): a run that lost it to a newer
 *     run — an older snapshot finishing late — writes no rows at all, so it
 *     can neither re-add a path the newer run deleted nor delete a path its
 *     older tree lacks. The stamp update takes the classroom row's lock, so two
 *     runs' transactions cannot interleave past it;
 *   - the upsert skips rows stamped at or after it (a newer write-through);
 *   - the delete only considers rows stamped below it AND whose path is not in
 *     the tree. Unchanged rows keep their old stamp, so the stamp alone can no
 *     longer tell "gone" from "untouched" — the path set does. A row written
 *     while the read was in flight is above the stamp and survives even though
 *     this snapshot has not seen it.
 *
 * A TRUNCATED tree upserts and does not delete: the entries that did not
 * arrive are not absent from the repo, and deleting their rows would strand
 * live files. A map that is too large costs a stale row; one that is too small
 * costs a missing asset on a live page. It still records the commit — it read
 * all it could at that commit, and refusing would re-read a too-big repo on
 * every push for nothing.
 *
 * `Classroom.content_assets_synced_at` is what `ensureContentAssets` measures
 * its refresh against; only this writes it.
 */
async function treeSync(
  classroom: ResolvedClassroom,
  { force = false }: SyncContentAssetsOptions = {}
): Promise<SyncContentAssetsResult> {
  // Before the head read, not after — see above.
  const syncedAt = new Date();
  const { provider, owner, commit } = await readHead(classroom);

  if (!force && classroom.syncedCommit === commit) {
    return { mode: 'skipped', upserted: 0, deleted: 0, truncated: false };
  }

  const tree = await provider.getTree(owner, classroom.content_repo, commit, /* recursive */ true);
  const { entries, truncated } = tree;
  if (truncated) {
    // Reported, not thrown — see above.
    console.warn(
      `[contentAssets] Tree for ${classroom.org}/${classroom.content_repo} was truncated; ` +
        `syncing the ${entries.length} entries that arrived, deleting nothing`
    );
  }

  const prisma = getPrisma();
  const stampOp = prisma.classroom.updateMany({
    where: {
      id: classroom.id,
      OR: [{ content_assets_synced_at: null }, { content_assets_synced_at: { lt: syncedAt } }],
    },
    data: { content_assets_synced_at: syncedAt, content_assets_synced_commit: commit },
  });
  const upsertOp = upsertChangedOp(classroom.id, entries, syncedAt);
  const deleteOp = truncated
    ? null
    : prisma.$executeRaw`
        DELETE FROM content_assets
        WHERE classroom_id = ${classroom.id}
          AND synced_at < ${syncedAt}
          AND NOT (path = ANY(${entries.map(entry => entry.path)}::text[]))
          AND EXISTS (
            SELECT 1 FROM classrooms
            WHERE id = ${classroom.id} AND content_assets_synced_at = ${syncedAt}
          )
      `;

  // The stamp first: the other two read it (see above).
  const ops = [stampOp, upsertOp, deleteOp].filter(op => op !== null);
  const results = await prisma.$transaction(ops);
  const countOf = (op: unknown) => {
    const result = op === null ? 0 : results[ops.indexOf(op as (typeof ops)[number])];
    return typeof result === 'number' ? result : 0;
  };

  return {
    mode: 'full',
    upserted: countOf(upsertOp),
    deleted: countOf(deleteOp),
    truncated,
  };
}

/**
 * Bring a classroom's asset map level with its content repo's branch head.
 *
 * Skips (no tree read) when the head is the commit the map is already level
 * with, unless `force`.
 */
export async function syncContentAssets(
  classroomId: string,
  opts: SyncContentAssetsOptions = {}
): Promise<SyncContentAssetsResult> {
  return treeSync(await resolveClassroom(classroomId), opts);
}

/**
 * Sync whatever classroom owns this content repo, addressed by org + repo.
 *
 * For writers that commit to a content repo DIRECTLY and need the map to
 * reflect it before the next render — a shared theme save is the case that
 * forced this. A theme is served by the SHA of its TREE, so until the map is
 * rebuilt every deck in the classroom keeps signing the previous tree and the
 * edge keeps serving the previous CSS. The push webhook would eventually fix
 * it, but "eventually" is after the author has already reloaded and seen their
 * change not take.
 *
 * NEVER THROWS. It sits after a write that already succeeded, and a commit that
 * reached GitHub must not be reported as a failed save because a cache could
 * not be refreshed. Returns null when nothing was synced — no classroom claims
 * this repo, or the refresh itself failed and the next sync will repair it.
 */
export async function syncContentAssetsForRepo(
  org: string,
  repo: string,
  reason: string
): Promise<SyncContentAssetsResult | null> {
  try {
    const classroom = await getPrisma().classroom.findFirst({
      where: { content_repo: repo, git_organization: { login: org } },
      select: { id: true },
    });
    // Not ours to care about — the same ordinary, non-error case the push
    // webhook's classroom lookup treats as "not a content repo".
    if (!classroom) return null;

    return await syncContentAssets(classroom.id);
  } catch (error: unknown) {
    console.warn(
      `[contentAssets] ${reason} sync failed for ${org}/${repo}; ` +
        'the next webhook or daily sweep will repair it:',
      error
    );
    return null;
  }
}

/** How long to wait before the one retry of a tree read that 404'd. */
const TREE_RETRY_MS = 500;

/**
 * A tree read that may 404 for a moment right after its commit landed
 * (replication lag on the provider side): retried ONCE.
 */
async function retryOnce404<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    if ((error as { status?: number } | null)?.status !== 404) throw error;
    await new Promise(resolve => setTimeout(resolve, TREE_RETRY_MS));
    return read();
  }
}

/** `a/b/` → `a/b`; null for the repo root or a path with `.`/`..` segments. */
function normalizeFolder(folder: string): string | null {
  const segments = folder.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/**
 * The tree shas of some folders at a commit a writer just made, written
 * through to the map — so a URL signed for the folder right after the write
 * names its new tree, without waiting for the push sync.
 *
 * Walks down from the root with NON-recursive reads, one per level, shared
 * between folders (`slides/intro` and `slides/intro/blocks` cost three reads,
 * not five):
 *
 *   - GitHub: by tree sha, starting at `rootTreeSha` (the commit's root tree,
 *     which the write's response carries) or at the commit itself;
 *   - GitLab: by path at `commit` — its listing has no read-by-sha — taking
 *     each child's id.
 *
 * Every folder walked, ancestors included, is written as a tree row with ONE
 * stamp, guarded so a newer row is never overwritten. The ancestors matter:
 * their tree shas moved too.
 *
 * `fill`: for a READER that found a folder missing and reads it at the commit
 * the map was last synced at (not a commit of its own). It only adds rows the
 * map lacks, leaves every existing row alone, and stamps the new ones with the
 * classroom's sync stamp rather than now: they are exactly as current as that
 * sync, so a sync already in flight still overwrites or deletes them as it
 * would any row of that snapshot. A fresh stamp would make the in-flight sync
 * skip them as newer.
 *
 * Returns folder → tree sha for every requested folder that exists at the
 * commit. NEVER THROWS: the commit already succeeded. An empty (or short) map
 * means "not resolved; sign nothing for it" — a folder missing from the result
 * was either absent at the commit or the walk/write failed (logged).
 */
export async function recordFolderTreesAfterCommit({
  classroomId,
  commit,
  rootTreeSha,
  folders,
  fill = false,
}: {
  classroomId: string;
  commit: string;
  rootTreeSha?: string;
  folders: string[];
  fill?: boolean;
}): Promise<Map<string, string>> {
  const wanted = [...new Set(folders.map(normalizeFolder).filter((f): f is string => f !== null))];
  if (wanted.length === 0) return new Map();

  try {
    const raw = await loadClassroomRaw(classroomId);
    if (!isDeliverable(raw)) return new Map();
    const classroom = toResolvedClassroom(raw, classroomId);
    const { provider, owner } = await repoAccess(classroom);
    const gitlab = classroom.gitOrganization.provider === 'GITLAB';
    const repo = classroom.content_repo;

    // path → tree sha, for every folder walked. '' is the root.
    const shaOf = new Map<string, string>([['', rootTreeSha ?? commit]]);
    const listings = new Map<string, Promise<TreeEntry[]>>();

    const childrenOf = (parent: string): Promise<TreeEntry[]> => {
      let listing = listings.get(parent);
      if (!listing) {
        listing = retryOnce404(async () => {
          if (gitlab) {
            const tree = await provider.getTree(owner, repo, commit, false, {
              path: parent || undefined,
            });
            return tree.entries;
          }
          const tree = await provider.getTree(owner, repo, shaOf.get(parent)!, false);
          // A non-recursive GitHub listing names entries relative to the tree.
          return tree.entries.map(entry => ({
            ...entry,
            path: parent ? `${parent}/${entry.path}` : entry.path,
          }));
        });
        listings.set(parent, listing);
      }
      return listing;
    };

    for (const folder of wanted) {
      let parent = '';
      for (const segment of folder.split('/')) {
        const path = parent ? `${parent}/${segment}` : segment;
        if (!shaOf.has(path)) {
          const entry = (await childrenOf(parent)).find(
            child => child.path === path && child.type === 'tree'
          );
          if (!entry) break;
          shaOf.set(path, entry.sha);
        }
        parent = path;
      }
    }

    const rows = [...shaOf]
      .filter(([path]) => path !== '')
      .map(([path, sha]) => ({ path, sha, type: 'tree' }));
    if (rows.length > 0) {
      const stamp = fill ? (raw.content_assets_synced_at ?? new Date(0)) : new Date();
      await upsertTreesOp(classroomId, rows, stamp, { fill });
    }

    return new Map(
      wanted.filter(folder => shaOf.has(folder)).map(folder => [folder, shaOf.get(folder)!])
    );
  } catch (error: unknown) {
    console.warn(
      `[contentAssets] Could not record folder trees at ${commit} for ${classroomId}; ` +
        'the push sync will:',
      error
    );
    return new Map();
  }
}

/**
 * Make sure the map exists and is not older than `maxAgeMs`, syncing if not.
 *
 * Age is `Classroom.content_assets_synced_at`, which only a tree sync writes —
 * the one thing that can claim the map matches the repo. See the body.
 *
 * This is what makes the system self-bootstrapping. No classroom needs to be
 * migrated into the delivery layer and no backfill job has to run: the first
 * render of a classroom that has never fully synced finds a null stamp, syncs,
 * and proceeds. It is also the backstop for a missed push webhook — a delivery
 * that never arrived costs staleness bounded by `maxAgeMs`, not a permanently
 * wrong map — which is why the bound has to hold no matter how much OTHER
 * write traffic the classroom saw in the meantime.
 *
 * NEVER THROWS — see the body. Returns null whenever no sync happened, whether
 * because the map was fresh, the classroom is not served by this layer, or the
 * refresh itself failed. A caller on a render path can therefore ignore the
 * result entirely; one that cares only needs to know a non-null means the map
 * was just rebuilt.
 */
export async function ensureContentAssets(
  classroomId: string,
  opts: { maxAgeMs: number }
): Promise<SyncContentAssetsResult | null> {
  return (await ensureContentAssetsOutcome(classroomId, opts)).result;
}

/**
 * What a MISS in this classroom's map is worth, alongside the sync itself.
 *
 * `ensureContentAssets` collapses four different outcomes into the same null,
 * which is all a caller that only wants the map refreshed needs. A caller that
 * has to INTERPRET a missing row needs the distinction, because the miss branch
 * is not neutral: a resolver that believes the map hands back a `/missing/`
 * placeholder, and a resolver that does not hands back the stored legacy
 * reference. Getting that backwards on a classroom whose map is empty turns
 * every image on the page into a 404.
 *
 * `mapIsTrustworthy` is false exactly when a miss cannot be believed — the
 * classroom is not served by this layer at all (no repo, not GitHub, or no App
 * installation), the row could not be read, or the map has NEVER completed a
 * full sync and the attempt to give it one just failed. It stays true for a
 * classroom that synced before and merely failed to refresh: that map is stale,
 * not fictional, and staleness degrades safely.
 */
export async function ensureContentAssetsOutcome(
  classroomId: string,
  { maxAgeMs }: { maxAgeMs: number }
): Promise<EnsureContentAssetsOutcome> {
  // One refresh per classroom at a time, per process.
  //
  // The stamp that makes this cheap is written at the END of a sync, so N
  // concurrent callers all read the same stale value and all start their own —
  // and a staff landing page renders ~20 deck thumbnails at once, each of which
  // now reads through the map. Twenty full syncs is sixty GitHub calls to
  // compute one answer, on exactly the classroom that was already behind.
  //
  // Sharing the in-flight promise costs nothing when the map is fresh (the
  // fast path below returns before this ever holds anything for long) and turns
  // that burst into one sync the other nineteen wait on.
  const inFlight = ensuring.get(classroomId);
  if (inFlight) return inFlight;

  const run = ensureOnce(classroomId, maxAgeMs).finally(() => ensuring.delete(classroomId));
  ensuring.set(classroomId, run);
  return run;
}

/**
 * In-flight refreshes, keyed by classroom. Per-process and deliberately so:
 * this is a stampede guard, not a lock. Two Fly instances syncing the same
 * classroom at once is harmless — `treeSync` is one transaction and idempotent —
 * and a real lock would need a table nobody wants to operate.
 */
const ensuring = new Map<string, Promise<EnsureContentAssetsOutcome>>();

/** @see ensureContentAssetsOutcome */
export interface EnsureContentAssetsOutcome {
  /** The sync this call ran, or null when none was needed or none could run. */
  result: SyncContentAssetsResult | null;
  /** Can a missing row be read as "the repo does not have this file"? */
  mapIsTrustworthy: boolean;
}

async function ensureOnce(
  classroomId: string,
  maxAgeMs: number
): Promise<EnsureContentAssetsOutcome> {
  // THIS FUNCTION DOES NOT THROW. It is the one entry point meant to sit on a
  // render path, so every way it can fail has to degrade to "the page renders
  // through the legacy path" — which is exactly what it did before any of this
  // existed. syncContentAssets keeps throwing, because it is called
  // deliberately and its failures should reach somebody.
  //
  // Two separate failure classes, and both return the same null:
  //
  //   CONFIGURATION — GitLab-backed, the mock org behind an example classroom,
  //   or simply no content repo. Known before any API call, so it is checked
  //   rather than caught.
  //
  //   The DB read itself is inside the try, though, which it did not used to
  //   be: the doc above promises this never throws, and a Postgres blip on the
  //   render path would have broken that promise in the one place a caller is
  //   least equipped to handle it.
  let classroom: ClassroomRecord;
  try {
    classroom = await loadClassroomRaw(classroomId);
  } catch (error: unknown) {
    console.warn(`[contentAssets] Could not load classroom ${classroomId}; serving stale:`, error);
    return { result: null, mapIsTrustworthy: false };
  }
  if (!isDeliverable(classroom)) {
    // Nothing will ever fill this map, so nothing may be concluded from its
    // emptiness. The resolvers read this as "hand back the stored reference".
    return { result: null, mapIsTrustworthy: false };
  }

  // Read off the CLASSROOM, not off the newest row. The rows cannot answer this
  // question: `recordContentAsset` stamps the single file a teacher just
  // uploaded with `now` — so the newest row says "something was written recently",
  // never "the map matches the repo". Measuring against it let one upload
  // suppress the daily repair for another 24 hours on exactly the classrooms
  // that need it most: the ones whose push webhook is not arriving, where
  // pushed files render as dangling URLs and deleted files are never swept.
  // Only `treeSync` writes this stamp. Null means never fully synced.
  const lastFullSync = classroom.content_assets_synced_at;

  if (lastFullSync && Date.now() - lastFullSync.getTime() < maxAgeMs) {
    return { result: null, mapIsTrustworthy: true };
  }

  try {
    //   RUNTIME — a GitHub 403 rate limit, a 5xx, a network blip. Not
    //   predictable and not this caller's problem: the previous map is still in
    //   the table and still usable, so a failed refresh should cost staleness,
    //   never a broken page. Caught here and only here.
    // Forced: this is the backstop for a map that drifted while the repo did
    // not move, so "the head is the commit we recorded" is no reason to skip.
    const result = await treeSync(toResolvedClassroom(classroom, classroomId), { force: true });
    return { result, mapIsTrustworthy: true };
  } catch (error: unknown) {
    console.warn(`[contentAssets] sync failed for ${classroomId}; serving stale/legacy:`, error);
    // A map that synced before is stale; one that never has is empty, and an
    // empty map cannot be allowed to answer "no" to every reference on the page.
    return { result: null, mapIsTrustworthy: Boolean(lastFullSync) };
  }
}

/**
 * Forget paths the repo no longer has, now, without waiting for a sweep.
 *
 * The mirror image of `recordContentAssets`, and it exists for the same reason:
 * the map is read on the render path, so a row that outlives its file is not a
 * stale cache entry, it is WRONG CONTENT. A deleted page whose row survives
 * keeps serving its last bytes from R2 — the blob is content-addressed and
 * immutable, so it is still perfectly servable — and a renamed snippet serves
 * its pre-rename bytes under the old name until the next full sync.
 *
 * `paths` is explicit. A folder delete has `removeContentAssetFolder` below,
 * which is the only prefix match on offer and is guarded — "delete everything
 * under this folder" is one empty string away from emptying a classroom's map.
 *
 * NEVER THROWS, like its counterpart — a delete that reached the repo must not
 * be reported as failed because a cache row could not be cleared. The next full
 * sync's sweep is the backstop either way; this only shortens the window.
 */
export async function removeContentAssets(classroomId: string, paths: string[]): Promise<boolean> {
  const unique = [...new Set(paths.filter(path => typeof path === 'string' && path.length > 0))];
  if (unique.length === 0) return true;

  try {
    await getPrisma().contentAsset.deleteMany({
      where: { classroom_id: classroomId, path: { in: unique } },
    });
    return true;
  } catch (error: unknown) {
    console.warn(
      `[contentAssets] Could not remove ${unique.length} path(s) for ${classroomId}; ` +
        "the next full sync's sweep will:",
      error
    );
    return false;
  }
}

/**
 * Forget every row under a folder the repo no longer has.
 *
 * The companion to `ContentService.deleteFolder`, which reports how many files
 * it removed but not which — and the map is the only thing that still knows.
 * Matches the folder itself (theme folders are rows too, addressed by their
 * tree sha) and everything beneath it.
 *
 * GUARDED, because the failure mode is not subtle: an empty or `/` prefix would
 * match every row this classroom has. A refusal is logged rather than thrown —
 * the folder is already gone from the repo, and the sweep is the backstop.
 */
export async function removeContentAssetFolder(
  classroomId: string,
  folder: string
): Promise<boolean> {
  const prefix = folder.replace(/^\/+|\/+$/g, '');
  if (prefix.length === 0) {
    console.warn(
      `[contentAssets] Refusing to clear the whole map for ${classroomId} ` +
        `(empty folder prefix "${folder}")`
    );
    return false;
  }

  try {
    await getPrisma().contentAsset.deleteMany({
      where: {
        classroom_id: classroomId,
        OR: [{ path: prefix }, { path: { startsWith: `${prefix}/` } }],
      },
    });
    return true;
  } catch (error: unknown) {
    console.warn(
      `[contentAssets] Could not remove ${prefix}/ for ${classroomId}; ` +
        "the next full sync's sweep will:",
      error
    );
    return false;
  }
}

/**
 * Record several just-written blobs in the map in one pass.
 *
 * The batch form of `recordContentAsset`, and the one every TEXT save uses: a
 * deck save commits `deck.json` and `index.html` together, so recording them
 * one at a time would load the classroom twice to answer the same question.
 *
 * Same contract as the single form in every other respect — never throws, and
 * a classroom the delivery layer does not serve is a quiet `false`. Partial
 * success is reported as failure: the caller's only use for the answer is a
 * log line, and "some rows landed" is not a state worth a second return shape.
 */
export async function recordContentAssets(
  classroomId: string,
  entries: Array<{ path: string; sha: string; size?: number }>
): Promise<boolean> {
  if (entries.length === 0) return true;

  try {
    const classroom = await loadClassroomRaw(classroomId);
    if (!isDeliverable(classroom)) return false;

    // One stamp for the batch. These files were committed together, and a sync
    // sweep compares against this value — giving them separate `now`s would be
    // a distinction the repo does not make.
    const syncedAt = new Date();
    await Promise.all(
      entries.map(entry =>
        upsertKnownOp(
          classroomId,
          { path: entry.path, sha: entry.sha, type: 'blob', size: entry.size },
          syncedAt
        )
      )
    );
    return true;
  } catch (error: unknown) {
    console.warn(
      `[contentAssets] Could not record ${entries.length} path(s) for ${classroomId}; ` +
        'the next sync will pick them up:',
      error
    );
    return false;
  }
}

/**
 * Record ONE just-uploaded blob in the map, now, without waiting for a sync.
 *
 * The map is otherwise filled by a push webhook or by `ensureContentAssets`'
 * 24-hour refresh, and both are too late for the file a teacher just dropped
 * into the editor: the save stores a repo path, the next render looks that path
 * up, misses, and the resolver emits its "dangling" URL. The upload already
 * knows everything a row needs — path, blob sha, size — so writing it here
 * removes the round trip entirely.
 *
 * The same reasoning applies to the TEXT a save writes — `content.json`,
 * `deck.json`, the generated `index.html` — for a sharper reason: those are
 * read THROUGH the map now (see `fetchContentText`), so a missing row is not a
 * dangling image, it is `/present` showing the previous version of the deck
 * that was just saved. Multi-file saves use `recordContentAssets` above.
 *
 * A later tree sync finds this row unchanged and leaves it, and its delete
 * keeps it (the path is in the tree), so this is only an early write of what
 * the sync would have written anyway. Type is always `blob`: an upload writes a
 * file, never a tree.
 *
 * NEVER THROWS, for the same reason `ensureContentAssets` does not — it sits on
 * an upload path, and an upload that reached the repo must not be reported as
 * failed because a cache row could not be written. Returns whether the row was
 * written: false covers both "this classroom is not served by the delivery
 * layer" (GitLab-backed, mock org, no content repo) and "the write failed".
 */
export async function recordContentAsset(
  classroomId: string,
  entry: { path: string; sha: string; size?: number }
): Promise<boolean> {
  try {
    // Configuration, checked rather than caught — same split as ensureContentAssets.
    const classroom = await loadClassroomRaw(classroomId);
    if (!isDeliverable(classroom)) return false;

    await upsertKnownOp(
      classroomId,
      { path: entry.path, sha: entry.sha, type: 'blob', size: entry.size },
      new Date()
    );
    return true;
  } catch (error: unknown) {
    console.warn(
      `[contentAssets] Could not record ${entry.path} for ${classroomId}; ` +
        'the next sync will pick it up:',
      error
    );
    return false;
  }
}

/**
 * One path → the git object behind it. Null when the map has never heard of it.
 */
export async function lookupContentAsset(
  classroomId: string,
  path: string
): Promise<ContentAssetRecord | null> {
  return getPrisma().contentAsset.findUnique({
    where: { classroom_id_path: { classroom_id: classroomId, path } },
    select: { sha: true, type: true, size: true },
  });
}

/**
 * Many paths → the git objects behind them, in ONE query.
 *
 * The batch form exists because a render resolves a whole document at once: a
 * forty-image deck opened by a lecture hall of students was forty `findUnique`
 * round trips per view through `lookupContentAsset`. Paths the map has never
 * heard of are simply absent from the returned map, which is the same "null"
 * the single-path lookup reports, and lets the caller keep its per-ref
 * branching unchanged.
 */
export async function lookupContentAssets(
  classroomId: string,
  paths: string[]
): Promise<Map<string, ContentAssetRecord>> {
  const wanted = [...new Set(paths)];
  if (wanted.length === 0) return new Map();

  const rows = await getPrisma().contentAsset.findMany({
    where: { classroom_id: classroomId, path: { in: wanted } },
    select: { path: true, sha: true, type: true, size: true },
  });

  return new Map(
    rows.map((row: { path: string } & ContentAssetRecord) => [
      row.path,
      { sha: row.sha, type: row.type, size: row.size },
    ])
  );
}

/**
 * Every FILE path a classroom's content repo holds, in one query.
 *
 * The import's chained-reference rewrite asks "did this file come along?", and
 * for a target that already had content the answer lives here rather than in
 * the batch being written. Whole-index rather than a filtered `path IN (…)`
 * because the caller does not know the candidate paths until it has walked the
 * content it is about to rewrite — and one index scan of short strings is
 * cheaper than the two-pass walk that would avoid it.
 *
 * Trees are excluded: a directory is not a file a reference can resolve to.
 */
export async function listContentAssetPaths(classroomId: string): Promise<Set<string>> {
  const rows = await getPrisma().contentAsset.findMany({
    where: { classroom_id: classroomId, type: 'blob' },
    select: { path: true },
  });
  return new Set(rows.map((row: { path: string }) => row.path));
}

/**
 * A directory's tree object, for the folders that are served whole — themes.
 *
 * Explicitly filtered to `type: 'tree'` rather than just looked up by path: a
 * repo can hold a FILE at the same path a caller expects a directory at, and
 * returning that would hand the caller a blob SHA it would then address as a
 * folder. No match is the right answer there.
 */
export async function lookupContentTree(
  classroomId: string,
  dirPath: string
): Promise<ContentAssetRecord | null> {
  // Trailing slashes are how directories are usually written in content, and
  // are not part of the path as git stores it.
  const normalized = dirPath.replace(/\/+$/, '');

  return getPrisma().contentAsset.findFirst({
    where: { classroom_id: classroomId, path: normalized, type: 'tree' },
    select: { sha: true, type: true, size: true },
  });
}

/**
 * Many SHAs → a path holding each, in ONE query.
 *
 * The batch form of `lookupContentAssetBySha`, and it exists for the same
 * reason `lookupContentAssets` does: an import rewrites a whole classroom's
 * worth of content at once, and resolving each signed URL on its own was a
 * round trip per image per page. SHAs the map has never heard of are simply
 * absent from the returned map.
 *
 * Where two paths share a SHA the winner is the lowest path, matching the
 * single-SHA lookup's `orderBy` — content-addressed means they are
 * byte-identical, so the choice cannot be wrong, only arbitrary, and pinning it
 * keeps repeated imports of the same content producing the same output.
 *
 * `opts.type` narrows to `blob` or `tree`. Unfiltered by default, because the
 * import's rewrite only wants to know whether the sha is in this classroom's
 * map at all. The signing guard asks for `blob`: a tree sha is 40 hex
 * characters like any other, and "the map holds this sha somewhere" is not a
 * licence to address a directory as a file.
 */
export async function lookupContentAssetsBySha(
  classroomId: string,
  shas: string[],
  opts: { type?: string } = {}
): Promise<Map<string, string>> {
  const wanted = [...new Set(shas)];
  if (wanted.length === 0) return new Map();

  const rows = await getPrisma().contentAsset.findMany({
    where: {
      classroom_id: classroomId,
      sha: { in: wanted },
      ...(opts.type ? { type: opts.type } : {}),
    },
    select: { path: true, sha: true },
    orderBy: { path: 'asc' },
  });

  const bySha = new Map<string, string>();
  for (const row of rows as { path: string; sha: string }[]) {
    if (!bySha.has(row.sha)) bySha.set(row.sha, row.path);
  }
  return bySha;
}

/**
 * Reverse lookup: a SHA out of a signed URL → a path that holds it.
 *
 * The editor does this on save, so a block that was rendered as a signed URL is
 * stored back as the repo path it came from. Without it, saving a page would
 * freeze today's signed URL into the content, and that content would then stop
 * following the file — a later edit to the image would never show, and a cache
 * bust would strand it.
 *
 * ANY matching row is a correct answer. Content-addressed means two paths with
 * the same SHA hold byte-identical content, so the caller cannot be harmed by
 * getting the other one. Ordered by path only so the answer is stable across
 * calls rather than varying with physical row order.
 */
export async function lookupContentAssetBySha(
  classroomId: string,
  sha: string
): Promise<{ path: string; type: string; size: number } | null> {
  return getPrisma().contentAsset.findFirst({
    where: { classroom_id: classroomId, sha },
    orderBy: { path: 'asc' },
    select: { path: true, type: true, size: true },
  });
}
