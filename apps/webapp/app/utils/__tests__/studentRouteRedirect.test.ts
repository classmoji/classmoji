/**
 * Staff who open a /student/:class/... URL are redirected to their own section
 * (#403). These tests pin the decision (who is redirected, and where), the
 * server lookup that feeds it (who is NOT redirected — non-members, other
 * classrooms, students, signed-out visitors keep the original refusal), the
 * student layout loader that applies it, and that the twin map stays in step
 * with the route modules on disk.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthSessionMock = vi.fn();
const resolveHighestMembershipMock = vi.fn();
const findBySlugMock = vi.fn();
const getBalanceMock = vi.fn();
const requireStudentAccessMock = vi.fn();

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
  resolveHighestMembership: (...a: unknown[]) => resolveHighestMembershipMock(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findBySlug: (...a: unknown[]) => findBySlugMock(...a) },
    token: { getBalance: (...a: unknown[]) => getBalanceMock(...a) },
  },
}));

vi.mock('~/utils/helpers', () => ({
  requireStudentAccess: (...a: unknown[]) => requireStudentAccessMock(...a),
}));

vi.mock('~/store', () => ({ default: () => ({ setTokenBalance: () => {} }) }));

const { STAFF_TWINS, STAFF_HOME, staffRedirectPath, staffRoleForStudentRoute } =
  await import('../studentRouteRedirect.ts');
const { staffRedirectFromStudentRoute } = await import('../studentRouteRedirect.server.ts');
const { loader: studentLayoutLoader } = await import('../../routes/student.$class/route.tsx');

const forbidden = () => new Response('Required role: STUDENT', { status: 403 });

describe('staffRoleForStudentRoute', () => {
  it.each([
    [['OWNER'], 'OWNER'],
    [['TEACHER'], 'TEACHER'],
    [['ASSISTANT'], 'ASSISTANT'],
    [['ASSISTANT', 'TEACHER'], 'TEACHER'],
    [['TEACHER', 'OWNER', 'ASSISTANT'], 'OWNER'],
  ])('staff %j → %s', (roles, expected) => {
    expect(staffRoleForStudentRoute(roles)).toBe(expected);
  });

  it('never redirects anyone holding STUDENT, whatever else they hold', () => {
    expect(staffRoleForStudentRoute(['STUDENT'])).toBeNull();
    expect(staffRoleForStudentRoute(['OWNER', 'STUDENT'])).toBeNull();
    expect(staffRoleForStudentRoute(['ASSISTANT', 'STUDENT'])).toBeNull();
  });

  it('never redirects a non-member', () => {
    expect(staffRoleForStudentRoute([])).toBeNull();
  });
});

describe('staffRedirectPath', () => {
  const to = (role: 'OWNER' | 'TEACHER' | 'ASSISTANT', pathname: string, search = '') =>
    staffRedirectPath({ role, classSlug: 'cs52', pathname, search });

  it('sends each role to the same screen in its own section', () => {
    expect(to('OWNER', '/student/cs52/calendar')).toBe('/admin/cs52/calendar');
    expect(to('TEACHER', '/student/cs52/calendar')).toBe('/teacher/cs52/calendar');
    expect(to('ASSISTANT', '/student/cs52/modules')).toBe('/assistant/cs52/modules');
  });

  it('falls back to the section dashboard when the role has no twin', () => {
    expect(to('OWNER', '/student/cs52/tokens')).toBe('/admin/cs52/tokens');
    expect(to('TEACHER', '/student/cs52/tokens')).toBe('/teacher/cs52/dashboard');
    expect(to('ASSISTANT', '/student/cs52/assignments')).toBe('/assistant/cs52/dashboard');
    expect(to('OWNER', '/student/cs52/settings')).toBe('/admin/cs52/dashboard');
  });

  it('sends the classroom index, unknown and dynamic subpaths to the dashboard', () => {
    expect(to('OWNER', '/student/cs52')).toBe('/admin/cs52/dashboard');
    expect(to('OWNER', '/student/cs52/')).toBe('/admin/cs52/dashboard');
    expect(to('TEACHER', '/student/cs52/no-such-screen')).toBe('/teacher/cs52/dashboard');
    expect(to('OWNER', '/student/cs52/pages/abc123')).toBe('/admin/cs52/dashboard');
    expect(to('TEACHER', '/student/cs52/repos/hw1/team')).toBe('/teacher/cs52/dashboard');
    expect(to('OWNER', '/student/cs52/quizzes/q1/attempt/a1')).toBe('/admin/cs52/dashboard');
    expect(to('ASSISTANT', '/student/cs52/regrade-requests/new')).toBe('/assistant/cs52/dashboard');
  });

  it('does not treat inherited object keys as screens', () => {
    expect(to('OWNER', '/student/cs52/constructor')).toBe('/admin/cs52/dashboard');
    expect(to('OWNER', '/student/cs52/__proto__')).toBe('/admin/cs52/dashboard');
  });

  it('matches case-insensitively, as the router does', () => {
    expect(to('OWNER', '/Student/cs52/Calendar')).toBe('/admin/cs52/calendar');
  });

  it('keeps the query string on a twin, drops it on the dashboard fallback', () => {
    expect(to('OWNER', '/student/cs52/calendar', '?view=week')).toBe(
      '/admin/cs52/calendar?view=week'
    );
    expect(to('TEACHER', '/student/cs52/tokens', '?x=1')).toBe('/teacher/cs52/dashboard');
    expect(to('OWNER', '/student/cs52/calendar', '?')).toBe('/admin/cs52/calendar');
  });

  it('never copies the request path into the target, so it cannot leave the section', () => {
    for (const pathname of [
      '/student/cs52//evil.example.com',
      '/student/cs52/../../admin/other/settings',
      '/student/cs52/%2F%2Fevil.example.com',
      '//evil.example.com/student/cs52/calendar',
    ]) {
      const target = to('TEACHER', pathname, '?next=//evil.example.com');
      expect(target.startsWith('/teacher/cs52/')).toBe(true);
      expect(new URL(target, 'https://app.classmoji.io').origin).toBe('https://app.classmoji.io');
    }
  });

  it('encodes the classroom slug as a single segment', () => {
    expect(
      staffRedirectPath({ role: 'OWNER', classSlug: 'a/b', pathname: '/student/a%2Fb/calendar' })
    ).toBe('/admin/a%2Fb/calendar');
  });
});

describe('STAFF_TWINS stays in step with the route modules', () => {
  const routesDir = fileURLToPath(new URL('../../routes', import.meta.url));
  const routeFiles = readdirSync(routesDir);
  const sectionFilePrefix = {
    OWNER: 'admin.$class.',
    TEACHER: 'teacher.$class_.',
    ASSISTANT: 'assistant.$class_.',
  } as const;

  it('every twin is a real route in that section', () => {
    for (const [studentPath, twins] of Object.entries(STAFF_TWINS)) {
      for (const [role, target] of Object.entries(twins)) {
        const file = sectionFilePrefix[role as keyof typeof sectionFilePrefix] + target;
        expect(routeFiles, `${studentPath} → ${role} ${target}`).toContain(file);
      }
    }
    for (const prefix of Object.values(sectionFilePrefix)) {
      expect(routeFiles).toContain(prefix + STAFF_HOME);
    }
  });

  it('every static student screen is listed (with {} when it has no twin)', () => {
    const studentScreens = routeFiles
      .filter(f => f.startsWith('student.$class.') && f !== 'student.$class._index')
      .map(f => f.slice('student.$class.'.length))
      .filter(sub => !sub.includes('$') && !sub.includes('_'))
      .map(sub => sub.replace(/\./g, '/'))
      // regrade-requests/new is a student form; it has no staff twin by design.
      .filter(sub => sub !== 'regrade-requests/new');
    expect(studentScreens.length).toBeGreaterThan(5);
    for (const sub of studentScreens) {
      expect(Object.keys(STAFF_TWINS), sub).toContain(sub);
    }
  });
});

describe('staffRedirectFromStudentRoute', () => {
  const request = (path = '/student/cs52/calendar?view=week') =>
    new Request(`https://app.classmoji.io${path}`);

  const memberships = (roles: string[]) => {
    resolveHighestMembershipMock.mockImplementation(
      async (_classroomId: string, _userId: string, wanted: string[]) => {
        const order = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];
        const role = order.find(r => wanted.includes(r) && roles.includes(r));
        return role ? { role } : null;
      }
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getAuthSessionMock.mockResolvedValue({ userId: 'u1' });
    findBySlugMock.mockResolvedValue({ id: 'c1', slug: 'cs52' });
  });

  it('redirects an owner to the same screen under /admin', async () => {
    memberships(['OWNER']);
    const res = await staffRedirectFromStudentRoute(request(), 'cs52', forbidden());
    expect(res?.status).toBe(302);
    expect(res?.headers.get('Location')).toBe('/admin/cs52/calendar?view=week');
    expect(resolveHighestMembershipMock).toHaveBeenCalledWith('c1', 'u1', [
      'OWNER',
      'TEACHER',
      'ASSISTANT',
    ]);
  });

  it('uses the highest staff role of a multi-role member', async () => {
    memberships(['ASSISTANT', 'TEACHER']);
    const res = await staffRedirectFromStudentRoute(request(), 'cs52', forbidden());
    expect(res?.headers.get('Location')).toBe('/teacher/cs52/calendar?view=week');
  });

  it('sends an assistant with no twin to their dashboard', async () => {
    memberships(['ASSISTANT']);
    const res = await staffRedirectFromStudentRoute(
      request('/student/cs52/tokens'),
      'cs52',
      forbidden()
    );
    expect(res?.headers.get('Location')).toBe('/assistant/cs52/dashboard');
  });

  it('does not redirect a non-member (includes members of other classrooms)', async () => {
    memberships([]);
    expect(await staffRedirectFromStudentRoute(request(), 'cs52', forbidden())).toBeNull();
  });

  it('does not redirect someone who also holds STUDENT here', async () => {
    memberships(['OWNER', 'STUDENT']);
    expect(await staffRedirectFromStudentRoute(request(), 'cs52', forbidden())).toBeNull();
  });

  it('does not redirect a signed-out visitor, or for anything but a 403', async () => {
    memberships(['OWNER']);
    getAuthSessionMock.mockResolvedValue(null);
    expect(await staffRedirectFromStudentRoute(request(), 'cs52', forbidden())).toBeNull();

    getAuthSessionMock.mockResolvedValue({ userId: 'u1' });
    for (const denial of [
      new Response('Unauthorized', { status: 401 }),
      new Response('Classroom not found', { status: 404 }),
      new Error('boom'),
    ]) {
      expect(await staffRedirectFromStudentRoute(request(), 'cs52', denial)).toBeNull();
    }
    expect(resolveHighestMembershipMock).not.toHaveBeenCalled();
  });

  it('does not redirect when the classroom does not exist', async () => {
    memberships(['OWNER']);
    findBySlugMock.mockResolvedValue(null);
    expect(await staffRedirectFromStudentRoute(request(), 'cs52', forbidden())).toBeNull();
  });
});

describe('student layout loader', () => {
  const args = (path: string) =>
    ({
      request: new Request(`https://app.classmoji.io${path}`),
      params: { class: 'cs52' },
    }) as unknown as Parameters<typeof studentLayoutLoader>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    getAuthSessionMock.mockResolvedValue({ userId: 'u1' });
    findBySlugMock.mockResolvedValue({ id: 'c1', slug: 'cs52' });
  });

  it('lets a student through', async () => {
    requireStudentAccessMock.mockResolvedValue({ userId: 'u1', classroom: { id: 'c1' } });
    getBalanceMock.mockResolvedValue(7);
    await expect(studentLayoutLoader(args('/student/cs52/calendar'))).resolves.toEqual({
      tokenBalance: 7,
      classroomId: 'c1',
      userId: 'u1',
    });
    expect(getAuthSessionMock).not.toHaveBeenCalled();
  });

  it('redirects a teacher to /teacher after the student gate refuses them', async () => {
    const denial = forbidden();
    requireStudentAccessMock.mockRejectedValue(denial);
    resolveHighestMembershipMock.mockImplementation(async (_c, _u, wanted: string[]) =>
      wanted.includes('TEACHER') ? { role: 'TEACHER' } : null
    );
    const thrown = await studentLayoutLoader(args('/student/cs52/slides')).catch(e => e);
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get('Location')).toBe('/teacher/cs52/slides');
    expect(requireStudentAccessMock).toHaveBeenCalledTimes(1);
    expect(getBalanceMock).not.toHaveBeenCalled();
  });

  it('rethrows the original refusal for a non-member', async () => {
    const denial = new Response('Not a member of this classroom', { status: 403 });
    requireStudentAccessMock.mockRejectedValue(denial);
    resolveHighestMembershipMock.mockResolvedValue(null);
    await expect(studentLayoutLoader(args('/student/cs52/calendar'))).rejects.toBe(denial);
    expect(getBalanceMock).not.toHaveBeenCalled();
  });

  it('rethrows a 401 untouched', async () => {
    const denial = new Response('Unauthorized', { status: 401 });
    requireStudentAccessMock.mockRejectedValue(denial);
    await expect(studentLayoutLoader(args('/student/cs52/calendar'))).rejects.toBe(denial);
  });
});
