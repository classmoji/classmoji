import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createReactBlockSpec, type ReactCustomBlockRenderProps } from '@blocknote/react';
import {
  IconArrowUp,
  IconArrowDown,
  IconExternalLink,
  IconFileText,
  IconLayoutColumns,
  IconPlus,
  IconX,
} from '@tabler/icons-react';

import {
  NAV_GRID_EMPTY_ENTRIES,
  moveNavGridEntry,
  navGridEntryLabel,
  normalizeNavGridColumns,
  parseNavGridEntries,
  sanitizeNavGridUrl,
  serializeNavGridEntries,
  type NavGridColumns,
  type NavGridEntry,
} from './navGridShared.ts';

/**
 * NavGrid ("Page directory") — the navigation block for class websites.
 *
 * Instructors author a grid of links (pages in this classroom + external URLs)
 * and that authored hub *is* the site's navigation — nav is content, not config.
 *
 * Storage: `entries` is a JSON **string** (BlockNote props must be primitives).
 * Parsing lives in `./navGridShared.ts` so the site renderer shares it.
 *
 * Rendering has two shapes:
 * - interactive (editor, in a real browser) — pickers, inline edits, reorder
 * - static (SSR via `blocksToFullHTML`, read-only editor, `toExternalHTML`) —
 *   semantic `<nav><a>` markup. Page anchors emit `href="#"` + `data-page-id`;
 *   the site renderer overrides this block and resolves real hrefs per viewer.
 *
 * NOTE: `editor.isEditable` is `true` inside `ServerBlockNoteEditor`, so it is
 * NOT sufficient to detect the browser. Interactivity is additionally gated on
 * a mount effect (effects don't flush before the server serializes).
 */

interface DirectoryPage {
  id: string;
  title: string;
  slug?: string;
  is_draft?: boolean;
  is_public?: boolean;
}

/* ------------------------------------------------------------------ *
 * Static render — shared by SSR, read-only editor, and toExternalHTML
 * ------------------------------------------------------------------ */

