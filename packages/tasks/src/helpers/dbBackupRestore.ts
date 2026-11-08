import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

import { BACKUP_PREFIX, type BackupManifest } from './dbBackup.ts';
import type { MediaStore } from './r2Objects.ts';

/**
 * The read side of the database backups: find the dumps that finished (the
 * ones with a manifest), and decide whether a target database is one a dump
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

export interface BackupEntry {
  dumpKey: string;
  manifestKey: string;
}

/**
 * Dumps that have a manifest, oldest first (keys start with a sortable UTC
 * stamp). A dump without one is an attempt that did not finish.
 */
export function finishedBackups(keys: string[]): BackupEntry[] {
  const present = new Set(keys);
  return keys
    .filter(key => key.startsWith(BACKUP_PREFIX) && key.endsWith('.manifest.json'))
    .map(manifestKey => ({
      manifestKey,
      dumpKey: manifestKey.slice(0, -'.manifest.json'.length) + '.dump',
    }))
    .filter(entry => present.has(entry.dumpKey))
    .sort((a, b) => a.dumpKey.localeCompare(b.dumpKey));
}

export async function listKeys(store: MediaStore): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await store.client.send(
      new ListObjectsV2Command({
        Bucket: store.bucket,
        Prefix: BACKUP_PREFIX,
        ContinuationToken: token,
      })
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function readManifest(store: MediaStore, key: string): Promise<BackupManifest> {
  const object = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }));
  const text = await object.Body?.transformToString('utf8');
  if (!text) throw new Error(`[restore] empty manifest ${key}`);
  const manifest = JSON.parse(text) as BackupManifest;
  if (manifest.version !== 1 || typeof manifest.bytes !== 'number' || !manifest.sha256) {
    throw new Error(`[restore] unreadable manifest ${key}`);
  }
  return manifest;
}
