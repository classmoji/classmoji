import { useState } from 'react';
import { UserRoundIcon } from 'lucide-react';

/**
 * A person on the feedback board: their picture, or their initials on a flat
 * neutral circle when there is none (no gradients).
 */
export function FeedbackAvatar({
  name,
  image,
  size = 24,
  anonymous = false,
}: {
  name: string;
  image?: string | null;
  size?: number;
  /** An anonymous author: a plain person icon, never initials. */
  anonymous?: boolean;
}) {
  const [errored, setErrored] = useState(false);
  const style = { width: size, height: size };
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';

  if (anonymous) {
    return (
      <span
        aria-hidden
        style={style}
        className="grid shrink-0 place-items-center rounded-full bg-stone-200 text-stone-500 dark:bg-neutral-700 dark:text-neutral-300"
      >
        <UserRoundIcon style={{ width: size * 0.6, height: size * 0.6 }} />
      </span>
    );
  }

  if (image && !errored) {
    return (
      <img
        src={image}
        alt=""
        onError={() => setErrored(true)}
        style={style}
        className="shrink-0 rounded-full object-cover ring-1 ring-line"
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.4)) }}
      className="grid shrink-0 place-items-center rounded-full bg-stone-200 font-semibold text-stone-600 dark:bg-neutral-700 dark:text-neutral-200"
    >
      {initials}
    </span>
  );
}
