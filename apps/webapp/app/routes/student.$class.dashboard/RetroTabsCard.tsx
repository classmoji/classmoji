import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { IconArrowRight, IconBrandGithub } from '@tabler/icons-react';
import Emoji from '~/components/ui/display/Emoji';

export interface FeedbackItem {
  id: string;
  assignmentTitle: string;
  closedAt: string | Date | null;
  graders: { id: string; name: string | null }[];
  grades: { id?: string; emoji: string }[];
  issueUrl: string | null;
}

export interface ResubmitItem {
  id: string;
  assignmentTitle: string;
  status: string;
  createdAt: string | Date;
}

export interface TeamMemberLite {
  id: string;
  name: string | null;
  login: string | null;
  providerId: string | null;
}

export interface TeamSummary {
  moduleTitle: string;
  moduleSlug: string | null;
  teamName: string;
  members: TeamMemberLite[];
  repoUrl: string | null;
}

export interface SelfFormedNeedsTeam {
  moduleTitle: string;
  moduleSlug: string | null;
}

interface RetroTabsCardProps {
  feedback: FeedbackItem[];
  team: TeamSummary | null;
  needsTeam: SelfFormedNeedsTeam | null;
  resubmits: ResubmitItem[];
  classSlug: string;
}

type TabKey = 'feedback' | 'team' | 'resubmits';

const TAB_ORDER: { key: TabKey; label: string }[] = [
  { key: 'feedback', label: 'Feedback' },
  { key: 'team', label: 'Team' },
  { key: 'resubmits', label: 'Resubmits' },
];

const statusStyles: Record<string, string> = {
  IN_REVIEW: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-200',
  APPROVED:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200',
  DENIED: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-900/30 dark:text-rose-200',
};

const fromNow = (date: string | Date) => {
  const diffMs = Date.now() - dayjs(date).valueOf();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return dayjs(date).format('MMM D');
};

const githubAvatarUrl = (providerId: string | null) =>
  providerId ? `https://avatars.githubusercontent.com/u/${providerId}?s=48` : undefined;

const initials = (name: string | null, login: string | null) => {
  const source = name || login || '?';
  return source
    .split(/\s+/)
    .map(p => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
};

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[10px] font-semibold tracking-[0.18em] text-gray-400 dark:text-gray-500 mb-2">
    {children}
  </div>
);

