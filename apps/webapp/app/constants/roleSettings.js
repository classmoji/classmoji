/**
 * Defines the settings for each role in the application.
 */

export const roleSettings = {
  OWNER: { path: '/admin', color: 'red' },
  ASSISTANT: { path: '/assistant', color: 'blue' },
  STUDENT: { path: '/student', color: 'green' },
  'PENDING INVITE': { path: '', color: 'yellow' },
};

/**
 * Get role from URL path prefix (e.g., 'admin' -> 'OWNER')
 */
export const getRoleFromPath = (pathPrefix) => {
  const pathToRole = Object.entries(roleSettings).reduce((acc, [role, settings]) => {
    if (settings.path) {
      const prefix = settings.path.replace('/', '');
      acc[prefix] = role;
    }
    return acc;
  }, {});

  return pathToRole[pathPrefix];
};
