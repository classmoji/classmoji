import { Link, useLoaderData } from 'react-router';
import { IconAlertTriangle } from '@tabler/icons-react';
import { loadClassroom } from './route.server';
import type { ClassroomMember } from './route.server';

export const loader = loadClassroom;

export const meta = ({ data }: { data?: { classroom?: { name: string } } }) => [
  { title: data?.classroom ? `${data.classroom.name} · Classmoji Admin` : 'Classroom · Admin' },
];

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <div className="rounded-lg border border-line px-3 py-2">
    <div className="text-[11px] uppercase tracking-wider text-ink-4">{label}</div>
    <div className="text-ink-0 font-semibold tabular-nums">{value}</div>
  </div>
);

const Field = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex gap-3 py-1.5 border-b border-line last:border-0">
    <dt className="text-ink-3 w-40 shrink-0">{label}</dt>
    <dd className="text-ink-1 min-w-0 break-words">{value}</dd>
  </div>
);

const People = ({ title, members }: { title: string; members: ClassroomMember[] }) => (
  <div>
    <h3 className="text-[11px] uppercase tracking-wider text-ink-4 mb-2">
      {title} <span className="text-ink-3">({members.length})</span>
    </h3>
    {members.length === 0 ? (
      <p className="text-sm text-ink-4">None</p>
    ) : (
      <ul className="space-y-1.5">
        {members.map(m => (
          <li key={m.userId} className="flex items-center gap-2 min-w-0">
            {m.image ? (
              <img src={m.image} alt="" className="w-6 h-6 rounded-full shrink-0" />
            ) : (
              <span className="w-6 h-6 rounded-full shrink-0 bg-accent-soft text-accent-ink grid place-items-center text-[10px] font-semibold">
                {(m.name ?? m.login ?? '?').trim().charAt(0).toUpperCase()}
              </span>
            )}
            <span className="text-sm text-ink-1 truncate">{m.name ?? m.login ?? m.userId}</span>
            {m.login ? <span className="text-xs text-ink-4 truncate">@{m.login}</span> : null}
          </li>
        ))}
      </ul>
    )}
  </div>
);

const ClassroomDetail = () => {
  const { classroom, org, owners, teachers, assistants, students, counts } =
    useLoaderData<typeof loader>();

  return (
    <>
      <div className="mt-2 mb-4">
        <Link to="/classrooms" className="text-xs text-ink-3 hover:text-ink-1">
          ← Classrooms
        </Link>
        <div className="flex items-center gap-2 mt-1">
          <h1 className="text-lg font-semibold text-ink-1">{classroom.name}</h1>
          {classroom.isArchived ? <span className="chip chip-ghost">archived</span> : null}
          {classroom.status === 'LOCKED' ? <span className="chip chip-locked">locked</span> : null}
          {classroom.status === 'UNPUBLISHED' ? (
            <span className="chip chip-upcoming">unpublished</span>
          ) : null}
          {classroom.isExample ? <span className="chip chip-ghost">example</span> : null}
        </div>
        <p className="text-xs text-ink-3">{classroom.slug}</p>
      </div>

      {!org.hasInstallation ? (
        <div className="mb-4 rounded-lg bg-amber-bg border border-amber-bord text-amber-ink px-4 py-2.5 text-sm flex items-start gap-2">
          <IconAlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            <strong>{org.login}</strong> has no GitHub App installation id. Repository operations
            for this classroom will fail.
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-ink-0 mb-3">Details</h2>
            <dl className="text-sm">
              <Field label="Organization" value={org.login} />
              <Field label="Provider" value={org.provider} />
              <Field label="Content repo" value={classroom.contentRepo} />
              <Field
                label="Status"
                value={`${classroom.status}${classroom.isArchived ? ' · archived' : ''}`}
              />
              {classroom.githubClassroomId ? (
                <Field label="GitHub Classroom id" value={classroom.githubClassroomId} />
              ) : null}
              <Field
                label="Created"
                value={new Date(classroom.createdAt).toLocaleDateString(undefined, {
                  dateStyle: 'medium',
                })}
              />
            </dl>
          </div>

          <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-ink-0 mb-3">Content</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Students" value={students.length} />
              <Stat label="Repositories" value={counts.repositories} />
              <Stat label="Quizzes" value={counts.quizzes} />
              <Stat label="Modules" value={counts.modules} />
              <Stat label="Pages" value={counts.pages} />
              <Stat label="Slides" value={counts.slides} />
              <Stat label="Teams" value={counts.teams} />
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 space-y-5 self-start">
          <h2 className="text-sm font-semibold text-ink-0">Teaching team</h2>
          <People title="Owners" members={owners} />
          <People title="Teachers" members={teachers} />
          <People title="Assistants" members={assistants} />
        </div>
      </div>
    </>
  );
};

export default ClassroomDetail;
