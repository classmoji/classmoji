/**
 * Where the CX-2 rehearsal helper (../oauth2CatchUp.rehearsal.test.ts) runs.
 *
 * The helper boots the REAL auth server on the database it is given, and the
 * server writes there as it does anywhere: the MCP resource row at boot, a
 * signing key (`jwks`, sealed with the helper's own BETTER_AUTH_SECRET), and
 * the rotation of the refresh token it is handed. So it runs only on a
 * rehearsal copy, and only when all three hold:
 *
 *   1. OAUTH_REHEARSAL_DATABASE_NAME is set and equals the database named in
 *      OAUTH_REHEARSAL_DATABASE_URL: the operator names the target twice;
 *   2. the host is this machine (localhost, 127.0.0.1, ::1) or a Neon
 *      endpoint (`*.neon.tech`); any other host is refused;
 *   3. the database holds the rehearsal's own user (REHEARSAL_MARKER_USER_ID),
 *      which the rehearsal's window step creates on the copy before the
 *      helper runs. Read with one query before the server module is loaded.
 *
 * Why the third: every Neon branch has a host of its own (its endpoint) and
 * the same database name (`neondb`), so neither the URL nor the name says
 * whether an endpoint is a rehearsal branch. The marker row is a property of
 * the branch's data, created by the rehearsal and by nothing else.
 */

/** The user the rehearsal's window step creates (and nothing else does). */
export const REHEARSAL_MARKER_USER_ID = 'cx2-rehearsal-user';

export interface RehearsalTarget {
  host: string;
  database: string;
  neon: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const NEON_SUFFIX = '.neon.tech';

/** Checks 1 and 2: the target, or why the helper may not run there. */
export function rehearsalTarget(
  url: string | undefined,
  confirmedName: string | undefined
): RehearsalTarget | { refused: string } {
  if (!url) return { refused: 'OAUTH_REHEARSAL_DATABASE_URL is not set' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: 'OAUTH_REHEARSAL_DATABASE_URL is not a URL' };
  }
  const host = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) return { refused: 'OAUTH_REHEARSAL_DATABASE_URL names no database' };
  if (!confirmedName) {
    return {
      refused: `set OAUTH_REHEARSAL_DATABASE_NAME to the database it connects to (${database})`,
    };
  }
  if (confirmedName !== database) {
    return {
      refused: `OAUTH_REHEARSAL_DATABASE_NAME is ${JSON.stringify(confirmedName)}, the URL names ${JSON.stringify(database)}`,
    };
  }
  const neon = host.endsWith(NEON_SUFFIX) && host.length > NEON_SUFFIX.length;
  if (!neon && !LOCAL_HOSTS.has(host)) {
    return { refused: `${host} is neither this machine nor a Neon endpoint` };
  }
  return { host, database, neon };
}

/**
 * All three checks; throws with the reason. `hasMarker` reads the target for
 * REHEARSAL_MARKER_USER_ID and is called only once checks 1 and 2 pass.
 */
export async function assertRehearsalTarget(
  url: string | undefined,
  confirmedName: string | undefined,
  hasMarker: () => Promise<boolean>
): Promise<RehearsalTarget> {
  const target = rehearsalTarget(url, confirmedName);
  if ('refused' in target) throw new Error(`rehearsal refused: ${target.refused}`);
  if (!(await hasMarker())) {
    throw new Error(
      `rehearsal refused: ${target.host}/${target.database} has no user ${REHEARSAL_MARKER_USER_ID} ` +
        '(the rehearsal creates it on its copy before this step)'
    );
  }
  return target;
}
