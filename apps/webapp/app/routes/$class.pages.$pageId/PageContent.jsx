import { useEffect, useRef, memo } from 'react';
import Prism from 'prismjs';
// Import common languages (order matters for dependencies)
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';

// Memoized page content component - prevents re-renders from parent state changes
export const PageContent = memo(function PageContent({ htmlContent, onHeadingsExtracted }) {
  const contentRef = useRef(null);

  useEffect(() => {
    if (!contentRef.current || !htmlContent) return;

    // Extract headings for TOC
    const headingElements = contentRef.current.querySelectorAll('h1, h2, h3');
    const extractedHeadings = [];

    headingElements.forEach((heading, index) => {
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
        index,
      });
    });

    onHeadingsExtracted(extractedHeadings);

    // Apply syntax highlighting
    const languageMap = {
      html: 'markup',
      xml: 'markup',
      js: 'javascript',
      ts: 'typescript',
      sh: 'bash',
      shell: 'bash',
    };

    const codeBlocks = contentRef.current.querySelectorAll('pre code');
    codeBlocks.forEach(code => {
      const classMatch = code.className.match(/language-(\w+)/);
      if (classMatch) {
        let lang = classMatch[1].toLowerCase();
        if (languageMap[lang]) {
          code.classList.remove(`language-${classMatch[1]}`);
          lang = languageMap[lang];
          code.classList.add(`language-${lang}`);
        }
      } else {
        code.classList.add('language-javascript');
      }
    });

    Prism.highlightAllUnder(contentRef.current);

    // Add copy buttons to code blocks and terminal blocks
    const addCopyButton = (container, getCodeText, insertTarget) => {
      // Check if button already exists
      if (container.querySelector('.copy-code-btn')) return;

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-code-btn';
      copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      copyBtn.title = 'Copy code';
      copyBtn.style.cssText = `
        background: transparent;
        border: none;
        color: #9ca3af;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        transition: all 0.15s;
      `;

      copyBtn.addEventListener('mouseenter', () => {
        copyBtn.style.background = '#374151';
        copyBtn.style.color = '#e5e7eb';
      });
      copyBtn.addEventListener('mouseleave', () => {
        copyBtn.style.background = 'transparent';
        copyBtn.style.color = '#9ca3af';
      });

      copyBtn.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const text = getCodeText();
        if (text) {
          try {
            await navigator.clipboard.writeText(text);
            copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            copyBtn.style.color = '#1f883d';
            setTimeout(() => {
              copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
              copyBtn.style.color = '#9ca3af';
            }, 2000);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        }
      });

      insertTarget.appendChild(copyBtn);
    };

    // Add copy buttons to .code-block elements (in header)
    contentRef.current.querySelectorAll('.code-block').forEach(block => {
      const header = block.querySelector('.code-header');
      const pre = block.querySelector('pre');
      if (header && pre) {
        addCopyButton(block, () => pre.textContent, header);
      }
    });

    // Add copy buttons to terminal blocks (in header)
    contentRef.current.querySelectorAll('.terminal-block').forEach(block => {
      const header = block.querySelector('.terminal-header');
      const pre = block.querySelector('pre');
      if (header && pre) {
        addCopyButton(block, () => pre.textContent, header);
      }
    });

    // Add copy buttons to standalone <pre> elements (not inside .code-block or .terminal-block)
    contentRef.current.querySelectorAll('pre').forEach(pre => {
      if (pre.closest('.code-block') || pre.closest('.terminal-block')) return;
      // Wrap in a container for positioning
      if (!pre.parentElement.classList.contains('pre-wrapper')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'pre-wrapper';
        wrapper.style.cssText = 'position: relative;';
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'position: absolute; top: 8px; right: 8px;';
        wrapper.appendChild(btnContainer);
        addCopyButton(wrapper, () => pre.textContent, btnContainer);
      }
    });
  }, [htmlContent, onHeadingsExtracted]);

  return (
    <div
      ref={contentRef}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
      className="page-content"
    />
  );
});
