/**
 * convertToBlock - Utility to convert a regular element to a draggable sl-block
 *
 * This function takes any element in document flow and converts it to an
 * absolutely-positioned sl-block that can be freely moved and resized.
 *
 * The conversion process:
 * 1. Calculate the element's current visual position on the slide
 * 2. Convert screen coordinates to slide coordinates (960×700 space)
 * 3. Create an sl-block wrapper with the calculated position
 * 4. Move the original element inside the block
 * 5. Remove from document flow by removing the original
 *
 * @param {HTMLElement} element - The element to convert
 * @param {Function} selectElement - Function to select the new block
 * @param {Function} onContentChange - Function to notify content change
 * @returns {HTMLElement|null} - The new sl-block element, or null if conversion failed
 */
export function convertToBlock(element, selectElement, onContentChange) {
  if (!element) return null;

  // Don't convert elements that are already in sl-blocks
  if (element.closest('.sl-block')) {
    console.warn('Element is already inside an sl-block');
    return null;
  }

  // Find the containing section (slide)
  const section = element.closest('section');
  if (!section) {
    console.warn('Element is not inside a slide section');
    return null;
  }

  // Get the Reveal.js scale factor
  const scale = window.Reveal?.getScale() || 1;

  // Get the element's bounding rect in screen pixels
  const elementRect = element.getBoundingClientRect();
  const sectionRect = section.getBoundingClientRect();

  // Convert to slide coordinates (relative to section, divided by scale)
  const left = Math.round((elementRect.left - sectionRect.left) / scale);
  const top = Math.round((elementRect.top - sectionRect.top) / scale);
  const width = Math.round(elementRect.width / scale);
  const height = Math.round(elementRect.height / scale);

  // Determine block type based on element
  let blockType = 'text';
  if (element.tagName === 'IMG') {
    blockType = 'image';
  } else if (element.tagName === 'PRE' || element.querySelector('code')) {
    blockType = 'code';
  } else if (element.tagName === 'IFRAME' || element.querySelector('iframe') || element.classList.contains('iframe-wrapper')) {
    blockType = 'iframe';
  }

  // Create the sl-block wrapper
  const block = document.createElement('div');
  block.className = 'sl-block';
  block.dataset.blockType = blockType;
  block.style.left = `${left}px`;
  block.style.top = `${top}px`;
  block.style.width = `${width}px`;
  block.style.height = `${height}px`;
  block.style.zIndex = '1';

  // Create the content wrapper
  const content = document.createElement('div');
  content.className = 'sl-block-content';

  // Clone the element to preserve the original while we work
  const clonedElement = element.cloneNode(true);

  // Reset any flow-related styles on the cloned element
  clonedElement.style.margin = '0';
  clonedElement.style.float = '';
  clonedElement.style.display = '';

  // Add the cloned element to the content wrapper
  content.appendChild(clonedElement);
  block.appendChild(content);

  // Insert the block into the section (at the end, it will overlay due to absolute positioning)
  section.appendChild(block);

  // Remove the original element from document flow
  element.remove();

  // Select the new block
  selectElement?.(block);

  // Notify of content change
  onContentChange?.();

  return block;
}

/**
 * Check if an element can be converted to a block
 *
 * @param {HTMLElement} element - The element to check
 * @returns {boolean} - Whether the element can be converted
 */
export function canConvertToBlock(element) {
  if (!element) return false;

  // Already in a block
  if (element.closest('.sl-block')) return false;

  // Must be in a section
  if (!element.closest('section')) return false;

  // Don't convert the section itself
  if (element.tagName === 'SECTION') return false;

  return true;
}
