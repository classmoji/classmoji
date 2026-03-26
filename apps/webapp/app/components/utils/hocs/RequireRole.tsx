import { useRole } from '~/hooks';

interface RequireRoleProps {
  roles: string | string[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
  [key: string]: unknown;
}

const RequireRole = ({ roles, children, fallback = null }: RequireRoleProps) => {
  const { role: userRole } = useRole();
  const rolesArray = Array.isArray(roles) ? roles : [roles];
  return userRole && rolesArray.includes(userRole) ? children : fallback;
};

export default RequireRole;
