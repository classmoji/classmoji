import { IconChevronR } from '@classmoji/ui-components';

export interface RepoCardData {
  name: string;
  slug: string;
  githubUrl: string;
}

interface RepoCardProps {
  repo: RepoCardData | null;
  groupHref?: string;
}

export function RepoCard({ repo, groupHref }: RepoCardProps) {
  if (!repo) {
    return (
      <div className="panel flex flex-col">
        <div className="px-[18px] pt-3.5 pb-2.5">
          <div className="text-sm font-semibold">No repository yet</div>
          <div className="mt-0.5 text-[11.5px] text-ink-3 mono">
            You haven&apos;t been assigned to a group repo.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col">
      <div className="px-[18px] pt-3.5 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold">{repo.name}</div>
          <div className="flex-1" />
          <span className="text-ink-3">
            <IconChevronR size={12} />
          </span>
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-3 mono">{repo.slug}</div>
      </div>
      <div className="sep" />
      <div className="px-[18px] pt-2.5 pb-2">
        <div className="caps text-[10px] mb-1.5">Recent activity</div>
        <div className="flex items-center gap-2 py-2 text-[12.5px] text-ink-3">
          <span className="dot" />
          <span>Activity coming soon</span>
        </div>
      </div>
      <div className="sep" />
      <div className="flex gap-2 px-3.5 py-2.5">
        {groupHref ? (
          <a href={groupHref} className="btn btn-sm no-underline">
            View group
          </a>
        ) : (
          <span className="btn btn-sm opacity-50 cursor-not-allowed">
            View group
          </span>
        )}
        <div className="flex-1" />
        <a
          href={repo.githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-sm no-underline"
        >
          Go to repo →
        </a>
      </div>
    </div>
  );
}

export default RepoCard;
