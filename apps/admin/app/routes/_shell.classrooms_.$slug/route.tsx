import { Form, Link, useFetcher, useLoaderData, useSearchParams } from 'react-router';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  Avatar,
  Empty,
  FilterChips,
  PageHeader,
  Panel,
  RoleChip,
  StatusChips,
  TABLE_HEAD,
  withParams,
} from '~/components/ui';
import { ViewAsButton } from '~/components/ViewAsButton';
import { relativeTime } from '~/utils/time';
import { classroomAction, loadClassroom, type ClassroomTab } from './route.server';

export const loader = loadClassroom;
export const action = classroomAction;

export const meta = ({ data }: { data?: { classroom?: { name: string } } }) => [
  { title: data?.classroom ? `${data.classroom.name} · Classmoji Admin` : 'Classroom · Admin' },
];

type Data = Awaited<ReturnType<typeof loadClassroom>>;

const TAB_LABEL: Record<ClassroomTab, string> = {
  people: 'People',
  coursework: 'Coursework',
  activity: 'Activity',
};

const Tile = ({
  tone,
  title,
  children,
}: {
  tone: 'critical' | 'warning' | 'ok' | 'neutral';
  title: string;
  children: React.ReactNode;
}) => {
  const style =
    tone === 'critical'
      ? 'bg-rose-bg border-rose-bord [&_b]:text-rose-ink'
      : tone === 'warning'
        ? 'bg-amber-bg border-amber-bord [&_b]:text-amber-ink'
        : tone === 'ok'
          ? 'bg-mint-bg border-mint-bord [&_b]:text-mint-ink'
          : 'bg-nav-hover border-transparent [&_b]:text-ink-0';
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs text-ink-2 min-w-0 ${style}`}>
      <b className="block text-[13px] font-semibold">{title}</b>
      {children}
    </div>
  );
};

const DeliveryToggle = ({ enabled }: { enabled: boolean }) => {
  const fetcher = useFetcher<{ error?: string }>();
  const pending = fetcher.formData?.get('enabled');
  const on = pending === undefined ? enabled : pending === 'true';
  return (
    <fetcher.Form method="post" className="inline">
      <input type="hidden" name="intent" value="delivery" />
      <input type="hidden" name="enabled" value={on ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={fetcher.state !== 'idle'}
        className="underline underline-offset-2 hover:text-ink-0 disabled:opacity-50"
      >
        {on ? 'Turn off' : 'Turn on'}
      </button>
      {fetcher.data?.error ? (
        <span role="alert" className="block text-red-600 dark:text-red-400">
          {fetcher.data.error}
        </span>
      ) : null}
    </fetcher.Form>
  );
};

const HealthStrip = ({ data }: { data: Data }) => {
  const h = data.health;
  return (
    <Panel
      title="Health"
      description={h.reasons.length ? h.reasons.join(' · ') : 'No problems found'}
    >
      <div className="grid gap-2 px-4 pb-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {data.org.provider === 'GITHUB' ? (
          h.hasInstallation ? (
            <Tile tone="ok" title="Github App ✓">
              installed on {data.org.login}
            </Tile>
          ) : (
            <Tile tone="neutral" title="No Github App">
              {"The owner's choice; Classmoji can't create repositories here until it's installed."}
            </Tile>
          )
        ) : (
          <Tile tone="neutral" title="Gitlab">
            {h.hasInstallation ? 'connected' : 'no connection'}
          </Tile>
        )}
        <Tile tone="neutral" title={`${h.accepted} students`}>
          {h.pending ? `${h.pending} haven't accepted` : 'everyone accepted'} · {h.staff} staff
        </Tile>
        <Tile tone="neutral" title="Content sync">
          {h.contentSyncedAt
            ? `full sync ${relativeTime(h.contentSyncedAt)}`
            : 'never fully synced'}
          {h.contentSyncedCommit ? ` · ${h.contentSyncedCommit.slice(0, 7)}` : ''}
        </Tile>
        <Tile
          tone={h.checkpointErrors ? 'critical' : 'neutral'}
          title={
            h.checkpointErrors
              ? `${h.checkpointErrors} checkpoint error${h.checkpointErrors === 1 ? '' : 's'}`
              : `Live editing ${h.collabEnabled ? 'on' : 'off'}`
          }
        >
          {h.checkpointError
            ? h.checkpointError.slice(0, 80)
            : h.lastCheckpointAt
              ? `last checkpoint ${relativeTime(h.lastCheckpointAt)}`
              : `${h.collabDocs} documents`}
        </Tile>
        <Tile tone="neutral" title={`Content delivery ${h.delivery ? 'on' : 'off'}`}>
          <DeliveryToggle enabled={h.delivery} />
        </Tile>
        {h.importJob ? (
          <Tile
            tone={h.importJob.status === 'FAILED' ? 'critical' : 'neutral'}
            title={`Import ${h.importJob.status.toLowerCase()}`}
          >
            {h.importJob.phase ? `${h.importJob.phase} · ` : ''}
            {relativeTime(h.importJob.at)}
          </Tile>
        ) : (
          <Tile tone="neutral" title="Last activity">
            {h.lastActivity ? relativeTime(h.lastActivity) : 'none recorded'}
          </Tile>
        )}
      </div>
    </Panel>
  );
};

