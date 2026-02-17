import { useRole } from '~/hooks';

const RequireRole = ({ roles, children, fallback = null }) => {
  const { role: userRole } = useRole();
  const rolesArray = Array.isArray(roles) ? roles : [roles];
  return userRole && rolesArray.includes(userRole) ? children : fallback;
};

export default RequireRole;
