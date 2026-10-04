import { ChevronUpIcon } from 'lucide-react';

interface VoteButtonProps {
  count: number;
  voted: boolean;
  onToggle: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function VoteButton({
  count,
  voted,
  onToggle,
  size = 'md',
  className = '',
}: VoteButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={voted}
      aria-label={`${voted ? 'Remove upvote' : 'Upvote'} (${count} ${count === 1 ? 'vote' : 'votes'})`}
      className={`inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg border font-semibold tabular-nums transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        size === 'md' ? 'h-9 min-w-[64px] px-2.5 text-sm' : 'h-7 min-w-[48px] px-2 text-xs'
      } ${
        voted
          ? 'border-mint-bord bg-mint-bg text-mint-ink'
          : 'border-line-2 bg-panel text-ink-1 hover:border-line-strong'
      } ${className}`}
    >
      <ChevronUpIcon className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />
      {count}
    </button>
  );
}
