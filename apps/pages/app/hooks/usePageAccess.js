import { useRouteLoaderData } from 'react-router';

/**
 * Hook to check page access from root loader data.
 * Returns role-based access flags.
 */
export function usePageAccess() {
  const rootData = useRouteLoaderData('root');

  if (!rootData?.user) {
    return {
      isAuthenticated: false,
      isStaff: false,
      isTeachingTeam: false,
      isStudent: false,
      role: null,
      user: null,
    };
  }

  const { user } = rootData;

  return {
    isAuthenticated: true,
    user,
    // Note: actual role checks happen per-route based on classroom membership
    // This hook provides the base user data
  };
}
