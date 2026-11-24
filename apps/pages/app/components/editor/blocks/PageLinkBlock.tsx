import React, { useState, useRef, useEffect } from 'react';
import { createReactBlockSpec, type ReactCustomBlockRenderProps } from '@blocknote/react';
import { pageLinkConfig } from '@classmoji/page-schema';
import { IconFileText } from '@tabler/icons-react';

import {
  classroomSlugFor,
  inAppPageHref,
  useReaderSurface,
} from '~/components/reader/readerSurface.ts';
import { isPlainPrimaryClick, pageLinkRender } from '~/utils/readerPayload.ts';
import { fieldBlockView, pageLinkMayFetch } from './readOnlyGates.ts';

/**
 * PageLink - Custom BlockNote block for linking to other pages in the classroom
 *
 * This block has three states:
 * 1. Empty state: Shows search input with dropdown of available pages
 * 2. Selected state: Shows clickable link with icon + page title
 * 3. Deleted state: Shows grayed-out link if referenced page no longer exists
 *
 * In the shared reader (`PageReader`, a read-only editor with a link map in
 * `ReaderSurfaceContext`) it is a real `<a href>` to the page, with the page's
 * live title, or nothing when the page is not one this viewer may open. No
 * router here: in-app navigation comes from the surface (`navigatePage`).
 */

/**
 * The reader's link. In the pages app it keeps the row the block has always
 * been — icon and title, the whole row clickable, the same colour and no
 * underline — now as a real `<a href>`. On the class site (and the page
 * render) it is the site's own markup, `div.page-link-display >
 * a.page-link-title`, so the site's stylesheet keeps serving it.
 * `data-kind`/`data-page-id` keep the embedded layout's click handler
 * (`routes/$classroomSlug/route.tsx`) able to take it over too.
 */
function ReaderPageLink({ href, title, pageId }: { href: string; title: string; pageId: string }) {
  const surface = useReaderSurface();
  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!surface.navigatePage || !isPlainPrimaryClick(event)) return;
    event.preventDefault();
    surface.navigatePage(pageId);
  };
  if (surface.surface === 'app') {
    return (
      <a
        className="page-link-display"
        contentEditable={false}
        href={href}
        data-kind="page"
        data-page-id={pageId}
        onClick={onClick}
      >
        <IconFileText size={18} className="page-link-display-icon" aria-hidden="true" />
        <span className="page-link-title">{title}</span>
      </a>
    );
  }
  return (
    <div className="page-link-display" contentEditable={false}>
      <a
        className="page-link-title"
        href={href}
        data-kind="page"
        data-page-id={pageId}
        onClick={onClick}
      >
        {title}
      </a>
    </div>
  );
}

/**
 * Dropdown component showing filtered list of pages
 */
interface PageLinkPage {
  id: string;
  title: string;
}

interface PageLinkDropdownProps {
  pages: PageLinkPage[];
  searchQuery: string;
  onSelect: (page: PageLinkPage) => void;
  onClose: () => void;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  isLoading: boolean;
}

