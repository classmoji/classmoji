import { Button } from 'antd';
import { IconUserOff } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { authClient } from '@classmoji/auth/client';

const ImpersonationBanner = ({ session }) => {
  const navigate = useNavigate();
  const [stopping, setStopping] = useState(false);

  // Check if this is an impersonation session
  const isImpersonating = session?.session?.impersonatedBy;

  if (!isImpersonating) {
    return null;
  }

  const handleStopImpersonating = async () => {
    setStopping(true);
    try {
      const { error } = await authClient.admin.stopImpersonating();

      if (error) {
        throw new Error(error.message || 'Failed to stop impersonating');
      }

      // Navigate back to the appropriate admin page for the current class
      const currentPath = window.location.pathname;
      const classMatch = currentPath.match(/\/(student|admin|assistant)\/([^/]+)/);
      const classSlug = classMatch ? classMatch[2] : null;

      if (classSlug) {
        // Navigate back to assistants page if viewing as assistant, otherwise students page
        if (currentPath.includes('/assistant/')) {
          navigate(`/admin/${classSlug}/assistants`);
        } else {
          navigate(`/admin/${classSlug}/students`);
        }
      } else {
        navigate('/select-organization');
      }
    } catch (error) {
      console.error('[STOP_IMPERSONATE] Failed to stop impersonating:', error);
      setStopping(false);
    }
  };

  return (
    <>
      {/* Spacer to push content below the fixed banner */}
      <div className="h-10" />
      <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-amber-950 py-2 px-4 flex items-center justify-center gap-4 shadow-md">
        <IconUserOff size={18} />
        <span className="font-medium">
          You are viewing as: <strong>{session?.user?.name || session?.user?.email}</strong>
        </span>
        <Button
          type="primary"
          size="small"
          danger
          onClick={handleStopImpersonating}
          loading={stopping}
          className="ml-2"
        >
          Stop viewing
        </Button>
      </div>
    </>
  );
};

export default ImpersonationBanner;
