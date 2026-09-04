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

export async function loadContentDelivery({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();

  const search = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { slug: { contains: q, mode: 'insensitive' as const } },
          { git_organization: { login: { contains: q, mode: 'insensitive' as const } } },
        ],
      }
    : {};

  const [classrooms, enabledCount, totalCount] = await Promise.all([
    prisma.classroom.findMany({
      where: { ...search, ...NOT_EXAMPLE },
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
    prisma.classroom.count({ where: { ...NOT_EXAMPLE, content_delivery_enabled: true } }),
    prisma.classroom.count({ where: NOT_EXAMPLE }),
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

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  if (intent === 'toggle') {
    const classroomId = String(form.get('classroomId') ?? '');
    if (!classroomId) return { error: 'No classroom named.' };
    const enabled = form.get('enabled') === 'true';
    await prisma.classroom.update({
      where: { id: classroomId },
      data: { content_delivery_enabled: enabled },
    });
    return { ok: true, changed: 1 };
  }

  if (intent === 'enable-all' || intent === 'disable-all') {
    const enabled = intent === 'enable-all';
    // Scoped to the same set the list shows. Example classrooms are excluded so
    // "enable for all" means the classrooms an admin can actually see here.
    const { count } = await prisma.classroom.updateMany({
      where: { ...NOT_EXAMPLE, content_delivery_enabled: !enabled },
      data: { content_delivery_enabled: enabled },
    });
    return { ok: true, changed: count };
  }

  return { error: `Unknown intent: ${intent || '(none)'}` };
}
