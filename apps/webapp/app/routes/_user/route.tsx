import { Outlet } from 'react-router';
import { UserHeader } from '~/components';

const UserLayout = () => {
  return (
    <div
      className="min-h-screen"
      style={{ background: '#EDEDED' }}
    >
      <UserHeader />
      <div className="max-w-[1200px] mx-auto px-8 pt-7 pb-20">
        <Outlet />
      </div>
    </div>
  );
};

export default UserLayout;
