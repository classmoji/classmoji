import { useUser } from '~/hooks';

const RequireAdmin = ({ children }) => {
  const { user } = useUser();

  if (user?.is_admin) {
    return children;
  }

  return null;
};

export default RequireAdmin;
