import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconSearch } from '@tabler/icons-react';
import { Avatar } from '~/components/ui';
import { useViewAs } from '~/hooks/useViewAs';

interface Results {
  people: Array<{ id: string; name: string; login: string | null; domain: string | null; image: string | null }>;
  classrooms: Array<{ slug: string; name: string; archived: boolean; owner: string | null }>;
  posts: Array<{ id: string; title: string; category: string; votes: number }>;
}

interface Item {
  key: string;
  group: string;
  label: React.ReactNode;
  hint: string;
  open: () => void;
  /** Shift+Enter: start View as (people only). */
  viewAs?: () => void;
}

const EMPTY: Results = { people: [], classrooms: [], posts: [] };

const PAGES = [
  { to: '/', label: 'Home' },
  { to: '/people', label: 'People' },
  { to: '/classrooms', label: 'Classrooms' },
  { to: '/insights', label: 'Insights' },
  { to: '/feedback', label: 'Feedback' },
  { to: '/ops/delivery', label: 'Ops · Content delivery' },
  { to: '/ops/activity', label: 'Ops · Activity log' },
  { to: '/ops/gitlab', label: 'Ops · Gitlab' },
];

/**
 * ⌘K / Ctrl+K from any page: one search over people, classrooms and feedback,
 * plus page jumps. Enter opens; Shift+Enter on a person starts View as.
 */
export const CommandPalette = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const navigate = useNavigate();
  const { viewAs } = useViewAs();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Results>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults(EMPTY);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setResults(EMPTY);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: ctrl.signal,
        });
        if (res.ok) setResults((await res.json()) as Results);
      } catch {
        // Aborted by the next keystroke, or offline: keep what is shown.
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  const go = useCallback(
    (to: string) => {
      onClose();
      navigate(to);
    },
    [navigate, onClose]
  );

  const items: Item[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out: Item[] = [];
    for (const p of results.people) {
      out.push({
        key: `u:${p.id}`,
        group: 'People',
        label: (
          <span className="flex items-center gap-2 min-w-0">
            <Avatar name={p.name} image={p.image} size={20} />
            <span className="truncate">
              {p.name}
              {p.login ? <span className="text-ink-3"> · @{p.login}</span> : null}
              {p.domain ? <span className="text-ink-4"> · {p.domain}</span> : null}
            </span>
          </span>
        ),
        hint: '↵ open · ⇧↵ view as',
        open: () => go(`/people/${p.id}`),
        viewAs: () => {
          onClose();
          void viewAs({ userId: p.id });
        },
      });
    }
    for (const c of results.classrooms) {
      out.push({
        key: `c:${c.slug}`,
        group: 'Classrooms',
        label: (
          <span className="truncate">
            {c.name}
            {c.owner ? <span className="text-ink-3"> · {c.owner}</span> : null}
            {c.archived ? <span className="chip chip-ghost ml-2">archived</span> : null}
          </span>
        ),
        hint: c.slug,
        open: () => go(`/classrooms/${encodeURIComponent(c.slug)}`),
      });
    }
    for (const p of results.posts) {
      out.push({
        key: `f:${p.id}`,
        group: 'Feedback',
        label: <span className="truncate">{p.title}</span>,
        hint: `${p.votes} vote${p.votes === 1 ? '' : 's'}`,
        open: () => go(`/feedback?category=${p.category}&post=${p.id}`),
      });
    }
    for (const page of PAGES) {
      if (!term || page.label.toLowerCase().includes(term)) {
        out.push({
          key: `p:${page.to}`,
          group: 'Go to',
          label: page.label,
          hint: page.to,
          open: () => go(page.to),
        });
      }
    }
    return out;
  }, [results, q, go, viewAs, onClose]);

  useEffect(() => setActive(0), [items.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (!item) return;
      if (e.shiftKey && item.viewAs) item.viewAs();
      else item.open();
    }
  };

  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[12vh] px-4"
      onMouseDown={e => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="w-full max-w-xl rounded-2xl bg-panel ring-1 ring-line-strong shadow-2xl overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line">
          <IconSearch size={17} className="text-ink-4 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search people, classrooms, feedback…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={items[active] ? `cmdk-${active}` : undefined}
            className="flex-1 bg-transparent text-base text-ink-0 placeholder:text-ink-4 focus:outline-none"
          />
          {loading ? (
            <span className="w-3 h-3 rounded-full border-2 border-line-strong border-t-transparent animate-spin" />
          ) : null}
        </div>
        <div ref={listRef} id="cmdk-list" role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-3 text-center">
              {q.trim().length < 2 ? 'Type a name, email, username, slug or id.' : 'Nothing found.'}
            </p>
          ) : (
            items.map((item, i) => {
              const header = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <div key={item.key}>
                  {header ? (
                    <div className="px-4 pt-2.5 pb-1 text-[10.5px] uppercase tracking-wider font-semibold text-ink-4">
                      {header}
                    </div>
                  ) : null}
                  <div
                    id={`cmdk-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={e => (e.shiftKey && item.viewAs ? item.viewAs() : item.open())}
                    className={`flex items-center justify-between gap-3 px-4 py-1.5 text-sm cursor-pointer ${
                      i === active ? 'bg-nav-hover text-ink-0' : 'text-ink-1'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="text-xs text-ink-4 shrink-0">{item.hint}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="flex gap-4 px-4 py-2 border-t border-line text-xs text-ink-4">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>⇧↵ view as</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
};
