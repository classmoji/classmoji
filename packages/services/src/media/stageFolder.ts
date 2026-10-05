/**
 * Folders inside a slide deck for agent uploads (`file_upload_start` /
 * `file_import_url` with `slide_id` and `folder`).
 *
 * A multi-file piece — a game with its scripts, sprites and sounds — is
 * embedded in a deck as an iframe over its own files, and those files refer to
 * each other by relative path. So a file uploaded into a folder is stored at
 * exactly `{deck folder}/{folder}/{name}`, with the name as given: no
 * timestamp, no lowercasing. Files without a folder keep today's behaviour
 * (the deck's `images/` folder, a stable sanitized name).
 *
 * Pure: no Prisma, no network. Every refusal is a `MediaError`
 * `STORAGE_REFUSED` with a sentence the agent can act on.
 *
 * While a folder upload is staging, its row's `filename` carries the relative
 * path (`folder/name`). Such a row is always bound for the course repository
 * and is tombstoned once placed, so it never becomes a media object whose
 * filename names a download.
 */

import { MediaError } from './MediaError.ts';
import { extensionOf } from './mediaKinds.ts';

/** The most folder levels below the deck folder. */
export const STAGE_FOLDER_MAX_DEPTH = 4;

/** The longest `folder/name` path, in characters. */
export const STAGE_PATH_MAX_LENGTH = 160;

/** One path segment: letters, digits, `.`, `_`, `-`; never starting with `.`. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function refuse(message: string): never {
  throw new MediaError('STORAGE_REFUSED', message);
}

/**
 * A folder path as stored (`games/minions`), or a refusal: relative, `/`
 * separated, at most `STAGE_FOLDER_MAX_DEPTH` levels, each segment from the
 * safe set. A trailing `/` is dropped; nothing else is rewritten.
 */
export function normalizeStageFolder(folder: string): string {
  const value = folder.trim().replace(/\/+$/, '');
  if (!value) refuse('folder is empty; omit it to use the deck’s images folder.');
  if (value.includes('\\')) refuse('folder uses "/" between folders, never "\\".');
  if (value.startsWith('/')) refuse('folder is relative to the deck folder; drop the leading "/".');
  const segments = value.split('/');
  if (segments.some(segment => segment === '..' || segment === '.')) {
    refuse('folder cannot contain "." or ".." segments.');
  }
  if (segments.some(segment => segment === ''))
    refuse('folder cannot contain empty segments ("//").');
  const bad = segments.find(segment => !SEGMENT.test(segment));
  if (bad !== undefined) {
    refuse(
      `folder segment "${bad.slice(0, 40)}" may use only letters, digits, ".", "_" and "-", ` +
        'and cannot start with ".".'
    );
  }
  if (segments.length > STAGE_FOLDER_MAX_DEPTH) {
    refuse(`folder can be at most ${STAGE_FOLDER_MAX_DEPTH} levels deep.`);
  }
  return value;
}

/**
 * The row filename for an upload: `name` alone, or `folder/name` for a deck
 * folder upload — the name then kept exactly, so it must be a plain segment
 * with an extension.
 */
export function stageFilename(
  name: string,
  folder: string | null | undefined,
  targetType: 'page' | 'slide'
): string {
  if (/[/\\]/.test(name)) {
    refuse(
      'filename is a name, not a path; put folders in folder (slide decks only), e.g. ' +
        'folder: "games/minions", filename: "sprite.png".'
    );
  }
  if (folder === undefined || folder === null) return name;
  if (targetType !== 'slide') refuse('folder is for slide decks; page files keep flat names.');
  const normalized = normalizeStageFolder(folder);
  const trimmed = name.trim();
  if (trimmed.length > 100) refuse('In a folder the file name can be at most 100 characters.');
  if (!SEGMENT.test(trimmed)) {
    refuse(
      `In a folder the file keeps its name exactly, so "${trimmed.slice(0, 60)}" may use only ` +
        'letters, digits, ".", "_" and "-", and cannot start with ".".'
    );
  }
  if (!extensionOf(trimmed)) refuse(`"${trimmed.slice(0, 60)}" needs an extension, e.g. game.js.`);
  const path = `${normalized}/${trimmed}`;
  if (path.length > STAGE_PATH_MAX_LENGTH) {
    refuse(`folder and filename together can be at most ${STAGE_PATH_MAX_LENGTH} characters.`);
  }
  return path;
}

/** A row filename split back into its folder (null for a flat name) and name. */
export function splitStagePath(filename: string): { folder: string | null; name: string } {
  const at = filename.lastIndexOf('/');
  if (at === -1) return { folder: null, name: filename };
  return { folder: filename.slice(0, at), name: filename.slice(at + 1) };
}
