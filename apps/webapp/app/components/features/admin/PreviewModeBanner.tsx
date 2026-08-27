import { Button } from 'antd';
import { IconEye } from '@tabler/icons-react';
import { Link } from 'react-router';
import { ownerExitPath, previewRoleLabel, type PreviewState } from '~/utils/previewRole';

/**
 * Persistent indicator shown while an OWNER is previewing the class as another
 * role. An owner must never be in doubt about which view they are looking at,
 * so this sticks to the top of the content area for the whole preview and
 * carries a one-click way out.
 *
 * DELIBERATELY DISTINCT FROM ImpersonationBanner, because the two states are
 * different in kind and confusing them would be the failure mode:
 *
 *   ImpersonationBanner (amber, fixed to the viewport top) — "you are signed in
 *   as someone else". The session really is another user's; writes are made as
 *   them, and leaving means ending that session.
 *
 *   This one (violet, sticky above the page) — "you are previewing". You are
 *   still yourself, your own permissions still apply, and leaving is a
 *   navigation.
 *
 * The two cannot appear together: during impersonation the root loader's
 * memberships are the IMPERSONATED user's, so an owner previewing a TA has no
 * OWNER membership in that list and `canPreview` is false.
 *
 * SECURITY: rendering this proves nothing and grants nothing — see the header
 * of ~/utils/previewRole. It is driven by `preview`, which requires a real
 * OWNER membership in this classroom, and the server still resolves the viewer
 * as OWNER regardless of the prefix in the URL.
 */
interface PreviewModeBannerProps {
  preview: PreviewState;
  classroomSlug: string | undefined;
}

const PreviewModeBanner = ({ preview, classroomSlug }: PreviewModeBannerProps) => {
  if (!preview.isPreviewing || !preview.previewRole || !classroomSlug) return null;

  const roleLabel = previewRoleLabel(preview.previewRole);

  return (
    <div
      data-preview-banner
      role="status"
      className="sticky top-0 z-20 -mx-1 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-300 bg-violet-100 px-4 py-2.5 text-violet-950 shadow-sm dark:border-violet-400/40 dark:bg-violet-500/20 dark:text-violet-50"
    >
      <span className="flex items-center gap-2 text-sm">
        <IconEye size={18} className="shrink-0" />
        <span>
          Preview mode — seeing this class as a <strong>{roleLabel}</strong>. You are still signed
          in as yourself, and your owner permissions are unchanged.
        </span>
      </span>
      <Link to={ownerExitPath(classroomSlug)}>
        <Button size="small" type="primary">
          Back to owner view
        </Button>
      </Link>
    </div>
  );
};

export default PreviewModeBanner;
