import { useState } from 'react';
import { Link, useLoaderData } from 'react-router';
import { IconCopy } from '@tabler/icons-react';
import { Avatar, BTN_XS, Empty, PageHeader, Panel, RoleChip, StatusChips } from '~/components/ui';
import { ViewAsButton } from '~/components/ViewAsButton';
import { relativeTime } from '~/utils/time';
import { loadPerson } from './route.server';

export const loader = loadPerson;

export const meta = ({ data }: { data?: { person?: { name: string } } }) => [
  { title: data?.person ? `${data.person.name} · Classmoji Admin` : 'Person · Classmoji Admin' },
];

const PROVIDER: Record<string, string> = { github: 'Github', gitlab: 'Gitlab', credential: 'Password' };

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';

const CopyId = ({ id }: { id: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={BTN_XS}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard refused: the id is visible on the page to select.
        }
      }}
    >
      <IconCopy size={14} />
      {copied ? 'Copied' : 'Copy id'}
    </button>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-3 py-1.5 border-b border-line last:border-0 text-sm">
    <dt className="text-ink-3 w-32 shrink-0">{label}</dt>
    <dd className="text-ink-1 min-w-0 break-words">{children}</dd>
  </div>
);

const Person = () => {
  const {
    back,
    person,
    accounts,
    classrooms,
    sessions,
    invites,
    feedback,
    askMojiConversations,
    activeDays30,
    history,
  } = useLoaderData<typeof loader>();
  const [historyFilter, setHistoryFilter] = useState<'all' | 'admin' | 'classroom'>('all');
  const shownHistory =
    historyFilter === 'all' ? history : history.filter(h => h.kind === historyFilter);
  const github = accounts.find(a => a.provider === 'github' && a.username);

  return (
    <>
      <PageHeader
        back={{ to: back, label: back === '/people' ? 'People' : 'Back' }}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={person.name} image={person.image} size={36} />
            <span className="min-w-0">
              <span className="block text-ink-0">
                {person.name}
                {person.banned ? <span className="chip chip-late ml-2">banned</span> : null}
              </span>
              <span className="block text-xs font-normal text-ink-3">
                {person.email ?? 'no email'}
                {person.email ? (person.emailVerified ? ' · verified' : ' · not verified') : ''} ·
                first sign-in {person.firstSignInAt ? fmt(person.firstSignInAt) : 'never'} · last
                seen {person.lastSeenAt ? relativeTime(person.lastSeenAt) : '—'}
              </span>
            </span>
          </span>
        }
      >
        <CopyId id={person.id} />
        {github ? (
          <a
            href={`https://github.com/${github.username}`}
            target="_blank"
            rel="noreferrer"
            className={BTN_XS}
          >
            Github ↗
          </a>
        ) : null}
        <ViewAsButton userId={person.id} name={person.name} primary />
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
        <div className="space-y-4 min-w-0">
          <Panel
            title="Classes"
            description={
              classrooms.length
                ? `${classrooms.length} classroom${classrooms.length === 1 ? '' : 's'}`
                : undefined
            }
          >
            {classrooms.length === 0 ? (
              <Empty title="Not in any classroom" />
            ) : (
              <div className="overflow-x-auto px-4 pb-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                      <th className="font-semibold py-2 pr-3">Classroom</th>
                      <th className="font-semibold py-2 pr-3">Role</th>
                      <th className="font-semibold py-2 pr-3">Membership</th>
                      <th className="font-semibold py-2 pr-3">Since</th>
                      <th className="py-2 w-px" />
                    </tr>
                  </thead>
                  <tbody>
                    {classrooms.map(c => (
                      <tr key={c.slug} className="border-t border-line row-hover">
                        <td className="py-1.5 pr-3">
                          <Link
                            to={`/classrooms/${encodeURIComponent(c.slug)}`}
                            className="font-medium text-ink-0 hover:underline"
                          >
                            {c.name}
                          </Link>{' '}
                          <StatusChips status={c.status} isArchived={c.archived} />
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className="flex flex-wrap gap-1">
                            {c.roles.map(r => (
                              <RoleChip key={r} role={r} />
                            ))}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 text-ink-2">
                          {c.accepted ? 'accepted' : <RoleChip role="PENDING" />}
                        </td>
                        <td className="py-1.5 pr-3 text-ink-3 whitespace-nowrap">{fmt(c.since)}</td>
                        <td className="py-1.5 text-right">
                          {!c.archived ? (
                            <ViewAsButton
                              userId={person.id}
                              name={person.name}
                              classroomSlug={c.slug}
                              label="View as here"
                            />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="History"
            description="Changes they made in classrooms, admin actions about them, first sign-in"
            aside={
              <div className="flex gap-1.5">
                {(['all', 'classroom', 'admin'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={historyFilter === f}
                    onClick={() => setHistoryFilter(f)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                      historyFilter === f
                        ? 'bg-ink-0 text-panel border-ink-0'
                        : 'border-line text-ink-2 hover:text-ink-0'
                    }`}
                  >
                    {f === 'all' ? 'All' : f === 'admin' ? 'Admin actions' : 'In classrooms'}
                  </button>
                ))}
              </div>
            }
          >
            {shownHistory.length === 0 ? (
              <Empty title="Nothing recorded" />
            ) : (
              <ol className="px-4 pb-4">
                {shownHistory.map((h, i) => (
                  <li
                    key={`${h.at}-${i}`}
                    className="relative grid grid-cols-[6.5rem_1fr] gap-3 py-1.5 pl-4 ml-1 border-l border-line text-sm"
                  >
                    <span
                      aria-hidden
                      className="absolute -left-[4px] top-3 w-[7px] h-[7px] rounded-full"
                      style={{
                        background: h.kind === 'admin' ? 'var(--amber-ink)' : 'var(--line-strong)',
                      }}
                    />
                    <span className="text-xs text-ink-4 tabular-nums pt-0.5">
                      {relativeTime(h.at)}
                    </span>
                    <span className="text-ink-1 min-w-0">
                      {h.text}
                      {h.classroom ? (
                        <>
                          {' · '}
                          <Link
                            to={`/classrooms/${encodeURIComponent(h.classroom.slug)}`}
                            className="text-ink-2 hover:underline"
                          >
                            {h.classroom.name}
                          </Link>
                        </>
                      ) : null}
                      {h.tool ? <span className="text-xs text-ink-4"> · {h.tool}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <Panel title="Account">
          <dl className="px-4 pb-3">
            <Field label="Role">
              {person.role ? <RoleChip role={person.role} /> : '—'}
              {person.classes ? (
                <span className="text-ink-3"> in {person.classes} class{person.classes === 1 ? '' : 'es'}</span>
              ) : null}
            </Field>
            <Field label="Signs in with">
              {accounts.length === 0 ? (
                '—'
              ) : (
                <ul className="space-y-0.5">
                  {accounts.map(a => (
                    <li key={`${a.provider}-${a.host ?? ''}-${a.username ?? ''}`}>
                      {PROVIDER[a.provider] ?? a.provider}
                      {a.username ? ` @${a.username}` : ''}
                      {a.host ? <span className="text-ink-4"> · self-managed</span> : null}
                      <span className={a.connected ? 'text-mint-ink' : 'text-ink-4'}>
                        {a.connected ? ' · connected' : ' · placeholder'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <Field label="Active days">{activeDays30} in the last 30</Field>
            <Field label="Sessions">
              {sessions.own} active
              {sessions.impersonated ? ` · ${sessions.impersonated} viewed-as` : ''}
            </Field>
            <Field label="Plan">{person.plan}</Field>
            <Field label="Email invites">
              {invites.length === 0
                ? 'none waiting'
                : invites.map(i => (
                    <span key={i.classroom.slug} className="block">
                      {i.classroom.name} · {relativeTime(i.createdAt)}
                    </span>
                  ))}
            </Field>
            <Field label="Feedback">
              {feedback.posts} post{feedback.posts === 1 ? '' : 's'} · {feedback.votes} vote
              {feedback.votes === 1 ? '' : 's'}
            </Field>
            <Field label="Ask Moji">
              {askMojiConversations} conversation{askMojiConversations === 1 ? '' : 's'}
            </Field>
            <Field label="Row created">{fmt(person.createdAt)}</Field>
            <Field label="User id">
              <span className="font-mono text-xs select-all">{person.id}</span>
            </Field>
          </dl>
        </Panel>
      </div>
    </>
  );
};

export default Person;
