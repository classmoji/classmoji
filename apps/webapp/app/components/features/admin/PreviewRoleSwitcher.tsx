import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { IconEye, IconArrowBackUp } from '@tabler/icons-react';
import { useNavigate } from 'react-router';
import {
  PREVIEWABLE_ROLES,
  ownerExitPath,
  previewPathFor,
  previewRoleLabel,
  type PreviewState,
  type PreviewableRole,
} from '~/utils/previewRole';

/**
 * Owner-only "Preview as" control, shown in the sidebar footer.
 *
 * SECURITY: this only navigates. It sets no role, writes nothing to the store
 * and asserts no permission — see the header of ~/utils/previewRole for why the
 * whole feature can only ever relabel an owner's OWN view. `canPreview` is
 * computed from the signed-in user's real memberships, so a non-owner never
 * renders this control, and reaching the same URL by hand still leaves them
 * with no role in the store and nothing rendered.
 *
 * Gated on the caller-supplied `preview` state rather than on `useRole()` on
 * purpose: during a preview the store role is the RELABELED one (TEACHER), so
 * an owner-gated control that read the store would vanish the moment preview
 * began — taking the way out with it.
 */
interface PreviewRoleSwitcherProps {
  preview: PreviewState;
  classroomSlug: string | undefined;
  collapsed?: boolean;
}

const PreviewRoleSwitcher = ({
  preview,
  classroomSlug,
  collapsed = false,
}: PreviewRoleSwitcherProps) => {
  const navigate = useNavigate();

  if (!preview.canPreview || !classroomSlug) return null;

  const items: MenuProps['items'] = [
    {
      key: 'heading',
      type: 'group',
      label: <span className="text-xs text-gray-500 dark:text-gray-400">Preview the class as</span>,
      children: PREVIEWABLE_ROLES.map(role => ({
        key: role,
        label: previewRoleLabel(role),
        icon: <IconEye size={16} />,
        // antd marks the active entry; the banner is the primary signal.
        disabled: preview.previewRole === role,
      })),
    },
    ...(preview.isPreviewing
      ? [
          { key: 'divider', type: 'divider' as const },
          {
            key: 'exit',
            label: 'Back to owner view',
            icon: <IconArrowBackUp size={16} />,
          },
        ]
      : []),
  ];

  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'exit') {
      navigate(ownerExitPath(classroomSlug));
      return;
    }
    if ((PREVIEWABLE_ROLES as readonly string[]).includes(key)) {
      navigate(previewPathFor(key as PreviewableRole, classroomSlug));
    }
  };

  const label = preview.isPreviewing
    ? `Previewing: ${previewRoleLabel(preview.previewRole!)}`
    : 'Preview as';

  const button = (
    <button
      type="button"
      data-preview-switcher
      aria-label={label}
      className={`group flex items-center gap-2.5 rounded-md transition-colors duration-150 w-[calc(100%-12px)] ${
        collapsed ? 'justify-center p-2 mx-1.5' : 'px-2 py-1.5 mx-1.5 text-left'
      } ${
        preview.isPreviewing
          ? 'bg-violet-100 text-violet-900 hover:bg-violet-200 dark:bg-violet-500/20 dark:text-violet-100 dark:hover:bg-violet-500/30'
          : 'text-ink-1 hover:bg-nav-hover'
      }`}
    >
      {collapsed ? (
        <Tooltip title={label} placement="right">
          <IconEye size={20} strokeWidth={1.75} />
        </Tooltip>
      ) : (
        <>
          <IconEye size={20} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 truncate text-sm">{label}</span>
        </>
      )}
    </button>
  );

  return (
    <div className="px-2 pb-1 shrink-0">
      <Dropdown menu={{ items, onClick }} placement="topLeft" trigger={['click']}>
        {button}
      </Dropdown>
    </div>
  );
};

export default PreviewRoleSwitcher;
