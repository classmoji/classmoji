import { getAuthSession, PLATFORM_ADMIN_USER_IDS } from '@classmoji/auth/server';

/** Who is looking at the feedback board, if anyone. Never redirects. */
export async function feedbackViewer(request: Request) {
  const authData = await getAuthSession(request).catch(() => null);
  const viewerId = authData?.userId ?? null;
  return { viewerId, isAdmin: viewerId ? PLATFORM_ADMIN_USER_IDS.includes(viewerId) : false };
}