const PanelShell = ({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) => (
  <div className="h-full flex flex-col">
    <h3 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
      {title}
    </h3>
    {subtitle && (
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</div>
    )}
    <div className="flex-1 mt-4 min-h-0">{children}</div>
    {footer && (
      <div className="mt-3 pt-3 border-t border-stone-200/70 dark:border-neutral-700/50 flex items-center justify-between gap-2">
        {footer}
      </div>
    )}
  </div>
);

const FeedbackPanel = ({ items }: { items: FeedbackItem[] }) => {
  if (items.length === 0) {
    return (
      <PanelShell title="Recent feedback" subtitle="Released grades from your graders">
        <div className="h-full flex flex-col items-center justify-center text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">No graded feedback yet</p>
        </div>
      </PanelShell>
    );
  }
  return (
    <PanelShell title="Recent feedback" subtitle="Released grades from your graders">
      <Eyebrow>RECENT GRADES</Eyebrow>
      <ul className="flex flex-col">
        {items.map(item => (
          <li
            key={item.id}
            className="flex items-center gap-3 py-2.5 border-b border-stone-200/60 dark:border-neutral-700/50 last:border-0"
          >
            <div className="flex items-center gap-1 shrink-0">
              {item.grades.slice(0, 3).map((g, idx) => (
                <Emoji key={g.id ?? idx} emoji={g.emoji} fontSize={18} />
              ))}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {item.assignmentTitle}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {item.graders.map(g => g.name).filter(Boolean).join(', ') || 'Graded'}
                {item.closedAt && <> · {fromNow(item.closedAt)}</>}
              </div>
            </div>
            {item.issueUrl && (
              <a
                href={item.issueUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 px-2 py-1 rounded ring-1 ring-stone-200 dark:ring-neutral-700 hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors"
              >
                View
              </a>
            )}
          </li>
        ))}
      </ul>
    </PanelShell>
  );
};

const TeamPanel = ({
  team,
  needsTeam,
  classSlug,
}: {
  team: TeamSummary | null;
  needsTeam: SelfFormedNeedsTeam | null;
  classSlug: string;
}) => {
  if (team) {
    const footer = (
      <>
        <Link
          to={`/student/${classSlug}/modules`}
          className="text-xs font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors"
        >
          View group
        </Link>
        {team.repoUrl ? (
          <a
            href={team.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-white px-3 py-1.5 rounded-full bg-gray-900 dark:bg-gray-100 dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            <IconBrandGithub size={14} />
            Go to repo
            <IconArrowRight size={12} />
          </a>
        ) : (
          <span />
        )}
      </>
    );
    return (
      <PanelShell
        title={team.teamName}
        subtitle={
          <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
            {team.moduleTitle}
          </span>
        }
        footer={footer}
      >
        <Eyebrow>MEMBERS</Eyebrow>
        <div className="flex items-center gap-2">
          <Avatar.Group max={{ count: 6 }}>
            {team.members.map(m => (
              <Tooltip key={m.id} title={m.name || m.login || ''}>
                <Avatar src={githubAvatarUrl(m.providerId)} size={32}>
                  {initials(m.name, m.login)}
                </Avatar>
              </Tooltip>
            ))}
          </Avatar.Group>
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
            {team.members.length} {team.members.length === 1 ? 'member' : 'members'}
          </span>
        </div>
      </PanelShell>
    );
  }
  if (needsTeam) {
    return (
      <PanelShell
        title="No team yet"
        subtitle={`${needsTeam.moduleTitle} is self-formed.`}
      >
        <div className="h-full flex flex-col items-center justify-center text-center">
          <Link
            to={`/student/${classSlug}/modules`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors"
          >
            Choose a team
            <IconArrowRight size={12} />
          </Link>
        </div>
      </PanelShell>
    );
  }
  return (
    <PanelShell title="Team" subtitle="No group modules in this class">
      <div className="h-full flex flex-col items-center justify-center text-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Nothing to show here yet.
        </p>
      </div>
    </PanelShell>
  );
};

const ResubmitsPanel = ({
  items,
  classSlug,
}: {
  items: ResubmitItem[];
  classSlug: string;
}) => {
  if (items.length === 0) {
    return (
      <PanelShell title="Regrade requests" subtitle="Track resubmits and their status">
        <div className="h-full flex flex-col items-center justify-center text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">No resubmits yet</p>
        </div>
      </PanelShell>
    );
  }
  const footer = (
    <>
      <span />
      <Link
        to={`/student/${classSlug}/regrade-requests`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors"
      >
        View all
        <IconArrowRight size={12} />
      </Link>
    </>
  );
  return (
    <PanelShell
      title="Regrade requests"
      subtitle={`${items.length} total`}
      footer={footer}
    >
      <Eyebrow>RECENT</Eyebrow>
      <ul className="flex flex-col">
        {items.slice(0, 5).map(item => (
          <li
            key={item.id}
            className="flex items-center gap-3 py-2.5 border-b border-stone-200/60 dark:border-neutral-700/50 last:border-0"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {item.assignmentTitle}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {fromNow(item.createdAt)}
              </div>
            </div>
            <span
              className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full ring-1 ${
                statusStyles[item.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200'
              }`}
            >
              {item.status.replace('_', ' ')}
            </span>
          </li>
        ))}
      </ul>
    </PanelShell>
  );
};

const RetroTabsCard = ({
  feedback,
  team,
  needsTeam,
  resubmits,
  classSlug,
}: RetroTabsCardProps) => {
  const [active, setActive] = useState<TabKey>('feedback');

  return (
    <div className="h-full flex flex-col">
      <div className="flex -mb-px relative">
        {TAB_ORDER.map(({ key, label }, idx) => {
          const isActive = key === active;
          const activeIdx = TAB_ORDER.findIndex(t => t.key === active);
          const distance = Math.abs(idx - activeIdx);
          const zClass = isActive ? 'z-30' : distance === 1 ? 'z-20' : 'z-10';
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActive(key)}
              style={
                isActive
                  ? { color: 'var(--accent)', borderTopColor: 'var(--accent)' }
                  : undefined
              }
              className={`relative ${zClass} px-4 py-2 text-sm font-medium rounded-t-2xl border transition-colors ${
                idx > 0 ? '-ml-2' : ''
              } ${
                isActive
                  ? 'bg-white dark:bg-neutral-900 border-stone-200 dark:border-neutral-800 border-b-transparent'
                  : 'bg-stone-100 dark:bg-neutral-800 text-gray-500 dark:text-gray-400 border-stone-200 dark:border-neutral-700 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <section className="flex-1 rounded-2xl rounded-tl-none bg-white dark:bg-neutral-900 border border-stone-200 dark:border-neutral-800 min-h-[400px] flex flex-col">
        <div className="flex-1 p-5 sm:p-6">
          {active === 'feedback' && <FeedbackPanel items={feedback} />}
          {active === 'team' && (
            <TeamPanel team={team} needsTeam={needsTeam} classSlug={classSlug} />
          )}
          {active === 'resubmits' && (
            <ResubmitsPanel items={resubmits} classSlug={classSlug} />
          )}
        </div>
      </section>
    </div>
  );
};

export default RetroTabsCard;
