import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Hook to parse Reveal.js DOM into a normalized data structure
 * and sync changes back to the DOM
 *
 * Data Model:
 * - stacks: Array of stack objects, each containing slides
 * - Every top-level item is a "stack" (even single slides)
 *
 * @param {Object} revealInstance - The Reveal.js instance (passed as state, not a ref)
 * @param {Function} onContentChange - Callback when content changes
 */
export function useSlideStructure(revealInstance, onContentChange) {
  const [stacks, setStacks] = useState([]);
  const [error, setError] = useState(null);
  // Track if we need to sync changes to DOM (set after user actions, not initial load)
  const pendingSyncRef = useRef(false);

  // Parse the DOM structure when Reveal.js instance becomes available
  // Using revealInstance (state) instead of a ref ensures this effect re-runs
  // when Reveal.js finishes initializing
  useEffect(() => {
    if (!revealInstance) return;

    const slidesContainer = revealInstance.getSlidesElement();
    if (!slidesContainer) {
      console.error('[SlideOverview] Failed to get slides container');
      setError('Could not find slides container. Try closing and reopening the overview.');
      return;
    }

    // Successfully got the slides container - parse it
    const parsed = parseSlideStructure(slidesContainer);
    if (parsed.length === 0) {
      console.error('[SlideOverview] No stacks found! Check slide structure.');
    }
    setStacks(parsed);
  }, [revealInstance]);

  // Find a slide by ID
  const findSlideById = useCallback((slideId) => {
    for (const stack of stacks) {
      const slide = stack.slides.find(s => s.id === slideId);
      if (slide) return slide;
    }
    return null;
  }, [stacks]);

  // Find a stack by ID
  const findStackById = useCallback((stackId) => {
    return stacks.find(s => s.id === stackId) || null;
  }, [stacks]);

  // Move a slide to a new location
  const moveSlide = useCallback((slideId, destination) => {
    setStacks(prevStacks => {
      // Clone stacks/slides but preserve DOM element references (JSON.stringify destroys them)
      const newStacks = prevStacks.map(stack => ({
        ...stack,
        slides: stack.slides.map(slide => ({ ...slide })),
      }));

      // Find and remove the slide from its current location
      let movedSlide = null;
      let sourceStackIndex = -1;

      for (let i = 0; i < newStacks.length; i++) {
        const slideIndex = newStacks[i].slides.findIndex(s => s.id === slideId);
        if (slideIndex !== -1) {
          movedSlide = newStacks[i].slides.splice(slideIndex, 1)[0];
          sourceStackIndex = i;
          break;
        }
      }

      if (!movedSlide) return prevStacks;

      // Handle destination
      if (destination.type === 'new-stack') {
        // Create a new single-slide stack at the specified index
        const newStack = {
          id: `stack-${Date.now()}`,
          slides: [movedSlide],
        };
        newStacks.splice(destination.index, 0, newStack);
      } else if (destination.type === 'into-stack') {
        // Insert into an existing stack
        const targetStack = newStacks.find(s => s.id === destination.stackId);
        if (targetStack) {
          targetStack.slides.splice(destination.index, 0, movedSlide);
        }
      }

      // Remove empty stacks
      return newStacks.filter(stack => stack.slides.length > 0);
    });
  }, []);

  // Move a stack to a new position
  const moveStack = useCallback((stackId, newIndex) => {
    setStacks(prevStacks => {
      const newStacks = [...prevStacks];
      const currentIndex = newStacks.findIndex(s => s.id === stackId);
      if (currentIndex === -1) return prevStacks;

      const [movedStack] = newStacks.splice(currentIndex, 1);

      // Adjust index if we removed from before the target
      const adjustedIndex = currentIndex < newIndex ? newIndex - 1 : newIndex;
      newStacks.splice(adjustedIndex, 0, movedStack);

      return newStacks;
    });
  }, []);

  // Delete a slide
  const deleteSlide = useCallback((slideId) => {
    setStacks(prevStacks => {
      // Count total slides to prevent deleting the last one
      const totalSlides = prevStacks.reduce((sum, stack) => sum + stack.slides.length, 0);
      if (totalSlides <= 1) return prevStacks;

      const newStacks = prevStacks.map(stack => ({
        ...stack,
        slides: stack.slides.filter(s => s.id !== slideId),
      }));

      // Remove empty stacks
      return newStacks.filter(stack => stack.slides.length > 0);
    });
  }, []);

  // Create a new stack from a slide (for new-stack-zone drops)
  const createStack = useCallback((slideId) => {
    setStacks(prevStacks => {
      // Clone stacks/slides but preserve DOM element references
      const newStacks = prevStacks.map(stack => ({
        ...stack,
        slides: stack.slides.map(slide => ({ ...slide })),
      }));

      // Find and remove the slide
      let movedSlide = null;
      for (let i = 0; i < newStacks.length; i++) {
        const slideIndex = newStacks[i].slides.findIndex(s => s.id === slideId);
        if (slideIndex !== -1) {
          movedSlide = newStacks[i].slides.splice(slideIndex, 1)[0];
          break;
        }
      }

      if (!movedSlide) return prevStacks;

      // Add new stack at the end
      newStacks.push({
        id: `stack-${Date.now()}`,
        slides: [movedSlide],
      });

      // Remove empty stacks
      return newStacks.filter(stack => stack.slides.length > 0);
    });
  }, []);

  // Sync the current state back to the Reveal.js DOM
  const syncToDOM = useCallback(() => {
    if (!revealInstance) return;

    const slidesContainer = revealInstance.getSlidesElement();
    if (!slidesContainer) return;

    // Build new DOM structure
    const fragment = document.createDocumentFragment();

    stacks.forEach(stack => {
      if (stack.slides.length === 1) {
        // Single slide - add directly (still wrapped conceptually as stack)
        const slide = stack.slides[0];
        const clone = slide.element.cloneNode(true);
        clone.setAttribute('contenteditable', 'true');
        fragment.appendChild(clone);
      } else {
        // Multiple slides - wrap in a section
        const wrapper = document.createElement('section');
        stack.slides.forEach(slide => {
          const clone = slide.element.cloneNode(true);
          clone.setAttribute('contenteditable', 'true');
          wrapper.appendChild(clone);
        });
        fragment.appendChild(wrapper);
      }
    });

    // Replace content
    slidesContainer.innerHTML = '';
    slidesContainer.appendChild(fragment);

    // Sync Reveal.js
    revealInstance.sync();
    revealInstance.layout();
    // Navigate to first slide to reset position
    revealInstance.slide(0, 0);
  }, [revealInstance, stacks]);

  // Effect to sync DOM when stacks change after user actions
  // This runs AFTER setStacks completes, ensuring we have the latest state
  useEffect(() => {
    if (pendingSyncRef.current && stacks.length > 0) {
      syncToDOM();
      onContentChange?.();
      pendingSyncRef.current = false;
    }
  }, [stacks, syncToDOM, onContentChange]);

  // Wrapper functions that mark changes as pending sync
  const moveSlideAndSync = useCallback((slideId, destination) => {
    pendingSyncRef.current = true;
    moveSlide(slideId, destination);
  }, [moveSlide]);

  const moveStackAndSync = useCallback((stackId, newIndex) => {
    pendingSyncRef.current = true;
    moveStack(stackId, newIndex);
  }, [moveStack]);

  const deleteSlideAndSync = useCallback((slideId) => {
    pendingSyncRef.current = true;
    deleteSlide(slideId);
  }, [deleteSlide]);

  const createStackAndSync = useCallback((slideId) => {
    pendingSyncRef.current = true;
    createStack(slideId);
  }, [createStack]);

  return {
    stacks,
    setStacks,
    error,
    findSlideById,
    findStackById,
    // Export the auto-syncing wrapper functions
    moveSlide: moveSlideAndSync,
    moveStack: moveStackAndSync,
    deleteSlide: deleteSlideAndSync,
    createStack: createStackAndSync,
  };
}

