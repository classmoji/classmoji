import { createHmac, timingSafeEqual } from 'node:crypto';

// Server-only. The generated workflow reports autograding results back to
// Classmoji (by triggering the ingest task via Trigger.dev's REST API); the
// token it sends proves the report is for THAT repository. It does NOT make
// the reported results tamper-proof (a student can edit the workflow in their
// own repo), which is why autograding results stay advisory (no grade
// mapping).
//
// The token is per repository (classroom slug + the repo's full path), and
// lives in that repo's workflow file, which its student can read. So a student
// can at most post results for their own repo, never a classmate's. The older
// per-classroom token let anyone holding it report for every repo in the
// class; it is still accepted from Github repos provisioned before the change
// until their workflow is re-provisioned (see verifyAutogradeCallbackToken).

function secret(): string {
  const value = process.env.AUTOGRADE_CALLBACK_SECRET;
  if (!value) throw new Error('AUTOGRADE_CALLBACK_SECRET is not set');
  return value;
}

function safeEqual(expected: string, token: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Token for one repository: `repoPath` is its full path (`owner/name`, or a Gitlab `group/…/name`). */
export function signAutogradeRepoToken(classroomSlug: string, repoPath: string): string {
  return createHmac('sha256', secret())
    .update(`repo:${classroomSlug}:${repoPath.toLowerCase()}`)
    .digest('hex');
}

/** The legacy per-classroom token. Only for verifying old Github workflows. */
export function signAutogradeCallbackToken(classroomSlug: string): string {
  return createHmac('sha256', secret()).update(classroomSlug).digest('hex');
}

/**
 * Whether `token` may report results for `repoPath` in this classroom: the
 * repo's own token, or (with `allowLegacyClassroomToken`, Github only) the old
 * per-classroom token.
 */
export function verifyAutogradeCallbackToken(
  classroomSlug: string,
  token: string | null | undefined,
  {
    repoPath,
    allowLegacyClassroomToken = false,
  }: { repoPath?: string | null; allowLegacyClassroomToken?: boolean } = {}
): boolean {
  if (!process.env.AUTOGRADE_CALLBACK_SECRET || !token) return false;
  try {
    if (repoPath && safeEqual(signAutogradeRepoToken(classroomSlug, repoPath), token)) return true;
    if (allowLegacyClassroomToken && safeEqual(signAutogradeCallbackToken(classroomSlug), token)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
