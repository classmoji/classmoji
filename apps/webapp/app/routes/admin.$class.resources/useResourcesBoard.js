import { useState, useMemo, useCallback } from 'react';

export const useResourcesBoard = (modules, pages, slides) => {
  const [activeCard, setActiveCard] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPages, setShowPages] = useState(true);
  const [showSlides, setShowSlides] = useState(true);

  // Filter resources based on search and type toggles
  const allPages = useMemo(() => {
    if (!showPages) return [];
    if (!searchQuery) return pages;
    return pages.filter(page =>
      page.title.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [pages, searchQuery, showPages]);

  const allSlides = useMemo(() => {
    if (!showSlides) return [];
    if (!searchQuery) return slides;
    return slides.filter(slide =>
      slide.title.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [slides, searchQuery, showSlides]);

  // Get resources linked to a specific module
  const getModuleResources = useCallback((moduleId) => {
    const modulePages = allPages.filter(page =>
      page.links?.some(link => link.module_id === moduleId && !link.assignment_id)
    );

    const moduleSlides = allSlides.filter(slide =>
      slide.links?.some(link => link.module_id === moduleId && !link.assignment_id)
    );

    return { pages: modulePages, slides: moduleSlides };
  }, [allPages, allSlides]);

  // Get resources linked to a specific assignment
  const getAssignmentResources = useCallback((assignmentId) => {
    const assignmentPages = allPages.filter(page =>
      page.links?.some(link => link.assignment_id === assignmentId)
    );

    const assignmentSlides = allSlides.filter(slide =>
      slide.links?.some(link => link.assignment_id === assignmentId)
    );

    return { pages: assignmentPages, slides: assignmentSlides };
  }, [allPages, allSlides]);

  // Check if a resource is already linked to a target
  const isLinked = useCallback((resource, resourceType, targetType, targetId) => {
    return resource.links?.some(link =>
      targetType === 'module'
        ? link.module_id === targetId && !link.assignment_id
        : link.assignment_id === targetId
    );
  }, []);

  // Get link ID for a resource in a specific target
  const getLinkId = useCallback((resource, targetType, targetId) => {
    const link = resource.links?.find(link =>
      targetType === 'module'
        ? link.module_id === targetId && !link.assignment_id
        : link.assignment_id === targetId
    );
    return link?.id;
  }, []);

  return {
    allPages,
    allSlides,
    getModuleResources,
    getAssignmentResources,
    isLinked,
    getLinkId,
    activeCard,
    setActiveCard,
    searchQuery,
    setSearchQuery,
    showPages,
    setShowPages,
    showSlides,
    setShowSlides,
  };
};
