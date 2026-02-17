import { useState, useCallback, useEffect } from 'react';
import { Select, Input, InputNumber, Switch } from 'antd';
import PropertySection, { PropertyRow, PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import { convertToBlock, canConvertToBlock } from '../utils/convertToBlock';

/**
 * IframeProperties - Property editor for iframe elements
 *
 * Allows configuring:
 * - URL (src attribute)
 * - Title (accessibility)
 * - Width and height
 * - Allow fullscreen
 * - Sandbox options (security)
 */

const SANDBOX_PRESETS = [
  { value: '', label: 'No sandbox (unrestricted)' },
  { value: 'allow-scripts allow-same-origin', label: 'Scripts + Same Origin' },
  { value: 'allow-scripts', label: 'Scripts only' },
  { value: 'allow-scripts allow-same-origin allow-forms', label: 'Scripts + Forms' },
  { value: 'allow-scripts allow-same-origin allow-popups', label: 'Scripts + Popups' },
];

export default function IframeProperties({ element }) {
  const { onContentChange, selectElement } = useElementSelection();

  // For iframes, we want to convert the wrapper if it exists
  const convertibleElement = element?.closest('.iframe-wrapper') || element;

  // State for all properties
  const [url, setUrl] = useState(() => element?.src || '');
  const [title, setTitle] = useState(() => element?.title || '');
  const [width, setWidth] = useState(() => parseSize(element?.style.width || element?.width));
  const [height, setHeight] = useState(() => parseSize(element?.style.height || element?.height));
  const [allowFullscreen, setAllowFullscreen] = useState(() => element?.hasAttribute('allowfullscreen'));
  const [sandbox, setSandbox] = useState(() => element?.getAttribute('sandbox') || '');

  // Parse size value (could be "300px", "50%", or just "300")
  function parseSize(value) {
    if (!value) return { value: '', unit: 'px' };
    const match = String(value).match(/^(\d+(?:\.\d+)?)(px|%|em|rem|vw|vh)?$/);
    if (match) {
      return { value: match[1], unit: match[2] || 'px' };
    }
    return { value: '', unit: 'px' };
  }

  // Sync state when element changes
  useEffect(() => {
    if (element) {
      setUrl(element.src || '');
      setTitle(element.title || '');
      setWidth(parseSize(element.style.width || element.getAttribute('width')));
      setHeight(parseSize(element.style.height || element.getAttribute('height')));
      setAllowFullscreen(element.hasAttribute('allowfullscreen'));
      setSandbox(element.getAttribute('sandbox') || '');
    }
  }, [element]);

  // Update URL
  const handleUrlChange = useCallback((e) => {
    if (!element) return;
    const newUrl = e.target.value;
    element.src = newUrl;
    setUrl(newUrl);

    // Remove placeholder styling from wrapper when a real URL is set
    const wrapper = element.closest('.iframe-wrapper');
    if (wrapper) {
      if (newUrl && newUrl !== 'about:blank') {
        wrapper.removeAttribute('data-iframe-placeholder');
      } else {
        wrapper.setAttribute('data-iframe-placeholder', 'true');
      }
    }

    onContentChange?.();
  }, [element, onContentChange]);

  // Update title
  const handleTitleChange = useCallback((e) => {
    if (!element) return;
    const newTitle = e.target.value;
    element.title = newTitle;
    setTitle(newTitle);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update width
  const handleWidthChange = useCallback((value) => {
    if (!element) return;
    const newWidth = { ...width, value: value ?? '' };
    setWidth(newWidth);

    if (newWidth.value) {
      element.style.width = `${newWidth.value}${newWidth.unit}`;
      element.removeAttribute('width');
    } else {
      element.style.width = '';
    }
    onContentChange?.();
  }, [element, width, onContentChange]);

  const handleWidthUnitChange = useCallback((unit) => {
    if (!element) return;
    const newWidth = { ...width, unit };
    setWidth(newWidth);

    if (newWidth.value) {
      element.style.width = `${newWidth.value}${unit}`;
    }
    onContentChange?.();
  }, [element, width, onContentChange]);

  // Update height
  const handleHeightChange = useCallback((value) => {
    if (!element) return;
    const newHeight = { ...height, value: value ?? '' };
    setHeight(newHeight);

    if (newHeight.value) {
      element.style.height = `${newHeight.value}${newHeight.unit}`;
      element.removeAttribute('height');
    } else {
      element.style.height = '';
    }
    onContentChange?.();
  }, [element, height, onContentChange]);

  const handleHeightUnitChange = useCallback((unit) => {
    if (!element) return;
    const newHeight = { ...height, unit };
    setHeight(newHeight);

    if (newHeight.value) {
      element.style.height = `${newHeight.value}${unit}`;
    }
    onContentChange?.();
  }, [element, height, onContentChange]);

  // Update allowfullscreen
  const handleAllowFullscreenChange = useCallback((checked) => {
    if (!element) return;

    if (checked) {
      element.setAttribute('allowfullscreen', '');
    } else {
      element.removeAttribute('allowfullscreen');
    }
    setAllowFullscreen(checked);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update sandbox
  const handleSandboxChange = useCallback((newSandbox) => {
    if (!element) return;

    if (newSandbox) {
      element.setAttribute('sandbox', newSandbox);
    } else {
      element.removeAttribute('sandbox');
    }
    setSandbox(newSandbox);
    onContentChange?.();
  }, [element, onContentChange]);

  if (!element) {
    return null;
  }

  return (
    <div className="space-y-4">
      <PropertySection title="Iframe">
        {/* URL */}
        <div>
          <PropertyLabel>URL</PropertyLabel>
          <Input
            value={url}
            onChange={handleUrlChange}
            placeholder="https://example.com"
            size="small"
          />
        </div>

        {/* Title */}
        <div>
          <PropertyLabel>Title</PropertyLabel>
          <Input
            value={title}
            onChange={handleTitleChange}
            placeholder="Describe the content..."
            size="small"
          />
          <p className="text-xs text-gray-400 mt-1">For accessibility</p>
        </div>

        {/* Width */}
        <div>
          <PropertyLabel>Width</PropertyLabel>
          <div className="flex gap-1">
            <InputNumber
              value={width.value ? Number(width.value) : null}
              onChange={handleWidthChange}
              placeholder="Auto"
              size="small"
              min={0}
              className="flex-1"
            />
            <Select
              value={width.unit}
              onChange={handleWidthUnitChange}
              options={[
                { value: 'px', label: 'px' },
                { value: '%', label: '%' },
                { value: 'em', label: 'em' },
                { value: 'vw', label: 'vw' },
              ]}
              size="small"
              className="w-16"
            />
          </div>
        </div>

        {/* Height */}
        <div>
          <PropertyLabel>Height</PropertyLabel>
          <div className="flex gap-1">
            <InputNumber
              value={height.value ? Number(height.value) : null}
              onChange={handleHeightChange}
              placeholder="Auto"
              size="small"
              min={0}
              className="flex-1"
            />
            <Select
              value={height.unit}
              onChange={handleHeightUnitChange}
              options={[
                { value: 'px', label: 'px' },
                { value: '%', label: '%' },
                { value: 'em', label: 'em' },
                { value: 'vh', label: 'vh' },
              ]}
              size="small"
              className="w-16"
            />
          </div>
        </div>

        {/* Allow Fullscreen */}
        <PropertyRow label="Allow Fullscreen">
          <Switch
            checked={allowFullscreen}
            onChange={handleAllowFullscreenChange}
            size="small"
          />
        </PropertyRow>

        {/* Sandbox */}
        <div>
          <PropertyLabel>Security Sandbox</PropertyLabel>
          <Select
            value={sandbox}
            onChange={handleSandboxChange}
            options={SANDBOX_PRESETS}
            className="w-full"
            size="small"
          />
          <p className="text-xs text-gray-400 mt-1">Restricts iframe capabilities</p>
        </div>
      </PropertySection>

      <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 px-1">
        Some sites block embedding. Try using embed URLs if available.
      </p>

      {/* Convert to draggable block */}
      {canConvertToBlock(convertibleElement) && (
        <PropertySection title="Layout">
          <button
            onClick={() => convertToBlock(convertibleElement, selectElement, onContentChange)}
            className="w-full px-3 py-2 text-sm bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-sm hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
          >
            📦 Convert to Draggable Block
          </button>
          <p className="text-xs text-gray-400 mt-1">
            Move freely with absolute positioning
          </p>
        </PropertySection>
      )}
    </div>
  );
}
