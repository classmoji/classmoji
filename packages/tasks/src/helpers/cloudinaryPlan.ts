/**
 * The Cloudinary → media migration PLAN (plan §13.2): what exists on
 * Cloudinary, which decks reference it, and what moving it would cost each
 * classroom. Read-only by construction — `planMigration` receives only read
 * functions, and `buildPlan` is pure.
 *
 * Imports nothing but the pure URL module, so the dry-run CLI can load it
 * without `@classmoji/services` / `@classmoji/database` (whose import creates a
 * Prisma client from `DATABASE_URL`).
 */

import { scanText, type ResolvedReference } from './cloudinaryUrls.ts';

/** Where every asset this migration covers lives (plan §13.4). */
export const CLOUDINARY_PREFIX = 'classmoji/slides/';

/** One Admin API resource (resource_type video, type upload). */
export interface CloudinaryAsset {
  publicId: string;
  format: string;
  bytes: number;
  version: number;
  /** The untransformed original — what the execute path fetches. */
  secureUrl: string;
  createdAt: string | null;
}

/** A DECK slide row and the classroom it belongs to. */
export interface DeckRecord {
  slideId: string;
  classroomId: string;
  title: string;
  contentPath: string;
  createdBy: string;
}

/** A deck file as read from the content repo's default branch. */
export interface DeckFile {
  path: string;
  sha: string;
  text: string;
}

/** What reading one deck produced. */
export interface DeckRead {
  /** `deck.json` and/or `index.html` from the default branch. */
  files: DeckFile[];
  /** The preview branch's `deck.json`, when a preview branch exists. */
  previewFiles: DeckFile[];
  previewBranch: string | null;
  /** Set when the deck could not be read at all; files are then empty. */
  unscanned: string | null;
}

export interface ClassroomFacts {
  classroomId: string;
  slug: string;
  name: string;
  isArchived: boolean;
  status: string;
  /** Informational: the execute path bypasses the Pro gate (decision 3). */
  isPro: boolean;
  /** Billed bytes of the classroom's live media rows today. */
  usedBytes: number;
  /**
   * The classroom half of "can media render here": delivery enabled, a
   * content repo, an org login. `media://` refs in a classroom without it
   * render as a placeholder, so the execute path skips such classrooms.
   */
  canServeMedia: boolean;
  gitProvider: string | null;
  gitOrgLogin: string | null;
  contentRepo: string | null;
}