/**
 * Parse the Reveal.js DOM structure into a normalized data model
 */
function parseSlideStructure(slidesContainer) {
  const stacks = [];

  // First try direct children
  let topLevelSections = slidesContainer.querySelectorAll(':scope > section');

  // If no direct sections, look for nested .slides container (handles double-wrapped content)
  if (topLevelSections.length === 0) {
    const nestedSlides = slidesContainer.querySelector('.slides');
    if (nestedSlides) {
      topLevelSections = nestedSlides.querySelectorAll(':scope > section');
    }
  }

  // Still nothing? Try any sections as fallback
  if (topLevelSections.length === 0) {
    topLevelSections = slidesContainer.querySelectorAll('section');
    // Filter to only top-level (not nested in other sections)
    topLevelSections = Array.from(topLevelSections).filter(
      section => !section.parentElement?.closest('section')
    );
  }

  topLevelSections.forEach((section, hIndex) => {
    const nestedSections = section.querySelectorAll(':scope > section');

    if (nestedSections.length > 0) {
      // This is a vertical stack
      const slides = Array.from(nestedSections).map((nested, vIndex) => ({
        id: `slide-${hIndex}-${vIndex}`,
        element: nested,
        hIndex,
        vIndex,
      }));
      stacks.push({
        id: `stack-${hIndex}`,
        slides,
      });
    } else {
      // Single slide (still treat as a stack with one slide)
      stacks.push({
        id: `stack-${hIndex}`,
        slides: [{
          id: `slide-${hIndex}-0`,
          element: section,
          hIndex,
          vIndex: 0,
        }],
      });
    }
  });

  return stacks;
}
