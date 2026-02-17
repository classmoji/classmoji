import { createReactBlockSpec } from '@blocknote/react';
import { IconFileText, IconArrowRight } from '@tabler/icons-react';
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';

/**
 * PageLink - Custom BlockNote block for linking to other pages in the classroom
 *
 * This block has three states:
 * 1. Empty state: Shows search input with dropdown of available pages
 * 2. Selected state: Shows clickable link with icon + page title
 * 3. Deleted state: Shows grayed-out link if referenced page no longer exists
 */

/**
 * Dropdown component showing filtered list of pages
 */
const PageLinkDropdown = ({ pages, searchQuery, onSelect, onClose, dropdownRef, isLoading }) => {
  const filteredPages = pages.filter(page =>
    page.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
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
const EmptyState = ({ searchQuery, setSearchQuery, isOpen, setIsOpen, filteredPages, onSelectPage, inputRef, dropdownRef, isLoading }) => {
  return (
    <div className="page-link-empty" contentEditable={false}>
      <div className="page-link-input-wrapper">
        <IconFileText size={20} className="page-link-icon" />
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          placeholder={isLoading ? "Loading pages..." : "Link to page..."}
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
const SelectedState = ({ pageId, pageTitle, pageExists, onClickLink }) => {
  if (!pageExists) {
    // Deleted page state
    return (
      <div className="page-link-display page-link-deleted" contentEditable={false}>
        <IconFileText size={16} className="page-link-display-icon" />
        <span className="page-link-title page-link-deleted-text">
          {pageTitle} (deleted)
        </span>
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
      onKeyDown={(e) => {
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

export const PageLink = createReactBlockSpec(
  {
    type: 'pageLink',
    propSchema: {
      pageId: { default: '' },
      pageTitle: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const { pageId, pageTitle } = props.block.props;
      const [isOpen, setIsOpen] = useState(!pageId);
      const [searchQuery, setSearchQuery] = useState('');
      const [availablePages, setAvailablePages] = useState([]);
      const [isLoading, setIsLoading] = useState(false);
      const [currentPageId, setCurrentPageId] = useState('');
      const inputRef = useRef(null);
      const dropdownRef = useRef(null);
      const navigate = useNavigate();

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
        if (isOpen && availablePages.length === 0 && !isLoading && typeof window !== 'undefined') {
          const classroomSlug = window.location.pathname.split('/')[1];

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
      }, [isOpen, availablePages.length, isLoading]);

      // Focus input when block is first inserted (empty state)
      useEffect(() => {
        if (!pageId && inputRef.current) {
          // Small delay to ensure the block is fully rendered
          const timer = setTimeout(() => {
            inputRef.current?.focus();
          }, 10);
          return () => clearTimeout(timer);
        }
      }, [pageId]);

      // Filter pages: exclude current page, apply search
      const filteredPages = availablePages.filter(p => p.id !== currentPageId);

      const handleSelectPage = (page) => {
        props.editor.updateBlock(props.block, {
          props: {
            pageId: page.id,
            pageTitle: page.title || 'Untitled',
          },
        });
        setIsOpen(false);
        setSearchQuery('');
      };

      const handleClickLink = (e) => {
        e.preventDefault();
        if (typeof window !== 'undefined') {
          const classroomSlug = window.location.pathname.split('/')[1];
          navigate(`/${classroomSlug}/${pageId}`);
        }
      };

      // Empty state - no page selected yet
      if (!pageId) {
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
  }
);