export interface PlanReadDeps {
  cloudName: string;
  /** The Pro quota, in bytes (the Trigger task passes the services constant). */
  proQuotaBytes: number;
  listCloudinaryAssets(): Promise<CloudinaryAsset[]>;
  listDecks(): Promise<DeckRecord[]>;
  classroomFacts(classroomIds: string[]): Promise<ClassroomFacts[]>;
  readDeck(deck: DeckRecord, classroom: ClassroomFacts | undefined): Promise<DeckRead>;
  /** Deck reads in flight at once. */
  concurrency?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface ReferenceSite {
  slideId: string;
  classroomId: string;
  path: string;
  /** Occurrences of this asset in that file. */
  count: number;
  /** Of those, how many are a `data-background-video` value (slides.com imports). */
  background: number;
}

export interface PlanAsset {
  publicId: string;
  format: string;
  bytes: number;
  version: number;
  secureUrl: string;
  referencedBy: ReferenceSite[];
  /** Classrooms whose decks reference it — each gets its own copy. */
  classroomIds: string[];
  /** No scanned deck references it: listed, never migrated. */
  unreferenced: boolean;
}

export interface PlanClassroom {
  classroomId: string;
  slug: string;
  name: string;
  isArchived: boolean;
  status: string;
  isPro: boolean;
  canServeMedia: boolean;
  usedBytes: number;
  quotaBytes: number;
  /** quotaBytes − usedBytes, before the migration; negative when already over. */
  headroomBytes: number;
  bytesToAdd: number;
  /** usedBytes + bytesToAdd > quotaBytes. The import bypasses the quota anyway. */
  overQuota: boolean;
  assets: string[];
  decks: string[];
}

/** One (asset, classroom) copy the execute path would make, in run order. */
export interface WorkItem {
  publicId: string;
  classroomId: string;
  bytes: number;
  /** Decks in this classroom whose default-branch files reference the asset. */
  slideIds: string[];
  /** The deck owner the media row is recorded as uploaded by. */
  uploadedBy: string;
}

export interface PlanDeck {
  slideId: string;
  classroomId: string;
  title: string;
  contentPath: string;
  files: { path: string; sha: string; videoRefs: number }[];
}

export interface OtherReference {
  slideId: string;
  classroomId: string;
  path: string;
  raw: string;
  kind: 'still' | 'unknown';
  publicId: string | null;
}

export interface PreviewReference {
  slideId: string;
  classroomId: string;
  branch: string;
  path: string;
  publicIds: string[];
}

export interface MigrationPlan {
  generatedAt: string;
  cloudName: string;
  prefix: string;
  assets: PlanAsset[];
  classrooms: PlanClassroom[];
  /** Decks with at least one Cloudinary reference on the default branch. */
  decks: PlanDeck[];
  work: WorkItem[];
  /** Work items past `limit`, not in `work`. */
  workDeferredByLimit: number;
  /** Stills and URLs of our cloud that match no listed asset. Never rewritten. */
  otherReferences: OtherReference[];
  /** Preview-branch decks that reference Cloudinary. Scanned, never rewritten. */
  previewReferences: PreviewReference[];
  /** Decks that could not be read. */
  unscannedDecks: { slideId: string; classroomId: string; reason: string }[];
  /** Work in classrooms whose media cannot render — skipped by the execute path. */
  blockedClassrooms: string[];
  totals: {
    assets: number;
    assetBytes: number;
    referencedAssets: number;
    unreferencedAssets: number;
    unreferencedBytes: number;
    decksScanned: number;
    decksWithReferences: number;
    decksUnscanned: number;
    classroomsAffected: number;
    workItems: number;
    bytesToCopy: number;
    overQuotaClassrooms: number;
    /** Video references on the default branch (every file, every form). */
    videoReferences: number;
    /** Of those, `data-background-video` values. */
    backgroundVideoReferences: number;
    otherReferences: number;
    previewBranchesWithReferences: number;
  };
}

export interface ScannedDeck {
  deck: DeckRecord;
  read: DeckRead;
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}

/**
 * The whole plan from what was read. Pure: same inputs, same plan (sorted
 * throughout, so two dry runs diff cleanly).
 */
export function buildPlan(input: {
  cloudName: string;
  proQuotaBytes: number;
  assets: CloudinaryAsset[];
  scanned: ScannedDeck[];
  classrooms: ClassroomFacts[];
  limit?: number;
  generatedAt: string;
}): MigrationPlan {
  const { cloudName, proQuotaBytes } = input;
  const assetsById = new Map(input.assets.map(asset => [asset.publicId, asset]));
  const known = new Set(assetsById.keys());
  const factsById = new Map(input.classrooms.map(facts => [facts.classroomId, facts]));

  const sites = new Map<string, ReferenceSite[]>();
  const planDecks: PlanDeck[] = [];
  const other: OtherReference[] = [];
  const preview: PreviewReference[] = [];
  const unscanned: MigrationPlan['unscannedDecks'] = [];

  for (const { deck, read } of input.scanned) {
    if (read.unscanned) {
      unscanned.push({
        slideId: deck.slideId,
        classroomId: deck.classroomId,
        reason: read.unscanned,
      });
      continue;
    }
    const deckFiles: PlanDeck['files'] = [];
    for (const file of read.files) {
      const refs = scanText(file.text, cloudName, known);
      const videos = refs.filter(
        (ref): ref is Extract<ResolvedReference, { kind: 'video' }> => ref.kind === 'video'
      );
      const backgrounds = countBy(
        videos.filter(ref => ref.context === 'background'),
        ref => ref.publicId
      );
      for (const [publicId, count] of countBy(videos, ref => ref.publicId)) {
        const list = sites.get(publicId) ?? [];
        list.push({
          slideId: deck.slideId,
          classroomId: deck.classroomId,
          path: file.path,
          count,
          background: backgrounds.get(publicId) ?? 0,
        });
        sites.set(publicId, list);
      }
      for (const ref of refs) {
        if (ref.kind === 'video') continue;
        other.push({
          slideId: deck.slideId,
          classroomId: deck.classroomId,
          path: file.path,
          raw: ref.raw,
          kind: ref.kind,
          publicId: ref.kind === 'still' ? ref.publicId : ref.guess,
        });
      }
      if (refs.length > 0) {
        deckFiles.push({ path: file.path, sha: file.sha, videoRefs: videos.length });
      }
    }
    if (deckFiles.length > 0) {
      planDecks.push({
        slideId: deck.slideId,
        classroomId: deck.classroomId,
        title: deck.title,
        contentPath: deck.contentPath,
        files: deckFiles,
      });
    }
    for (const file of read.previewFiles) {
      const refs = scanText(file.text, cloudName, known);
      if (refs.length === 0) continue;
      preview.push({
        slideId: deck.slideId,
        classroomId: deck.classroomId,
        branch: read.previewBranch ?? '',
        path: file.path,
        publicIds: [
          ...new Set(
            refs.map(ref => (ref.kind === 'unknown' ? (ref.guess ?? ref.raw) : ref.publicId))
          ),
        ].sort(),
      });
    }
  }

  const decksById = new Map(input.scanned.map(({ deck }) => [deck.slideId, deck]));

  const assets: PlanAsset[] = [...assetsById.values()]
    .sort((a, b) => a.publicId.localeCompare(b.publicId))
    .map(asset => {
      const referencedBy = (sites.get(asset.publicId) ?? []).sort(
        (a, b) =>
          a.classroomId.localeCompare(b.classroomId) ||
          a.slideId.localeCompare(b.slideId) ||
          a.path.localeCompare(b.path)
      );
      const classroomIds = [...new Set(referencedBy.map(site => site.classroomId))].sort();
      return {
        publicId: asset.publicId,
        format: asset.format,
        bytes: asset.bytes,
        version: asset.version,
        secureUrl: asset.secureUrl,
        referencedBy,
        classroomIds,
        unreferenced: referencedBy.length === 0,
      };
    });

  // One work item per (asset, classroom), grouped by asset so a second
  // classroom's copy comes right after the first (an R2 CopyObject of it).
  const allWork: WorkItem[] = [];
  for (const asset of assets) {
    for (const classroomId of asset.classroomIds) {
      const slideIds = [
        ...new Set(
          asset.referencedBy
            .filter(site => site.classroomId === classroomId)
            .map(site => site.slideId)
        ),
      ].sort();
      const owner = decksById.get(slideIds[0]!)?.createdBy ?? '';
      allWork.push({
        publicId: asset.publicId,
        classroomId,
        bytes: asset.bytes,
        slideIds,
        uploadedBy: owner,
      });
    }
  }
  const limit = input.limit;
  const work = limit === undefined ? allWork : allWork.slice(0, limit);

  const classroomIds = [...new Set(allWork.map(item => item.classroomId))].sort();
  const classrooms: PlanClassroom[] = classroomIds.map(classroomId => {
    const facts = factsById.get(classroomId);
    const items = allWork.filter(item => item.classroomId === classroomId);
    const usedBytes = facts?.usedBytes ?? 0;
    const bytesToAdd = items.reduce((total, item) => total + item.bytes, 0);
    return {
      classroomId,
      slug: facts?.slug ?? '',
      name: facts?.name ?? '',
      isArchived: facts?.isArchived ?? false,
      status: facts?.status ?? 'UNKNOWN',
      isPro: facts?.isPro ?? false,
      canServeMedia: facts?.canServeMedia ?? false,
      usedBytes,
      quotaBytes: proQuotaBytes,
      headroomBytes: proQuotaBytes - usedBytes,
      bytesToAdd,
      overQuota: usedBytes + bytesToAdd > proQuotaBytes,
      assets: items.map(item => item.publicId),
      decks: [...new Set(items.flatMap(item => item.slideIds))].sort(),
    };
  });

  const referenced = assets.filter(asset => !asset.unreferenced);
  const allSites = assets.flatMap(asset => asset.referencedBy);
  const unreferenced = assets.filter(asset => asset.unreferenced);
  planDecks.sort(
    (a, b) => a.classroomId.localeCompare(b.classroomId) || a.slideId.localeCompare(b.slideId)
  );
  unscanned.sort(
    (a, b) => a.classroomId.localeCompare(b.classroomId) || a.slideId.localeCompare(b.slideId)
  );

  return {
    generatedAt: input.generatedAt,
    cloudName,
    prefix: CLOUDINARY_PREFIX,
    assets,
    classrooms,
    decks: planDecks,
    work,
    workDeferredByLimit: allWork.length - work.length,
    otherReferences: other,
    previewReferences: preview,
    unscannedDecks: unscanned,
    blockedClassrooms: classrooms.filter(c => !c.canServeMedia).map(c => c.classroomId),
    totals: {
      assets: assets.length,
      assetBytes: assets.reduce((total, asset) => total + asset.bytes, 0),
      referencedAssets: referenced.length,
      unreferencedAssets: unreferenced.length,
      unreferencedBytes: unreferenced.reduce((total, asset) => total + asset.bytes, 0),
      decksScanned: input.scanned.length - unscanned.length,
      decksWithReferences: planDecks.length,
      decksUnscanned: unscanned.length,
      classroomsAffected: classrooms.length,
      workItems: allWork.length,
      bytesToCopy: allWork.reduce((total, item) => total + item.bytes, 0),
      overQuotaClassrooms: classrooms.filter(c => c.overQuota).length,
      videoReferences: allSites.reduce((total, site) => total + site.count, 0),
      backgroundVideoReferences: allSites.reduce((total, site) => total + site.background, 0),
      otherReferences: other.length,
      previewBranchesWithReferences: new Set(preview.map(p => p.slideId)).size,
    },
  };
}

/** `fn` over `items`, at most `limit` in flight; results in input order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Read everything and build the plan. Every dependency is a read; there is no
 * write function in `PlanReadDeps` to call.
 *
 * A deck whose read throws is recorded as unscanned rather than failing the
 * plan — one revoked install must not hide every other classroom's decks.
 */
export async function planMigration(
  deps: PlanReadDeps,
  opts: { limit?: number } = {}
): Promise<MigrationPlan> {
  const log = deps.log ?? (() => {});
  const assets = await deps.listCloudinaryAssets();
  log('Listed Cloudinary assets', { count: assets.length });

  const decks = await deps.listDecks();
  log('Listed deck slides', { count: decks.length });

  const classroomIds = [...new Set(decks.map(deck => deck.classroomId))].sort();
  const classrooms = await deps.classroomFacts(classroomIds);
  const factsById = new Map(classrooms.map(facts => [facts.classroomId, facts]));

  let done = 0;
  const scanned = await mapLimited(decks, deps.concurrency ?? 4, async deck => {
    let read: DeckRead;
    try {
      read = await deps.readDeck(deck, factsById.get(deck.classroomId));
    } catch (error) {
      read = {
        files: [],
        previewFiles: [],
        previewBranch: null,
        unscanned: `read failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    done++;
    if (done % 50 === 0) log('Scanned decks', { done, total: decks.length });
    return { deck, read };
  });

  return buildPlan({
    cloudName: deps.cloudName,
    proQuotaBytes: deps.proQuotaBytes,
    assets,
    scanned,
    classrooms,
    limit: opts.limit,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
}
