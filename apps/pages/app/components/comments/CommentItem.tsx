import { useEffect, useRef, useState } from 'react';
import { IconDots } from '@tabler/icons-react';

import { Composer } from './Composer.tsx';
import { LinkedText } from './LinkedText.tsx';
import { ReactionPicker } from './ReactionPicker.tsx';
import { fullTime, relativeTime } from './relativeTime.ts';
import type { CommentAuthor, CommentIntent, PageComment } from './types.ts';

/** A person's picture, or their initials on a tint. */
export function Avatar({ author, size = 24 }: { author: CommentAuthor | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (author?.image && !broken) {
    return (
      <img
        src={author.image}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="shrink-0 rounded-full object-cover ring-1 ring-black/5 dark:ring-white/10"
        style={{ width: size, height: size }}
      />
    );
  }
  const initials = author
    ? author.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0]?.toUpperCase() ?? '')
        .join('')
    : '?';
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-stone-200 text-[10px] font-semibold text-stone-600 dark:bg-neutral-700 dark:text-neutral-200"
      style={{ width: size, height: size }}
    >
      {initials || '?'}
    </span>
  );
}

export function RoleBadge({ badge }: { badge: CommentAuthor['badge'] }) {
  if (!badge) return null;
  return (
    <span
      className={
        badge === 'Instructor'
          ? 'rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
          : 'rounded-full bg-sky-100 px-1.5 py-px text-[10px] font-semibold text-sky-800 dark:bg-sky-900/50 dark:text-sky-200'
      }
    >
      {badge}
    </span>
  );
}

interface CommentItemProps {
  comment: PageComment;
  /** May react (signed-in member, classroom not locked). */
  canReact: boolean;
  /** The classroom is locked: no edits or deletes either. */
  frozen: boolean;
  act: (payload: CommentIntent) => Promise<boolean>;
  onRequestDelete: (comment: PageComment) => void;
}

export function CommentItem({ comment, canReact, frozen, act, onRequestDelete }: CommentItemProps) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const author = comment.author;
  const name = author?.name ?? 'Deleted user';
  const canEdit = comment.canEdit && !frozen;
  const canDelete = comment.canDelete && !frozen;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const react = (emoji: string, on: boolean) => {
    void act({ intent: 'react', commentId: comment.id, emoji, on });
  };

  return (
    <div className="group/comment flex gap-2.5">
      <Avatar author={author} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`truncate text-sm font-semibold ${author ? 'text-gray-900 dark:text-gray-100' : 'italic text-gray-500 dark:text-gray-400'}`}
          >
            {name}
          </span>
          <RoleBadge badge={author?.badge ?? null} />
          <time
            dateTime={comment.createdAt}
            title={fullTime(comment.createdAt)}
            className="shrink-0 text-xs text-gray-500 dark:text-gray-400"
          >
            {relativeTime(comment.createdAt)}
          </time>
          {comment.editedAt && (
            <span
              className="shrink-0 text-xs text-gray-400 dark:text-gray-500"
              title={`Edited ${fullTime(comment.editedAt)}`}
            >
              (edited)
            </span>
          )}
          {(canEdit || canDelete) && !editing && (
            <div
              ref={menuRef}
              className="relative ml-auto"
              onKeyDown={event => {
                if (event.key === 'Escape' && menuOpen) {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuOpen(false);
                  menuButtonRef.current?.focus();
                }
              }}
            >
              <button
                ref={menuButtonRef}
                type="button"
                onClick={() => setMenuOpen(open => !open)}
                aria-label="Comment actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={`flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:opacity-100 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100 ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover/comment:opacity-100 max-md:opacity-100'}`}
              >
                <IconDots size={15} />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-7 z-20 min-w-28 overflow-hidden rounded-lg bg-white py-1 shadow-lg ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-700"
                >
                  {canEdit && (
                    <button
                      type="button"
                      role="menuitem"
                      autoFocus
                      onClick={() => {
                        setMenuOpen(false);
                        setEditing(true);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:text-gray-200 dark:hover:bg-neutral-800 dark:focus:bg-neutral-800"
                    >
                      Edit
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      role="menuitem"
                      autoFocus={!canEdit}
                      onClick={() => {
                        setMenuOpen(false);
                        onRequestDelete(comment);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none dark:text-red-400 dark:hover:bg-red-950/40 dark:focus:bg-red-950/40"
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {editing ? (
          <div className="mt-1.5">
            <Composer
              label="Edit comment"
              placeholder="Edit your comment"
              submitLabel="Save"
              initialValue={comment.body}
              autoFocus
              cancelLabel="Cancel"
              onCancel={() => setEditing(false)}
              onSubmit={async body => {
                if (body === comment.body) {
                  setEditing(false);
                  return true;
                }
                const ok = await act({ intent: 'edit', commentId: comment.id, body });
                if (ok) setEditing(false);
                return ok;
              }}
            />
          </div>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200">
            <LinkedText text={comment.body} />
          </p>
        )}

        {(comment.reactions.length > 0 || canReact) && !editing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {comment.reactions.map(reaction => (
              <button
                key={reaction.emoji}
                type="button"
                disabled={!canReact}
                onClick={() => react(reaction.emoji, !reaction.mine)}
                aria-pressed={reaction.mine}
                aria-label={`${reaction.emoji} ${reaction.count}${reaction.mine ? ', including you' : ''}`}
                className={`flex h-6 items-center gap-1 rounded-full px-2 text-xs ring-1 transition-colors disabled:cursor-default ${
                  reaction.mine
                    ? 'bg-blue-50 font-semibold text-blue-700 ring-blue-300 hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-200 dark:ring-blue-700 dark:hover:bg-blue-900/60'
                    : 'bg-white text-gray-700 ring-stone-200 hover:bg-gray-50 dark:bg-neutral-900 dark:text-gray-300 dark:ring-neutral-700 dark:hover:bg-neutral-800'
                }`}
              >
                <span className="text-sm leading-none">{reaction.emoji}</span>
                <span>{reaction.count}</span>
              </button>
            ))}
            {canReact && (
              <ReactionPicker
                // Adds (idempotent): taking one back is its chip's job.
                onPick={emoji => react(emoji, true)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
