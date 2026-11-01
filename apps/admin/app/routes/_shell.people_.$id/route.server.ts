import type { LoaderFunctionArgs } from 'react-router';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { auditView } from '~/utils/audit.server';
import { describeAdminAction } from '~/utils/metrics.server';
import { distinctClassrooms, emailDomain, highestRole } from '~/utils/people';
import { safeReturn } from '~/utils/url';

/** A person's page: one screen instead of impersonating to find things out. */
const HISTORY = 25;

export async function loadPerson({ request, params }: LoaderFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);
  const id = params.id as string;
  const now = new Date();

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      created_at: true,
      first_sign_in_at: true,
      last_seen_at: true,
      banned: true,
      accounts: {
        select: {
          provider_id: true,
          username: true,
          email: true,
          gitlab_instance_id: true,
          created_at: true,
          access_token: true,
        },
      },
      classroom_memberships: {
        orderBy: { created_at: 'desc' },
        select: {
          role: true,
          has_accepted_invite: true,
          created_at: true,
          classroom_id: true,
          classroom: {
            select: {
              id: true,
              slug: true,
              name: true,
              status: true,
              is_archived: true,
              is_example: true,
            },
          },
        },
      },
      subscriptions: {
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { tier: true, ends_at: true },
      },
    },
  });
  if (!user) throw new Response('Person not found', { status: 404 });

  // A staff read of someone's data is audited (deduplicated per 10 minutes).
  await auditView({
    actorId: admin.id,
    action: 'user.view',
    targetType: 'user',
    targetId: user.id,
    data: { targetName: user.name ?? user.email ?? user.id },
  });

  const [sessions, invites, posts, votes, askMoji, activityDays, auditRows, adminRows] =
    await Promise.all([
      prisma.session.findMany({
        where: { user_id: user.id, expires_at: { gt: now } },
        select: { impersonatedBy: true },
      }),
      user.email
        ? prisma.classroomInvite.findMany({
            where: { school_email: { equals: user.email, mode: 'insensitive' } },
            select: { created_at: true, classroom: { select: { slug: true, name: true } } },
          })
        : Promise.resolve([]),
      prisma.feedbackPost.count({ where: { author_id: user.id } }),
      prisma.feedbackVote.count({ where: { user_id: user.id } }),
      prisma.aIConversation.count({ where: { user_id: user.id, type: 'SYLLABUS_BOT' } }),
      prisma.userActivityDay.count({
        where: { user_id: user.id, day: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      }),
      prisma.auditLog.findMany({
        where: { user_id: user.id, action: { in: ['CREATE', 'UPDATE', 'DELETE'] } },
        orderBy: { timestamp: 'desc' },
        take: HISTORY,
        select: {
          action: true,
          resource_type: true,
          timestamp: true,
          data: true,
          classroom: { select: { name: true, slug: true } },
        },
      }),
      prisma.platformAuditLog.findMany({
        where: { target_id: user.id, action: { not: 'user.view' } },
        orderBy: { created_at: 'desc' },
        take: HISTORY,
        select: {
          action: true,
          data: true,
          created_at: true,
          actor: { select: { id: true, name: true } },
        },
      }),
    ]);

  const real = user.classroom_memberships.filter(m => !m.classroom.is_example);
  // One row per classroom, its roles together.
  const byClass = new Map<
    string,
    {
      slug: string;
      name: string;
      status: string;
      archived: boolean;
      roles: string[];
      accepted: boolean;
      since: string;
    }
  >();
  for (const m of real) {
    const row = byClass.get(m.classroom_id) ?? {
      slug: m.classroom.slug,
      name: m.classroom.name,
      status: m.classroom.status,
      archived: m.classroom.is_archived,
      roles: [],
      accepted: true,
      since: m.created_at.toISOString(),
    };
    row.roles.push(m.role);
    row.accepted = row.accepted && m.has_accepted_invite;
    if (m.created_at.toISOString() < row.since) row.since = m.created_at.toISOString();
    byClass.set(m.classroom_id, row);
  }

  const history = [
    ...auditRows.map(r => ({
      at: r.timestamp.toISOString(),
      kind: 'classroom' as const,
      text: `${r.action === 'CREATE' ? 'Created' : r.action === 'DELETE' ? 'Deleted' : 'Changed'} ${r.resource_type.replace(/_/g, ' ').toLowerCase()}`,
      classroom: r.classroom ? { name: r.classroom.name, slug: r.classroom.slug } : null,
      tool:
        r.data && typeof r.data === 'object' && 'tool' in r.data
          ? String((r.data as { tool?: unknown }).tool)
          : null,
    })),
    ...adminRows.map(r => {
      const reason =
        r.data && typeof r.data === 'object' && 'reason' in r.data
          ? String((r.data as { reason?: unknown }).reason)
          : null;
      return {
        at: r.created_at.toISOString(),
        kind: 'admin' as const,
        text: `${r.actor?.name ?? 'An admin'} ${describeAdminAction(r.action, r.data)}${reason ? ` (reason: “${reason}”)` : ''}`,
        classroom: null,
        tool: null,
      };
    }),
    ...(user.first_sign_in_at
      ? [
          {
            at: user.first_sign_in_at.toISOString(),
            kind: 'signin' as const,
            text: 'First sign-in',
            classroom: null,
            tool: null,
          },
        ]
      : []),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, HISTORY);

  const sub = user.subscriptions[0];
  const isPro = sub?.tier === 'PRO' && (!sub.ends_at || sub.ends_at > now);
  const url = new URL(request.url);

  return {
    back: safeReturn(url.searchParams.get('from'), '/people'),
    person: {
      id: user.id,
      name: user.name ?? user.accounts.find(a => a.username)?.username ?? user.email ?? user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      domain: emailDomain(user.email),
      image: user.image,
      banned: user.banned,
      createdAt: user.created_at.toISOString(),
      firstSignInAt: user.first_sign_in_at?.toISOString() ?? null,
      lastSeenAt: user.last_seen_at?.toISOString() ?? null,
      role: highestRole(real),
      classes: distinctClassrooms(real),
      plan: isPro ? 'Pro' : 'Free',
    },
    accounts: user.accounts.map(a => ({
      provider: a.provider_id,
      username: a.username,
      email: a.email,
      host: a.gitlab_instance_id || null,
      // Whether it can sign in (a token or a password), never the secret itself.
      connected: Boolean(a.access_token) || a.provider_id === 'credential',
      since: a.created_at.toISOString(),
    })),
    classrooms: [...byClass.values()],
    sessions: {
      own: sessions.filter(s => !s.impersonatedBy).length,
      impersonated: sessions.filter(s => s.impersonatedBy).length,
    },
    invites: invites.map(i => ({
      classroom: i.classroom,
      createdAt: i.created_at.toISOString(),
    })),
    feedback: { posts, votes },
    askMojiConversations: askMoji,
    activeDays30: activityDays,
    history,
  };
}
