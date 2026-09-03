import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';
import { getGitProvider } from '../git/index.ts';

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
 *     Worker will 404 on it. The full sync's stamp-and-sweep below is how rows
 *     for vanished paths go away.
 */

const DEFAULT_BRANCH = 'main';

/**
 * Above this many changed paths, one tree call beats N per-path reads.
 *
 * A per-path read is one GitHub request; the tree call is one request for the
 * WHOLE repo regardless of size. The crossover is not sharp — the tree
 * response is larger, and a big repo makes it much larger — so this is set at
 * the point where the request count starts to look like rate-limit pressure
 * rather than at a measured optimum. A push touching more than a couple of
 * dozen files is usually a bulk import or a folder move, which is exactly when
 * the whole-repo answer is also the more accurate one.
 */
const TREE_CALL_THRESHOLD = 30;

/**
 * Theme folders are served by the SHA of their TREE, not of any file inside.
 *
 * That makes them the one case where an incremental sync is not enough: editing
 * `.slidesthemes/midnight/theme.css` changes the tree SHA of `midnight/` and of
 * every parent above it, and a push webhook reports only the file. Rather than
 * recompute the affected tree chain — which needs the whole tree anyway — any
 * change under this prefix escalates to a full sync.
 */
const THEME_PREFIX = '.slidesthemes/';

export interface ContentAssetChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface SyncContentAssetsOptions {
  full?: boolean;
  changes?: ContentAssetChanges;
}

