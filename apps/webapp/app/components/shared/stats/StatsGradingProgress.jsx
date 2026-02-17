import { Progress, Table, Card } from 'antd';
import dayjs from 'dayjs';
import { CardHeader } from '~/components';
import theme from '~/config/theme';

const StatsGradingProgress = ({ gradingProgress }) => {
  const columns = [
    {
      title: 'Assignment',
      dataIndex: 'title',
      width: '40%',
      render: title => (
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-primary rounded-full"></div>
          <span className="font-medium text-gray-800 dark:text-gray-200">{title}</span>
        </div>
      ),
    },
    {
      title: 'Progress',
      dataIndex: 'progress',
      render: progress => {
        const getProgressColor = value => {
          if (value >= 90) return theme.PRIMARY; // primary green
          if (value >= 70) return '#fbbf24'; // yellow
          if (value >= 50) return '#f97316'; // orange
          return '#ef4444'; // red
        };

        return (
          <div className="flex items-center gap-3">
            <Progress
              percent={progress.toFixed(0)}
              showInfo={false}
              strokeColor={getProgressColor(progress)}
              trailColor="#f1f5f9"
              size="small"
              className="flex-1"
            />
            <span
              className={`text-sm font-semibold min-w-12 ${
                progress >= 90
                  ? 'text-green-600'
                  : progress >= 70
                    ? 'text-yellow-600'
                    : progress >= 50
                      ? 'text-orange-600'
                      : 'text-red-600'
              }`}
            >
              {progress.toFixed(0)}%
            </span>
          </div>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'progress',
      width: '20%',
      render: progress => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded-full ${
            progress >= 90
              ? 'bg-green-100 text-green-700'
              : progress >= 70
                ? 'bg-yellow-100 text-yellow-700'
                : progress >= 50
                  ? 'bg-orange-100 text-orange-700'
                  : 'bg-red-100 text-red-700'
          }`}
        >
          {progress >= 90
            ? 'Complete'
            : progress >= 70
              ? 'Nearly Done'
              : progress >= 50
                ? 'In Progress'
                : 'Behind'}
        </span>
      ),
    },
  ];

  const data = gradingProgress.filter(assignment => {
    return dayjs().isAfter(dayjs(assignment.student_deadline));
  });

  return (
    <Card className="h-full shadow-xs">
      <CardHeader>Class Grading Progress</CardHeader>

      <Table
        dataSource={data.sort((a, b) => b.progress - a.progress)} // Sort by progress desc
        columns={columns}
        rowKey={record => record.id || record.title}
        size="small"
        pagination={{
          pageSize: 5,
          showSizeChanger: false,
          showQuickJumper: false,
          size: 'small',
        }}
      />
    </Card>
  );
};

export default StatsGradingProgress;
