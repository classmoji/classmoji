import { useState, useEffect, useContext } from 'react';
import { useLocation } from 'react-router';
import SyllabusBotWidget from './SyllabusBotWidget';
import { useDarkMode } from '~/hooks';
import { UserContext } from '~/contexts';
import { getRoleFromPath } from '~/constants/roleSettings';

/**
 * SyllabusBotRoot - Root-level wrapper for the syllabus bot widget
 *
 * Handles:
 * - Extracting org from URL
 * - Fetching syllabus bot config
 * - Rendering widget when enabled
 *
 * Placed in root.jsx to show on all pages when enabled.
 */
const SyllabusBotRoot = () => {
  const { pathname } = useLocation();
  const { isDarkMode } = useDarkMode();
  const { user } = useContext(UserContext);
  const [config, setConfig] = useState(null);
  const [currentClassroom, setCurrentClassroom] = useState(null);
  const [currentRole, setCurrentRole] = useState(null);

  // Extract classroom slug and role from pathname
  // Patterns: /student/{classroomSlug}/..., /admin/{classroomSlug}/..., /assistant/{classroomSlug}/...
  useEffect(() => {
    const match = pathname.match(/^\/(student|admin|assistant)\/([^/]+)/);
    if (match) {
      const rolePrefix = match[1];
      const classroomSlug = match[2];
      const role = getRoleFromPath(rolePrefix);

      if (classroomSlug !== currentClassroom) {
        setCurrentClassroom(classroomSlug);
        setConfig(null); // Reset config when classroom changes
      }
      setCurrentRole(role);
    } else {
      // Not in a classroom context
      setCurrentClassroom(null);
      setCurrentRole(null);
      setConfig(null);
    }
  }, [pathname, currentClassroom]);

  // Fetch config when classroom changes
  useEffect(() => {
    if (!currentClassroom) return;

    let cancelled = false;

    const fetchConfig = async () => {
      try {
        const response = await fetch(`/api/syllabus-bot/${currentClassroom}`);
        if (response.ok && !cancelled) {
          const data = await response.json();
          setConfig(data);
        }
      } catch (err) {
        console.warn('[SyllabusBotRoot] Failed to fetch config:', err.message);
      }
    };

    fetchConfig();

    return () => {
      cancelled = true;
    };
  }, [currentClassroom]);

  // Don't render if no classroom or not enabled
  if (!currentClassroom || !config?.enabled) {
    return null;
  }

  return (
    <SyllabusBotWidget
      key={`${currentClassroom}-${currentRole}`}
      classroomSlug={currentClassroom}
      slidesUrl={config.slidesUrl}
      userLogin={user?.login}
      userRole={currentRole}
      enabled={config.enabled}
      isDarkMode={isDarkMode}
    />
  );
};

export default SyllabusBotRoot;
