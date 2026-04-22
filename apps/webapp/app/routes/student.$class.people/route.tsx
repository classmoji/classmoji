import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomMember } from '~/utils/routeAuth.server';
import { getInitials, hashHue } from '~/utils/hue';

interface PersonRow {
  userId: string;
  name: string | null;
  login: string | null;
  role: 'OWNER' | 'ASSISTANT' | 'STUDENT';
}

interface MembershipWithUser {
  role: string;
  user: {
    id: string;
    name: string | null;
    login: string | null;
  };
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomMember(request, classSlug!, {
    resourceType: 'PEOPLE',
    action: 'view_people',
  });

  const memberships = (await ClassmojiService.classroomMembership.findByClassroomId(
    classroom.id
  )) as unknown as MembershipWithUser[];

  const people: PersonRow[] = memberships
    .map(m => ({
      userId: m.user.id,
      name: m.user.name,
      login: m.user.login,
      role: m.role as PersonRow['role'],
    }))
    .filter(p => p.role === 'OWNER' || p.role === 'ASSISTANT' || p.role === 'STUDENT');

  const teachers = people.filter(p => p.role === 'OWNER' || p.role === 'ASSISTANT');
  const students = people.filter(p => p.role === 'STUDENT');

  return { teachers, students, classroomName: classroom.name ?? 'Classroom' };
};

const roleLabel = (role: PersonRow['role']): string =>
  role === 'OWNER' ? 'Instructor' : role === 'ASSISTANT' ? 'TA' : 'Student';

function Avatar({ name, login }: { name: string | null; login: string | null }) {
  const label = name ?? login ?? 'User';
  const initials = getInitials(label, login ?? label);
  const hue = hashHue(login ?? label);
  return (
    <span
      className="grid place-items-center rounded-full text-[11px] font-semibold text-slate-800"
      style={{
        width: 32,
        height: 32,
        background: `linear-gradient(135deg, oklch(82% 0.08 ${hue}), oklch(66% 0.15 ${hue}))`,
      }}
    >
      {initials}
    </span>
  );
}

function PersonRowView({ p }: { p: PersonRow }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
      <Avatar name={p.name} login={p.login} />
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium text-gray-900 dark:text-gray-100 truncate">
          {p.name ?? p.login ?? 'Unknown'}
        </div>
        <div className="font-mono text-[11px] text-gray-500 dark:text-gray-400 truncate">
          @{p.login ?? '—'}
        </div>
      </div>
      <span
        className={
          p.role === 'OWNER'
            ? 'text-[10.5px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
            : p.role === 'ASSISTANT'
              ? 'text-[10.5px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300'
              : 'text-[10.5px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
        }
      >
        {roleLabel(p.role)}
      </span>
    </div>
  );
}

const StudentPeople = ({ loaderData }: Route.ComponentProps) => {
  const { teachers, students } = loaderData;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          People
        </h1>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {teachers.length} teaching · {students.length} students
        </span>
      </div>
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500 dark:text-gray-400 mb-1">
          Teaching team
        </div>
        {teachers.length === 0 ? (
          <div className="py-6 text-sm text-gray-500 dark:text-gray-400">No instructors listed.</div>
        ) : (
          teachers.map(p => <PersonRowView key={`${p.userId}-${p.role}`} p={p} />)
        )}
      </section>
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500 dark:text-gray-400 mb-1">
          Classmates
        </div>
        {students.length === 0 ? (
          <div className="py-6 text-sm text-gray-500 dark:text-gray-400">No classmates yet.</div>
        ) : (
          students.map(p => <PersonRowView key={`${p.userId}-${p.role}`} p={p} />)
        )}
      </section>
    </div>
  );
};

export default StudentPeople;
