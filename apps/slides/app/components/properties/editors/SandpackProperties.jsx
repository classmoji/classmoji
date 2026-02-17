/**
 * SandpackProperties - Property editor for Sandpack code playground blocks
 *
 * Allows editing template, theme, layout, and display options for Sandpack embeds.
 */

import { useCallback, useState } from 'react';
import { Select } from 'antd';
import { useElementSelection } from '../ElementSelectionContext';
import PropertySection from '../PropertySection';
import {
  SANDPACK_TEMPLATES,
  SANDPACK_THEMES,
  SANDPACK_LAYOUTS,
  DEFAULT_FILES,
  parseFromHtml,
  updateFilesInElement,
} from '@classmoji/ui-components/sandpack';

/**
 * SandpackProperties component
 *
 * @param {object} props
 * @param {HTMLElement} props.element - The .sandpack-embed element
 */
export default function SandpackProperties({ element }) {
  const { onContentChange } = useElementSelection();
  // Counter to force re-renders when DOM attributes change
  // This is needed because parseFromHtml reads from DOM, which React doesn't track
  const [, forceUpdate] = useState(0);

  // Parse current configuration from the element
  const config = parseFromHtml(element);

  // Update a data attribute on the element
  const updateAttribute = useCallback((key, value) => {
    element.dataset[key] = value;
    forceUpdate(c => c + 1); // Trigger re-render to reflect DOM changes
    onContentChange?.();
  }, [element, onContentChange]);

  // Update options that are stored as data attributes
  // Note: dataset API expects camelCase keys and automatically converts to kebab-case attributes
  // e.g., element.dataset.showConsole = 'true' creates data-show-console="true"
  const updateOption = useCallback((key, value) => {
    if (value === true) {
      element.dataset[key] = 'true';
    } else if (value === false) {
      element.dataset[key] = 'false';
    } else {
      element.dataset[key] = value;
    }
    forceUpdate(c => c + 1); // Trigger re-render to reflect DOM changes
    onContentChange?.();
  }, [element, onContentChange]);

  // Handle template change - also reset files to defaults
  const handleTemplateChange = useCallback((newTemplate) => {
    element.dataset.template = newTemplate;
    // Reset files to defaults for the new template
    const defaultFiles = DEFAULT_FILES[newTemplate] || DEFAULT_FILES.vanilla;
    updateFilesInElement(element, defaultFiles);
    forceUpdate(c => c + 1); // Trigger re-render to reflect DOM changes
    onContentChange?.();
  }, [element, onContentChange]);

  return (
    <div className="space-y-4">
      <PropertySection title="Code Playground">
        {/* Template selector */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Template
          </label>
          <Select
            value={config.template}
            onChange={handleTemplateChange}
            className="w-full"
            size="small"
            options={Object.values(SANDPACK_TEMPLATES).map((t) => ({
              value: t.id,
              label: t.label,
            }))}
          />
          <p className="text-xs text-gray-500">
            {SANDPACK_TEMPLATES[config.template]?.description}
          </p>
        </div>

        {/* Theme selector */}
        <div className="space-y-2 mt-3">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Theme
          </label>
          <Select
            value={config.theme}
            onChange={(value) => updateAttribute('theme', value)}
            className="w-full"
            size="small"
            options={Object.values(SANDPACK_THEMES).map((t) => ({
              value: t.id,
              label: t.label,
            }))}
          />
        </div>

        {/* Layout selector */}
        <div className="space-y-2 mt-3">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Layout
          </label>
          <Select
            value={config.layout}
            onChange={(value) => updateAttribute('layout', value)}
            className="w-full"
            size="small"
            options={Object.values(SANDPACK_LAYOUTS).map((l) => ({
              value: l.id,
              label: l.label,
            }))}
          />
        </div>

        {/* Editor width slider - only show for horizontal layouts */}
        {config.layout !== 'preview-bottom' && config.layout !== 'preview-only' && config.layout !== 'editor-only' && (
          <div className="space-y-2 mt-3">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              Editor Width
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="20"
                max="100"
                step="5"
                value={config.editorWidthPercentage}
                onChange={(e) => updateAttribute('editorWidth', e.target.value)}
                className="flex-1"
              />
              <span className="text-xs text-gray-500 w-10 text-right">
                {config.editorWidthPercentage}%
              </span>
            </div>
          </div>
        )}
      </PropertySection>

      <PropertySection title="Display Options">
        {/* Show tabs toggle */}
        <div className="flex items-center justify-between">
          <label className="text-xs text-gray-700 dark:text-gray-300">
            Show file tabs
          </label>
          <input
            type="checkbox"
            checked={config.options.showTabs !== false}
            onChange={(e) => updateOption('showTabs', e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
        </div>

        {/* Show line numbers toggle */}
        <div className="flex items-center justify-between mt-2">
          <label className="text-xs text-gray-700 dark:text-gray-300">
            Show line numbers
          </label>
          <input
            type="checkbox"
            checked={config.options.showLineNumbers !== false}
            onChange={(e) => updateOption('showLineNumbers', e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
        </div>

        {/* Show console toggle */}
        <div className="flex items-center justify-between mt-2">
          <label className="text-xs text-gray-700 dark:text-gray-300">
            Show console
          </label>
          <input
            type="checkbox"
            checked={config.options.showConsole === true}
            onChange={(e) => updateOption('showConsole', e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
        </div>

        {/* Read-only toggle */}
        <div className="flex items-center justify-between mt-2">
          <label className="text-xs text-gray-700 dark:text-gray-300">
            Read-only mode
          </label>
          <input
            type="checkbox"
            checked={config.options.readOnly === true}
            onChange={(e) => updateOption('readOnly', e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
        </div>
      </PropertySection>

      <PropertySection title="Visible Files">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          Select which files appear as tabs. Unchecked files are still included in the bundle but hidden from view.
        </p>
        {Object.keys(config.files).map((filePath) => {
          // Check if this file is visible (null/undefined means all visible)
          const visibleFiles = config.options.visibleFiles;
          const isVisible = !visibleFiles || visibleFiles.includes(filePath);

          return (
            <div key={filePath} className="flex items-center justify-between mt-1">
              <label className="text-xs text-gray-700 dark:text-gray-300 font-mono">
                {filePath}
              </label>
              <input
                type="checkbox"
                checked={isVisible}
                onChange={(e) => {
                  const currentVisible = config.options.visibleFiles || Object.keys(config.files);
                  let newVisible;

                  if (e.target.checked) {
                    // Add file to visible list
                    newVisible = [...currentVisible, filePath];
                  } else {
                    // Remove file from visible list (but keep at least one)
                    newVisible = currentVisible.filter(f => f !== filePath);
                    if (newVisible.length === 0) {
                      // Don't allow hiding all files
                      return;
                    }
                  }

                  // If all files are now visible, clear the visibleFiles setting
                  if (newVisible.length === Object.keys(config.files).length) {
                    element.removeAttribute('data-visible-files');
                  } else {
                    element.dataset.visibleFiles = JSON.stringify(newVisible);
                  }
                  forceUpdate(c => c + 1);
                  onContentChange?.();
                }}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>
          );
        })}
      </PropertySection>

      {/* Info section */}
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-4 p-2 bg-gray-50 dark:bg-gray-700 rounded">
        <p className="font-medium mb-1">💡 Tip</p>
        <p>
          Code changes are saved automatically. Students can edit and run code
          during presentations - changes won&apos;t affect your saved content.
        </p>
      </div>
    </div>
  );
}
