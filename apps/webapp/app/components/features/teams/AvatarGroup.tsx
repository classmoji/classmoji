import { Tooltip, Avatar } from 'antd';

const AvatarGroup = ({ users }: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- accepts various Prisma user/member shapes
  const slicedUsers = users.length > 20 ? users.slice(0, 20) : users;

  const tooltips = slicedUsers.map((user: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- various user shapes
    return (
      <Tooltip title={`@${user.login}`} key={user.login}>
        <Avatar
          src={user.avatar_url || user.avatarUrl}
          shape="circle"
          className="w-[40px] h-[40px] relative"
        />
      </Tooltip>
    );
  });

  if (users.length > 20) {
    tooltips.push(
      <Avatar shape="circle" className="w-[40px] h-[40px]">
        +{users.length - 20}
      </Avatar>
    );
  }

  return <div className="">{tooltips}</div>;
};

export default AvatarGroup;
