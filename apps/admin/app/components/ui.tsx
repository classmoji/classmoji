/**
 * Building blocks every admin screen shares, on the shared design system
 * (packages/ui-components/styles: `.chip`, `.btn`, ink/line/panel tokens).
 * Lists follow one pattern: filters and sort live in the URL, the server pages.
 */
import { Form, Link, useLocation, useSearchParams } from 'react-router';
import { IconInfoCircle, IconSearch } from '@tabler/icons-react';
import { useDebouncedSearch } from '~/hooks/useDebouncedSearch';

// ───────── URL helpers ─────────

/**
 * The current query string with `updates` applied (null removes a key).
 * Changing anything but the page resets to page 1.
 */
export const withParams = (current: URLSearchParams, updates: Record<string, string | null>) => {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  }
  if (!('page' in updates)) next.delete('page');
  const s = next.toString();
  return s ? `?${s}` : '?';
};

// ───────── layout ─────────

export const PageHeader = ({
  title,
  children,
  back,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  back?: { to: string; label: string };
}) => (
  <div className="mt-2 mb-4">
    {back ? (
      <Link to={back.to} className="text-xs text-ink-3 hover:text-ink-1">
        ← {back.label}
      </Link>
    ) : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-lg font-semibold text-ink-1 shrink-0">{title}</h1>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  </div>
);

/** The floating list card (Standard Page Layout). */
export const Sheet = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={`rounded-2xl bg-panel ring-1 ring-line px-3 py-4 sm:px-4 ${className}`}>
    {children}
  </div>
);

/** A bordered section with an optional header row. */
export const Panel = ({
  title,
  description,
  aside,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <section className={`rounded-xl border border-line bg-panel min-w-0 ${className}`}>
    {title ? (
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-0">{title}</h2>
          {description ? <p className="text-xs text-ink-3 mt-0.5">{description}</p> : null}
        </div>
        {aside}
      </div>
    ) : null}
    {children}
  </section>
);

export const Empty = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="text-center py-12 text-gray-500">
    <div className="font-medium">{title}</div>
    {hint ? <div className="text-sm">{hint}</div> : null}
  </div>
);

export const InfoTip = ({ text }: { text: string }) => (
  <span title={text} aria-label={text} className="inline-flex text-ink-4 hover:text-ink-2 cursor-help">
    <IconInfoCircle size={13} stroke={1.75} />
  </span>
);

// ───────── list controls ─────────

export interface ChipOption {
  value: string;
  label: string;
  count?: number;
}

