import { useState } from 'react';

const GRADIENTS = [
  'from-rose-400 to-pink-500',
  'from-amber-400 to-orange-500',
  'from-emerald-400 to-teal-500',
  'from-sky-400 to-indigo-500',
  'from-violet-400 to-fuchsia-500',
  'from-lime-400 to-green-500',
  'from-cyan-400 to-blue-500',
  'from-fuchsia-400 to-rose-500',
];

const pickGradient = (seed: string) => {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
};

const getInitials = (name?: string | null, login?: string | null) => {
  const source = (name || login || '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  const initials = parts
    .map(p => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return initials || source.slice(0, 1).toUpperCase();
};

interface UserAvatarProps {
  login?: string | null;
  name?: string | null;
  seed?: string | null;
  size?: number;
  className?: string;
  ringClassName?: string;
}

const UserAvatar = ({
  login,
  name,
  seed,
  size = 32,
  className = '',
  ringClassName = 'ring-1 ring-gray-200 dark:ring-gray-700',
}: UserAvatarProps) => {
  const [errored, setErrored] = useState(false);
  const initials = getInitials(name, login);
  const gradient = pickGradient(seed || login || name || 'x');
  const style = { width: size, height: size };
  const fontSize = Math.max(10, Math.round(size * 0.38));

  if (!login || errored) {
    return (
      <div
        style={{ ...style, fontSize }}
        className={`rounded-full bg-gradient-to-br ${gradient} text-white flex items-center justify-center font-bold flex-shrink-0 ring-1 ring-black/5 dark:ring-white/10 ${className}`}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={`https://github.com/${login}.png?size=${size * 2}`}
      alt={name || login}
      onError={() => setErrored(true)}
      style={style}
      className={`rounded-full ${ringClassName} flex-shrink-0 object-cover ${className}`}
    />
  );
};

export default UserAvatar;
