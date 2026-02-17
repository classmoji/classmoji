import { CardHeader } from '~/components';
import { Tag, Card } from 'antd';

const TAGradingLeaderboard = ({ progress }) => {
  const getRankStyle = index => {
    if (index === 0) return 'bg-yellow-400 text-white';
    if (index === 1) return 'bg-gray-300 text-white';
    if (index === 2) return 'bg-amber-600 text-white';
    return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  };

  return (
    <Card className="h-[68vh] overflow-hidden flex flex-col shadow-xs">
      <CardHeader>TA Grading Leaderboard</CardHeader>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
        {progress.map((item, i) => (
          <div key={item.id} className="p-2 rounded-lg">
            <div className="flex items-center justify-between gap-2">
              {/* Rank badge */}
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${getRankStyle(
                  i
                )}`}
              >
                {i + 1}
              </div>

              <div className="flex items-center gap-2 min-w-0 flex-1">
                <img
                  src={`https://github.com/${item.login}.png`}
                  alt={item.name || 'User avatar'}
                  className="w-8 h-8 rounded-full ring-1 ring-gray-200 flex-shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p
                    className="font-medium text-gray-800 text-xs truncate"
                    title={item.name || 'Unknown'}
                  >
                    {item.name ? item.name.split(' ')[0] : 'Unknown'}
                  </p>
                </div>
              </div>

              <Tag
                className={`font-medium border-0 ${
                  item.progress >= 90
                    ? 'bg-green-100 text-green-700'
                    : item.progress >= 75
                      ? 'bg-yellow-100 text-yellow-700'
                      : item.progress >= 50
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-red-100 text-red-700'
                }`}
              >
                {item.progress.toFixed(0)}%
              </Tag>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

export default TAGradingLeaderboard;
