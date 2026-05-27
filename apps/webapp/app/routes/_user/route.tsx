import { Outlet } from 'react-router';
import { UserHeader } from '~/components';

const UserLayout = () => {
  return (
    <div
      className="min-h-screen bg-[#EDEDED] dark:bg-[#1d1d1d]"
    >
      <UserHeader />
      <div className="max-w-[1200px] mx-auto px-4 sm:px-8 pt-4 sm:pt-7 pb-20">
        <Outlet />
      </div>
    </div>
  );
};

export default UserLayout;
