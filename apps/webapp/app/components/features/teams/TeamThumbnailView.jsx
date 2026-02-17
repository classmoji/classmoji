import _ from 'lodash';

const TeamThumbnailView = ({ team }) => {
  const { avatar_url, name } = team;
  return (
    <div className="flex gap-3">
      <img className="w-[37px] h-[37px] rounded-full" src={avatar_url} alt={avatar_url} />

      <div>
        <div className="text-sm font-bold">{_.capitalize(name)}</div>
        <div className="text-sm">@{name}</div>
      </div>
    </div>
  );
};

export default TeamThumbnailView;
