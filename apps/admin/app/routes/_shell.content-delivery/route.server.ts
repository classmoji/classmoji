import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

/**
 * The rollout switch for the signed content delivery layer.
 *
 * Two things have to be true before a classroom's assets are served through the
 * Worker: the deployment must carry the signing secret and the delivery origin
 * (an env question, the same for every classroom on this app), and the
 * classroom row must be opted in. This screen owns the second one.
 *
 * The env half is reported alongside, because a flag flipped on in a deployment
 * that cannot sign does nothing at all — and that is exactly the confusing
 * state a rollout screen should name rather than hide.
 */

export interface DeliveryRow {
  id: string;
  slug: string;
  name: string;
  orgLogin: string;
  contentRepo: string;
  enabled: boolean;
}

/** Example classrooms are per-user onboarding sandboxes — noise on this list. */
const NOT_EXAMPLE = { is_example: false } as const;

/**
 * The filter the list is showing, from the request.
 *
 * Shared by the loader and the action, and that sharing is the point: the bulk
 * buttons say "in this list", and a list narrowed by a search while the update
 * quietly hit every classroom on the platform is a confirmation dialog that
 * lies. One function, one answer, both directions.
 */
function searchFilter(request: Request) {
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  const search = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { slug: { contains: q, mode: 'insensitive' as const } },
          { git_organization: { login: { contains: q, mode: 'insensitive' as const } } },
        ],
      }
    : {};
  return { q, where: { ...search, ...NOT_EXAMPLE } };
}

export async function loadContentDelivery({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);

  const { q, where } = searchFilter(request);

  const [classrooms, enabledCount, totalCount] = await Promise.all([
    prisma.classroom.findMany({
      where,
      orderBy: [{ content_delivery_enabled: 'desc' }, { created_at: 'desc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        content_repo: true,
        content_delivery_enabled: true,
        git_organization: { select: { login: true } },
      },
    }),
    // Both counts are scoped to the SAME filter the rows are, so "12 of 30 on"
    // describes the list in front of you rather than the whole platform.
    prisma.classroom.count({ where: { ...where, content_delivery_enabled: true } }),
    prisma.classroom.count({ where }),
  ]);

  const rows: DeliveryRow[] = classrooms.map(c => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    orgLogin: c.git_organization.login,
    contentRepo: c.content_repo,
    enabled: c.content_delivery_enabled,
  }));

  return {
    rows,
    query: q,
    enabledCount,
    totalCount,
    // Never the values themselves — only whether both are present. A signing
    // secret has no business travelling to a browser, admin session or not.
    envConfigured: Boolean(
      process.env.CONTENT_SIGNING_SECRET && process.env.CONTENT_DELIVERY_ORIGIN
    ),
  };
}

/**
 * Flip one classroom, or every classroom at once.
 *
 * `requirePlatformAdmin` is re-run here rather than inherited from the layout:
 * React Router matches only the action route for a submission and revalidates
 * loaders afterwards, so a layout loader's gate runs strictly AFTER the write.
 * The action's own check is the one that decides.
 */
export async function contentDeliveryAction({ request }: ActionFunctionArgs) {
  await requirePlatformAdmin(request);

  // Read the body BEFORE anything else touches the request: `searchFilter`
  // reads the URL, which survives, but the body can only be consumed once.
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  if (intent === 'toggle') {
    const classroomId = String(form.get('classroomId') ?? '');
    if (!classroomId) return { error: 'No classroom named.' };
    const enabled = form.get('enabled') === 'true';
    try {
      await prisma.classroom.update({
        where: { id: classroomId },
        data: { content_delivery_enabled: enabled },
      });
    } catch (error) {
      // P2025 — the row is gone. An admin list is a snapshot, and a classroom
      // deleted in another tab (or by its owner, mid-session) is the ordinary
      // way to get here. The row says so and the list revalidates; anything
      // else is a real fault and belongs in the logs.
      if (isRecordNotFound(error)) {
        return { error: 'That classroom no longer exists — the list is out of date.' };
      }
      console.error('[admin] content-delivery toggle failed:', error);
      return { error: 'Could not change that classroom. Try again.' };
    }
    return { ok: true, changed: 1 };
  }

  if (intent === 'enable-all' || intent === 'disable-all') {
    const enabled = intent === 'enable-all';
    // Scoped to the SAME filter the list is showing, because the dialog that
    // asked for this said "in this list". An admin who searched for one course
    // and clicked "Enable for all" must not switch on the whole platform.
    const { where } = searchFilter(request);
    try {
      const { count } = await prisma.classroom.updateMany({
        where: { ...where, content_delivery_enabled: !enabled },
        data: { content_delivery_enabled: enabled },
      });
      return { ok: true, changed: count };
    } catch (error) {
      console.error('[admin] content-delivery bulk update failed:', error);
      return { error: 'Could not apply that change. Try again.' };
    }
  }

  return { error: `Unknown intent: ${intent || '(none)'}` };
}

/** Prisma's "record not found" for an update/delete, without importing its client. */
function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2025'
  );
}
