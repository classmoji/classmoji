import { useEffect } from 'react';

// Redesign (2026) ships light-only. The auto OS-preference dark-mode toggle
// was removing sidebar/topbar backgrounds while leaving content cards light,
// producing a broken mixed look. This hook now just strips any lingering
// `.dark` class and reports `isDarkMode: false`.
const useDarkMode = () => {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.remove('dark');
  }, []);

  return { isDarkMode: false } as const;
};

export default useDarkMode;
