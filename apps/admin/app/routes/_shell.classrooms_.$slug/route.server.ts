import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { GIT_IDENTITY } from '@classmoji/database';
import { gitUsername } from '@classmoji/utils';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { auditView, platformAudit } from '~/utils/audit.server';
import { healthOf, loadPlans, loadSignals } from '~/utils/classroomHealth.server';
import { describeAdminAction } from '~/utils/metrics.server';
import { safeReturn } from '~/utils/url';

const TABS = ['people', 'coursework', 'activity'] as const;
export type ClassroomTab = (typeof TABS)[number];
const ROLE_ORDER = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

export async function loadClassroom({ request, params }: LoaderFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const slug = params.slug as string;
  const tabParam = url.searchParams.get('tab') ?? '';
  const tab: ClassroomTab = (TABS as readonly string[]).includes(tabParam)
    ? (tabParam as ClassroomTab)
    : 'people';

  const classroom = await prisma.classroom.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      is_archived: true,
      is_example: true,
      content_repo: true,
      github_classroom_id: true,
      created_at: true,
      collab_enabled: true,
      content_delivery_enabled: true,
      content_assets_synced_at: true,
      content_assets_synced_commit: true,
      creator: { select: { id: true, name: true } },
      import_job: { select: { status: true, phase: true, updated_at: true } },
      git_organization: {
        select: {
          login: true,
          provider: true,
          base_url: true,
          github_installation_id: true,
          gitlab_connection_id: true,
        },
      },
    },
  });
  if (!classroom) throw new Response('Classroom not found', { status: 404 });

  // The roster and activity are other people's data: audited.
  await auditView({
    actorId: admin.id,
    action: 'classroom.view',
    targetType: 'classroom',
    targetId: classroom.id,
    classroomId: classroom.id,
    data: { classroomName: classroom.name },
  });

  const [signalsMap, plans, docs, ownerRow] = await Promise.all([
    loadSignals([classroom]),
    loadPlans([classroom.id]),
    prisma.collabDoc.aggregate({
      where: { classroom_id: classroom.id },
      _count: { _all: true },
      _max: { last_checkpoint_at: true },
    }),
    prisma.classroomMembership.findFirst({
      where: { classroom_id: classroom.id, role: 'OWNER', has_accepted_invite: true },
      orderBy: { created_at: 'asc' },
      select: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);
  const signals = signalsMap.get(classroom.id)!;
  const checkpointError = signals.checkpointErrors
    ? await prisma.collabDoc.findFirst({
        where: { classroom_id: classroom.id, last_checkpoint_error: { not: null } },
        orderBy: { last_checkpoint_at: 'desc' },
        select: { last_checkpoint_error: true, last_checkpoint_at: true },
      })
    : null;

  const org = classroom.git_organization;
  const githubBase = org.provider === 'GITHUB' ? `https://github.com/${org.login}` : null;

  const base = {
    tab,
    back: safeReturn(url.searchParams.get('from'), '/classrooms'),
    classroom: {
      id: classroom.id,
      slug: classroom.slug,
      name: classroom.name,
      status: classroom.status,
      isArchived: classroom.is_archived,
      isExample: classroom.is_example,
      contentRepo: classroom.content_repo,
      githubClassroomId: classroom.github_classroom_id,
      createdAt: classroom.created_at.toISOString(),
      creator: classroom.creator,
      plan: plans.get(classroom.id) ?? 'Free',
      owner: ownerRow
        ? { id: ownerRow.user.id, name: ownerRow.user.name ?? ownerRow.user.email ?? 'Owner' }
        : null,
    },
    org: {
      login: org.login,
      provider: org.provider,
      url: githubBase,
      contentRepoUrl: githubBase ? `${githubBase}/${classroom.content_repo}` : null,
    },
    health: {
      ...healthOf(signals),
      hasInstallation: signals.hasInstallation,
      accepted: signals.accepted,
      pending: signals.pending,
      staff: signals.staff,
      lastActivity: signals.lastActivity?.toISOString() ?? null,
      importJob: classroom.import_job
        ? {
            status: classroom.import_job.status,
            phase: classroom.import_job.phase,
            at: classroom.import_job.updated_at.toISOString(),
          }
        : null,
      contentSyncedAt: classroom.content_assets_synced_at?.toISOString() ?? null,
      contentSyncedCommit: classroom.content_assets_synced_commit,
      collabEnabled: classroom.collab_enabled,
      collabDocs: docs._count._all,
      lastCheckpointAt: docs._max.last_checkpoint_at?.toISOString() ?? null,
      checkpointErrors: signals.checkpointErrors,
      checkpointError: checkpointError?.last_checkpoint_error ?? null,
      delivery: classroom.content_delivery_enabled,
    },
  };

  if (tab === 'people') {
    const group = url.searchParams.get('people') ?? '';
    const pq = (url.searchParams.get('pq') ?? '').trim().toLowerCase();
    const memberships = await prisma.classroomMembership.findMany({
      where: { classroom_id: classroom.id },
      select: {
        role: true,
        has_accepted_invite: true,
        created_at: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            last_seen_at: true,
            ...GIT_IDENTITY,
          },
        },
      },
    });
    // One row per person, roles together, staff first.
    const people = new Map<
      string,
      {
        id: string;
        name: string;
        login: string | null;
        email: string | null;
        image: string | null;
        roles: string[];
        accepted: boolean;
        lastSeenAt: string | null;
        joinedAt: string;
      }
    >();
    for (const m of memberships) {
      const login = gitUsername(m.user, org.provider);
      const row = people.get(m.user.id) ?? {
        id: m.user.id,
        name: m.user.name ?? login ?? m.user.email ?? m.user.id,
        login,
        email: m.user.email,
        image: m.user.image,
        roles: [],
        accepted: true,
        lastSeenAt: m.user.last_seen_at?.toISOString() ?? null,
        joinedAt: m.created_at.toISOString(),
      };
      row.roles.push(m.role);
      row.accepted = row.accepted && m.has_accepted_invite;
      people.set(m.user.id, row);
    }
    const all = [...people.values()].map(p => ({
      ...p,
      roles: p.roles.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)),
    }));
    const isStaff = (p: (typeof all)[number]) => p.roles.some(r => r !== 'STUDENT');
    const counts = {
      all: all.length,
      staff: all.filter(isStaff).length,
      students: all.filter(p => !isStaff(p) && p.accepted).length,
      pending: all.filter(p => !p.accepted).length,
    };
    const filtered = all
      .filter(p =>
        group === 'staff'
          ? isStaff(p)
          : group === 'students'
            ? !isStaff(p) && p.accepted
            : group === 'pending'
              ? !p.accepted
              : true
      )
      .filter(p => !pq || [p.name, p.login, p.email].some(v => v?.toLowerCase().includes(pq)))
      .sort(
        (a, b) =>
          ROLE_ORDER.indexOf(a.roles[0]) - ROLE_ORDER.indexOf(b.roles[0]) ||
          a.name.localeCompare(b.name)
      );
    return { ...base, people: { group, query: pq, counts, rows: filtered } };
  }

  if (tab === 'coursework') {
    const modules = await prisma.module.findMany({
      where: { classroom_id: classroom.id },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        title: true,
        is_published: true,
        assignments: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            type: true,
            is_published: true,
            student_deadline: true,
            _count: {
              select: { git_repo_assignments: { where: { closed_at: { not: null } } } },
            },
          },
        },
      },
    });
    return {
      ...base,
      coursework: modules.map(m => ({
        id: m.id,
        title: m.title,
        published: m.is_published,
        assignments: m.assignments.map(a => ({
          id: a.id,
          title: a.title,
          type: a.type,
          published: a.is_published,
          deadline: a.student_deadline?.toISOString() ?? null,
          submissions: a._count.git_repo_assignments,
        })),
      })),
    };
  }

  const [audit, adminRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: { classroom_id: classroom.id, action: { not: 'VIEW' } },
      orderBy: { timestamp: 'desc' },
      take: 40,
      select: {
        action: true,
        resource_type: true,
        timestamp: true,
        data: true,
        user: { select: { id: true, name: true } },
      },
    }),
    prisma.platformAuditLog.findMany({
      where: { classroom_id: classroom.id, action: { not: 'classroom.view' } },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: {
        action: true,
        data: true,
        created_at: true,
        actor: { select: { id: true, name: true } },
      },
    }),
  ]);
  const activity = [
    ...audit.map(r => ({
      at: r.timestamp.toISOString(),
      admin: false,
      actor: r.user,
      text: `${r.action.toLowerCase().replace('_', ' ')} ${r.resource_type.replace(/_/g, ' ').toLowerCase()}`,
      tool:
        r.data && typeof r.data === 'object' && 'tool' in r.data
          ? String((r.data as { tool?: unknown }).tool)
          : null,
    })),
    ...adminRows.map(r => ({
      at: r.created_at.toISOString(),
      admin: true,
      actor: r.actor,
      text: describeAdminAction(r.action, r.data),
      tool: null,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { ...base, activity };
}

/**
 * The classroom's content-delivery switch. Re-runs the admin gate (a layout
 * loader runs after an action, never before) and writes an audit row.
 */
export async function classroomAction({ request, params }: ActionFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);
  const form = await request.formData();
  if (form.get('intent') !== 'delivery') return { error: 'Unknown action.' };
  const enabled = form.get('enabled') === 'true';
  const classroom = await prisma.classroom.findUnique({
    where: { slug: params.slug as string },
    select: { id: true, name: true },
  });
  if (!classroom) return { error: 'That classroom no longer exists.' };
  await prisma.classroom.update({
    where: { id: classroom.id },
    data: { content_delivery_enabled: enabled },
  });
  await platformAudit({
    actorId: admin.id,
    action: 'delivery.toggle',
    targetType: 'classroom',
    targetId: classroom.id,
    classroomId: classroom.id,
    data: { enabled, classroomName: classroom.name },
  });
  return { ok: true };
}
