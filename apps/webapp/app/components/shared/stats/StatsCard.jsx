import { Card } from 'antd';

const StatsCard = ({ title, children, icon }) => {
  const Icon = icon;

  return (
    <Card className="hover:shadow-lg transition-all duration-200 shadow-sm border border-gray-100 dark:border-gray-700 hover:border-primary-200 dark:hover:border-primary-900/50 border-t-2 border-t-primary">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
            {title}
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
            {children}
          </div>
        </div>

        {icon && (
          <div className="bg-primary-50/50 dark:bg-primary-900/20 p-2 rounded-xl shrink-0">
            <Icon size={15} className="text-primary dark:text-primary" />
          </div>
        )}
      </div>
    </Card>
  );
};

export default StatsCard;
