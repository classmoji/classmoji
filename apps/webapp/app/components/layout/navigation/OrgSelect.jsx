import { Select, Avatar, Tag } from 'antd';
import { useNavigate } from 'react-router';
import useStore from '~/store';
import { roleSettings } from '~/constants/roleSettings';

const OrgSelect = ({ memberships }) => {
  const { membership } = useStore();
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-0 max-w-[450px] min-w-[280px]">
      <Select
        placeholder="Select classroom"
        variant="borderless"
        className="w-full bg-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-lg transition-colors"
        styles={{
          popup: {
            root: {
              minWidth: '360px',
              padding: '12px 8px',
              msOverflowStyle: 'none',
              scrollbarWidth: 'none',
            },
          },
        }}
        classNames={{ popup: { root: '[&::-webkit-scrollbar]:hidden' } }}
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

          return (
            <div className="flex items-center gap-3 justify-between py-1.5 px-2">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Avatar
                  src={membership.organization.avatar_url}
                  size={32}
                  className="border-2 border-gray-300 dark:border-gray-600 shrink-0 shadow-sm"
                />
                <div className="flex flex-col min-w-0">
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {membership.organization.name}
                  </div>
                  {membership.organization.term && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {membership.organization.term} {membership.organization.year}
                    </div>
                  )}
                </div>
              </div>

              <Tag
                color={roleSettings[membership.role]?.color || 'default'}
                className="ml-2 shrink-0 font-semibold text-xs"
              >
                {membership.role}
              </Tag>
            </div>
          );
        }}
        optionRender={({ data }) => {
          return (
            <button
              className="flex justify-between w-full items-center gap-3 p-3.5 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-lg cursor-pointer transition-all duration-150 hover:shadow-sm border border-transparent hover:border-primary-200 dark:hover:border-primary-900/30"
              onClick={() => {
                // Students go to class root (student.$class._index handles default page)
                const suffix = data.role === 'STUDENT' ? '' : '/dashboard';
                navigate(`${roleSettings[data.role].path}/${data.organization.login}${suffix}`);
              }}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Avatar
                  src={data.organization.avatar_url}
                  size={40}
                  className="border-2 border-gray-200 dark:border-gray-600 shrink-0 shadow-sm"
                />
                <div className="text-sm text-gray-800 dark:text-gray-200 truncate flex flex-col items-start gap-1">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">
                    {data.organization.name}
                  </div>
                  {data.organization.term && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {data.organization.term} {data.organization.year}
                    </div>
                  )}
                </div>
              </div>

              <Tag
                color={roleSettings[data.role]?.color || 'default'}
                className="shrink-0 font-semibold text-xs"
              >
                {data.role}
              </Tag>
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
