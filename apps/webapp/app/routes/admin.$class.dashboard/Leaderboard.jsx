import { UserThumbnailView, CardHeader } from '~/components';
import { Tag, Card } from 'antd';

const StudentList = ({ students, title, isTop = false }) => (
  <Card className="h-full">
    <CardHeader>{title}</CardHeader>
    <div className="flex flex-col gap-2">
      {students.map((student, index) => (
        <div
          key={student.id}
          className="flex items-center justify-between p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-200"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isTop && index < 3 && (
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  index === 0
                    ? 'bg-yellow-400 text-white'
                    : index === 1
                      ? 'bg-gray-300 text-white'
                      : 'bg-amber-600 text-white'
                }`}
              >
                {index + 1}
              </div>
            )}
            <UserThumbnailView user={student} truncate={true} />
          </div>

          <Tag
            className={`font-medium border-0 ${
              student.grade < 0
                ? 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                : student.grade >= 90
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                  : student.grade >= 80
                    ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                    : student.grade >= 70
                      ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400'
                      : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
            }`}
          >
            {student.grade < 0 ? '--' : student.grade.toFixed(1)}
          </Tag>
        </div>
      ))}
    </div>
  </Card>
);

const Leaderboard = ({ topStudents, bottomStudents }) => {
  return (
    <div className="grid grid-cols-2 gap-6 h-full min-h-[370px]">
      <StudentList students={topStudents} title="Top Students" isTop={true} />
      <StudentList students={bottomStudents} title="Bottom Students" />
    </div>
  );
};

export default Leaderboard;
