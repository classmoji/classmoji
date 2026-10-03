import { parseMediaRef } from './mediaRefs.ts';

/**
 * Which media files on a page a reader may download, and where the button
 * points.
 *
 * The rule is `contentDelivery.mediaDownloadUrl`'s, restated so the page can
 * decide whether to DRAW a button without minting anything: a video is
 * downloadable for a student only when its uploader ticked "Allow download";
 * every other kind (a pdf, a zip, a recording in an audio block) is the file
 * itself, with no player to fall back on, and always is; teaching staff can
 * always download. The URL is minted only on click, by `/api/media-download`,
 * which applies the same rule again — so a button drawn wrongly could never
 * hand out a file, it could only fail.
 *
 * Pure and import-light on purpose: the page loader, the class-site renderer
 * and the unit suite all read it, and none may pull in the services root.
 */

/**
 * The teaching team: they see drafts, and download any media file whatever its
 * uploader chose for students.
 */
export const TEACHING_TEAM_ROLES: ReadonlySet<string> = new Set(['OWNER', 'TEACHER', 'ASSISTANT']);

/**
 * The role a reader's download map is drawn for, or null for no buttons.
 *
 * It has to be the role `/api/media-download` reads when the button is
 * clicked, or the button 404s: an ACCEPTED membership only (as the class site
 * counts members), given as `acceptedRole` — and only where that role can view
 * the page, which for a draft is the teaching team. A pending invite, or a
 * draft seen through a role whose invite is still pending, draws nothing.
 */
export function downloadMapRole(acceptedRole: string | null, isDraft: boolean): string | null {
  if (!acceptedRole) return null;
  if (isDraft && !TEACHING_TEAM_ROLES.has(acceptedRole)) return null;
  return acceptedRole;
}

/** The blocks a download button belongs on: the ones that are a file to a reader. */
export const DOWNLOADABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['video', 'file', 'audio']);

/** What the download rule needs to know about one READY media row. */
export interface DownloadableRecord {
  kind: string;
  allowDownload: boolean;
}

/** `ref → downloadable`, for the refs a page's file blocks hold. Nothing else is in it. */
export type MediaDownloads = Record<string, boolean>;

type BlockNode = { type?: unknown; props?: unknown; children?: unknown };

/**
 * Every `media://` reference held by a video, file or audio block, in document
 * order, each once. Recurses through `children` (columns, toggles, lists) the
 * way `collectBlockAssetRefs` does.
 */
export function collectMediaDownloadRefs(blocks: unknown): string[] {
  const seen = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const block = node as BlockNode;
    if (typeof block.type === 'string' && DOWNLOADABLE_BLOCK_TYPES.has(block.type)) {
      const url = (block.props as { url?: unknown } | undefined)?.url;
      if (typeof url === 'string' && parseMediaRef(url)) seen.add(url);
    }
    if (block.children) walk(block.children);
  };

  walk(blocks);
  return [...seen];
}

/** `mediaDownloadUrl`'s rule, for a row that exists and is READY. */
export function isDownloadable(record: DownloadableRecord, forStudent: boolean): boolean {
  if (!forStudent) return true;
  return record.kind !== 'VIDEO' || record.allowDownload;
}

/**
 * The map a page ships: each ref → whether to draw a button for it.
 *
 * `records` is keyed by media id and holds READY rows of THIS classroom only
 * (the lookup's own scoping); a ref with no row — deleted, still uploading,
 * another classroom's — is `false`.
 */
export function downloadableByRef(
  refs: readonly string[],
  records: ReadonlyMap<string, DownloadableRecord>,
  forStudent: boolean
): MediaDownloads {
  const out: MediaDownloads = {};
  for (const ref of refs) {
    const id = parseMediaRef(ref);
    const record = id ? records.get(id) : undefined;
    out[ref] = record ? isDownloadable(record, forStudent) : false;
  }
  return out;
}

/**
 * The button's target. `origin` is empty on the pages host itself and the
 * canonical pages origin on a class site, whose own host does not serve the
 * route (the session cookie is shared across the Classmoji subdomains).
 */
export function mediaDownloadHref(pageId: string, ref: string, origin = ''): string {
  return `${origin}/api/media-download?${new URLSearchParams({ pageId, ref })}`;
}

/**
 * The class site's form of the map: `signedUrl → downloadHref`, because the
 * site renders a document whose references have already been rewritten to
 * signed URLs. A ref that did not resolve to a URL of its own (the resolve
 * failed, or it could not be signed) has no entry — its block renders as
 * nothing on the site, so it has nothing to hang a button on.
 */
export function siteDownloadsFor(
  downloads: MediaDownloads,
  urlFor: (ref: string) => string | undefined,
  pageId: string,
  origin: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ref, allowed] of Object.entries(downloads)) {
    if (!allowed) continue;
    const signed = urlFor(ref);
    if (!signed || signed === ref) continue;
    out[signed] = mediaDownloadHref(pageId, ref, origin);
  }
  return out;
}
