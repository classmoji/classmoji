import { useEffect, useState } from 'react';

const useDarkMode = () => {
  // IMPORTANT: Always initialize to false for SSR/hydration consistency.
  // The actual system preference is set in useEffect after hydration.
  // This prevents Ant Design CSS-in-JS hash mismatches between server and client.
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    // Only run on client side
    if (typeof window === 'undefined') return;

    // Update document class
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    // Only run on client side
    if (typeof window === 'undefined') return;

    // Listen for system preference changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = e => {
      setIsDarkMode(e.matches);
    };

    // Set initial value based on current system preference
    setIsDarkMode(mediaQuery.matches);

    // Modern browsers
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    // Legacy browsers
    else if (mediaQuery.addListener) {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, []);

  return {
    isDarkMode,
  };
};

export default useDarkMode;