const PeopleTab = ({ data }: { data: Extract<Data, { people: unknown }> }) => {
  const { people, classroom } = data;
  const [params] = useSearchParams();
  const keep = [...params.entries()].filter(([k]) => k !== 'pq');
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <FilterChips
          param="people"
          options={[
            { value: '', label: 'All', count: people.counts.all },
            { value: 'staff', label: 'Staff', count: people.counts.staff },
            { value: 'students', label: 'Students', count: people.counts.students },
            { value: 'pending', label: 'Pending', count: people.counts.pending },
          ]}
        />
        <Form method="get" className="flex">
          {keep.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input
            type="search"
            name="pq"
            defaultValue={people.query}
            placeholder="Filter by name, username, email…"
            aria-label="Filter people"
            className="w-64 rounded-md border border-line bg-panel px-2.5 py-1 text-sm text-ink-0 placeholder:text-ink-4 focus:outline-none focus:border-line-strong"
          />
        </Form>
      </div>
      {people.rows.length === 0 ? (
        <Empty title="No one here" />
      ) : (
        <div className="overflow-x-auto px-4 pb-3">
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD}>
                <th className="font-semibold py-2 pr-3">Person</th>
                <th className="font-semibold py-2 pr-3">Role</th>
                <th className="font-semibold py-2 pr-3">Email</th>
                <th className="font-semibold py-2 pr-3">Last seen</th>
                <th className="font-semibold py-2 pr-3">Added</th>
                <th className="py-2 w-px" />
              </tr>
            </thead>
            <tbody>
              {people.rows.map(p => (
                <tr key={p.id} className="border-t border-line row-hover">
                  <td className="py-1.5 pr-3">
                    <Link to={`/people/${p.id}`} className="flex items-center gap-2 group min-w-0">
                      <Avatar name={p.name} image={p.image} size={22} />
                      <span className="font-medium text-ink-0 group-hover:underline truncate">
                        {p.name}
                      </span>
                      {p.login && p.login !== p.name ? (
                        <span className="text-xs text-ink-3 truncate">@{p.login}</span>
                      ) : null}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="flex flex-wrap gap-1">
                      {p.roles.map(r => (
                        <RoleChip key={r} of={r} />
                      ))}
                      {!p.accepted ? <RoleChip of="PENDING" /> : null}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-ink-2 truncate max-w-[16rem]">
                    {p.email ?? '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-ink-2 whitespace-nowrap">
                    {p.lastSeenAt ? (
                      relativeTime(p.lastSeenAt)
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-ink-3 whitespace-nowrap">
                    {relativeTime(p.joinedAt)}
                  </td>
                  <td className="py-1.5 text-right">
                    {p.accepted ? (
                      <ViewAsButton userId={p.id} name={p.name} classroomSlug={classroom.slug} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

const TYPE_CHIP: Record<string, string> = {
  REPO: 'chip chip-asgn',
  QUIZ: 'chip chip-quiz',
  FORM: 'chip chip-lect',
};

const CourseworkTab = ({ data }: { data: Extract<Data, { coursework: unknown }> }) =>
  data.coursework.length === 0 ? (
    <Empty title="No modules yet" />
  ) : (
    <div className="px-4 pb-4 space-y-4 pt-3">
      {data.coursework.map(m => (
        <div key={m.id}>
          <h3 className="text-sm font-semibold text-ink-0 flex items-center gap-2">
            {m.title}
            {!m.published ? <span className="chip chip-upcoming">draft</span> : null}
          </h3>
          {m.assignments.length === 0 ? (
            <p className="text-xs text-ink-4 mt-1">No assignments</p>
          ) : (
            <table className="w-full text-sm mt-1">
              <tbody>
                {m.assignments.map(a => (
                  <tr key={a.id} className="border-t border-line">
                    <td className="py-1.5 pr-3 w-16">
                      <span className={TYPE_CHIP[a.type] ?? 'chip chip-ghost'}>{a.type}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-ink-1">
                      {a.title}
                      {!a.published ? <span className="chip chip-upcoming ml-2">draft</span> : null}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-3 whitespace-nowrap">
                      {a.deadline
                        ? `due ${new Date(a.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                        : 'no deadline'}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-ink-2 whitespace-nowrap">
                      {a.type === 'REPO' ? `${a.submissions} submitted` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );

const ActivityTab = ({ data }: { data: Extract<Data, { activity: unknown }> }) =>
  data.activity.length === 0 ? (
    <Empty title="Nothing recorded" hint="Changes made in this classroom show up here." />
  ) : (
    <ol className="px-4 py-3">
      {data.activity.map((a, i) => (
        <li
          key={`${a.at}-${i}`}
          className="relative grid grid-cols-[6.5rem_1fr] gap-3 py-1.5 pl-4 ml-1 border-l border-line text-sm"
        >
          <span
            aria-hidden
            className="absolute -left-[4px] top-3 w-[7px] h-[7px] rounded-full"
            style={{ background: a.admin ? 'var(--amber-ink)' : 'var(--line-strong)' }}
          />
          <span className="text-xs text-ink-4 tabular-nums pt-0.5">{relativeTime(a.at)}</span>
          <span className="text-ink-1">
            {a.actor ? (
              <Link to={`/people/${a.actor.id}`} className="font-medium text-ink-0 hover:underline">
                {a.actor.name ?? 'Someone'}
              </Link>
            ) : (
              <b className="font-medium text-ink-0">Someone</b>
            )}{' '}
            {a.text}
            {a.tool ? <span className="text-xs text-ink-4"> · {a.tool}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );

const ClassroomDetail = () => {
  const data = useLoaderData<typeof loader>();
  const { classroom, org, tab } = data;
  const [params] = useSearchParams();
  const owner = classroom.owner;

  return (
    <>
      <PageHeader
        back={{ to: data.back, label: data.back === '/classrooms' ? 'Classrooms' : 'Back' }}
        title={
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 text-ink-0">
              {classroom.name}
              <StatusChips
                status={classroom.status}
                isArchived={classroom.isArchived}
                isExample={classroom.isExample}
              />
              {classroom.plan === 'Pro' ? <span className="chip chip-done">Pro</span> : null}
            </span>
            <span className="block text-xs font-normal text-ink-3">
              {classroom.slug} · {org.provider === 'GITLAB' ? 'Gitlab' : 'Github'}{' '}
              {org.url ? (
                <a href={org.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {org.login} ↗
                </a>
              ) : (
                org.login
              )}{' '}
              · content{' '}
              {org.contentRepoUrl ? (
                <a
                  href={org.contentRepoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {classroom.contentRepo} ↗
                </a>
              ) : (
                classroom.contentRepo
              )}{' '}
              · created{' '}
              {new Date(classroom.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              {classroom.creator ? (
                <>
                  {' '}
                  by{' '}
                  <Link to={`/people/${classroom.creator.id}`} className="hover:underline">
                    {classroom.creator.name ?? 'someone'}
                  </Link>
                </>
              ) : null}
              {classroom.githubClassroomId ? ' · imported from Github Classroom' : ''}
            </span>
          </span>
        }
      >
        {owner ? (
          <ViewAsButton
            userId={owner.id}
            name={owner.name}
            classroomSlug={classroom.slug}
            label="View as owner"
            primary
          />
        ) : null}
      </PageHeader>

      {data.health.health === 'critical' ? (
        <div className="mb-4 rounded-lg bg-amber-bg border border-amber-bord text-amber-ink px-4 py-2.5 text-sm flex items-start gap-2">
          <IconAlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>{data.health.reasons.join(' · ')}</span>
        </div>
      ) : null}

      <div className="space-y-4">
        <HealthStrip data={data} />

        <section className="rounded-xl border border-line bg-panel min-w-0">
          <nav className="flex gap-1 border-b border-line px-4" aria-label="Classroom sections">
            {(Object.keys(TAB_LABEL) as ClassroomTab[]).map(t => (
              <Link
                key={t}
                to={withParams(
                  new URLSearchParams(params.get('from') ? { from: params.get('from')! } : {}),
                  {
                    tab: t === 'people' ? null : t,
                  }
                )}
                preventScrollReset
                aria-current={t === tab ? 'page' : undefined}
                className={`-mb-px px-3 py-2 text-sm border-b-2 ${
                  t === tab
                    ? 'border-accent text-ink-0 font-medium'
                    : 'border-transparent text-ink-3 hover:text-ink-1'
                }`}
              >
                {TAB_LABEL[t]}
                {t === 'people' && 'people' in data ? (
                  <span className="ml-1 text-ink-4 tabular-nums">{data.people.counts.all}</span>
                ) : null}
              </Link>
            ))}
          </nav>
          {'people' in data ? <PeopleTab data={data} /> : null}
          {'coursework' in data ? <CourseworkTab data={data} /> : null}
          {'activity' in data ? <ActivityTab data={data} /> : null}
        </section>
      </div>
    </>
  );
};

export default ClassroomDetail;
