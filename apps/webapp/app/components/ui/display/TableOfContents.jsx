import { useEffect, useState, useCallback } from 'react';

/**
 * Notion-style Table of Contents with small gray bars
 * Each heading is represented by a horizontal bar that highlights when active
 */
const TableOfContents = ({
  headings = [],
  activeId,
  onHeadingClick,
  className = '',
  position = 'right', // 'right' or 'left'
}) => {
  const [isHovered, setIsHovered] = useState(false);

  if (headings.length === 0) return null;

  const positionClasses =
    position === 'right' ? 'right-4 top-1/2 -translate-y-1/2' : 'left-4 top-1/2 -translate-y-1/2';

  return (
    <div
      className={`hidden xl:flex fixed ${positionClasses} flex-col gap-4 z-40 ${className}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {headings.map((heading, index) => {
        const isActive = activeId === heading.id;
        // Bar width based on heading level (h1 = longest, h3 = shortest)
        const barWidth = heading.level === 1 ? 24 : heading.level === 2 ? 18 : 12;

        return (
          <div key={heading.id || index} className="relative group flex items-center">
            {/* The clickable bar */}
            <button
              type="button"
              onClick={() => onHeadingClick?.(heading.id, index)}
              className={`h-[3px] rounded-full transition-all duration-200 ${
                isActive
                  ? 'bg-primary-600 dark:bg-primary-400'
                  : 'bg-gray-300 dark:bg-gray-500 hover:bg-gray-400 dark:hover:bg-gray-400 group-hover:bg-gray-400 dark:group-hover:bg-gray-400'
              }`}
              style={{ width: barWidth }}
              title={heading.text}
              aria-label={`Jump to ${heading.text}`}
            />

            {/* Tooltip showing heading text on hover */}
            {isHovered && (
              <div
                className={`absolute ${position === 'right' ? 'right-full mr-3' : 'left-full ml-3'}
                  whitespace-nowrap px-2 py-1 text-xs bg-gray-900 dark:bg-gray-700 text-white rounded
                  opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none`}
              >
                {heading.text || `Heading ${heading.level}`}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Hook to track active heading based on scroll position
 */
export const useActiveHeading = (headings, options = {}) => {
  const { getElement = id => document.querySelector(`[data-block-id="${id}"]`) } = options;

  const [activeId, setActiveId] = useState(headings[0]?.id || null);

  useEffect(() => {
    if (headings.length === 0) return;

    const handleScroll = () => {
      const headingElements = headings.map(h => getElement(h.id)).filter(Boolean);

      if (headingElements.length === 0) return;

      const viewportHeight = window.innerHeight;
      const lastHeading = headingElements[headingElements.length - 1];
      const lastHeadingRect = lastHeading.getBoundingClientRect();

      // If last heading is visible, highlight it
      const isLastHeadingVisible = lastHeadingRect.top >= 0 && lastHeadingRect.top <= viewportHeight;

      let activeHeading = null;

      if (isLastHeadingVisible) {
        activeHeading = lastHeading;
      } else {
        // Find the last heading above middle of viewport
        const middleOfViewport = viewportHeight / 2;

        for (const heading of headingElements) {
          const rect = heading.getBoundingClientRect();
          if (rect.top <= middleOfViewport) {
            activeHeading = heading;
          }
        }

        // If nothing scrolled past yet, use first heading
        if (!activeHeading) {
          activeHeading = headingElements[0];
        }
      }

      if (activeHeading) {
        const id = activeHeading.dataset?.blockId || activeHeading.id;
        setActiveId(id);
      }
    };

    // Use IntersectionObserver as backup trigger
    const observer = new IntersectionObserver(() => handleScroll(), {
      threshold: [0, 0.5, 1],
      rootMargin: '-50% 0px -50% 0px',
    });

    headings.forEach(h => {
      const el = getElement(h.id);
      if (el) observer.observe(el);
    });

    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });

    handleScroll(); // Initial call

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('scroll', handleScroll, { capture: true });
    };
  }, [headings, getElement]);

  return [activeId, setActiveId];
};

export default TableOfContents;
