import { Card } from 'antd';

interface InfoCardProps {
  title: string;
  value: React.ReactNode;
  note?: string | null;
}

const InfoCard = ({ title, value, note = null }: InfoCardProps) => {
  return (
    <Card className="shadow-xs hover:shadow-md transition-shadow duration-200 border-t-2 border-t-primary">
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-2">
          <h1 className="font-semibold text-center text-sm text-ink-0 dark:text-ink-0">
            {title}
          </h1>
        </div>
        <p className="text-3xl font-bold text-ink-0">{value}</p>
        {note && (
          <p className="text-xs text-red-500 dark:text-red-400 bg-rose-bg dark:bg-red-900/20 px-2 py-1 rounded-full">
            {note}
          </p>
        )}
      </div>
    </Card>
  );
};

export default InfoCard;
