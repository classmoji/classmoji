import { useState, useCallback, useEffect } from 'react';
import { Select, Input, InputNumber } from 'antd';
import PropertySection, { PropertyRow, PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import { convertToBlock, canConvertToBlock } from '../utils/convertToBlock';

/**
 * ImageProperties - Property editor for image elements
 *
 * Allows configuring:
 * - Alt text (accessibility)
 * - Width and height
 * - Alignment
 * - Object fit (how image scales within its container)
 */

const ALIGNMENTS = [
  { value: '', label: 'Default' },
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

const OBJECT_FITS = [
  { value: '', label: 'Default' },
  { value: 'contain', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'fill', label: 'Fill' },
  { value: 'none', label: 'None' },
  { value: 'scale-down', label: 'Scale Down' },
];

export default function ImageProperties({ element }) {
  const { onContentChange, selectElement } = useElementSelection();

  // State for all properties
  const [altText, setAltText] = useState(() => element?.alt || '');
  const [width, setWidth] = useState(() => parseSize(element?.style.width || element?.width));
  const [height, setHeight] = useState(() => parseSize(element?.style.height || element?.height));
  const [alignment, setAlignment] = useState(() => getAlignment(element));
  const [objectFit, setObjectFit] = useState(() => element?.style.objectFit || '');

  // Parse size value (could be "300px", "50%", or just "300")
  function parseSize(value) {
    if (!value) return { value: '', unit: 'px' };
    const match = String(value).match(/^(\d+(?:\.\d+)?)(px|%|em|rem|vw|vh)?$/);
    if (match) {
      return { value: match[1], unit: match[2] || 'px' };
    }
    return { value: '', unit: 'px' };
  }

  // Get alignment from element style or parent
  function getAlignment(el) {
    if (!el) return '';
    // Check display:block + margin:auto for center
    const style = el.style;
    if (style.display === 'block' && style.marginLeft === 'auto' && style.marginRight === 'auto') {
      return 'center';
    }
    // Check float for left/right
    if (style.float === 'left') return 'left';
    if (style.float === 'right') return 'right';
    return '';
  }

  // Sync state when element changes
  useEffect(() => {
    if (element) {
      setAltText(element.alt || '');
      setWidth(parseSize(element.style.width || element.getAttribute('width')));
      setHeight(parseSize(element.style.height || element.getAttribute('height')));
      setAlignment(getAlignment(element));
      setObjectFit(element.style.objectFit || '');
    }
  }, [element]);

  // Update alt text
  const handleAltChange = useCallback((e) => {
    if (!element) return;
    const newAlt = e.target.value;
    element.alt = newAlt;
    setAltText(newAlt);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update width
  const handleWidthChange = useCallback((value) => {
    if (!element) return;
    const newWidth = { ...width, value: value ?? '' };
    setWidth(newWidth);

    if (newWidth.value) {
      element.style.width = `${newWidth.value}${newWidth.unit}`;
      // Remove HTML attribute to avoid conflicts
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

  // Update alignment
  const handleAlignmentChange = useCallback((newAlign) => {
    if (!element) return;

    // Clear previous alignment styles
    element.style.display = '';
    element.style.marginLeft = '';
    element.style.marginRight = '';
    element.style.float = '';

    // Apply new alignment
    if (newAlign === 'center') {
      element.style.display = 'block';
      element.style.marginLeft = 'auto';
      element.style.marginRight = 'auto';
    } else if (newAlign === 'left') {
      element.style.float = 'left';
      element.style.marginRight = '1em';
    } else if (newAlign === 'right') {
      element.style.float = 'right';
      element.style.marginLeft = '1em';
    }

    setAlignment(newAlign);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update object fit
  const handleObjectFitChange = useCallback((newFit) => {
    if (!element) return;
    element.style.objectFit = newFit;
    setObjectFit(newFit);
    onContentChange?.();
  }, [element, onContentChange]);

  if (!element) {
    return null;
  }

  return (
    <div className="space-y-4">
      <PropertySection title="Image">
        {/* Thumbnail preview */}
        <div className="mb-3">
          <div className="w-full h-24 bg-gray-100 dark:bg-gray-700 rounded-sm overflow-hidden flex items-center justify-center">
            <img
              src={element.src}
              alt={altText || 'Preview'}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        </div>

        {/* Alt text */}
        <div>
          <PropertyLabel>Alt Text</PropertyLabel>
          <Input
            value={altText}
            onChange={handleAltChange}
            placeholder="Describe the image..."
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

        {/* Alignment */}
        <div>
          <PropertyLabel>Alignment</PropertyLabel>
          <Select
            value={alignment}
            onChange={handleAlignmentChange}
            options={ALIGNMENTS}
            className="w-full"
            size="small"
          />
        </div>

        {/* Object Fit */}
        <div>
          <PropertyLabel>Fit Mode</PropertyLabel>
          <Select
            value={objectFit}
            onChange={handleObjectFitChange}
            options={OBJECT_FITS}
            className="w-full"
            size="small"
          />
          <p className="text-xs text-gray-400 mt-1">How the image scales</p>
        </div>
      </PropertySection>

      {/* Convert to draggable block */}
      {canConvertToBlock(element) && (
        <PropertySection title="Layout">
          <button
            onClick={() => convertToBlock(element, selectElement, onContentChange)}
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
