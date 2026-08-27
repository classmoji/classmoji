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
  /**
   * Scope the breadcrumb cookie was set with, so it can be deleted with a
   * matching domain. Null in bare development (host-only cookies).
   */
  impersonationCookieDomain?: string | null;
}

/** Name must match apps/admin's `ORIGIN_COOKIE`. */
const ORIGIN_COOKIE = 'cm_impersonation_origin';

const clearImpersonationOrigin = (cookieDomain?: string | null) => {
  const parts = [`${ORIGIN_COOKIE}=`, 'path=/', 'max-age=0', 'samesite=lax'];
  if (cookieDomain) parts.push(`domain=${cookieDomain}`);
  if (window.location.protocol === 'https:') parts.push('secure');
  document.cookie = parts.join('; ');
};

const ImpersonationBanner = ({
  session,
  returnToAdminUrl,
  impersonationCookieDomain,
}: ImpersonationBannerProps) => {
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

      // Clear the breadcrumb apps/admin dropped before handing off. It carries
      // max-age=3600, so leaving it set would make the NEXT impersonation --
      // including an ordinary classroom "View as" -- return to the admin app
      // too. Deleting a cookie requires the same domain and path it was set
      // with, hence impersonationCookieDomain coming down from the loader.
      clearImpersonationOrigin(impersonationCookieDomain);

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
      const classMatch = currentPath.match(/\/(student|admin|teacher|assistant)\/([^/]+)/);
      const classSlug = classMatch ? classMatch[2] : null;

      if (classSlug) {
        // Return to the list the impersonated user was picked from: teaching
        // team members (teachers and assistants alike) live on the Teaching
        // Staff page, everyone else on the roster.
        if (currentPath.includes('/assistant/') || currentPath.includes('/teacher/')) {
          navigate(`/admin/${classSlug}/staff`);
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
