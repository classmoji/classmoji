import { useEffect, useRef, useCallback, memo } from 'react';

/**
 * PageViewer — Read-only rendered page content.
 *
 * Two rendering paths:
 * - JSON content: pre-rendered to HTML on server via blocksToFullHTML()
 * - Legacy HTML: rendered as-is from GitHub
 *
 * Client-side enhancements:
 * - Syntax highlighting via highlight.js
 * - Copy buttons on code blocks
 * - External links open in new tab
 * - Heading extraction for TOC
 */
interface PageViewerProps {
  htmlContent: string;
  onHeadingsExtracted?: (
    headings: Array<{ id: string; text: string | null; level: number }>
  ) => void;
}

const PageViewer = memo(function PageViewer({ htmlContent, onHeadingsExtracted }: PageViewerProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current || !htmlContent) return;

    // Extract headings for TOC
    const headingElements = contentRef.current.querySelectorAll('h1, h2, h3');
    const extractedHeadings: Array<{ id: string; text: string | null; level: number }> = [];

    headingElements.forEach((heading: Element, index: number) => {
      if (!heading.id) {
        const slug = heading.textContent
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
        heading.id = slug ? `${slug}-${index}` : `heading-${index}`;
      }
      extractedHeadings.push({
        id: heading.id,
        text: heading.textContent,
        level: parseInt(heading.tagName[1]),
      });
    });

    if (onHeadingsExtracted) {
      onHeadingsExtracted(extractedHeadings);
    }

    // Add copy buttons to code blocks
    contentRef.current.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code')?.textContent || pre.textContent;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = 'Copy';
          }, 2000);
        });
      });
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });

    // Make external links open in new tab
    contentRef.current.querySelectorAll('a').forEach(link => {
      if (link.hostname !== window.location.hostname) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    });

    // Syntax highlighting via highlight.js
    import('highlight.js/lib/common').then(hljs => {
      contentRef.current?.querySelectorAll('pre code').forEach(block => {
        hljs.default.highlightElement(block as HTMLElement);
      });
    });
  }, [htmlContent, onHeadingsExtracted]);

  if (!htmlContent) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p className="text-lg">This page has no content yet.</p>
      </div>
    );
  }

  return (
    <div
      ref={contentRef}
      className="page-viewer"
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
});

export default PageViewer;
