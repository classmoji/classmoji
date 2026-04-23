interface InfoCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

const InfoCard = ({ title, children, className = '' }: InfoCardProps) => (
  <div className={`panel ${className}`}>
    <div className="panel-body">
      <h3 className="text-ink-2 text-xs uppercase tracking-wide mb-2">{title}</h3>
      {children}
    </div>
  </div>
);

export default InfoCard;
