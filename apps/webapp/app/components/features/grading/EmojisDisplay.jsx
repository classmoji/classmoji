import { Tooltip } from 'antd';
import { useRole } from '~/hooks';

import Emoji from '../../ui/display/Emoji';

const EmojisDisplay = ({ grades }) => {
  const { role } = useRole();

  if (!grades || grades.length === 0) {
    return <div className="text-gray-400 text-sm italic">No grades yet</div>;
  }

  return (
    <div className="flex gap-2 flex-wrap items-center">
      {grades.map((grade, index) => {
        return (
          <div key={grade.id} className="relative group">
            <Tooltip title={role !== 'STUDENT' && grade.grader?.name} placement="top">
              <div className="p-2 rounded-lg bg-gray-50 hover:bg-gray-100 transition-all duration-200 hover:scale-110 hover:shadow-xs border border-gray-200">
                <Emoji emoji={grade.emoji} fontSize={14} className="block" />
              </div>
            </Tooltip>
            {role !== 'STUDENT' && (
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-blue-500 text-white text-xs rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                {index + 1}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default EmojisDisplay;
