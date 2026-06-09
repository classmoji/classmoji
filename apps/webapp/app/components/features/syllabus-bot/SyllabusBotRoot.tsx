import { useEffect, useContext, useState } from 'react';
import { useLocation } from 'react-router';
import SyllabusBotWidget from './SyllabusBotWidget';
import { UserContext } from '~/contexts';
import { getRoleFromPath } from '~/constants/roleSettings';
import useStore from '~/store';

interface SyllabusBotConfig {
  enabled: boolean;
  slidesUrl?: string;
  orgName?: string;
  courseName?: string;
}

const SyllabusBotRoot = () => {
  const { pathname } = useLocation();
  const { user } = useContext(UserContext);
  const isAskMojiOpen = useStore(s => s.isAskMojiOpen);
  const setAskMojiOpen = useStore(s => s.setAskMojiOpen);
  const setAskMojiEnabled = useStore(s => s.setAskMojiEnabled);
  const setAskMojiActive = useStore(s => s.setAskMojiActive);

  const [config, setConfig] = useState<SyllabusBotConfig | null>(null);
  const [currentClassroom, setCurrentClassroom] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<string | null>(null);

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
        setAskMojiActive(false);
      }
      setCurrentRole(role);
    } else {
      setCurrentClassroom(null);
      setCurrentRole(null);
      setConfig(null);
      setAskMojiEnabled(false);
      setAskMojiOpen(false);
      setAskMojiActive(false);
    }
  }, [pathname, currentClassroom, setAskMojiEnabled, setAskMojiOpen, setAskMojiActive]);

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
      courseName={config.courseName}
      orgName={config.orgName}
    />
  );
};

export default SyllabusBotRoot;
