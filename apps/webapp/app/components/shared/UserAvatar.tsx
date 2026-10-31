import { useState } from 'react';
import { isPlaceholderAvatar } from '@classmoji/utils';

const COLORS = [
  'bg-pink-500',
  'bg-orange-500',
  'bg-teal-500',
  'bg-indigo-500',
  'bg-fuchsia-500',
  'bg-green-500',
  'bg-blue-500',
  'bg-rose-500',
];

const pickColor = (seed: string) => {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
};

const getInitials = (name?: string | null, login?: string | null) => {
  const source = (name || login || '').trim();
  if (!source) return '?';
  // Words that start with a letter or digit, so "Avery (TA)" reads "A", not "A(".
  const parts = source.split(/\s+/).filter(p => /^[\p{L}\p{N}]/u.test(p));
  const initials = parts
    .map(p => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return initials || source.slice(0, 1).toUpperCase();
};

interface UserAvatarProps {
  login?: string | null;
  image?: string | null;
  name?: string | null;
  seed?: string | null;
  size?: number;
  className?: string;
  ringClassName?: string;
}

const UserAvatar = ({
  login,
  image,
  name,
  seed,
  size = 32,
  className = '',
  ringClassName = 'ring-1 ring-gray-200 dark:ring-gray-700',
}: UserAvatarProps) => {
  // Remember which src failed, so a new image gets its own chance to load.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const initials = getInitials(name, login);
  const color = pickColor(seed || login || name || 'x');
  const style = { width: size, height: size };
  const fontSize = Math.max(10, Math.round(size * 0.38));

  // No image, the generic default silhouette, or a URL that failed to load:
  // draw initials rather than a stock icon or the browser's broken image.
  const src = isPlaceholderAvatar(image) ? null : image;
  if (!src || failedSrc === src) {
    return (
      <div
        style={{ ...style, fontSize }}
        className={`rounded-full ${color} text-white flex items-center justify-center font-bold flex-shrink-0 ring-1 ring-black/5 dark:ring-white/10 ${className}`}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name || login || ''}
      onError={() => setFailedSrc(src)}
      style={style}
      className={`rounded-full ${ringClassName} flex-shrink-0 object-cover ${className}`}
    />
  );
};

export default UserAvatar;
