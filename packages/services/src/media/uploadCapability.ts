/**
 * The server half of the storage router: what one classroom's uploads can do.
 *
 * `storageTargetFor` (`storageRouter.ts`) is pure and runs anywhere; it needs a
 * capability to route against, and only the server can build one — it needs
 * the classroom's Pro state, whether this deployment has a media bucket, and
 * whether the classroom's content can be served. This module builds it, and
 * holds the one check every repository write of a user's file runs
 * (`assertRepoTarget`).
 *
 * No S3 client here. A loader asks for the capability on every editor render,
 * so the usage sum is read through `mediaLookup.ts` (the read half) rather than
 * `media.service.ts`, which would load the AWS SDK for a number.
 */

import getPrisma from '@classmoji/database';
import { REPO_REST_MAX_BYTES } from '@classmoji/utils';
import { uploadFileTypes } from '../classmoji/contentDelivery.service.ts';
import { getProStateForClassroomId } from '../classmoji/subscription.service.ts';
import { isMediaConfigured } from './mediaConfig.ts';
import { usedBytesFor } from './mediaLookup.ts';
import { PER_FILE_MAX_BYTES, quotaBytesFor } from './mediaQuota.ts';
import { MediaRoutingError } from './MediaRoutingError.ts';
import { kindOfFilename, storageTargetFor, type UploadCapability } from './storageRouter.ts';

/**
 * The classroom fields a capability needs. `id` always; the delivery fields
 * when the caller has them (a page's or slide's `.classroom` usually does) —
 * any that are missing are read from the database rather than guessed, because
 * a missing `content_delivery_enabled` reads as "not enabled" and would quietly
 * turn media off.
 */
export interface CapabilityClassroom {
  id: string;
  content_delivery_enabled?: boolean | null;
  content_repo?: string | null;
  git_organization?: {
    login?: string | null;
    provider?: string | null;
    github_installation_id?: string | null;
    gitlab_connection_id?: string | null;
  } | null;
}

async function withDeliveryFields(classroom: CapabilityClassroom): Promise<CapabilityClassroom> {
  if (
    classroom.content_delivery_enabled !== undefined &&
    classroom.content_repo !== undefined &&
    classroom.git_organization !== undefined
  ) {
    return classroom;
  }
  const row = await getPrisma().classroom.findUnique({
    where: { id: classroom.id },
    select: {
      content_delivery_enabled: true,
      content_repo: true,
      git_organization: {
        select: {
          login: true,
          provider: true,
          github_installation_id: true,
          gitlab_connection_id: true,
        },
      },
    },
  });
  return { ...classroom, ...(row ?? {}), id: classroom.id };
}

/**
 * Build the capability. `withUsage: false` skips the quota sum and reports the
 * per-file ceiling as `remainingBytes` — for the enforcement path, which routes
 * and never displays (the router does not read quota; see its header).
 */
async function buildCapability(
  classroom: CapabilityClassroom,
  { withUsage }: { withUsage: boolean }
): Promise<UploadCapability> {
  const full = await withDeliveryFields(classroom);
  const repoFileTypes = uploadFileTypes(full);
  const { isPro } = await getProStateForClassroomId(classroom.id);

  // `repoFileTypes === 'any'` is `isContentDeliveryConfigured() &&
  // canDeliverContent(classroom)` — the deployment can SIGN delivery URLs and
  // this classroom is served through them. Media is only ever served signed,
  // so a deployment with a bucket but no signing secret (or no delivery
  // origin) must not offer it: the upload would succeed and every reference to
  // it would render as a placeholder.
  let media: UploadCapability['media'] = null;
  if (isPro && isMediaConfigured() && repoFileTypes === 'any') {
    const remainingBytes = withUsage
      ? Math.max(0, quotaBytesFor(true) - (await usedBytesFor(classroom.id)))
      : PER_FILE_MAX_BYTES;
    media = { perFileMaxBytes: PER_FILE_MAX_BYTES, remainingBytes };
  }

  return { repoMaxBytes: REPO_REST_MAX_BYTES, repoFileTypes, isPro, media };
}

/**
 * What this classroom's uploads can do — for a loader to hand an editor, which
 * routes each file with `storageTargetFor` before sending it.
 *
 * `media` is null unless the classroom is Pro, this deployment has a media
 * bucket, and the classroom's content can be served (media is only ever served
 * signed, so a classroom that cannot sign has nowhere to show it).
 */
export async function uploadCapabilityFor(
  classroom: CapabilityClassroom
): Promise<UploadCapability> {
  return buildCapability(classroom, { withUsage: true });
}

/**
 * Refuse a repository write the router sends to media.
 *
 * Every entry point that commits a USER's file into the content repo calls this
 * with the file it actually received — `pageContent.uploadPageAsset` (the page
 * editor, the page cover, MCP `page_asset_upload`) and the deck editor's image
 * upload. Throws `MediaRoutingError('USE_MEDIA')`, which the routes answer as
 * 409 `{ error: 'USE_MEDIA' }` (`mediaRoutingResponse`).
 *
 * Only `media` is refused here. A file the router would refuse outright falls
 * through to the repository write's own validation, which refuses it with the
 * status and sentence that path has always used (413/415/400).
 *
 * The common case costs nothing: a file that is not a video and fits the
 * repository can never be routed to media, whatever the classroom, so it
 * returns before any lookup.
 */
export async function assertRepoTarget(
  classroom: CapabilityClassroom,
  file: { name: string; size: number }
): Promise<void> {
  if (kindOfFilename(file.name) !== 'VIDEO' && file.size <= REPO_REST_MAX_BYTES) return;
  if (!isMediaConfigured()) return;

  const capability = await buildCapability(classroom, { withUsage: false });
  if (storageTargetFor(capability, file).kind === 'media') {
    throw new MediaRoutingError(
      'USE_MEDIA',
      kindOfFilename(file.name) === 'VIDEO'
        ? 'Videos in this class are stored in media storage, not the course repository.'
        : 'Files this large are stored in media storage, not the course repository.'
    );
  }
}
