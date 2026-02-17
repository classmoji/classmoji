import { useCallback, useState, useEffect, useRef } from 'react';
import { Popconfirm, message, Popover, Tooltip, Dropdown } from 'antd';
import ImageUploadModal from './ImageUploadModal';
import { useElementSelection } from './properties/ElementSelectionContext';

// ─────────────────────────────────────────────────────────────
// Overflow Detection Hook - Progressively hides groups when toolbar overflows
// ─────────────────────────────────────────────────────────────

function useToolbarOverflow(toolbarRef) {
  const [hiddenGroups, setHiddenGroups] = useState(0); // 0-4 groups hidden
  const lastAvailableWidthRef = useRef(0);
  const isExpandingRef = useRef(false); // Track if we just expanded to skip collapse check
  const hiddenGroupsRef = useRef(0); // Ref for stable access in ResizeObserver

  // Collapse order: 1=Insert, 2=SlideMgmt, 3=Lists, 4=Headings
  // (Themes moved to SlideProperties panel)
  // Estimated widths for expansion
  const MAX_HIDDEN = 4;
  const getNeededSpace = (level) => {
    switch (level) {
      case 1: return 150; // Insert Content
      case 2: return 250; // Slide Management
      case 3: return 120; // Lists
      case 4: return 100; // Headings
      default: return 150;
    }
  };

  // Keep ref in sync with state
  useEffect(() => {
    hiddenGroupsRef.current = hiddenGroups;
  }, [hiddenGroups]);

  // Helper to get available width from parent container
  const getAvailableWidth = (toolbar) => {
    const navbarCenter = toolbar.closest('.slides-navbar-editing > div:nth-child(2)');
    return navbarCenter ? navbarCenter.clientWidth : toolbar.parentElement?.clientWidth || 0;
  };

  // Helper to get actual content width (sum of children) since min-w-0 can shrink container
  const getContentWidth = (toolbar) => {
    let width = 0;
    for (const child of toolbar.children) {
      width += child.offsetWidth;
    }
    // Add gaps between children (gap-0.5 = 2px)
    const gapCount = Math.max(0, toolbar.children.length - 1);
    width += gapCount * 2;
    return width;
  };

  // Check overflow after render - collapse if overflowing, expand if room
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const wasExpanding = isExpandingRef.current;
    if (wasExpanding) {
      isExpandingRef.current = false;
    }

    // Use RAF to ensure DOM has painted
    const checkId = requestAnimationFrame(() => {
      const availableWidth = getAvailableWidth(toolbar);
      const currentHidden = hiddenGroupsRef.current;
      // Use getContentWidth for accurate measurement (min-w-0 can shrink scrollWidth)
      const contentWidth = getContentWidth(toolbar);
      // Account for hamburger button (~40px) and outer padding
      const toolbarNeeds = contentWidth + (currentHidden > 0 ? 40 : 0);
      const isOverflowing = toolbarNeeds > availableWidth - 10;

      // Skip collapse check if we just expanded (avoid collapse/expand race)
      if (!wasExpanding && isOverflowing && currentHidden < MAX_HIDDEN) {
        // Still overflowing, hide another group
        setHiddenGroups(h => h + 1);
      } else if (!isOverflowing && currentHidden > 0) {
        // Not overflowing and groups are hidden - check if we can expand more
        const extraSpace = availableWidth - contentWidth - 50;
        const neededSpace = getNeededSpace(currentHidden);

        if (extraSpace > neededSpace) {
          isExpandingRef.current = true;
          setHiddenGroups(h => h - 1);
        }
      }
    });

    return () => cancelAnimationFrame(checkId);
  }, [hiddenGroups]);

  // Watch for resize to potentially expand or contract - set up ONCE
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const handleResize = () => {
      const availableWidth = getAvailableWidth(toolbar);
      const widthDelta = availableWidth - lastAvailableWidthRef.current;
      lastAvailableWidthRef.current = availableWidth;

      const currentHidden = hiddenGroupsRef.current;
      // Use getContentWidth for accurate measurement (min-w-0 can shrink scrollWidth)
      const contentWidth = getContentWidth(toolbar);
      // Account for hamburger button (~40px) and outer padding
      const toolbarNeeds = contentWidth + (currentHidden > 0 ? 40 : 0);
      const isOverflowing = toolbarNeeds > availableWidth - 10;

      if (isOverflowing && currentHidden < MAX_HIDDEN) {
        // Need to hide more groups
        setHiddenGroups(h => h + 1);
      } else if (!isOverflowing && widthDelta > 30 && currentHidden > 0) {
        // Have space AND container is expanding - try showing one more group
        const extraSpace = availableWidth - contentWidth - 50; // 50px buffer
        const neededSpace = getNeededSpace(currentHidden);

        if (extraSpace > neededSpace) {
          isExpandingRef.current = true; // Flag to skip next collapse check
          setHiddenGroups(h => h - 1);
        }
      }
    };

    // Observe the navbar center container for size changes
    const navbarCenter = toolbar.closest('.slides-navbar-editing > div:nth-child(2)');
    const elementToObserve = navbarCenter || toolbar;

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(elementToObserve);
    lastAvailableWidthRef.current = getAvailableWidth(toolbar);

    // Initial check with small delay
    setTimeout(handleResize, 100);

    return () => resizeObserver.disconnect();
  }, []); // Empty deps - set up once, use refs for current values

  return {
    // Note: Themes removed - now in SlideProperties panel
    showInsertContent: hiddenGroups < 1,
    showSlideManagement: hiddenGroups < 2,
    showLists: hiddenGroups < 3,
    showHeadings: hiddenGroups < 4,
    hiddenGroups,
  };
}

