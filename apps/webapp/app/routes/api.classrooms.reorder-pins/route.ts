/**
 * Reorder pinned classrooms for the current user.
 *
 * POST /api/classrooms/reorder-pins
 * Body: { items: Array<{ classroom_id: string; role: string }> }
 *
 * The order in the array is the new per-user `pin_order` (1..N), applied to
 * each matching `ClassroomMembership` row owned by the user. Any signed-in
 * user may reorder their own pins; the endpoint only updates memberships the
 * user already owns, so non-owned classrooms are silently ignored.
 *
 * Returns `{ ok: true }`.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Role } from '@prisma/client';
import type { Route } from './+types/route';

interface ReorderItem {
  classroom_id: string;
  role: string;
}

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const raw = (body as { items?: unknown }).items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return new Response('Missing items', { status: 400 });
  }
  const items: ReorderItem[] = raw
    .filter((v): v is ReorderItem => {
      return (
        !!v &&
        typeof v === 'object' &&
        typeof (v as ReorderItem).classroom_id === 'string' &&
        typeof (v as ReorderItem).role === 'string'
      );
    })
    .map(v => ({ classroom_id: v.classroom_id, role: v.role }));

  if (items.length === 0) {
    return new Response('Missing items', { status: 400 });
  }

  const prisma = getPrisma();

  await prisma.$transaction(
    items.map((item, idx) =>
      prisma.classroomMembership.updateMany({
        where: { user_id: userId, classroom_id: item.classroom_id, role: item.role as Role },
        data: { pin_order: idx + 1 },
      })
    )
  );

  return Response.json({ ok: true });
};
