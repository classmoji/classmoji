import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

import { BACKUP_KEY_PATTERN, BACKUP_METADATA } from './dbBackup.ts';
import type { MediaStore } from './r2Objects.ts';

/**
 * The read side of the database backups: list them, read the size and
 * checksum each carries as metadata, and decide whether a target database is one a dump
 * may be restored into. Used by `scripts/restoreBackup.ts`.
 */

/** Hosts a restore may target without `--allow-remote`. */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'host.docker.internal',
  'classmoji-postgres',
]);

export type TargetCheck =
  | { ok: true; host: string; database: string }
  | { ok: false; reason: string };

/**
 * A restore never goes into a database by accident: the target must be a
 * Postgres URL naming a database, and on this machine unless `allowRemote`
 * (a disaster restore into a brand-new Neon project). Whether it is EMPTY is
 * checked separately, against the live database, before anything is written.
 */
export function checkRestoreTarget(target: string, allowRemote: boolean): TargetCheck {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: 'the target is not a URL' };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return { ok: false, reason: 'the target must be a postgres:// or postgresql:// URL' };
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) return { ok: false, reason: 'the target URL names no database' };
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !allowRemote) {
    return {
      ok: false,
      reason: `${host} is not a local database; pass --allow-remote only for a new, empty database you created for this restore`,
    };
  }
  return { ok: true, host, database };
}

/** Counts the user tables in a database; a restore target must have none. */
export const USER_TABLES_SQL =
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')";

/** Backup names in the bucket, oldest first (names start with a sortable UTC stamp). */
export function listBackups(keys: string[]): string[] {
  return keys.filter(key => BACKUP_KEY_PATTERN.test(key)).sort();
}

export async function listKeys(store: MediaStore): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await store.client.send(
      new ListObjectsV2Command({
        Bucket: store.bucket,
        ContinuationToken: token,
      })
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** What the restore needs from a backup: its size and SHA-256, from its metadata. */
export interface StoredBackup {
  key: string;
  bytes: number;
  sha256: string;
  startedAt: string;
}

/**
 * A backup's size and checksum, read from the object's own metadata
 * (`BACKUP_METADATA`, set at upload). A dump without a checksum cannot be
 * verified, so it is refused rather than restored blind.
 */
export async function readBackupInfo(store: MediaStore, key: string): Promise<StoredBackup> {
  const head = await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: key }));
  const meta = head.Metadata ?? {};
  const sha256 = meta[BACKUP_METADATA.sha256];
  if (typeof head.ContentLength !== 'number' || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`[restore] ${key} has no size or SHA-256 to verify it against`);
  }
  return {
    key,
    bytes: head.ContentLength,
    sha256,
    startedAt: meta[BACKUP_METADATA.startedAt] ?? key,
  };
}
