import { Button } from 'antd';
import { IconUserOff } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { authClient } from '@classmoji/auth/client';

interface ImpersonationBannerProps {
  session?: {
    session?: { impersonatedBy?: string };
    user?: { name?: string; email?: string };
  } | null;
  /**
   * Set when the impersonation was started from the standalone admin app
   * (apps/admin), which drops a `cm_impersonation_origin=admin` cookie before
   * handing off. Such a session has no originating classroom, so the
   * slug-based return below has nothing to work with.
   */
  returnToAdminUrl?: string | null;
}

const ImpersonationBanner = ({ session, returnToAdminUrl }: ImpersonationBannerProps) => {
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

      // Started from the standalone admin app: send them back there. Checked
      // first because such a session has no originating classroom, so the
      // slug-based branch below would fall through to /select-organization.
      // A full navigation, not navigate() — different origin.
      if (returnToAdminUrl) {
        window.location.href = returnToAdminUrl;
        return;
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
    } catch (error: unknown) {
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