const PageLinkDropdown = ({
  pages,
  searchQuery,
  onSelect,
  onClose,
  dropdownRef,
  isLoading,
}: PageLinkDropdownProps) => {
  const filteredPages = pages.filter(page =>
    page.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, dropdownRef]);

  return (
    <div className="page-link-dropdown" ref={dropdownRef}>
      <div className="page-link-dropdown-header">Select a page</div>
      <div className="page-link-dropdown-list">
        {isLoading ? (
          <div className="page-link-no-results">Loading pages...</div>
        ) : filteredPages.length === 0 ? (
          <div className="page-link-no-results">No pages found</div>
        ) : (
          filteredPages.map(page => (
            <button
              key={page.id}
              onClick={() => onSelect(page)}
              className="page-link-dropdown-item"
            >
              <div className="page-link-item-content">
                <div className="page-link-item-title">{page.title || 'Untitled'}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

/**
 * Empty state component with search input
 */
interface EmptyStateProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  filteredPages: PageLinkPage[];
  onSelectPage: (page: PageLinkPage) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  isLoading: boolean;
}

const EmptyState = ({
  searchQuery,
  setSearchQuery,
  isOpen,
  setIsOpen,
  filteredPages,
  onSelectPage,
  inputRef,
  dropdownRef,
  isLoading,
}: EmptyStateProps) => {
  return (
    <div className="page-link-empty" contentEditable={false}>
      <div className="page-link-input-wrapper">
        <IconFileText size={20} className="page-link-icon" />
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          placeholder={isLoading ? 'Loading pages...' : 'Link to page...'}
          className="page-link-input"
          autoFocus
          disabled={isLoading}
        />
      </div>

      {isOpen && (
        <PageLinkDropdown
          pages={filteredPages}
          searchQuery={searchQuery}
          onSelect={onSelectPage}
          onClose={() => setIsOpen(false)}
          dropdownRef={dropdownRef}
          isLoading={isLoading}
        />
      )}
    </div>
  );
};

/**
 * Selected state component showing the page link
 */
interface SelectedStateProps {
  pageId: string;
  pageTitle: string;
  pageExists: boolean;
  onClickLink: (e: React.MouseEvent | React.KeyboardEvent) => void;
}

const SelectedState = ({
  pageId: _pageId,
  pageTitle,
  pageExists,
  onClickLink,
}: SelectedStateProps) => {
  if (!pageExists) {
    // Deleted page state
    return (
      <div className="page-link-display page-link-deleted" contentEditable={false}>
        <IconFileText size={16} className="page-link-display-icon" />
        <span className="page-link-title page-link-deleted-text">{pageTitle} (deleted)</span>
      </div>
    );
  }

  // Normal link state
  return (
    <div
      className="page-link-display"
      contentEditable={false}
      onClick={onClickLink}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClickLink(e);
        }
      }}
    >
      <IconFileText size={18} className="page-link-display-icon" />
      <span className="page-link-title">{pageTitle || 'Untitled'}</span>
    </div>
  );
};

type PageLinkRenderProps = ReactCustomBlockRenderProps<typeof pageLinkConfig>;

export const PageLink = createReactBlockSpec(pageLinkConfig, {
  render: function PageLinkRenderer(props: PageLinkRenderProps) {
    const { pageId, pageTitle } = props.block.props;
    const [isOpen, setIsOpen] = useState(!pageId);
    const [searchQuery, setSearchQuery] = useState('');
    const [availablePages, setAvailablePages] = useState<PageLinkPage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [currentPageId, setCurrentPageId] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const surface = useReaderSurface();
    // The page picker is an author's: a reader never searches, and never asks
    // `/api/pages/…` for the classroom's pages.
    const editable = props.editor.isEditable;

    // Get current page ID from URL
    useEffect(() => {
      if (typeof window !== 'undefined') {
        const pathParts = window.location.pathname.split('/');
        const currentId = pathParts[2]; // classroomSlug is [1], pageId is [2]
        setCurrentPageId(currentId || '');
      }
    }, []);

    // Fetch pages when dropdown opens
    useEffect(() => {
      if (
        pageLinkMayFetch({
          editable,
          open: isOpen,
          loaded: availablePages.length > 0,
          loading: isLoading,
        }) &&
        typeof window !== 'undefined'
      ) {
        const classroomSlug = classroomSlugFor(surface);
        if (!classroomSlug) return;

        setIsLoading(true);
        fetch(`/api/pages/${classroomSlug}`)
          .then(res => res.json())
          .then(data => {
            setAvailablePages(data.pages || []);
            setIsLoading(false);
          })
          .catch(err => {
            console.error('Failed to fetch pages:', err);
            setIsLoading(false);
          });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the slug is read once per open
    }, [editable, isOpen, availablePages.length, isLoading]);

    // Focus input when block is first inserted (empty state)
    useEffect(() => {
      if (editable && !pageId && inputRef.current) {
        // Small delay to ensure the block is fully rendered
        const timer = setTimeout(() => {
          inputRef.current?.focus();
        }, 10);
        return () => clearTimeout(timer);
      }
    }, [editable, pageId]);

    // Filter pages: exclude current page, apply search
    const filteredPages = availablePages.filter(p => p.id !== currentPageId);

    const handleSelectPage = (page: PageLinkPage) => {
      props.editor.updateBlock(props.block, {
        props: {
          pageId: page.id,
          pageTitle: page.title || 'Untitled',
        },
      });
      setIsOpen(false);
      setSearchQuery('');
    };

    const handleClickLink = (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();
      if (surface.navigatePage) {
        surface.navigatePage(pageId);
        return;
      }
      if (typeof window !== 'undefined') {
        // No router on this surface: a plain navigation. Preserve the embed
        // context (embed/parentOrigin/theme) when the block is clicked inside
        // the webapp's reader, and stay bare in the canonical editor —
        // buildEmbeddedPageHref forwards, never forces, `embed`. No classroom
        // to build it from: no navigation at all.
        const href = inAppPageHref(classroomSlugFor(surface), pageId, window.location.search);
        if (href) window.location.assign(href);
      }
    };

    // The shared reader: a real link from the viewer's map, or nothing.
    if (!editable) {
      const reader = pageLinkRender(surface.links, pageId, pageTitle);
      if (reader.kind === 'nothing') return null;
      if (reader.kind === 'link') {
        return <ReaderPageLink href={reader.href} title={reader.title} pageId={reader.pageId} />;
      }
    }

    // Empty state - no page selected yet. A reader of an empty link gets
    // nothing: the search box is an author's.
    const view = fieldBlockView(editable, Boolean(pageId));
    if (view === 'nothing') return null;
    if (view === 'empty-state') {
      return (
        <EmptyState
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          isOpen={isOpen}
          setIsOpen={setIsOpen}
          filteredPages={filteredPages}
          onSelectPage={handleSelectPage}
          inputRef={inputRef}
          dropdownRef={dropdownRef}
          isLoading={isLoading}
        />
      );
    }

    // Selected state - page has been chosen
    const pageExists = availablePages.length === 0 || availablePages.some(p => p.id === pageId);
    return (
      <SelectedState
        pageId={pageId}
        pageTitle={pageTitle}
        pageExists={pageExists}
        onClickLink={handleClickLink}
      />
    );
  },
});
