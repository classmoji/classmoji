import { GithubFilled, GitlabFilled } from '@ant-design/icons';

type ProviderKey = 'GITHUB' | 'GITLAB';

const PROVIDERS: Record<
  ProviderKey,
  { label: string; icon: React.ReactNode; classes: string }
> = {
  GITHUB: {
    label: 'GitHub',
    icon: <GithubFilled style={{ fontSize: 12 }} />,
    classes:
      'text-gray-700 bg-gray-100 border-gray-200 dark:text-gray-300 dark:bg-neutral-800 dark:border-neutral-700',
  },
  GITLAB: {
    label: 'GitLab',
    icon: <GitlabFilled style={{ fontSize: 12, color: '#FC6D26' }} />,
    classes:
      'text-[#C24A16] bg-[#FEEEE6] border-[#FBD3BE] dark:text-orange-300 dark:bg-orange-950/30 dark:border-orange-800/40',
  },
};

/**
 * Small pill showing which git provider the signed-in user authenticated with.
 * Mirrors the RoleChip pattern. `provider` comes from `user.provider`
 * (GitProvider enum). Legacy rows have `provider = null` — those pre-date GitLab
 * support and are GitHub users, so unknown/null falls back to GitHub.
 */
export function ProviderBadge({ provider }: { provider?: string | null }) {
  const key: ProviderKey = provider === 'GITLAB' ? 'GITLAB' : 'GITHUB';
  const m = PROVIDERS[key];
  return (
    <span
      className={`inline-flex items-center gap-1 leading-none text-[11px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0 ${m.classes}`}
    >
      {m.icon}
      {m.label}
    </span>
  );
}

export default ProviderBadge;