export function NavGridStatic({
  entries,
  columns,
}: {
  entries: NavGridEntry[];
  columns: NavGridColumns;
}) {
  return (
    <nav
      // `bn-nav-grid` is the documented contract class, but BlockNote's
      // `toExternalHTML` exporter strips `bn-*` classes from the ROOT element
      // (verified against @blocknote/core 0.46 — children are left alone), so
      // `nav-grid` rides along as the hook that survives every export path.
      className="bn-nav-grid nav-grid"
      data-columns={columns}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {entries.map((entry, index) =>
        entry.kind === 'page' ? (
          // Placeholder href: consumers (the class-site renderer) resolve the
          // real per-viewer URL from data-page-id. Part of the export contract.
          // eslint-disable-next-line jsx-a11y/anchor-is-valid -- resolved downstream
          <a
            key={`page-${entry.pageId}-${index}`}
            className="bn-nav-grid-item"
            data-kind="page"
            data-page-id={entry.pageId}
            href="#"
          >
            {entry.emoji ? (
              <span className="bn-nav-grid-emoji" aria-hidden="true">
                {entry.emoji}
              </span>
            ) : null}
            <span className="bn-nav-grid-label">{navGridEntryLabel(entry)}</span>
          </a>
        ) : (
          <a
            key={`external-${index}`}
            className="bn-nav-grid-item"
            data-kind="external"
            href={entry.url}
            rel="noopener noreferrer"
          >
            {entry.emoji ? (
              <span className="bn-nav-grid-emoji" aria-hidden="true">
                {entry.emoji}
              </span>
            ) : null}
            <span className="bn-nav-grid-label">{navGridEntryLabel(entry)}</span>
            <span className="bn-nav-grid-ext" aria-hidden="true">
              ↗
            </span>
          </a>
        )
      )}
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Page picker (same data source + look as the pageLink block)
 * ------------------------------------------------------------------ */

interface PagePickerProps {
  pages: DirectoryPage[];
  isLoading: boolean;
  onSelect: (page: DirectoryPage) => void;
  onClose: () => void;
  /** The button row the dropdown hangs beneath; anchors the portal's position. */
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

function PagePicker({ pages, isLoading, onSelect, onClose, anchorRef }: PagePickerProps) {
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The dropdown is portaled to <body> so it escapes BlockNote's per-block
  // stacking contexts — an absolutely-positioned dropdown inside the block is
  // painted over by whatever block follows, regardless of its z-index. Position
  // it under the anchor with fixed coords and keep it attached on scroll/resize.
  useEffect(() => {
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 8, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorRef]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Neither the portaled dropdown nor the anchor buttons (which manage their
      // own open/close) count as "outside".
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        anchorRef.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, anchorRef]);

  const filtered = pages.filter(page =>
    (page.title || 'Untitled').toLowerCase().includes(query.toLowerCase())
  );

  const dropdown = (
    <div
      className="page-link-dropdown nav-grid-picker nav-grid-picker-portal"
      ref={containerRef}
      style={
        pos
          ? { position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }
          : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
      }
    >
      <div className="page-link-dropdown-header">Select a page</div>
      <div className="nav-grid-picker-search">
        <IconFileText size={16} className="page-link-icon" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder={isLoading ? 'Loading pages...' : 'Search pages...'}
          className="page-link-input"
        />
      </div>
      <div className="page-link-dropdown-list">
        {isLoading ? (
          <div className="page-link-no-results">Loading pages...</div>
        ) : filtered.length === 0 ? (
          <div className="page-link-no-results">No pages found</div>
        ) : (
          filtered.map(page => (
            <button
              key={page.id}
              type="button"
              className="page-link-dropdown-item"
              onClick={() => onSelect(page)}
            >
              <div className="page-link-item-content">
                <div className="page-link-item-title">{page.title || 'Untitled'}</div>
              </div>
              {page.is_draft ? (
                <span className="nav-grid-badge nav-grid-badge-draft">Draft</span>
              ) : page.is_public === false ? (
                <span className="nav-grid-badge">Members</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );

  return typeof document === 'undefined' ? dropdown : createPortal(dropdown, document.body);
}

/* ------------------------------------------------------------------ *
 * External link form (draft state lives here, never in the block prop —
 * a half-typed URL would be dropped by the parser mid-keystroke)
 * ------------------------------------------------------------------ */

interface ExternalFormValue {
  /** null = appending a new entry; number = editing the entry at that index. */
  index: number | null;
  url: string;
  label: string;
}

interface ExternalFormProps {
  value: ExternalFormValue;
  onChange: (value: ExternalFormValue) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error: string;
}

function ExternalForm({ value, onChange, onSubmit, onCancel, error }: ExternalFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="nav-grid-form">
      <div className="nav-grid-form-row">
        <input
          ref={inputRef}
          value={value.url}
          onChange={e => onChange({ ...value, url: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="https://example.com"
          className="nav-grid-form-input"
          aria-label="Link URL"
        />
        <input
          value={value.label}
          onChange={e => onChange({ ...value, label: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="Label"
          className="nav-grid-form-input nav-grid-form-input-label"
          aria-label="Link label"
        />
        <button type="button" className="nav-grid-btn nav-grid-btn-primary" onClick={onSubmit}>
          {value.index === null ? 'Add' : 'Save'}
        </button>
        <button type="button" className="nav-grid-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error ? <div className="nav-grid-form-error">{error}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Interactive entry row
 * ------------------------------------------------------------------ */

interface EntryRowProps {
  entry: NavGridEntry;
  index: number;
  total: number;
  page?: DirectoryPage;
  pagesLoaded: boolean;
  isEditingLabel: boolean;
  labelDraft: string;
  onLabelDraftChange: (value: string) => void;
  onStartLabelEdit: () => void;
  onCommitLabel: () => void;
  onCancelLabel: () => void;
  onEmojiChange: (emoji: string) => void;
  onEditExternal: () => void;
  onChangePage: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}

function EntryRow({
  entry,
  index,
  total,
  page,
  pagesLoaded,
  isEditingLabel,
  labelDraft,
  onLabelDraftChange,
  onStartLabelEdit,
  onCommitLabel,
  onCancelLabel,
  onEmojiChange,
  onEditExternal,
  onChangePage,
  onMove,
  onRemove,
}: EntryRowProps) {
  const isPage = entry.kind === 'page';
  const missing = isPage && pagesLoaded && !page;
  const membersOnly = isPage && !missing && page?.is_public === false && !page?.is_draft;
  const draft = isPage && !missing && page?.is_draft === true;

  return (
    <div className={`nav-grid-row${missing ? ' nav-grid-row-missing' : ''}`}>
      <input
        className="nav-grid-emoji-input"
        value={entry.emoji || ''}
        onChange={e => onEmojiChange(e.target.value)}
        maxLength={2}
        placeholder="＋"
        aria-label="Entry emoji"
        title="Emoji (optional)"
      />

      {isEditingLabel ? (
        <input
          className="nav-grid-label-input"
          value={labelDraft}
          autoFocus
          onChange={e => onLabelDraftChange(e.target.value)}
          onBlur={onCommitLabel}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommitLabel();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancelLabel();
            }
          }}
          aria-label="Entry label"
        />
      ) : (
        <button
          type="button"
          className="nav-grid-label-btn"
          onClick={onStartLabelEdit}
          title="Rename this entry"
        >
          {navGridEntryLabel(entry)}
        </button>
      )}

      {missing ? <span className="nav-grid-badge nav-grid-badge-missing">Missing</span> : null}
      {draft ? <span className="nav-grid-badge nav-grid-badge-draft">Draft</span> : null}
      {membersOnly ? <span className="nav-grid-badge">Members</span> : null}

      {entry.kind === 'external' ? (
        <button
          type="button"
          className="nav-grid-icon-btn nav-grid-ext-btn"
          onClick={onEditExternal}
          title={entry.url}
          aria-label="Edit link URL"
        >
          <IconExternalLink size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="nav-grid-icon-btn nav-grid-ext-btn"
          onClick={onChangePage}
          aria-label="Change linked page"
          title="Change linked page"
        >
          <IconFileText size={14} />
        </button>
      )}

      <div className="nav-grid-row-actions">
        <button
          type="button"
          className="nav-grid-icon-btn"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label="Move up"
          title="Move up"
        >
          <IconArrowUp size={14} />
        </button>
        <button
          type="button"
          className="nav-grid-icon-btn"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          aria-label="Move down"
          title="Move down"
        >
          <IconArrowDown size={14} />
        </button>
        <button
          type="button"
          className="nav-grid-icon-btn nav-grid-icon-btn-danger"
          onClick={onRemove}
          aria-label="Remove entry"
          title="Remove"
        >
          <IconX size={14} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Block spec
 * ------------------------------------------------------------------ */

const navGridPropSchema = {
  /** JSON string — see navGridShared.ts for the entry shape. */
  entries: { default: NAV_GRID_EMPTY_ENTRIES },
  columns: { default: 2, values: [1, 2] },
};

type NavGridRenderProps = ReactCustomBlockRenderProps<'navGrid', typeof navGridPropSchema, 'none'>;

const navGridImplementation = {
  toExternalHTML: function NavGridExternalHTML(props: NavGridRenderProps) {
    const entries = parseNavGridEntries(props.block.props.entries);
    const columns = normalizeNavGridColumns(props.block.props.columns);
    return <NavGridStatic entries={entries} columns={columns} />;
  },

  render: function NavGridRenderer(props: NavGridRenderProps) {
    const entries = useMemo(
      () => parseNavGridEntries(props.block.props.entries),
      [props.block.props.entries]
    );
    const columns = normalizeNavGridColumns(props.block.props.columns);

    // `isEditable` is true inside ServerBlockNoteEditor, so we also require a
    // real mount — effects don't run before the server serializes the HTML.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const interactive = mounted && props.editor.isEditable;

    const [pages, setPages] = useState<DirectoryPage[]>([]);
    const [pagesLoaded, setPagesLoaded] = useState(false);
    const [pagesLoading, setPagesLoading] = useState(false);
    const [currentPageId, setCurrentPageId] = useState('');

    const [pickerTarget, setPickerTarget] = useState<{ index: number | null } | null>(null);
    // Anchor for the portaled page picker — the action-button row it drops under.
    const actionsRef = useRef<HTMLDivElement>(null);
    const [externalForm, setExternalForm] = useState<ExternalFormValue | null>(null);
    const [formError, setFormError] = useState('');
    const [labelEditIndex, setLabelEditIndex] = useState<number | null>(null);
    const [labelDraft, setLabelDraft] = useState('');

    // Fetch the classroom's page list once, in the browser only. Powers the
    // picker, the Members/Draft badges, and missing-page detection.
    //
    // The one-shot guard is a ref, and `interactive` is the only dep: keying
    // this off the loading/loaded state instead would re-run the effect the
    // moment `setPagesLoading(true)` lands, and the re-run's cleanup would
    // cancel the very fetch that just started (page list stays empty forever).
    const fetchStartedRef = useRef(false);
    useEffect(() => {
      if (!interactive || fetchStartedRef.current) return;
      if (typeof window === 'undefined') return;

      const classroomSlug = window.location.pathname.split('/')[1];
      setCurrentPageId(window.location.pathname.split('/')[2] || '');
      if (!classroomSlug) return;

      fetchStartedRef.current = true;
      setPagesLoading(true);
      let cancelled = false;
      (async () => {
        try {
          const res = await fetch(`/api/pages/${classroomSlug}`);
          const data = await res.json();
          if (cancelled) return;
          setPages(Array.isArray(data?.pages) ? data.pages : []);
        } catch (err) {
          console.error('[navGrid] Failed to fetch pages:', err);
        } finally {
          if (!cancelled) {
            setPagesLoading(false);
            setPagesLoaded(true);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [interactive]);

    const pagesById = useMemo(() => {
      const map = new Map<string, DirectoryPage>();
      for (const page of pages) map.set(page.id, page);
      return map;
    }, [pages]);

    // Only ever called from a direct user action — a write on mount would
    // register as an unsaved edit against the editor's diff baseline.
    const commitEntries = useCallback(
      (next: NavGridEntry[]) => {
        props.editor.updateBlock(props.block, {
          props: { entries: serializeNavGridEntries(next) },
        });
      },
      [props.editor, props.block]
    );

    const setColumns = (value: NavGridColumns) => {
      props.editor.updateBlock(props.block, { props: { columns: value } });
    };

    const handleSelectPage = (page: DirectoryPage) => {
      const target = pickerTarget;
      setPickerTarget(null);
      if (!target) return;

      if (target.index === null) {
        commitEntries([
          ...entries,
          { kind: 'page', pageId: page.id, title: page.title || 'Untitled' },
        ]);
        return;
      }
      commitEntries(
        entries.map((entry, i) =>
          i === target.index
            ? {
                kind: 'page' as const,
                pageId: page.id,
                title: page.title || 'Untitled',
                ...(entry.emoji ? { emoji: entry.emoji } : {}),
              }
            : entry
        )
      );
    };

    const handleSubmitExternal = () => {
      if (!externalForm) return;
      const url = sanitizeNavGridUrl(externalForm.url);
      if (!url) {
        setFormError('Enter a valid http(s) or mailto link.');
        return;
      }
      const label = externalForm.label.trim();

      if (externalForm.index === null) {
        commitEntries([...entries, { kind: 'external', url, label }]);
      } else {
        const target = entries[externalForm.index];
        commitEntries(
          entries.map((entry, i) =>
            i === externalForm.index
              ? {
                  kind: 'external' as const,
                  url,
                  label,
                  ...(target?.emoji ? { emoji: target.emoji } : {}),
                }
              : entry
          )
        );
      }
      setExternalForm(null);
      setFormError('');
    };

    const handleEmojiChange = (index: number, raw: string) => {
      const emoji = raw.trim();
      const next = entries.map((entry, i) => {
        if (i !== index) return entry;
        const copy = { ...entry } as NavGridEntry;
        if (emoji) copy.emoji = emoji;
        else delete copy.emoji;
        return copy;
      });
      commitEntries(next);
    };

    const commitLabel = () => {
      if (labelEditIndex === null) return;
      const index = labelEditIndex;
      const value = labelDraft.trim();
      setLabelEditIndex(null);
      setLabelDraft('');
      if (!entries[index]) return;

      commitEntries(
        entries.map((entry, i) => {
          if (i !== index) return entry;
          return entry.kind === 'page' ? { ...entry, title: value } : { ...entry, label: value };
        })
      );
    };

    /* ---------- static render (SSR, export, read-only editor) ---------- */
    if (!interactive) {
      return (
        <div className="nav-grid-block" contentEditable={false}>
          <NavGridStatic entries={entries} columns={columns} />
        </div>
      );
    }

    /* ---------------------- interactive render ------------------------ */
    const pickerPages = pages.filter(page => page.id !== currentPageId);

    return (
      <div className="nav-grid-block nav-grid-block-editing" contentEditable={false}>
        <div className="nav-grid-toolbar">
          <span className="nav-grid-toolbar-title">
            <IconLayoutColumns size={14} />
            Page directory
          </span>
          <div className="nav-grid-cols" role="group" aria-label="Columns">
            {([1, 2] as NavGridColumns[]).map(value => (
              <button
                key={value}
                type="button"
                className={`nav-grid-col-btn${columns === value ? ' is-active' : ''}`}
                onClick={() => setColumns(value)}
                aria-pressed={columns === value}
                title={`${value} column${value === 1 ? '' : 's'}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        {entries.length === 0 ? (
          <div className="nav-grid-empty-state">Add your first link</div>
        ) : (
          <div
            className="nav-grid-rows"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {entries.map((entry, index) => (
              <EntryRow
                key={`${entry.kind}-${index}`}
                entry={entry}
                index={index}
                total={entries.length}
                page={entry.kind === 'page' ? pagesById.get(entry.pageId) : undefined}
                pagesLoaded={pagesLoaded}
                isEditingLabel={labelEditIndex === index}
                labelDraft={labelDraft}
                onLabelDraftChange={setLabelDraft}
                onStartLabelEdit={() => {
                  setLabelEditIndex(index);
                  setLabelDraft(
                    entry.kind === 'page' ? entry.title : entry.label || navGridEntryLabel(entry)
                  );
                }}
                onCommitLabel={commitLabel}
                onCancelLabel={() => {
                  setLabelEditIndex(null);
                  setLabelDraft('');
                }}
                onEmojiChange={value => handleEmojiChange(index, value)}
                onEditExternal={() => {
                  if (entry.kind !== 'external') return;
                  setPickerTarget(null);
                  setFormError('');
                  setExternalForm({ index, url: entry.url, label: entry.label });
                }}
                onChangePage={() => {
                  setExternalForm(null);
                  setPickerTarget({ index });
                }}
                onMove={delta => commitEntries(moveNavGridEntry(entries, index, index + delta))}
                onRemove={() => commitEntries(entries.filter((_, i) => i !== index))}
              />
            ))}
          </div>
        )}

        {externalForm ? (
          <ExternalForm
            value={externalForm}
            onChange={value => {
              setExternalForm(value);
              setFormError('');
            }}
            onSubmit={handleSubmitExternal}
            onCancel={() => {
              setExternalForm(null);
              setFormError('');
            }}
            error={formError}
          />
        ) : null}

        <div className="nav-grid-actions" ref={actionsRef}>
          <button
            type="button"
            className="nav-grid-btn"
            onClick={() => {
              setExternalForm(null);
              setPickerTarget({ index: null });
            }}
          >
            <IconPlus size={14} />
            Add page link
          </button>
          <button
            type="button"
            className="nav-grid-btn"
            onClick={() => {
              setPickerTarget(null);
              setFormError('');
              setExternalForm({ index: null, url: '', label: '' });
            }}
          >
            <IconPlus size={14} />
            Add external link
          </button>

          {pickerTarget ? (
            <PagePicker
              pages={pickerPages}
              isLoading={pagesLoading}
              onSelect={handleSelectPage}
              onClose={() => setPickerTarget(null)}
              anchorRef={actionsRef}
            />
          ) : null}
        </div>
      </div>
    );
  },
};

/**
 * The block's editor view, exported so it can be mounted directly (tests,
 * or any surface that wants the interactive hub without a BlockNote node view).
 */
export const NavGridBlockView = navGridImplementation.render;

export const NavGrid = createReactBlockSpec(
  {
    type: 'navGrid' as const,
    propSchema: navGridPropSchema,
    content: 'none' as const,
  },
  navGridImplementation
);
