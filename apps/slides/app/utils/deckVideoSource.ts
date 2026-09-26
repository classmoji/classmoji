/**
 * deckVideoSource.ts — which repository file a deck's video URL names, and
 * whether it belongs to that deck.
 *
 * Moving a video to Cloudinary reads the file out of the content repo and then
 * DELETES it there. The URL comes from the editor, so the file it names is
 * bound to the deck being edited before either happens: the deck's own org and
 * content repo, and a path inside the deck's folder.
 *
 * Pure, so it can be unit tested without the route's imports.
 */

import { isWithinContentPath } from './slideDocumentAccess.ts';

/** The deck the video is being moved for. */
export interface DeckLocation {
  org: string;
  repo: string;
  contentPath: string | null | undefined;
}

export type DeckVideoSource =
  /** Not one of our `/content/...` URLs — Cloudinary fetches it itself. */
  | { kind: 'external' }
  /** A file in this deck's folder, safe to read and then delete. */
  | { kind: 'repo'; org: string; repo: string; path: string }
  /** A `/content/...` URL for a file outside this deck. */
  | { kind: 'foreign' };

/**
 * Local content URLs are `/content/{org}/{repo}/{path}`, either relative or on
 * a localhost origin (the dev stack). Anything else is external.
 */
export function deckVideoSource(videoUrl: string, deck: DeckLocation): DeckVideoSource {
  const isLocalContentUrl =
    videoUrl.startsWith('/content/') ||
    (videoUrl.includes('/content/') && videoUrl.includes('localhost'));
  if (!isLocalContentUrl) return { kind: 'external' };

  const afterPrefix = videoUrl.substring(videoUrl.indexOf('/content/') + '/content/'.length);
  // A query string or fragment is not part of the file's path.
  const bare = afterPrefix.split(/[?#]/)[0];
  const [org, repo, ...rest] = bare.split('/');
  const path = rest.join('/');

  // No empty, `.` or `..` segments: the path is compared as a string below, and
  // a string that climbs out of the folder would pass that comparison.
  const segmentsOk = rest.length > 0 && rest.every(s => s !== '' && s !== '.' && s !== '..');

  if (
    !segmentsOk ||
    org !== deck.org ||
    repo !== deck.repo ||
    !isWithinContentPath(path, deck.contentPath)
  ) {
    return { kind: 'foreign' };
  }
  return { kind: 'repo', org, repo, path };
}