export interface SyncContentAssetsResult {
  mode: 'full' | 'incremental';
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
 * The classroom plus the two things a sync needs from it: which org, which repo.
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
 */
function isDeliverable(classroom: ClassroomRecord): boolean {
  return Boolean(
    classroom?.content_repo &&
    classroom.git_organization?.login &&
    classroom.git_organization.provider === 'GITHUB'
  );
}

interface TreeEntry {
  path: string;
  sha: string;
  type: string;
  size?: number;
}

async function readRepoTree(
  classroom: ResolvedClassroom
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const provider = getGitProvider(classroom.gitOrganization);
  const tree = await provider.getTree(
    classroom.org,
    classroom.content_repo,
    DEFAULT_BRANCH,
    /* recursive */ true
  );

  if (tree.truncated) {
    // Reported, not thrown. A truncated tree is still hundreds of correct
    // entries, and a partial map degrades to "some assets fall back to the
    // legacy path"; refusing it would leave the classroom with no map at all.
    console.warn(
      `[contentAssets] Tree for ${classroom.org}/${classroom.content_repo} was truncated by GitHub; ` +
        `syncing the ${tree.entries.length} entries that arrived`
    );
  }

  return { entries: tree.entries, truncated: tree.truncated };
}

function upsertOp(classroomId: string, entry: TreeEntry, syncedAt: Date) {
  const row = {
    sha: entry.sha,
    type: entry.type,
    size: entry.size ?? 0,
    synced_at: syncedAt,
  };

  return getPrisma().contentAsset.upsert({
    where: { classroom_id_path: { classroom_id: classroomId, path: entry.path } },
    create: { classroom_id: classroomId, path: entry.path, ...row },
    update: row,
  });
}

/**
 * Rebuild the whole map from the repo's tree.
 *
 * Stamp-and-sweep: every row written this run carries the same `syncedAt`, and
 * anything left below that stamp is a path that is no longer in the repo and is
 * deleted. Doing it this way rather than diffing means the sweep is correct
 * even when the previous state was partial, wrong, or absent.
 *
 * The whole thing is ONE transaction: a half-applied sync would leave the map
 * claiming paths at SHAs that never coexisted, and a reader cannot tell that
 * from a good map. All-or-nothing means a failure leaves the previous map
 * intact — stale, and stale is recoverable.
 *
 * A TRUNCATED tree is the exception to the sweep, and deliberately so: the
 * entries that did not arrive are not absent from the repo, and sweeping them
 * would delete rows for files that still exist. So a truncated run upserts and
 * does not delete, which can only leave the map too large — a superset, whose
 * worst case is a stale row, rather than a subset, whose worst case is a
 * missing asset on a live page.
 */
async function fullSync(classroom: ResolvedClassroom): Promise<SyncContentAssetsResult> {
  const { entries, truncated } = await readRepoTree(classroom);
  const syncedAt = new Date();

  const operations = entries.map(entry => upsertOp(classroom.id, entry, syncedAt));

  let deleted = 0;

  if (truncated) {
    await getPrisma().$transaction(operations);
  } else {
    // Destructured rather than indexed off the tail: the sweep's count is
    // positionally coupled to it being the LAST operation, and appending
    // another op later would otherwise report a wrong count silently.
    const [...results] = await getPrisma().$transaction([
      ...operations,
      getPrisma().contentAsset.deleteMany({
        where: { classroom_id: classroom.id, synced_at: { lt: syncedAt } },
      }),
    ]);
    const sweep = results.at(-1) as { count: number };
    deleted = sweep.count;
  }

  return { mode: 'full', upserted: entries.length, deleted, truncated };
}

/**
 * Apply just the paths a push touched.
 *
 * `removed` is deleted outright. `added` and `modified` are re-read — a push
 * webhook names the paths but not their new SHAs, which are the whole point of
 * the row — either one at a time or, past TREE_CALL_THRESHOLD, out of a single
 * whole-repo tree read.
 *
 * A path that comes back missing is treated as removed. That covers the
 * ordinary race where a later push deletes what this one added, and it is the
 * safe direction: no row means the renderer falls back, where a row at a SHA
 * that no longer exists means a signed URL that 404s at the edge.
 */
async function incrementalSync(
  classroom: ResolvedClassroom,
  changes: ContentAssetChanges
): Promise<SyncContentAssetsResult> {
  const removed = unique(changes.removed ?? []);
  const touched = unique([...(changes.added ?? []), ...(changes.modified ?? [])]);

  let entries: TreeEntry[] = [];
  // Whether the listing this run worked from was complete. Only the tree branch
  // can come back short, and when it does a path's absence stops meaning "gone
  // from the repo" — see the deletion guard below.
  let truncated = false;

  if (touched.length > TREE_CALL_THRESHOLD) {
    const wanted = new Set(touched);
    const tree = await readRepoTree(classroom);
    truncated = tree.truncated;
    entries = tree.entries.filter(entry => wanted.has(entry.path));
  } else {
    const found = await Promise.all(
      touched.map(async path => {
        // skipCache because this runs off a push webhook: ContentService's
        // 60-second meta cache is very likely to still hold the PRE-push SHA,
        // which is precisely the value that must not be written here.
        const meta = await ContentService.getMeta({
          gitOrganization: classroom.gitOrganization,
          repo: classroom.content_repo,
          path,
          skipCache: true,
        });
        if (!meta) return null;
        return { path, sha: meta.sha, type: 'blob', size: meta.size ?? 0 } as TreeEntry;
      })
    );
    entries = found.filter((entry): entry is TreeEntry => entry !== null);
  }

  const resolvedPaths = new Set(entries.map(entry => entry.path));
  const vanished = touched.filter(path => !resolvedPaths.has(path));

  // `removed` is the webhook naming a deletion, which is always trustworthy.
  // `vanished` is an INFERENCE from absence, and a truncated listing destroys
  // the premise: the entries GitHub omitted are not gone from the repo, so
  // deleting them would strand live files. Same invariant fullSync holds — a
  // map that is too large costs a stale row, one that is too small costs a
  // missing asset on a live page.
  //
  // The per-path branch never sets `truncated`, and does not need to:
  // ContentService.getMeta returns null only on a 404 and rethrows everything
  // else, so a rate limit or a 5xx aborts the sync instead of emptying the map.
  const toDelete = truncated ? unique(removed) : unique([...removed, ...vanished]);

  const syncedAt = new Date();
  const operations = entries.map(entry => upsertOp(classroom.id, entry, syncedAt));

  const results = await getPrisma().$transaction([
    ...operations,
    getPrisma().contentAsset.deleteMany({
      where: { classroom_id: classroom.id, path: { in: toDelete } },
    }),
  ]);

  // Same positional coupling as fullSync: the delete is appended last.
  const deleted = (results.at(-1) as { count: number }).count;

  return { mode: 'incremental', upserted: entries.length, deleted, truncated };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function touchesThemes(changes: ContentAssetChanges): boolean {
  return [...(changes.added ?? []), ...(changes.modified ?? []), ...(changes.removed ?? [])].some(
    path => path.startsWith(THEME_PREFIX)
  );
}

/**
 * Refresh a classroom's asset map.
 *
 * Full by default. Pass `changes` for the incremental path — but note that a
 * change under `.slidesthemes/` escalates back to full regardless, because a
 * theme is addressed by its tree SHA and no per-file update can produce one.
 * Pass `full: true` to force the full path even when `changes` is present.
 */
export async function syncContentAssets(
  classroomId: string,
  opts: SyncContentAssetsOptions = {}
): Promise<SyncContentAssetsResult> {
  const classroom = await resolveClassroom(classroomId);

  const goFull = opts.full === true || !opts.changes || touchesThemes(opts.changes);

  return goFull ? fullSync(classroom) : incrementalSync(classroom, opts.changes!);
}

/**
 * Make sure the map exists and is not older than `maxAgeMs`, syncing if not.
 *
 * This is what makes the system self-bootstrapping. No classroom needs to be
 * migrated into the delivery layer and no backfill job has to run: the first
 * render of a classroom that has never synced finds no rows, syncs, and
 * proceeds. It is also the backstop for a missed push webhook — a delivery that
 * never arrived costs staleness bounded by `maxAgeMs`, not a permanently wrong
 * map.
 *
 * NEVER THROWS — see the body. Returns null whenever no sync happened, whether
 * because the map was fresh, the classroom is not served by this layer, or the
 * refresh itself failed. A caller on a render path can therefore ignore the
 * result entirely; one that cares only needs to know a non-null means the map
 * was just rebuilt.
 */
export async function ensureContentAssets(
  classroomId: string,
  { maxAgeMs }: { maxAgeMs: number }
): Promise<SyncContentAssetsResult | null> {
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
  const classroom = await loadClassroomRaw(classroomId);
  if (!isDeliverable(classroom)) {
    return null;
  }

  const newest = await getPrisma().contentAsset.findFirst({
    where: { classroom_id: classroomId },
    orderBy: { synced_at: 'desc' },
    select: { synced_at: true },
  });

  if (newest && Date.now() - newest.synced_at.getTime() < maxAgeMs) {
    return null;
  }

  try {
    //   RUNTIME — a GitHub 403 rate limit, a 5xx, a network blip. Not
    //   predictable and not this caller's problem: the previous map is still in
    //   the table and still usable, so a failed refresh should cost staleness,
    //   never a broken page. Caught here and only here.
    return await fullSync(toResolvedClassroom(classroom, classroomId));
  } catch (error: unknown) {
    console.warn(`[contentAssets] sync failed for ${classroomId}; serving stale/legacy:`, error);
    return null;
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
