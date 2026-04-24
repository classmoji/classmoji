import { useEffect, useContext, useState } from 'react';
import { useLocation } from 'react-router';
import SyllabusBotWidget from './SyllabusBotWidget';
import { useDarkMode } from '~/hooks';
import { UserContext } from '~/contexts';
import { getRoleFromPath } from '~/constants/roleSettings';
import useStore from '~/store';

/**
 * SyllabusBotRoot - Root-level wrapper for the syllabus bot widget
 *
 * Handles:
 * - Extracting org from URL
 * - Fetching syllabus bot config
 * - Publishing enabled state to the global store so the sidebar can render
 *   the "Ask Moji" nav item
 * - Rendering the chat drawer, controlled by store's isAskMojiOpen
 */
interface SyllabusBotConfig {
  enabled: boolean;
  slidesUrl?: string;
}

const SyllabusBotRoot = () => {
  const { pathname } = useLocation();
  const { isDarkMode } = useDarkMode();
  const { user } = useContext(UserContext);
  const isAskMojiOpen = useStore(s => s.isAskMojiOpen);
  const setAskMojiOpen = useStore(s => s.setAskMojiOpen);
  const setAskMojiEnabled = useStore(s => s.setAskMojiEnabled);

  const [config, setConfig] = useState<SyllabusBotConfig | null>(null);
  const [currentClassroom, setCurrentClassroom] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<string | null>(null);

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
        setConfig(null);
        setAskMojiEnabled(false);
        setAskMojiOpen(false);
      }
      setCurrentRole(role);
    } else {
      setCurrentClassroom(null);
      setCurrentRole(null);
      setConfig(null);
      setAskMojiEnabled(false);
      setAskMojiOpen(false);
    }
  }, [pathname, currentClassroom, setAskMojiEnabled, setAskMojiOpen]);

  // Fetch config when classroom changes
  useEffect(() => {
    if (!currentClassroom) return;

    let cancelled = false;

    const fetchConfig = async () => {
      try {
        const response = await fetch(`/api/syllabus-bot/${currentClassroom}`);
        if (response.ok && !cancelled) {
          const data = (await response.json()) as SyllabusBotConfig;
          setConfig(data);
          setAskMojiEnabled(Boolean(data?.enabled));
        }
      } catch (err: unknown) {
        console.warn(
          '[SyllabusBotRoot] Failed to fetch config:',
          err instanceof Error ? err.message : String(err)
        );
      }
    };

    fetchConfig();

    return () => {
      cancelled = true;
    };
  }, [currentClassroom, setAskMojiEnabled]);

  if (!currentClassroom || !config?.enabled) {
    return null;
  }

  return (
    <SyllabusBotWidget
      key={`${currentClassroom}-${currentRole}`}
      classroomSlug={currentClassroom}
      slidesUrl={config.slidesUrl ?? ''}
      userLogin={user?.login ?? null}
      userRole={currentRole ?? ''}
      isOpen={isAskMojiOpen}
      onClose={() => setAskMojiOpen(false)}
      isDarkMode={isDarkMode}
    />
  );
};

export default SyllabusBotRoot;