/** One URL param, one chip per value; `''` is the default (no param). */
export const FilterChips = ({ param, options }: { param: string; options: ChipOption[] }) => {
  const [params] = useSearchParams();
  const current = params.get(param) ?? '';
  return (
    <div className="flex flex-wrap gap-1.5" role="group">
      {options.map(o => {
        const on = o.value === current;
        return (
          <Link
            key={o.value || 'all'}
            to={withParams(params, { [param]: o.value || null })}
            preventScrollReset
            aria-current={on ? 'true' : undefined}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors ${
              on
                ? 'bg-ink-0 text-panel border-ink-0'
                : 'border-line text-ink-2 bg-panel hover:text-ink-0 hover:border-line-strong'
            }`}
          >
            {o.label}
            {o.count !== undefined ? (
              <span className={`ml-1 tabular-nums ${on ? 'opacity-70' : 'text-ink-4'}`}>
                {o.count.toLocaleString()}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
};

/** A column header that sorts by `value` (second click flips direction). */
export const SortHeader = ({
  value,
  label,
  className = '',
  defaultDir = 'desc',
}: {
  value: string;
  label: string;
  className?: string;
  defaultDir?: 'asc' | 'desc';
}) => {
  const [params] = useSearchParams();
  const sort = params.get('sort') ?? '';
  const dir = params.get('dir') ?? defaultDir;
  const active = sort === value;
  const nextDir = active ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir;
  return (
    <th className={`font-semibold py-2 pr-3 ${className}`}>
      <Link
        to={withParams(params, { sort: value, dir: nextDir })}
        preventScrollReset
        className={`inline-flex items-center gap-1 hover:text-ink-1 ${active ? 'text-ink-1' : ''}`}
      >
        {label}
        {active ? <span aria-hidden>{dir === 'asc' ? '▲' : '▼'}</span> : null}
      </Link>
    </th>
  );
};

export const Pager = ({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}) => {
  const [params] = useSearchParams();
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const last = Math.max(1, Math.ceil(total / pageSize));
  const btn =
    'rounded-md border border-line px-2.5 py-0.5 text-xs font-medium text-ink-1 hover:bg-nav-hover';
  return (
    <div className="flex items-center justify-between pt-3 px-1 text-xs text-ink-3">
      <span className="tabular-nums">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex gap-1.5">
        {page > 1 ? (
          <Link to={withParams(params, { page: String(page - 1) })} className={btn}>
            ‹ Prev
          </Link>
        ) : null}
        {page < last ? (
          <Link to={withParams(params, { page: String(page + 1) })} className={btn}>
            Next ›
          </Link>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Search-as-you-type that keeps every other param (filters, sort) and resets
 * the page. A real GET form, so it works without JS.
 */
export const SearchBox = ({
  query,
  placeholder,
  label,
  className = 'sm:w-80',
}: {
  query: string;
  placeholder: string;
  label: string;
  className?: string;
}) => {
  const { inputRef, onSearchChange, searching } = useDebouncedSearch(query);
  const [params] = useSearchParams();
  const keep = [...params.entries()].filter(([k]) => k !== 'q' && k !== 'page');
  return (
    <Form method="get" className="min-w-0" onChange={onSearchChange}>
      {keep.map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className={`relative min-w-0 ${className}`}>
        <IconSearch
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4 pointer-events-none"
        />
        <input
          ref={inputRef}
          type="search"
          name="q"
          defaultValue={query}
          placeholder={placeholder}
          aria-label={label}
          className="w-full rounded-md border border-line bg-panel pl-9 pr-8 py-1.5 text-sm text-ink-0 placeholder:text-ink-4 focus:outline-none focus:border-line-strong"
        />
        {searching ? (
          <span
            aria-hidden
            className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-line-strong border-t-transparent animate-spin"
          />
        ) : null}
      </div>
    </Form>
  );
};

/** The current path + query, to carry into a detail page's back link. */
export const useReturnTo = () => {
  const location = useLocation();
  return `${location.pathname}${location.search}`;
};


// ───────── marks ─────────

const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

export const Avatar = ({
  name,
  image,
  size = 28,
}: {
  name: string | null;
  image?: string | null;
  size?: number;
}) =>
  image ? (
    <img
      src={image}
      alt=""
      className="rounded-full shrink-0"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="rounded-full shrink-0 bg-accent-soft text-accent-ink grid place-items-center font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initialsOf(name ?? '?')}
    </span>
  );

const ROLE_STYLE: Record<string, string> = {
  OWNER: 'chip chip-inprog',
  TEACHER: 'chip chip-upcoming',
  ASSISTANT: 'chip chip-upcoming',
  STUDENT: 'chip chip-upcoming',
  PENDING: 'chip chip-submitted',
};

export const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  TEACHER: 'Teacher',
  ASSISTANT: 'Assistant',
  STUDENT: 'Student',
  PENDING: 'Pending',
};

export const RoleChip = ({ role }: { role: string }) => (
  <span className={ROLE_STYLE[role] ?? 'chip chip-ghost'}>{ROLE_LABEL[role] ?? role}</span>
);

export const StatusChips = ({
  status,
  isArchived,
  isExample,
}: {
  status: string;
  isArchived: boolean;
  isExample?: boolean;
}) => (
  <>
    {isArchived ? <span className="chip chip-ghost">archived</span> : null}
    {status === 'LOCKED' ? <span className="chip chip-locked">locked</span> : null}
    {status === 'UNPUBLISHED' ? <span className="chip chip-upcoming">unpublished</span> : null}
    {isExample ? <span className="chip chip-ghost">example</span> : null}
  </>
);

/**
 * A small weekly sparkline: ink line, faint area, accent endpoint; the last
 * (partial) segment dashed so an unfinished week never reads as a drop.
 */
export const Sparkline = ({ values, label }: { values: number[]; label: string }) => {
  const W = 100;
  const H = 28;
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i * W) / (n - 1));
  const y = (v: number) => 2 + (H - 4) * (1 - v / max);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`);
  const full = pts.slice(0, Math.max(1, n - 1)).join(' ');
  const tail = n >= 2 ? `${pts[n - 2]} ${pts[n - 1]}` : '';
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-7 mt-1.5"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <polyline
        points={`0,${H} ${full} ${n >= 2 ? x(n - 2) : 0},${H}`}
        fill="var(--ink-0)"
        opacity={0.06}
      />
      <polyline points={full} fill="none" stroke="var(--ink-0)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {tail ? (
        <polyline
          points={tail}
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
};

export const Dot = ({ tone }: { tone: 'critical' | 'warning' | 'ok' | 'muted' }) => (
  <span
    aria-hidden
    className="inline-block w-2 h-2 rounded-full shrink-0"
    style={{
      background:
        tone === 'critical'
          ? 'var(--rose-ink)'
          : tone === 'warning'
            ? 'var(--amber-ink)'
            : tone === 'ok'
              ? 'var(--mint-ink)'
              : 'var(--line-strong)',
    }}
  />
);

export const TABLE_HEAD = 'text-left text-[11px] uppercase tracking-wider text-ink-4';
export const BTN_XS =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-nav-hover disabled:opacity-40 disabled:hover:bg-transparent';
export const BTN_PRIMARY_XS =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40';
