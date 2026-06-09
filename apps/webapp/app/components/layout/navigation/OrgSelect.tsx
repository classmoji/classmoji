import { Select, Avatar } from 'antd';
import { useNavigate } from 'react-router';
import { useRef, useState } from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import useStore from '~/store';
import { roleSettings } from '~/constants/roleSettings';
import type { MembershipWithOrganization } from '~/types';

interface OrgSelectProps {
  memberships: MembershipWithOrganization[];
}

type OrgSelectOption = {
  value: string;
  label: string;
} & MembershipWithOrganization;

const roleLabel = (role: string) => {
  const map: Record<string, string> = {
    OWNER: 'Owner',
    TEACHER: 'Teacher',
    ASSISTANT: 'Assistant',
    STUDENT: 'Student',
  };
  return map[role] ?? role.charAt(0) + role.slice(1).toLowerCase();
};

const OrgSelect = ({ memberships }: OrgSelectProps) => {
  const { membership } = useStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 120);
  };

  const handleMouseEnter = () => {
    cancelClose();
    setOpen(true);
  };

  return (
    <div className="w-full" onMouseEnter={handleMouseEnter} onMouseLeave={scheduleClose}>
      <Select
        placeholder="Select classroom"
        variant="borderless"
        className="w-full bg-transparent hover:bg-nav-hover rounded-md transition-colors"
        popupMatchSelectWidth={true}
        open={open}
        onDropdownVisibleChange={visible => {
          cancelClose();
          setOpen(visible);
        }}
        suffixIcon={
          <IconChevronDown
            size={16}
            className={`text-ink-4 transition-transform duration-200 ease-out ${
              open ? '-rotate-180' : 'rotate-0'
            }`}
          />
        }
        dropdownRender={menu => (
          <div onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
            {menu}
          </div>
        )}
        styles={{
          popup: {
            root: {
              padding: '2px',
              msOverflowStyle: 'none',
              scrollbarWidth: 'none',
              boxShadow: 'none',
              border: '1px solid var(--line)',
              borderRadius: '8px',
            },
          },
        }}
        classNames={{
          popup: {
            root: 'cm-org-select-popup [&::-webkit-scrollbar]:hidden [&_.ant-select-item-option-selected]:!bg-transparent [&_.ant-select-item-option-active]:!bg-transparent',
          },
        }}
        options={memberships
          ?.filter(m => !(m.organization as { is_example?: boolean }).is_example)
          .sort(
            (a, b) =>
              new Date(b.organization.created_at ?? 0).getTime() -
              new Date(a.organization.created_at ?? 0).getTime()
          )
          .map(m => ({
            value: m.id.toString(),
            label: m.organization.name,
            ...m,
          }))}
        labelInValue={true}
        labelRender={() => {
          if (!membership) return null;
          return (
            <div className="min-w-0 px-1 flex items-baseline gap-1.5">
              <span className="text-sm font-semibold text-ink-0 truncate">
                {membership.organization.name}
              </span>
            </div>
          );
        }}
        optionRender={({ data }) => {
          const membershipOption = data as OrgSelectOption;
          return (
            <button
              className="flex w-full items-center gap-2 px-1.5 py-1.5 hover:bg-nav-hover rounded-md cursor-pointer transition-colors text-left"
              onClick={() => {
                // Students go to class root (student.$class._index handles default page)
                const suffix = membershipOption.role === 'STUDENT' ? '' : '/dashboard';
                navigate(
                  `${(roleSettings as Record<string, { path: string; color: string }>)[membershipOption.role].path}/${membershipOption.organization.login}${suffix}`
                );
              }}
            >
              <Avatar
                src={membershipOption.organization.avatar_url}
                size={22}
                className="shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <div className="font-medium text-sm text-ink-0 truncate leading-tight">
                    {membershipOption.organization.name}
                  </div>
                </div>
                <div
                  className="text-xs text-ink-3 truncate leading-tight"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {membershipOption.organization.login} · {roleLabel(membershipOption.role)}
                </div>
              </div>
            </button>
          );
        }}
        value={
          membership?.id
            ? { value: membership.id.toString(), label: membership.organization.name }
            : undefined
        }
      />
    </div>
  );
};

export default OrgSelect;
