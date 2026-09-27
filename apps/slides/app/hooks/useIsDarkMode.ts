import { useEffect, useState } from 'react';

/**
 * Whether the app is in dark mode right now — the `dark` class the root toggles
 * on `<html>` from the OS preference. For Ant Design, which themes by algorithm
 * rather than by CSS variables and so has to be told.
 */
export function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
