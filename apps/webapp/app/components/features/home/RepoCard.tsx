import { IconArrowR, IconGithub } from '@classmoji/ui-components';

export interface RepoCardData {
  name: string;
  slug: string;
  githubUrl: string;
}

interface RepoCardProps {
  repo: RepoCardData | null;
}

export function RepoCard({ repo }: RepoCardProps) {
  if (!repo) return null;
  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--ink-0)' }}>
          <IconGithub size={14} />
        </span>
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>{repo.name}</span>
      </div>
      <div
        style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}
        className="mono"
      >
        {repo.slug}
      </div>

      {/* TODO: Phase 4a - fetch commits via GitHub API (likely via packages/services or a trigger.dev task) */}

      <a
        href={repo.githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn"
        style={{
          width: '100%',
          marginTop: 14,
          textDecoration: 'none',
          justifyContent: 'center',
        }}
      >
        View repo on GitHub <IconArrowR size={14} />
      </a>
    </div>
  );
}

export default RepoCard;
