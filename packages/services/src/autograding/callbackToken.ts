import { createHmac, timingSafeEqual } from 'node:crypto';

// Server-only. The generated workflow reports autograding results back to
// Classmoji (by triggering the ingest task via Trigger.dev's REST API); this
// signs/verifies a per-classroom token so the ingest task can trust the
// *origin* (the run is for this classroom). It does NOT make the reported
// results tamper-proof — students can edit the workflow — which is why
// autograding results stay advisory (no grade mapping).

export function signAutogradeCallbackToken(classroomSlug: string): string {
  const secret = process.env.AUTOGRADE_CALLBACK_SECRET;
  if (!secret) throw new Error('AUTOGRADE_CALLBACK_SECRET is not set');
  return createHmac('sha256', secret).update(classroomSlug).digest('hex');
}

export function verifyAutogradeCallbackToken(
  classroomSlug: string,
  token: string | null | undefined
): boolean {
  if (!process.env.AUTOGRADE_CALLBACK_SECRET || !token) return false;
  let expected: string;
  try {
    expected = signAutogradeCallbackToken(classroomSlug);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
