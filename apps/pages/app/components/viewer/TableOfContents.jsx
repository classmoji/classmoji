import { useState, useEffect, useCallback } from 'react';

/**
 * Table of Contents sidebar with scroll-tracking highlight.
 * Extracts h1/h2/h3 from rendered HTML and highlights active section.
 */
const TableOfContents = ({ headings }) => {
  const [activeId, setActiveId] = useState('');

  // Track scroll position to highlight active heading
  useEffect(() => {
    if (!headings || headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the first visible heading
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      {
        rootMargin: '-80px 0px -60% 0px',
        threshold: 0,
      }
    );

    headings.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  const scrollToHeading = useCallback((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  if (!headings || headings.length === 0) return null;

  return (
    <nav className="toc-sidebar">
      <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
        On this page
      </h4>
      {headings.map(({ id, text, level }) => (
        <a
          key={id}
          href={`#${id}`}
          data-depth={level}
          className={activeId === id ? 'active' : ''}
          onClick={(e) => {
            e.preventDefault();
            scrollToHeading(id);
          }}
        >
          {text}
        </a>
      ))}
    </nav>
  );
};

export default TableOfContents;