/**
 * SlideToolbar - WYSIWYG editing toolbar for Reveal.js slides
 *
 * Provides formatting controls, slide navigation, content insertion,
 * and theme selection.
 * Uses document.execCommand for text formatting (widely supported).
 *
 * Reveal.js slide structure:
 * - Horizontal slides: sibling <section> elements
 * - Vertical slides: nested <section> elements inside a parent <section>
 */
export default function SlideToolbar({
  revealInstance,
  onContentChange,
  onImageUpload,
  onOpenOverview,   // Callback to open slide overview
}) {
  const [isImageModalOpen, setIsImageModalOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const toolbarRef = useRef(null);

  // Get snippets from context
  const { snippets } = useElementSelection();

  // Overflow detection - progressively hide groups when toolbar doesn't fit
  // Note: Themes moved to SlideProperties panel, Insert Content group was removed (only draggable blocks remain)
  const { showSlideManagement, showLists, showHeadings, hiddenGroups } = useToolbarOverflow(toolbarRef);
  // ─────────────────────────────────────────────────────────────
  // Text Formatting (uses execCommand - still works in all browsers)
  // ─────────────────────────────────────────────────────────────

  const execFormat = useCallback((command, value = null) => {
    document.execCommand(command, false, value);
    onContentChange?.();
  }, [onContentChange]);

  const formatBold = () => execFormat('bold');
  const formatItalic = () => execFormat('italic');
  const formatUnderline = () => execFormat('underline');
  const formatStrikethrough = () => execFormat('strikeThrough');

  // ─────────────────────────────────────────────────────────────
  // Block Formatting (headings, paragraphs, lists)
  // ─────────────────────────────────────────────────────────────

  const formatBlock = (tag) => {
    document.execCommand('formatBlock', false, tag);
    onContentChange?.();
  };

  const formatH1 = () => formatBlock('h1');
  const formatH2 = () => formatBlock('h2');
  const formatH3 = () => formatBlock('h3');
  const formatParagraph = () => formatBlock('p');

  const insertUnorderedList = () => execFormat('insertUnorderedList');
  const insertOrderedList = () => execFormat('insertOrderedList');

  // ─────────────────────────────────────────────────────────────
  // Slide Navigation (add slides left, right, or below)
  // ─────────────────────────────────────────────────────────────

  const getCurrentSlide = useCallback(() => {
    if (!revealInstance) return null;
    return revealInstance.getCurrentSlide();
  }, [revealInstance]);

  const createNewSlide = () => {
    const section = document.createElement('section');
    section.setAttribute('contenteditable', 'true');
    section.innerHTML = '<h2>New Slide</h2>\n<p>Add your content here...</p>';
    return section;
  };

  const addSlideLeft = useCallback(() => {
    const currentSlide = getCurrentSlide();
    if (!currentSlide) return;

    const newSlide = createNewSlide();

    // If current slide is in a vertical stack, add before the stack
    const parent = currentSlide.parentElement;
    if (parent.tagName === 'SECTION') {
      // In vertical stack - add before the parent stack
      parent.parentElement.insertBefore(newSlide, parent);
    } else {
      // Top-level slide - add before current
      parent.insertBefore(newSlide, currentSlide);
    }

    revealInstance.sync();
    revealInstance.left(); // Navigate to new slide
    revealInstance.layout(); // Recalculate slide positioning
    onContentChange?.();
  }, [getCurrentSlide, revealInstance, onContentChange]);

  const addSlideRight = useCallback(() => {
    const currentSlide = getCurrentSlide();
    if (!currentSlide) return;

    const newSlide = createNewSlide();

    // If current slide is in a vertical stack, add after the stack
    const parent = currentSlide.parentElement;
    if (parent.tagName === 'SECTION') {
      // In vertical stack - add after the parent stack
      parent.parentElement.insertBefore(newSlide, parent.nextSibling);
    } else {
      // Top-level slide - add after current
      parent.insertBefore(newSlide, currentSlide.nextSibling);
    }

    revealInstance.sync();
    revealInstance.right(); // Navigate to new slide
    revealInstance.layout(); // Recalculate slide positioning
    onContentChange?.();
  }, [getCurrentSlide, revealInstance, onContentChange]);

  const addSlideBelow = useCallback(() => {
    const currentSlide = getCurrentSlide();
    if (!currentSlide) return;

    const newSlide = createNewSlide();
    const parent = currentSlide.parentElement;

    // Get current position before DOM changes
    const indices = revealInstance.getIndices();
    const isCreatingNewStack = parent.tagName !== 'SECTION';

    if (parent.tagName === 'SECTION') {
      // Already in a vertical stack - add after current slide
      parent.insertBefore(newSlide, currentSlide.nextSibling);
    } else {
      // Not in a vertical stack - need to create one
      // Wrap current slide and new slide in a parent section
      const wrapper = document.createElement('section');
      parent.insertBefore(wrapper, currentSlide);
      wrapper.appendChild(currentSlide);
      wrapper.appendChild(newSlide);
      // Re-enable contenteditable on current slide (may have been removed)
      currentSlide.setAttribute('contenteditable', 'true');
    }

    // Sync first to update internal slide indices
    revealInstance.sync();

    if (isCreatingNewStack) {
      // When creating a new stack, explicitly navigate to the new slide
      // The horizontal index stays the same, vertical becomes 1 (second slide in stack)
      revealInstance.slide(indices.h, 1);
    } else {
      // In existing stack, just go down
      revealInstance.down();
    }

    revealInstance.layout(); // Recalculate slide positioning
    onContentChange?.();
  }, [getCurrentSlide, revealInstance, onContentChange]);

  // ─────────────────────────────────────────────────────────────
  // Delete Current Slide
  // ─────────────────────────────────────────────────────────────

  // Check if we can delete (more than one slide)
  const canDeleteSlide = useCallback(() => {
    const allSlides = document.querySelectorAll('.reveal .slides > section');
    return allSlides.length > 1;
  }, []);

  // Perform the actual deletion (called by Popconfirm onConfirm)
  const performDeleteSlide = useCallback(() => {
    const currentSlide = getCurrentSlide();
    if (!currentSlide) return;

    const parent = currentSlide.parentElement;

    // Navigate away from the slide before deleting
    // Try to go to the previous slide, otherwise next
    const indices = revealInstance.getIndices();
    const canGoLeft = indices.h > 0;
    const canGoUp = indices.v > 0;

    if (parent.tagName === 'SECTION') {
      // In vertical stack
      const siblings = parent.querySelectorAll(':scope > section');
      if (siblings.length <= 1) {
        // Last slide in stack - navigate horizontally then remove stack
        if (canGoLeft) {
          revealInstance.left();
        } else {
          revealInstance.right();
        }
        parent.remove();
      } else {
        // Multiple slides in stack - navigate vertically then remove slide
        if (canGoUp) {
          revealInstance.up();
        } else {
          revealInstance.down();
        }
        currentSlide.remove();
      }
    } else {
      // Top-level slide - navigate horizontally then remove
      if (canGoLeft) {
        revealInstance.left();
      } else {
        revealInstance.right();
      }
      currentSlide.remove();
    }

    revealInstance.sync();
    revealInstance.layout(); // Recalculate slide positioning
    onContentChange?.();
  }, [getCurrentSlide, revealInstance, onContentChange]);

  // Handle delete button click - show warning if can't delete
  const handleDeleteClick = useCallback((e) => {
    if (!canDeleteSlide()) {
      e.preventDefault();
      e.stopPropagation();
      message.warning('Cannot delete the only slide in the presentation');
      return false;
    }
  }, [canDeleteSlide]);

  // ─────────────────────────────────────────────────────────────
  // Sandpack Code Playground
  // ─────────────────────────────────────────────────────────────

  // Default Sandpack files for code playground blocks
  const getDefaultSandpackFiles = () => ({
    '/index.html': `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Hello World</h1>
  <p>Edit the code to see changes!</p>
  <script src="index.js"></script>
</body>
</html>`,
    '/styles.css': `body {
  font-family: system-ui, sans-serif;
  padding: 20px;
  margin: 0;
}

h1 {
  color: #333;
}`,
    '/index.js': `// Your JavaScript code here
console.log('Hello from JavaScript!');

document.querySelector('h1').addEventListener('click', () => {
  alert('Clicked!');
});`,
  });

  // Insert draggable Sandpack sl-block
  const insertSandpackSlBlock = useCallback(() => {
    requestAnimationFrame(() => {
      const section = revealInstance?.getCurrentSlide();
      if (!section) return;

      // Create sl-block wrapper for draggable positioning
      const block = document.createElement('div');
      block.className = 'sl-block';
      block.dataset.blockType = 'sandpack';
      block.style.left = '30px';
      block.style.top = '100px';
      block.style.width = '900px';
      block.style.height = '400px';

      const content = document.createElement('div');
      content.className = 'sl-block-content';
      block.appendChild(content);

      const sandpackDiv = document.createElement('div');
      sandpackDiv.className = 'sandpack-embed';
      sandpackDiv.dataset.template = 'vanilla';
      sandpackDiv.dataset.theme = 'auto';
      sandpackDiv.dataset.layout = 'preview-right';

      const script = document.createElement('script');
      script.type = 'application/json';
      script.setAttribute('data-sandpack-files', '');
      script.textContent = JSON.stringify(getDefaultSandpackFiles(), null, 2);
      sandpackDiv.appendChild(script);

      content.appendChild(sandpackDiv);
      section.appendChild(block);

      onContentChange?.();
    });
  }, [revealInstance, onContentChange]);

  // ─────────────────────────────────────────────────────────────
  // SL-Block Insertion (absolutely positioned blocks)
  // ─────────────────────────────────────────────────────────────

  // Helper to create sl-block wrapper with default positioning
  const createSlBlock = useCallback((type, width = 400, height = 100) => {
    const block = document.createElement('div');
    block.className = 'sl-block';
    block.dataset.blockType = type;
    // Position at center of slide (960x700 default)
    block.style.left = `${Math.round((960 - width) / 2)}px`;
    block.style.top = `${Math.round((700 - height) / 2)}px`;
    block.style.width = `${width}px`;
    block.style.height = type === 'text' ? 'auto' : `${height}px`;

    const content = document.createElement('div');
    content.className = 'sl-block-content';
    block.appendChild(content);

    return { block, content };
  }, []);

  // Get the current slide section (for sl-blocks, we always add to section, not column)
  const getCurrentSection = useCallback(() => {
    if (revealInstance) {
      return revealInstance.getCurrentSlide();
    }
    // Fallback: query DOM
    let section = document.querySelector('section.stack.present section.present[contenteditable="true"]');
    if (!section) {
      section = document.querySelector('section.present[contenteditable="true"]:not(.stack)');
    }
    return section;
  }, [revealInstance]);

  // Insert a text block
  const insertTextSlBlock = useCallback(() => {
    requestAnimationFrame(() => {
      const section = getCurrentSection();
      if (!section) return;

      const { block, content } = createSlBlock('text', 400, 100);
      const p = document.createElement('p');
      p.textContent = 'Click to edit text...';
      content.appendChild(p);
      section.appendChild(block);

      onContentChange?.();
    });
  }, [getCurrentSection, createSlBlock, onContentChange]);

  // Insert an image block (opens upload modal)
  const [pendingBlockImage, setPendingBlockImage] = useState(false);

  const insertImageSlBlock = useCallback(() => {
    setPendingBlockImage(true);
    setIsImageModalOpen(true);
  }, []);

  // Handle image upload for sl-block
  const handleBlockImageUploaded = useCallback(async (file) => {
    if (!onImageUpload) {
      message.error('Image upload not available');
      setPendingBlockImage(false);
      return;
    }

    const url = await onImageUpload(file);

    requestAnimationFrame(() => {
      const section = getCurrentSection();
      if (!section) {
        setPendingBlockImage(false);
        return;
      }

      const { block, content } = createSlBlock('image', 400, 300);
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Block image';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      content.appendChild(img);
      section.appendChild(block);

      setPendingBlockImage(false);
      onContentChange?.();
    });
  }, [getCurrentSection, createSlBlock, onContentChange, onImageUpload]);

  // Insert a code block
  const insertCodeSlBlock = useCallback(() => {
    requestAnimationFrame(() => {
      const section = getCurrentSection();
      if (!section) return;

      const { block, content } = createSlBlock('code', 500, 200);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-javascript';
      code.textContent = '// Your code here';
      pre.appendChild(code);
      content.appendChild(pre);
      section.appendChild(block);

      onContentChange?.();
    });
  }, [getCurrentSection, createSlBlock, onContentChange]);

  // Insert an iframe block
  const insertIframeSlBlock = useCallback(() => {
    requestAnimationFrame(() => {
      const section = getCurrentSection();
      if (!section) return;

      const { block, content } = createSlBlock('iframe', 560, 315); // 16:9 aspect ratio

      // Wrap iframe in a container for placeholder styling when empty
      const wrapper = document.createElement('div');
      wrapper.className = 'iframe-wrapper';
      wrapper.setAttribute('data-iframe-placeholder', 'true');
      wrapper.style.width = '100%';
      wrapper.style.height = '100%';

      const iframe = document.createElement('iframe');
      iframe.src = 'about:blank';
      iframe.title = 'Embedded content';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = 'none';
      iframe.setAttribute('allowfullscreen', '');

      wrapper.appendChild(iframe);
      content.appendChild(wrapper);
      section.appendChild(block);

      onContentChange?.();
    });
  }, [getCurrentSection, createSlBlock, onContentChange]);

  // Insert a snippet as an sl-block
  const insertSnippet = useCallback((/** @type {{id: string, name: string, content: string}} */ snippet) => {
    requestAnimationFrame(() => {
      const section = getCurrentSection();
      if (!section) return;

      // Default size for snippet blocks - user can resize as needed
      const { block, content } = createSlBlock('snippet', 400, 150);
      block.dataset.snippetId = snippet.id;

      // Insert the snippet HTML into the block content
      content.innerHTML = snippet.content;
      section.appendChild(block);

      onContentChange?.();
    });
  }, [getCurrentSection, createSlBlock, onContentChange]);

  // ─────────────────────────────────────────────────────────────
  // Toolbar Button Component
  // ─────────────────────────────────────────────────────────────

  const ToolbarButton = ({ onClick, title, children, className = '' }) => (
    <Tooltip title={title} mouseEnterDelay={0.1} mouseLeaveDelay={0}>
      <button
        onClick={onClick}
        className={`px-2 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors ${className}`}
      >
        {children}
      </button>
    </Tooltip>
  );

  const Divider = () => (
    <div className="w-px h-6 bg-gray-300 dark:bg-gray-600 mx-1" />
  );

  // ─────────────────────────────────────────────────────────────
  // Render Functions for Button Groups
  // ─────────────────────────────────────────────────────────────

  // Group 1: Text Formatting (always visible)
  const renderTextFormattingGroup = () => (
    <>
      <ToolbarButton onClick={formatBold} title="Bold (Ctrl+B)">
        <span className="font-bold">B</span>
      </ToolbarButton>
      <ToolbarButton onClick={formatItalic} title="Italic (Ctrl+I)">
        <span className="italic">I</span>
      </ToolbarButton>
      <ToolbarButton onClick={formatUnderline} title="Underline (Ctrl+U)">
        <span className="underline">U</span>
      </ToolbarButton>
      <ToolbarButton onClick={formatStrikethrough} title="Strikethrough">
        <span className="line-through">S</span>
      </ToolbarButton>
    </>
  );

  // Group 2: Headings (collapsible at very small sizes)
  const renderHeadingsGroup = (inMenu = false) => (
    <div className={inMenu ? 'flex flex-wrap items-center gap-1' : 'flex items-center gap-0.5'}>
      <ToolbarButton onClick={formatH1} title="Heading 1">H1</ToolbarButton>
      <ToolbarButton onClick={formatH2} title="Heading 2">H2</ToolbarButton>
      <ToolbarButton onClick={formatH3} title="Heading 3">H3</ToolbarButton>
      <ToolbarButton onClick={formatParagraph} title="Paragraph">P</ToolbarButton>
    </div>
  );

  // Group 3: Lists (collapsible at very small sizes)
  const renderListsGroup = (inMenu = false) => (
    <div className={inMenu ? 'flex flex-wrap items-center gap-1' : 'flex items-center gap-0.5'}>
      <ToolbarButton onClick={insertUnorderedList} title="Bullet List">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={insertOrderedList} title="Numbered List">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h10M7 16h10M3 8h.01M3 12h.01M3 16h.01" />
        </svg>
      </ToolbarButton>
    </div>
  );

  // Group 4: Slide Management - includes navigation + delete + overview (collapsible)
  const renderSlideManagementGroup = (inMenu = false) => (
    <div className={inMenu ? 'flex flex-wrap items-center gap-1' : 'flex items-center gap-0.5'}>
      <ToolbarButton onClick={addSlideLeft} title="Add slide to left">
        ← Add
      </ToolbarButton>
      <ToolbarButton onClick={addSlideRight} title="Add slide to right">
        → Add
      </ToolbarButton>
      <ToolbarButton onClick={addSlideBelow} title="Add slide below (vertical)">
        ↓ Add
      </ToolbarButton>
      <Popconfirm
        title="Delete Slide"
        description="Are you sure you want to delete this slide?"
        onConfirm={performDeleteSlide}
        okText="Delete"
        okButtonProps={{ danger: true }}
        cancelText="Cancel"
        disabled={!canDeleteSlide()}
      >
        <button
          onClick={handleDeleteClick}
          title="Delete current slide"
          className={`px-2 py-1 text-sm font-medium rounded transition-colors ${
            canDeleteSlide()
              ? 'text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30'
              : 'text-gray-400 dark:text-gray-500 cursor-not-allowed'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </Popconfirm>
      <ToolbarButton onClick={onOpenOverview} title="Slide Overview">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
      </ToolbarButton>
    </div>
  );

  // Insert Blocks (absolutely positioned, draggable blocks)
  const renderBlocksGroup = (inMenu = false) => (
    <div className={inMenu ? 'flex flex-wrap items-center gap-1' : 'flex items-center gap-0.5'}>
      <ToolbarButton onClick={insertTextSlBlock} title="Add text block">
        <span className="text-xs font-medium">T</span>
        <svg className="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={insertImageSlBlock} title="Add image block">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <svg className="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={insertCodeSlBlock} title="Add code block">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
        <svg className="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={insertIframeSlBlock} title="Add iframe embed">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <svg className="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={insertSandpackSlBlock} title="Add code playground">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <svg className="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </ToolbarButton>
    </div>
  );

  // Overflow menu content - shows hidden groups
  const renderOverflowMenuContent = () => (
    <div className="p-3 min-w-[220px] bg-white dark:bg-gray-800 rounded-lg">
      {!showSlideManagement && (
        <>
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">Slide Management</div>
          {renderSlideManagementGroup(true)}
          <div className="w-full h-px bg-gray-200 dark:bg-gray-600 my-3" />
        </>
      )}
      {!showLists && (
        <>
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">Lists</div>
          {renderListsGroup(true)}
          {!showHeadings && <div className="w-full h-px bg-gray-200 dark:bg-gray-600 my-3" />}
        </>
      )}
      {!showHeadings && (
        <>
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">Headings</div>
          {renderHeadingsGroup(true)}
        </>
      )}
    </div>
  );

  // Hamburger icon for overflow menu
  const HamburgerIcon = () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );

  return (
    <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-gray-700 rounded-lg px-1 py-0.5">
      {/* Main toolbar content - measured for overflow detection */}
      <div
        ref={toolbarRef}
        className="flex items-center gap-0.5 flex-nowrap min-w-0"
      >
        {/* Insert Blocks (always visible - for absolute positioning) */}
        {renderBlocksGroup()}

        {/* Snippets dropdown (only if snippets exist) */}
        {snippets && snippets.length > 0 && (
          <Dropdown
            menu={{
              items: snippets.map((/** @type {{id: string, name: string, content: string}} */ s) => ({
                key: s.id,
                label: s.name,
                onClick: () => insertSnippet(s),
              })),
            }}
            trigger={['click']}
            placement="bottomLeft"
          >
            <button
              title="Insert snippet"
              className="px-2 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </Dropdown>
        )}

        {/* Group 2: Text Formatting (always visible) */}
        <Divider />
        {renderTextFormattingGroup()}

        {/* Group 3: Headings (collapsible at very small sizes) */}
        {showHeadings && (
          <>
            <Divider />
            {renderHeadingsGroup()}
          </>
        )}

        {/* Group 4: Lists (collapsible at very small sizes) */}
        {showLists && (
          <>
            <Divider />
            {renderListsGroup()}
          </>
        )}

        {/* Group 5: Slide Management (collapsible) */}
        {showSlideManagement && (
          <>
            <Divider />
            {renderSlideManagementGroup()}
          </>
        )}
      </div>

      {/* Hamburger menu - outside overflow container so it's always visible */}
      {hiddenGroups > 0 && (
        <>
          <Divider />
          <Popover
            content={renderOverflowMenuContent()}
            trigger="click"
            placement="bottomRight"
            open={popoverOpen}
            onOpenChange={setPopoverOpen}
            overlayClassName="slides-toolbar-popover"
            arrow={false}
          >
            <button
              title="More options"
              className="px-2 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors shrink-0"
            >
              <HamburgerIcon />
            </button>
          </Popover>
        </>
      )}

      {/* Image Upload Modal */}
      <ImageUploadModal
        open={isImageModalOpen}
        onClose={() => {
          setIsImageModalOpen(false);
          setPendingBlockImage(false);
        }}
        onUpload={handleBlockImageUploaded}
      />
    </div>
  );
}
