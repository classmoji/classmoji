import { Outlet } from 'react-router';
import { UserHeader } from '~/components';

const UserLayout = () => {
  return (
    <div className="min-h-screen bg-panel">
      <UserHeader />
      <div className="absolute top-[50px] px-20 w-full pt-12">
        <Outlet />
      </div>
    </div>
  );
};

export default UserLayout;
