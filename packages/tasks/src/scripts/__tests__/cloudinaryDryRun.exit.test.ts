/**
 * The dry run EXITS (non-zero) when something fails after it connected,
 * instead of hanging on its open database connection.
 *
 * What this proves is the exit, not the `$disconnect()` in the script's
 * `finally`: the pool lets Node exit while idle (`allowExitOnIdle`), and the
 * OS closes the socket at exit either way, so the session is gone in both
 * cases and nothing outside the process can tell them apart.
 *
 * Runs the real script in a child process against a local database, with
 * every fetch failing (offlineFetch.mjs), so the first call after connecting,
 * the Cloudinary listing, errors and nothing leaves the machine. Skipped unless
 * DATABASE_URL names a LOCAL, non-shared database.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RUN =
  /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL) && !/\/classmoji(\?|$)/.test(DATABASE_URL);

const SCRIPT = fileURLToPath(new URL('../cloudinaryDryRun.ts', import.meta.url));
const OFFLINE = fileURLToPath(new URL('./offlineFetch.mjs', import.meta.url));

describe.skipIf(!RUN)('cloudinaryDryRun on an error after connecting (real database)', () => {
  it('exits 1 instead of hanging', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--import', OFFLINE, SCRIPT],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          CLASSMOJI_DRY_RUN_ACK: 'read-only',
          DATABASE_URL_UNPOOLED: DATABASE_URL,
          CLOUDINARY_CLOUD_NAME: 'test-cloud',
          CLOUDINARY_API_KEY: 'test-key',
          CLOUDINARY_API_SECRET: 'test-secret',
          GITHUB_APP_ID: '1',
          GITHUB_PRIVATE_KEY_BASE64: Buffer.from(pem).toString('base64'),
        },
      }
    );
    expect(result.error, 'the script did not exit by itself').toBeUndefined();
    expect(result.stderr).toContain('connected read-only');
    expect(result.stderr).toContain('offline (test preload)');
    expect(result.status).toBe(1);
  }, 40_000);
});
