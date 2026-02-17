import { Button, Space } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { formatFullDate, getWeekDates } from './utils';

const WeekNavigator = ({ currentWeek, onWeekChange }) => {
  const weekDates = getWeekDates(currentWeek);
  const firstDay = weekDates[0];
  const lastDay = weekDates[6];

  const goToPreviousWeek = () => {
    const newDate = new Date(currentWeek);
    newDate.setDate(newDate.getDate() - 7);
    onWeekChange(newDate);
  };

  const goToNextWeek = () => {
    const newDate = new Date(currentWeek);
    newDate.setDate(newDate.getDate() + 7);
    onWeekChange(newDate);
  };

  const goToToday = () => {
    onWeekChange(new Date());
  };

  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-4">
        <Space>
          <Button
            icon={<LeftOutlined />}
            onClick={goToPreviousWeek}
            aria-label="Previous week"
          />
          <Button onClick={goToToday}>Today</Button>
          <Button
            icon={<RightOutlined />}
            onClick={goToNextWeek}
            aria-label="Next week"
          />
        </Space>
      </div>

      <div className="text-lg font-semibold text-gray-700 dark:text-gray-300">
        {formatFullDate(firstDay)} - {formatFullDate(lastDay)}
      </div>
    </div>
  );
};

export default WeekNavigator;
