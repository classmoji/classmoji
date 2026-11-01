import { FeedbackAvatar } from './FeedbackAvatar';
import type { FeedbackAuthor } from './feedback';

/**
 * Overlapping faces of the people in a conversation (the author, then
 * commenters), with "+N" for the rest. Anonymous people are never in the list.
 */
export function ParticipantStack({
  people,
  total,
  size = 22,
  className = '',
}: {
  people: FeedbackAuthor[];
  total: number;
  size?: number;
  className?: string;
}) {
  if (people.length === 0) return null;
  const more = total - people.length;
  const names = people.map(p => p.name || 'Former user');
  const label = `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  return (
    <span className={`inline-flex items-center ${className}`} title={label}>
      <span className="sr-only">In this conversation: {label}</span>
      <span aria-hidden className="flex -space-x-1.5">
        {people.map((p, i) => (
          <span key={p.id} className="rounded-full ring-2 ring-panel" style={{ zIndex: 10 - i }}>
            <FeedbackAvatar name={p.name || 'Former user'} image={p.image} size={size} />
          </span>
        ))}
      </span>
      {more > 0 && (
        <span aria-hidden className="ml-1.5 text-[11px] font-semibold text-ink-3">
          +{more}
        </span>
      )}
    </span>
  );
}
