import { useState, useCallback, useEffect, useMemo } from 'react';
import { InputNumber, Tooltip } from 'antd';
import PropertySection, { PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import TextProperties from './TextProperties';
import ImageProperties from './ImageProperties';
import CodeBlockProperties from './CodeBlockProperties';
import IframeProperties from './IframeProperties';
import VideoProperties from './VideoProperties';

/**
 * BlockProperties - Property editor for sl-block elements
 *
 * Allows configuring:
 * - Position (X, Y in slide coordinates)
 * - Size (Width, Height)
 * - Z-Index (layer order with visual controls)
 * - Content-specific properties based on block type
 */

export default function BlockProperties({ element }) {
  const { onContentChange } = useElementSelection();

  // State for position and size
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [size, setSize] = useState({ width: 100, height: 100 });
  const [zIndex, setZIndex] = useState(0);

  // Parse pixel value from style string
  const parsePixels = useCallback((value) => {
    if (!value) return 0;
    return parseInt(value, 10) || 0;
  }, []);

  // Sync state from element
  useEffect(() => {
    if (element) {
      const rect = element.getBoundingClientRect();
      const scale = window.Reveal?.getScale() || 1;

      setPosition({
        left: parsePixels(element.style.left),
        top: parsePixels(element.style.top),
      });
      setSize({
        width: parsePixels(element.style.width) || Math.round(rect.width / scale),
        height: parsePixels(element.style.height) || Math.round(rect.height / scale),
      });
      setZIndex(parsePixels(element.style.zIndex));
    }
  }, [element, parsePixels]);

  // Update position
  const handlePositionChange = useCallback((prop, value) => {
    if (!element || value === null) return;
    const newValue = Math.round(value);
    element.style[prop] = `${newValue}px`;
    setPosition(prev => ({ ...prev, [prop]: newValue }));
    onContentChange?.();
  }, [element, onContentChange]);

  // Update size
  const handleSizeChange = useCallback((prop, value) => {
    if (!element || value === null) return;
    const newValue = Math.max(10, Math.round(value));
    element.style[prop] = `${newValue}px`;
    setSize(prev => ({ ...prev, [prop]: newValue }));
    onContentChange?.();
  }, [element, onContentChange]);

  // Get max z-index from all blocks in the current section
  const getMaxZIndex = useCallback(() => {
    if (!element) return 0;
    const section = element.closest('section');
    if (!section) return 0;

    const blocks = section.querySelectorAll('.sl-block');
    let max = 0;
    blocks.forEach(block => {
      const z = parseInt(block.style.zIndex || '0', 10);
      if (z > max) max = z;
    });
    return max;
  }, [element]);

  // Z-index controls
  const handleBringForward = useCallback(() => {
    if (!element) return;
    const newZ = zIndex + 1;
    element.style.zIndex = newZ;
    setZIndex(newZ);
    onContentChange?.();
  }, [element, zIndex, onContentChange]);

  const handleSendBackward = useCallback(() => {
    if (!element) return;
    const newZ = Math.max(0, zIndex - 1);
    element.style.zIndex = newZ;
    setZIndex(newZ);
    onContentChange?.();
  }, [element, zIndex, onContentChange]);

  const handleBringToFront = useCallback(() => {
    if (!element) return;
    const maxZ = getMaxZIndex();
    const newZ = maxZ + 1;
    element.style.zIndex = newZ;
    setZIndex(newZ);
    onContentChange?.();
  }, [element, getMaxZIndex, onContentChange]);

  const handleSendToBack = useCallback(() => {
    if (!element) return;
    const section = element.closest('section');
    if (!section) return;

    // Shift all other blocks up by 1
    const blocks = section.querySelectorAll('.sl-block');
    blocks.forEach(block => {
      if (block !== element) {
        const currentZ = parseInt(block.style.zIndex || '0', 10);
        block.style.zIndex = currentZ + 1;
      }
    });

    // Set this block to 0
    element.style.zIndex = 0;
    setZIndex(0);
    onContentChange?.();
  }, [element, onContentChange]);

  // Get block type for display
  const getBlockType = useCallback(() => {
    if (!element) return 'Block';
    const type = element.dataset.blockType || 'unknown';
    return type.charAt(0).toUpperCase() + type.slice(1);
  }, [element]);

  // Get the content element inside the block based on type
  const contentElement = useMemo(() => {
    if (!element) return null;
    const blockType = element.dataset.blockType;
    const content = element.querySelector('.sl-block-content');
    if (!content) return null;

    switch (blockType) {
      case 'image':
        return content.querySelector('img');
      case 'code':
        return content.querySelector('pre');
      case 'iframe':
        return content.querySelector('iframe');
      case 'video':
        return content.querySelector('video');
      case 'text':
      default:
        // For text blocks, return the first text element or the content itself
        return content.querySelector('h1, h2, h3, h4, h5, h6, p, ul, ol') || content;
    }
  }, [element]);

  // Determine which content editor to show
  const ContentEditor = useMemo(() => {
    if (!element) return null;
    const blockType = element.dataset.blockType;

    switch (blockType) {
      case 'image':
        return ImageProperties;
      case 'code':
        return CodeBlockProperties;
      case 'iframe':
        return IframeProperties;
      case 'video':
        return VideoProperties;
      case 'text':
        return TextProperties;
      default:
        return null;
    }
  }, [element]);

  if (!element) {
    return null;
  }

  return (
    <div className="space-y-4">
      <PropertySection title={`${getBlockType()} Block`}>
        {/* Position */}
        <div>
          <PropertyLabel>Position</PropertyLabel>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-xs text-gray-400 block mb-1">X</span>
              <InputNumber
                value={position.left}
                onChange={(v) => handlePositionChange('left', v)}
                size="small"
                className="w-full"
                addonAfter="px"
              />
            </div>
            <div>
              <span className="text-xs text-gray-400 block mb-1">Y</span>
              <InputNumber
                value={position.top}
                onChange={(v) => handlePositionChange('top', v)}
                size="small"
                className="w-full"
                addonAfter="px"
              />
            </div>
          </div>
        </div>

        {/* Size */}
        <div>
          <PropertyLabel>Size</PropertyLabel>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-xs text-gray-400 block mb-1">W</span>
              <InputNumber
                value={size.width}
                onChange={(v) => handleSizeChange('width', v)}
                size="small"
                min={10}
                className="w-full"
                addonAfter="px"
              />
            </div>
            <div>
              <span className="text-xs text-gray-400 block mb-1">H</span>
              <InputNumber
                value={size.height}
                onChange={(v) => handleSizeChange('height', v)}
                size="small"
                min={10}
                className="w-full"
                addonAfter="px"
              />
            </div>
          </div>
        </div>
      </PropertySection>

      <PropertySection title="Layer Order">
        <div className="flex items-center justify-between gap-1">
          <Tooltip title="Send to Back (Cmd+Shift+[)">
            <button
              onClick={handleSendToBack}
              className="flex-1 px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors"
            >
              ⇊
            </button>
          </Tooltip>
          <Tooltip title="Send Backward (Cmd+[)">
            <button
              onClick={handleSendBackward}
              className="flex-1 px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors"
            >
              ↓
            </button>
          </Tooltip>
          <Tooltip title="Bring Forward (Cmd+])">
            <button
              onClick={handleBringForward}
              className="flex-1 px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors"
            >
              ↑
            </button>
          </Tooltip>
          <Tooltip title="Bring to Front (Cmd+Shift+])">
            <button
              onClick={handleBringToFront}
              className="flex-1 px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors"
            >
              ⇈
            </button>
          </Tooltip>
        </div>
        <div className="flex items-center justify-between text-xs text-gray-400 mt-1">
          <span>Back</span>
          <span>z: {zIndex}</span>
          <span>Front</span>
        </div>
      </PropertySection>

      <PropertySection title="Tips">
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <p>• Drag block center to move</p>
          <p>• Drag corners/edges to resize</p>
          <p>• Double-click to edit content</p>
          <p>• Hold Shift for aspect ratio lock</p>
        </div>
      </PropertySection>

      {/* Content-specific properties */}
      {ContentEditor && contentElement && (
        <>
          <div className="border-t border-gray-200 dark:border-gray-700 my-4" />
          <ContentEditor element={contentElement} />
        </>
      )}
    </div>
  );
}
