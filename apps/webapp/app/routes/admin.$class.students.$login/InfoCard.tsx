interface InfoCardProps {
  title: string;
  value: React.ReactNode;
  note?: string | null;
}

const InfoCard = ({ title, value, note = null }: InfoCardProps) => {
  return (
    <div className="rounded-xl ring-1 ring-line p-3 text-center">
      <div className="text-xs font-medium text-ink-3 mb-1">{title}</div>
      <div className="text-xl font-bold text-ink-0">{value}</div>
      {note && (
        <div className="text-xs text-red-500 dark:text-red-400 mt-1">{note}</div>
      )}
    </div>
  );
};

export default InfoCard;
