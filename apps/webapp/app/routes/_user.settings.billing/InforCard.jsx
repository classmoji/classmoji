import { Card } from 'antd';

const InfoCard = ({ title, children, className = '' }) => (
  <Card
    className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${className}`}
  >
    <div>
      <h3 className="font-medium text-gray-600 dark:text-gray-400 mb-2">{title}</h3>
      {children}
    </div>
  </Card>
);

export default InfoCard;
