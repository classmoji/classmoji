import { Avatar, Tooltip, Dropdown } from 'antd';

/**
 * Format a date as relative time (e.g., "2 hours ago", "3 days ago")
 */
const formatRelativeTime = date => {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;

  // For older than a week, show the date
  return then.toLocaleDateString();
};

/**
 * Role category configuration for grouping viewers
 */
const ROLE_CATEGORIES = {
  teaching: {
    label: 'Teaching View',
    roles: ['OWNER', 'TEACHER'],
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-900/20',
  },
  assistant: {
    label: 'Assistant View',
    roles: ['ASSISTANT'],
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-900/20',
  },
  student: {
    label: 'Student View',
    roles: ['STUDENT'],
    color: 'text-green-600 dark:text-green-400',
    bgColor: 'bg-green-50 dark:bg-green-900/20',
  },
};

/**
 * Get the category key for a role
 */
const getRoleCategory = role => {
  if (ROLE_CATEGORIES.teaching.roles.includes(role)) return 'teaching';
  if (ROLE_CATEGORIES.assistant.roles.includes(role)) return 'assistant';
  if (ROLE_CATEGORIES.student.roles.includes(role)) return 'student';
  return 'student'; // Default to student for unknown/null roles
};

/**
 * Viewer row component
 */
const ViewerRow = ({ user, lastViewedAt }) => (
  <div className="flex items-center gap-3">
    <Avatar
      src={user.avatar_url}
      size={28}
      className="shrink-0 border border-gray-200 dark:border-gray-600"
    >
      {!user.avatar_url && (user.name?.[0] || user.login?.[0] || '?')}
    </Avatar>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
        {user.name || user.login || 'Unknown'}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {formatRelativeTime(lastViewedAt)}
      </div>
    </div>
  </div>
);

/**
 * RecentViewers - Notion-style presence indicator
 * Shows stacked avatars of users who recently viewed the current page,
 * with a dropdown showing the full list with timestamps.
 *
 * @param {Object} props
 * @param {Array} props.viewers - Array of { user, lastViewedAt, role? } objects
 * @param {number} props.totalCount - Total number of viewers (may exceed viewers.length)
 * @param {boolean} props.groupByRole - If true, group viewers by role category (for admin views)
 */
const RecentViewers = ({ viewers = [], totalCount = 0, groupByRole = false }) => {
  if (!viewers || viewers.length === 0) {
    return null;
  }

  // Use totalCount if provided, otherwise fall back to viewers.length
  const displayTotal = totalCount || viewers.length;

  // Group viewers by role category if enabled
  const groupedViewers = groupByRole
    ? viewers.reduce((acc, viewer) => {
        const category = getRoleCategory(viewer.role);
        if (!acc[category]) acc[category] = [];
        acc[category].push(viewer);
        return acc;
      }, {})
    : null;

  // Dropdown content - grouped or flat list
  const dropdownContent = (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-3 min-w-[280px] max-h-[70vh] overflow-y-auto">
      <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3 flex items-center justify-between">
        <span>Last viewed by</span>
        <span className="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-[10px] font-medium">
          {displayTotal} {displayTotal === 1 ? 'viewer' : 'viewers'}
        </span>
      </div>

      {groupByRole && groupedViewers ? (
        // Grouped by role category
        <div className="space-y-4">
          {['teaching', 'assistant', 'student'].map(categoryKey => {
            const categoryViewers = groupedViewers[categoryKey];
            if (!categoryViewers?.length) return null;

            const category = ROLE_CATEGORIES[categoryKey];
            return (
              <div key={categoryKey}>
                <div className={`text-[10px] font-semibold uppercase tracking-wider mb-2 px-2 py-1 rounded ${category.bgColor} ${category.color}`}>
                  {category.label} ({categoryViewers.length})
                </div>
                <div className="space-y-2 pl-1">
                  {categoryViewers.map(({ user, lastViewedAt }) => (
                    <ViewerRow key={user.id} user={user} lastViewedAt={lastViewedAt} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // Flat list (original behavior)
        <div className="space-y-2">
          {viewers.map(({ user, lastViewedAt }) => (
            <ViewerRow key={user.id} user={user} lastViewedAt={lastViewedAt} />
          ))}
        </div>
      )}
    </div>
  );

  // Show up to 4 avatars, then "+N" for overflow (using total count for accuracy)
  const maxDisplay = 4;
  const displayViewers = viewers.slice(0, maxDisplay);
  const additionalCount = displayTotal - maxDisplay;

  return (
    <Dropdown
      dropdownRender={() => dropdownContent}
      trigger={['hover', 'click']}
      placement="bottomRight"
    >
      <div className="flex items-center cursor-pointer">
        <div className="flex -space-x-2">
          {displayViewers.map(({ user }, index) => (
            <Tooltip key={user.id} title={user.name || user.login}>
              <Avatar
                src={user.avatar_url}
                size={28}
                className="border-2 border-white dark:border-gray-900 shadow-sm hover:z-10 transition-transform hover:scale-110"
                style={{ zIndex: displayViewers.length - index }}
              >
                {!user.avatar_url && (user.name?.[0] || user.login?.[0] || '?')}
              </Avatar>
            </Tooltip>
          ))}
          {additionalCount > 0 && (
            <Avatar
              size={28}
              className="border-2 border-white dark:border-gray-900 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium"
              style={{ zIndex: 0 }}
            >
              +{additionalCount}
            </Avatar>
          )}
        </div>
      </div>
    </Dropdown>
  );
};

export default RecentViewers;
