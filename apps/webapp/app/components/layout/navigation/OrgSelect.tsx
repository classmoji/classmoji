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

const termAbbreviation = (term?: string | null, year?: number | null) => {
  if (!term || !year) return null;
  const prefix: Record<string, string> = {
    FALL: 'F',
    WINTER: 'W',
    SPRING: 'S',
    SUMMER: 'X',
  };
  const p = prefix[term];
  if (!p) return null;
  return `${p}${String(year).slice(-2)}`;
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
    <div
      className="w-full"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={scheduleClose}
    >
      <Select
        placeholder="Select classroom"
        variant="borderless"
        className="w-full bg-transparent hover:bg-gray-50 dark:hover:bg-neutral-800/50 rounded-md transition-colors"
        popupMatchSelectWidth={true}
        open={open}
        onDropdownVisibleChange={visible => {
          cancelClose();
          setOpen(visible);
        }}
        suffixIcon={
          <IconChevronDown
            size={16}
            className={`text-gray-400 dark:text-gray-500 transition-transform duration-200 ease-out ${
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
              border: '1px solid rgb(231 229 228)',
              borderRadius: '6px',
            },
          },
        }}
        classNames={{
          popup: {
            root: 'cm-org-select-popup [&::-webkit-scrollbar]:hidden [&_.ant-select-item-option-selected]:!bg-transparent [&_.ant-select-item-option-active]:!bg-transparent',
          },
        }}
        options={memberships
          ?.sort((a, b) => a.organization.name?.localeCompare(b.organization.name))
          .map(m => ({
            value: m.id.toString(),
            label: m.organization.name,
            ...m,
          }))}
        labelInValue={true}
        labelRender={() => {
          if (!membership) return null;
          const term = termAbbreviation(
            membership.organization.term,
            membership.organization.year
          );
          return (
            <div className="min-w-0 px-1 flex items-baseline gap-1.5">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                {membership.organization.name}
              </span>
              {term && (
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500 shrink-0">
                  {term}
                </span>
              )}
            </div>
          );
        }}
        optionRender={({ data }) => {
          const membershipOption = data as OrgSelectOption;
          return (
            <button
              className="flex w-full items-center gap-2 px-1.5 py-1.5 hover:bg-stone-50 dark:hover:bg-neutral-800/60 rounded-md cursor-pointer transition-colors text-left"
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
                  <div className="font-medium text-[13px] text-gray-900 dark:text-gray-100 truncate leading-tight">
                    {membershipOption.organization.name}
                  </div>
                  {(() => {
                    const term = termAbbreviation(
                      membershipOption.organization.term,
                      membershipOption.organization.year
                    );
                    return term ? (
                      <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 shrink-0">
                        {term}
                      </span>
                    ) : null;
                  })()}
                </div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate leading-tight">
                  {roleLabel(membershipOption.role)}
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
