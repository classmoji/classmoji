import { useState, useCallback, useEffect } from 'react';
import { Select, Input, Modal, Dropdown, Popconfirm, Collapse, Switch } from 'antd';
import { PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import { BUILTIN_THEMES } from '../../RevealSlides';

const { TextArea } = Input;

/**
 * SlideProperties - Property editor for slide sections
 *
 * Allows configuring slide-level settings:
 * - Layout (single column, 2 columns, etc.)
 * - Vertical alignment
 * - Custom Code (Snippets & CSS Themes)
 *
 * When a multi-column layout is selected, columns are automatically
 * created with labels. Existing content is moved to the first column.
 */

// Layout options - these apply CSS Grid to the section
const LAYOUT_OPTIONS = [
  { value: '', label: 'Default (Single Column)' },
  { value: 'two-columns', label: '2 Columns (Equal)' },
  { value: 'two-columns-left', label: '2 Columns (Left Wide)' },
  { value: 'two-columns-right', label: '2 Columns (Right Wide)' },
  { value: 'three-columns', label: '3 Columns' },
];

// Vertical alignment options
const VALIGN_OPTIONS = [
  { value: '', label: 'Default (Center)' },
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Center' },
  { value: 'bottom', label: 'Bottom' },
];

// CSS class mappings for layouts
const LAYOUT_CLASSES = {
  '': '',
  'two-columns': 'slide-layout-2col',
  'two-columns-left': 'slide-layout-2col-left',
  'two-columns-right': 'slide-layout-2col-right',
  'three-columns': 'slide-layout-3col',
};

// Expected column count for each layout
const LAYOUT_COLUMN_COUNT = {
  '': 1,
  'two-columns': 2,
  'two-columns-left': 2,
  'two-columns-right': 2,
  'three-columns': 3,
};

// Code syntax highlighting themes (highlight.js)
const CODE_THEMES = [
  { value: 'github-dark', label: 'GitHub Dark' },
  { value: 'github', label: 'GitHub Light' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'atom-one-dark', label: 'Atom One Dark' },
  { value: 'vs2015', label: 'VS 2015' },
  { value: 'dracula', label: 'Dracula' },
];

// Built-in theme options for dropdown
const builtInThemeOptions = BUILTIN_THEMES.map(t => ({
  label: t.charAt(0).toUpperCase() + t.slice(1),
  value: t,
}));

export default function SlideProperties({ element }) {
  const { onContentChange, setActiveColumn, getThemes, setTheme, snippets, onSaveSnippet, onUpdateSnippet, onDeleteSnippet, cssThemes, onSaveTheme, onUpdateTheme, onDeleteTheme, customThemes = [], sharedThemes = [] } = useElementSelection();

  // Build theme options: shared themes FIRST, then custom CSS themes, then built-in themes
  const themeOptions = [
    // Shared themes from slides.com imports (complete theme packages)
    ...sharedThemes.map(t => ({
      label: `📦 ${t.name}`,
      value: t.id,
    })),
    // Custom CSS themes
    ...customThemes.map(t => ({
      label: `${t.name} ★`,
      value: t.id,
    })),
    // Built-in reveal.js themes
    ...builtInThemeOptions,
  ];

  const [layout, setLayout] = useState(() => detectLayout(element));
  const [valign, setValign] = useState(() => element?.dataset.verticalAlign || '');
  const [isHidden, setIsHidden] = useState(() => element?.dataset.hidden === 'true');

  // Snippet modal state (for both create and edit)
  const [showSnippetModal, setShowSnippetModal] = useState(false);
  const [snippetName, setSnippetName] = useState('');
  const [snippetHtml, setSnippetHtml] = useState('');
  // When editing, store the original snippet id
  const [editingSnippetId, setEditingSnippetId] = useState(/** @type {string | null} */ (null));

  // CSS Theme modal state (for both create and edit)
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [themeName, setThemeName] = useState('');
  const [themeType, setThemeType] = useState(/** @type {'light' | 'dark'} */ ('light'));
  const [themeCss, setThemeCss] = useState('');
  // When editing, store the original theme id
  const [editingThemeId, setEditingThemeId] = useState(/** @type {string | null} */ (null));

  // Presentation theme state (from context) - single theme
  const [currentTheme, setCurrentTheme] = useState(() => getThemes().theme || 'white');
  const [currentCodeTheme, setCurrentCodeTheme] = useState(() => getThemes().codeTheme || 'github');

  // Detect current layout from element classes
  function detectLayout(el) {
    if (!el) return '';
    for (const [key, className] of Object.entries(LAYOUT_CLASSES)) {
      if (className && el.classList.contains(className)) {
        return key;
      }
    }
    return '';
  }

  // Sync state when element changes
  useEffect(() => {
    if (element) {
      setLayout(detectLayout(element));
      setValign(element.dataset.verticalAlign || '');
      setIsHidden(element.dataset.hidden === 'true');
      // Ensure column labels are set on existing columns
      updateColumnLabels(element);
    }
    // Sync theme state from context
    const themes = getThemes();
    setCurrentTheme(themes.theme || 'white');
    setCurrentCodeTheme(themes.codeTheme || 'github');
  }, [element, getThemes]);

  // Add data-column-label attributes to column divs
  function updateColumnLabels(el) {
    if (!el) return;
    const columns = el.querySelectorAll(':scope > div');
    columns.forEach((col, i) => {
      col.setAttribute('data-column-label', `Column ${i + 1}`);
    });
  }

  // Update layout - automatically creates column divs when switching to multi-column
  const handleLayoutChange = useCallback((newLayout) => {
    if (!element) return;

    const previousLayout = detectLayout(element);
    const wasMultiColumn = previousLayout !== '';
    const isNowMultiColumn = newLayout !== '';

    // Remove all layout classes
    Object.values(LAYOUT_CLASSES).forEach(cls => {
      if (cls) element.classList.remove(cls);
    });

    // Add new layout class
    const newClass = LAYOUT_CLASSES[newLayout];
    if (newClass) {
      element.classList.add(newClass);
    }

    // If switching TO a multi-column layout, automatically set up columns
    if (isNowMultiColumn && !wasMultiColumn) {
      const expectedCount = LAYOUT_COLUMN_COUNT[newLayout] || 2;
      const existingDivs = element.querySelectorAll(':scope > div').length;

      if (existingDivs < expectedCount) {
        // Get all existing content (non-div direct children)
        const existingContent = Array.from(element.children).filter(
          child => child.tagName !== 'DIV'
        );

        // Create first column with existing content
        let firstColumn;
        if (existingContent.length > 0) {
          firstColumn = document.createElement('div');
          existingContent.forEach(child => firstColumn.appendChild(child));
          element.insertBefore(firstColumn, element.firstChild);
        } else {
          // No existing content, create empty first column
          firstColumn = document.createElement('div');
          element.appendChild(firstColumn);
        }
        firstColumn.setAttribute('data-column-label', 'Column 1');

        // Create remaining empty columns
        for (let i = 1; i < expectedCount; i++) {
          const newCol = document.createElement('div');
          newCol.setAttribute('data-column-label', `Column ${i + 1}`);
          element.appendChild(newCol);
        }

        // Set the first column as active
        setActiveColumn?.(firstColumn);
      }
    }

    // Update labels on any existing columns
    updateColumnLabels(element);

    setLayout(newLayout);
    onContentChange?.();
  }, [element, onContentChange, setActiveColumn]);

  // Update vertical alignment
  const handleValignChange = useCallback((newValign) => {
    if (!element) return;

    if (newValign) {
      element.dataset.verticalAlign = newValign;
    } else {
      delete element.dataset.verticalAlign;
    }

    setValign(newValign);
    onContentChange?.();
  }, [element, onContentChange]);

  // Toggle hidden state for slide
  const handleHiddenChange = useCallback((checked) => {
    if (!element) return;

    if (checked) {
      element.dataset.hidden = 'true';
      element.classList.add('slide-hidden');
    } else {
      delete element.dataset.hidden;
      element.classList.remove('slide-hidden');
    }

    setIsHidden(checked);
    onContentChange?.();
  }, [element, onContentChange]);

  // Theme change handlers (single theme)
  const handleThemeChange = useCallback((value) => {
    setTheme('theme', value);
    setCurrentTheme(value);
  }, [setTheme]);

  const handleCodeThemeChange = useCallback((value) => {
    setTheme('codeTheme', value);
    setCurrentCodeTheme(value);
  }, [setTheme]);

  // Save or update a snippet
  const handleSaveSnippet = useCallback(() => {
    if (!snippetName.trim() || !snippetHtml.trim()) return;

    if (editingSnippetId) {
      // Updating existing snippet
      onUpdateSnippet?.(editingSnippetId, snippetName.trim(), snippetHtml.trim());
    } else {
      // Creating new snippet
      onSaveSnippet?.(snippetName.trim(), snippetHtml.trim());
    }

    setShowSnippetModal(false);
    setSnippetName('');
    setSnippetHtml('');
    setEditingSnippetId(null);
  }, [snippetName, snippetHtml, editingSnippetId, onSaveSnippet, onUpdateSnippet]);

  // Open modal for creating a new snippet
  const handleCreateSnippet = useCallback(() => {
    setEditingSnippetId(null);
    setSnippetName('');
    setSnippetHtml('');
    setShowSnippetModal(true);
  }, []);

  // Open modal for editing an existing snippet
  const handleEditSnippet = useCallback((/** @type {{id: string, name: string, content: string}} */ snippet) => {
    setEditingSnippetId(snippet.id);
    setSnippetName(snippet.name);
    setSnippetHtml(snippet.content);
    setShowSnippetModal(true);
  }, []);

  // Delete a snippet
  const handleDeleteSnippet = useCallback((/** @type {string} */ id) => {
    onDeleteSnippet?.(id);
  }, [onDeleteSnippet]);

  // Close snippet modal and reset state
  const handleCloseModal = useCallback(() => {
    setShowSnippetModal(false);
    setSnippetName('');
    setSnippetHtml('');
    setEditingSnippetId(null);
  }, []);

  // Save or update a CSS theme
  const handleSaveTheme = useCallback(() => {
    if (!themeName.trim() || !themeCss.trim()) return;

    if (editingThemeId) {
      // Updating existing theme
      onUpdateTheme?.(editingThemeId, themeName.trim(), themeType, themeCss.trim());
    } else {
      // Creating new theme
      onSaveTheme?.(themeName.trim(), themeType, themeCss.trim());
    }

    setShowThemeModal(false);
    setThemeName('');
    setThemeType('light');
    setThemeCss('');
    setEditingThemeId(null);
  }, [themeName, themeType, themeCss, editingThemeId, onSaveTheme, onUpdateTheme]);

  // Open modal for creating a new theme
  const handleCreateTheme = useCallback(() => {
    setEditingThemeId(null);
    setThemeName('');
    setThemeType('light');
    setThemeCss('');
    setShowThemeModal(true);
  }, []);

  // Open modal for editing an existing theme
  const handleEditTheme = useCallback((/** @type {{id: string, name: string, type: string, content: string}} */ theme) => {
    setEditingThemeId(theme.id);
    setThemeName(theme.name);
    setThemeType(/** @type {'light' | 'dark'} */ (theme.type));
    setThemeCss(theme.content);
    setShowThemeModal(true);
  }, []);

  // Delete a theme
  const handleDeleteTheme = useCallback((/** @type {string} */ id) => {
    onDeleteTheme?.(id);
  }, [onDeleteTheme]);

  // Close theme modal and reset state
  const handleCloseThemeModal = useCallback(() => {
    setShowThemeModal(false);
    setThemeName('');
    setThemeType('light');
    setThemeCss('');
    setEditingThemeId(null);
  }, []);

  if (!element) {
    return null;
  }

  const isMultiColumn = layout !== '';

  // Collapse panel items
  const collapseItems = [
    {
      key: 'slide',
      label: 'Slide Layout',
      children: (
        <div className="space-y-3">
          {/* Layout */}
          <div>
            <PropertyLabel>Layout</PropertyLabel>
            <Select
              value={layout}
              onChange={handleLayoutChange}
              options={LAYOUT_OPTIONS}
              className="w-full"
              size="small"
            />
            {isMultiColumn ? (
              <p className="text-xs text-gray-400 mt-1">
                Click a column to select it, then use toolbar to add content
              </p>
            ) : (
              <p className="text-xs text-gray-400 mt-1">
                Arrange content in columns
              </p>
            )}
          </div>

          {/* Vertical Alignment */}
          <div>
            <PropertyLabel>Vertical Align</PropertyLabel>
            <Select
              value={valign}
              onChange={handleValignChange}
              options={VALIGN_OPTIONS}
              className="w-full"
              size="small"
            />
          </div>

          {/* Hidden Slide Toggle */}
          <div>
            <div className="flex items-center justify-between">
              <PropertyLabel>Hidden Slide</PropertyLabel>
              <Switch
                size="small"
                checked={isHidden}
                onChange={handleHiddenChange}
              />
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {isHidden
                ? 'This slide will be skipped during presentation'
                : 'Toggle to hide this slide from presentation'}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'themes',
      label: 'Presentation Themes',
      children: (
        <div className="space-y-3">
          <div>
            <PropertyLabel>Theme</PropertyLabel>
            <Select
              value={currentTheme}
              onChange={handleThemeChange}
              options={themeOptions}
              className="w-full"
              size="small"
            />
            <p className="text-xs text-gray-400 mt-1">
              Presentation visual theme
            </p>
          </div>

          <div>
            <PropertyLabel>Code Theme</PropertyLabel>
            <Select
              value={currentCodeTheme}
              onChange={handleCodeThemeChange}
              options={CODE_THEMES}
              className="w-full"
              size="small"
            />
            <p className="text-xs text-gray-400 mt-1">
              Syntax highlighting for code blocks
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'custom-code',
      label: 'Custom Code',
      children: (
        <div className="space-y-3">
          {/* Snippets Dropdown */}
          <div>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'create',
                    label: (
                      <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Create New...
                      </span>
                    ),
                    onClick: handleCreateSnippet,
                  },
                  ...(snippets && snippets.length > 0 ? [{ type: 'divider' }] : []),
                  ...(snippets || []).map((/** @type {{id: string, name: string, content: string}} */ s) => ({
                    key: s.id,
                    label: (
                      <div className="flex items-center justify-between w-full min-w-[180px]">
                        <span className="truncate">{s.name}</span>
                        <span className="flex items-center gap-1 ml-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditSnippet(s);
                            }}
                            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm"
                            title="Edit snippet"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <Popconfirm
                            title="Delete this snippet?"
                            onConfirm={(e) => {
                              e?.stopPropagation();
                              handleDeleteSnippet(s.id);
                            }}
                            onCancel={(e) => e?.stopPropagation()}
                            okText="Delete"
                            cancelText="Cancel"
                            placement="left"
                          >
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-sm text-red-600 dark:text-red-400"
                              title="Delete snippet"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </Popconfirm>
                        </span>
                      </div>
                    ),
                  })),
                ],
              }}
              trigger={['click']}
              placement="bottomLeft"
            >
              <button className="w-full px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-sm transition-colors flex items-center justify-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                Snippets
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </Dropdown>
            <p className="text-xs text-gray-400 mt-1">
              {snippets && snippets.length > 0
                ? `${snippets.length} snippet${snippets.length !== 1 ? 's' : ''} saved`
                : 'Reusable HTML blocks'}
            </p>
          </div>

          {/* CSS Themes Dropdown */}
          <div>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'create',
                    label: (
                      <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Create New...
                      </span>
                    ),
                    onClick: handleCreateTheme,
                  },
                  ...(cssThemes && cssThemes.length > 0 ? [{ type: 'divider' }] : []),
                  ...(cssThemes || []).map((/** @type {{id: string, name: string, type: string, content: string}} */ t) => ({
                    key: t.id,
                    label: (
                      <div className="flex items-center justify-between w-full min-w-[180px]">
                        <span className="truncate">
                          {t.name}
                          <span className="ml-1 text-xs text-gray-400">({t.type})</span>
                        </span>
                        <span className="flex items-center gap-1 ml-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditTheme(t);
                            }}
                            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm"
                            title="Edit theme"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <Popconfirm
                            title="Delete this CSS theme?"
                            onConfirm={(e) => {
                              e?.stopPropagation();
                              handleDeleteTheme(t.id);
                            }}
                            onCancel={(e) => e?.stopPropagation()}
                            okText="Delete"
                            cancelText="Cancel"
                            placement="left"
                          >
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-sm text-red-600 dark:text-red-400"
                              title="Delete theme"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </Popconfirm>
                        </span>
                      </div>
                    ),
                  })),
                ],
              }}
              trigger={['click']}
              placement="bottomLeft"
            >
              <button className="w-full px-3 py-2 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-sm transition-colors flex items-center justify-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                </svg>
                CSS Themes
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </Dropdown>
            <p className="text-xs text-gray-400 mt-1">
              {cssThemes && cssThemes.length > 0
                ? `${cssThemes.length} theme${cssThemes.length !== 1 ? 's' : ''} saved`
                : 'Custom CSS stylesheets'}
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="slide-properties">
      <Collapse
        defaultActiveKey={['slide']}
        size="small"
        items={collapseItems}
        className="slide-properties-collapse"
      />

      {/* Create/Edit Snippet Modal */}
      <Modal
        title={editingSnippetId ? 'Edit Snippet' : 'Create Snippet'}
        open={showSnippetModal}
        onOk={handleSaveSnippet}
        onCancel={handleCloseModal}
        okText={editingSnippetId ? 'Update' : 'Create'}
        okButtonProps={{ disabled: !snippetName.trim() || !snippetHtml.trim() }}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Snippet Name</label>
            <Input
              value={snippetName}
              onChange={(e) => setSnippetName(e.target.value)}
              placeholder="e.g., Header with Logo"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">HTML Content</label>
            <TextArea
              value={snippetHtml}
              onChange={(e) => setSnippetHtml(e.target.value)}
              placeholder="<div>Your HTML here...</div>"
              rows={8}
              className="font-mono text-sm"
            />
          </div>
        </div>
      </Modal>

      {/* Create/Edit CSS Theme Modal */}
      <Modal
        title={editingThemeId ? 'Edit CSS Theme' : 'Create CSS Theme'}
        open={showThemeModal}
        onOk={handleSaveTheme}
        onCancel={handleCloseThemeModal}
        okText={editingThemeId ? 'Update' : 'Create'}
        okButtonProps={{ disabled: !themeName.trim() || !themeCss.trim() }}
        width={600}
      >
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Theme Name</label>
              <Input
                value={themeName}
                onChange={(e) => setThemeName(e.target.value)}
                placeholder="e.g., Company Brand"
              />
            </div>
            <div className="w-32">
              <label className="block text-sm font-medium mb-1">Mode</label>
              <Select
                value={themeType}
                onChange={(value) => setThemeType(value)}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                className="w-full"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">CSS Content</label>
            <TextArea
              value={themeCss}
              onChange={(e) => setThemeCss(e.target.value)}
              placeholder={`.reveal {\n  --r-background-color: #fff;\n  --r-main-color: #333;\n}`}
              rows={12}
              className="font-mono text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              Use Reveal.js CSS variables to customize the theme
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
